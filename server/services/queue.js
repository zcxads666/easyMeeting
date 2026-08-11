import { EventEmitter } from 'node:events';

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