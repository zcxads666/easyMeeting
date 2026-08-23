import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager } from '../../server/services/queue.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitTask = (manager, id) => new Promise((resolve) => {
  const current = manager.get(id); if (['completed', 'failed', 'cancelled'].includes(current.status)) return resolve(current);
  const listener = (task) => { if (task.id === id && ['completed', 'failed', 'cancelled'].includes(task.status)) { manager.events.off('updated', listener); resolve(task); } };
  manager.events.on('updated', listener);
});

test('local concurrency=1 且按顺序', async () => {
  const manager = new TaskManager({ laneConcurrency: { local: 1, cloud: 2 } });
  let active = 0, peak = 0; const order = [];
  const ids = [1, 2, 3].map((n) => manager.create({ type: 'asr', lane: 'local', run: async () => {
    active++; peak = Math.max(peak, active); order.push(`start${n}`); await sleep(10); order.push(`end${n}`); active--; return n;
  }}).id);
  await Promise.all(ids.map((id) => waitTask(manager, id)));
  assert.equal(peak, 1); assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
});

test('cloud lane 允许配置并发', async () => {
  const manager = new TaskManager({ laneConcurrency: { local: 1, cloud: 2 } }); let active = 0, peak = 0;
  const ids = [1, 2].map(() => manager.create({ type: 'asr', lane: 'cloud', run: async () => { active++; peak = Math.max(peak, active); await sleep(15); active--; } }).id);
  await Promise.all(ids.map((id) => waitTask(manager, id))); assert.equal(peak, 2);
});

test('queued cancellation 真正移出队列', async () => {
  const manager = new TaskManager({ laneConcurrency: { local: 1 } });
  let ran = false; let release; const blocker = new Promise((resolve) => { release = resolve; });
  const first = manager.create({ type: 'asr', lane: 'local', run: () => blocker });
  const second = manager.create({ type: 'asr', lane: 'local', run: () => { ran = true; } });
  assert.equal(manager.cancel(second.id), true); assert.equal(manager.get(second.id).status, 'cancelled');
  release(); await waitTask(manager, first.id); assert.equal(ran, false);
});

test('running local cancellation 是 cooperative，结果被丢弃', async () => {
  const manager = new TaskManager({ laneConcurrency: { local: 1 } });
  let release; const blocker = new Promise((resolve) => { release = resolve; });
  const task = manager.create({ type: 'asr', lane: 'local', run: async (context) => { await blocker; return { saved: !context.isCancellationRequested() }; } });
  manager.cancel(task.id); assert.equal(manager.get(task.id).cancelRequested, true); release();
  const done = await waitTask(manager, task.id); assert.equal(done.status, 'cancelled'); assert.equal(done.result, null);
});

test('失败保留 code/message，stage 可观察', async () => {
  const manager = new TaskManager({ laneConcurrency: { local: 1 } });
  const task = manager.create({ type: 'asr', lane: 'local', run: async ({ update }) => { update('transcribing'); throw Object.assign(new Error('boom'), { code: 'ASR_BOOM' }); } });
  const done = await waitTask(manager, task.id); assert.equal(done.status, 'failed'); assert.deepEqual(done.error, { code: 'ASR_BOOM', message: 'boom' });
});
