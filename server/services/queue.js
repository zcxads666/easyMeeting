import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// 简单内存任务队列，进度通过事件下发
export class TaskQueue {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
    this.events = new EventEmitter();
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.running >= this.concurrency || !this.pending.length) return;
    const { task, resolve, reject } = this.pending.shift();
    this.running++;
    Promise.resolve()
      .then(() => task.setup?.())
      .then(() => task.run())
      .then((res) => { this.events.emit('done', { taskId: task.id, ok: true }); resolve(res); })
      .catch((err) => { this.events.emit('done', { taskId: task.id, ok: false, error: err.message }); reject(err); })
      .finally(() => { this.running--; this._pump(); });
  }

  progress(taskId, data) {
    this.events.emit('progress', { taskId, ...data });
  }

  onProgress(fn) { this.events.on('progress', fn); }
  onDone(fn) { this.events.on('done', fn); }
}

export const queue = new TaskQueue({ concurrency: 2 });

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class TaskManager {
  constructor({ laneConcurrency = { local: 1, cloud: 3 } } = {}) {
    this.tasks = new Map();
    this.events = new EventEmitter();
    this.lanes = new Map(Object.entries(laneConcurrency).map(([name, concurrency]) => [name, { concurrency, running: 0, pending: [] }]));
  }

  create({ id = randomUUID(), type, lane = 'cloud', run, metadata = {} }) {
    if (!this.lanes.has(lane)) throw new Error(`未知任务 lane: ${lane}`);
    const task = { id, type, lane, status: 'queued', stage: 'queued', progress: null,
      createdAt: Date.now(), startedAt: null, finishedAt: null, error: null, result: null,
      cancelRequested: false, metadata, _run: run, _controller: new AbortController() };
    this.tasks.set(id, task); this.lanes.get(lane).pending.push(task); this._emit(task); this._pump(lane);
    return this.public(task);
  }

  get(id) { const task = this.tasks.get(id); return task ? this.public(task) : null; }
  list() { return [...this.tasks.values()].map((task) => this.public(task)); }
  cancel(id) {
    const task = this.tasks.get(id);
    if (!task || TERMINAL.has(task.status)) return false;
    task.cancelRequested = true; task._controller.abort(new Error('task cancelled'));
    if (task.status === 'queued') {
      const lane = this.lanes.get(task.lane);
      lane.pending = lane.pending.filter((candidate) => candidate.id !== id);
      this._finish(task, 'cancelled');
    } else this._emit(task);
    return true;
  }

  public(task) { const { _run, _controller, ...value } = task; return structuredClone(value); }
  _emit(task) { this.events.emit('updated', this.public(task)); }
  _finish(task, status, extra = {}) { Object.assign(task, extra, { status, stage: status, finishedAt: Date.now() }); this._emit(task); }
  _pump(name) {
    const lane = this.lanes.get(name);
    while (lane.running < lane.concurrency && lane.pending.length) {
      const task = lane.pending.shift();
      if (task.status !== 'queued') continue;
      lane.running++; task.status = 'running'; task.stage = 'preparing'; task.startedAt = Date.now(); this._emit(task);
      const context = { signal: task._controller.signal,
        update: (stage, progress = null) => { if (!TERMINAL.has(task.status)) { task.stage = stage; task.progress = progress; this._emit(task); } },
        isCancellationRequested: () => task.cancelRequested };
      Promise.resolve().then(() => task._run(context)).then((result) => {
        if (task.cancelRequested) this._finish(task, 'cancelled');
        else this._finish(task, 'completed', { result });
      }).catch((error) => {
        if (task.cancelRequested || error?.name === 'AbortError') this._finish(task, 'cancelled');
        else this._finish(task, 'failed', { error: { code: error.code || 'TASK_FAILED', message: error.message } });
      }).finally(() => { lane.running--; this._pump(name); });
    }
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const taskManager = new TaskManager({ laneConcurrency: {
  local: positiveInt(process.env.MEETING_LOCAL_ASR_CONCURRENCY, 1),
  cloud: positiveInt(process.env.MEETING_CLOUD_ASR_CONCURRENCY, 3), runtime: 1
} });
