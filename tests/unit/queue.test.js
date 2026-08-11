import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../../server/services/queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('队列按顺序执行且并发受限', async () => {
  const q = new TaskQueue({ concurrency: 1 });
  const order = [];
  const tasks = [1, 2, 3].map((n) => q.add({
    id: `t${n}`,
    async run() {
      order.push(`start${n}`);
      await sleep(20);
      order.push(`end${n}`);
      return n;
    }
  }));
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
});

test('队列错误传递且后续任务继续', async () => {
  const q = new TaskQueue({ concurrency: 1 });
  const events = [];
  q.onDone(({ taskId, ok }) => events.push({ taskId, ok }));
  const fail = q.add({ id: 'fail', async run() { throw new Error('boom'); } });
  const okTask = q.add({ id: 'ok', async run() { return 42; } });
  await assert.rejects(fail, /boom/);
  assert.equal(await okTask, 42);
  // done 事件同时发出
  await sleep(10);
  assert.deepEqual(events.map((e) => e.taskId).sort(), ['fail', 'ok']);
  assert.deepEqual(events.find((e) => e.taskId === 'fail').ok, false);
  assert.deepEqual(events.find((e) => e.taskId === 'ok').ok, true);
});

test('progress 事件', async () => {
  const q = new TaskQueue();
  const seen = [];
  q.onProgress(({ taskId, percent }) => seen.push({ taskId, percent }));
  const t = q.add({
    id: 'p',
    async run() { q.progress('p', { percent: 50 }); return 'done'; }
  });
  await t;
  assert.deepEqual(seen, [{ taskId: 'p', percent: 50 }]);
});

test('setup 在 run 之前调用', async () => {
  const q = new TaskQueue();
  const calls = [];
  await q.add({
    id: 'setup',
    setup() { calls.push('setup'); },
    run() { calls.push('run'); return 'ok'; }
  });
  assert.deepEqual(calls, ['setup', 'run']);
});
