import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localRealtime } from '../../server/services/asr/local.js';
const settings = { asr: { local: { engine: 'qwen', model: 'Qwen/test', device: 'cpu' } } };
const pcm = (seconds, value = 1000) => { const out = Buffer.alloc(Math.round(seconds * 16000 * 2)); for (let i = 0; i < out.length; i += 2) out.writeInt16LE(value, i); return out; };
const config = { minSeconds: 0.2, targetSeconds: 0.5, maxSeconds: 0.8, overlapSeconds: 0.1, silenceSeconds: 0.1 };

test('小于 min 不推理，target 推理并使用 sample offset', async () => {
  const calls = [], finals = []; const stream = localRealtime(settings, { config, transcribe: async (body) => { calls.push(body); return { text: '第一段' }; } });
  stream.on('final', (event) => finals.push(event)); stream.send(pcm(0.1)); await new Promise((r) => setTimeout(r, 5)); assert.equal(calls.length, 0);
  stream.send(pcm(0.4)); await stream.stop(); assert.equal(calls.length, 1); assert.equal(finals[0].start, 0); assert.equal(finals[0].end, 0.5); assert.equal(finals[0].timing, 'estimated');
});

test('silence flush 与 max window 强制推理', async () => {
  const silenceCalls = []; const a = localRealtime(settings, { config, transcribe: async (body) => { silenceCalls.push(body); return { text: '' }; } });
  a.send(Buffer.concat([pcm(0.2), pcm(0.1, 0)])); await new Promise((r) => setTimeout(r, 10)); await a.stop(); assert.equal(silenceCalls.length, 1);
  const maxCalls = []; const b = localRealtime(settings, { config: { ...config, targetSeconds: 2 }, transcribe: async (body) => { maxCalls.push(body); return { text: '' }; } });
  b.send(pcm(0.8)); await b.stop(); assert.equal(maxCalls.length, 1);
});

test('processing 时缓存新音频，stop 等待并 flush，overlap dedupe', async () => {
  const calls = [], finals = []; let release;
  const first = new Promise((resolve) => { release = resolve; });
  const stream = localRealtime(settings, { config, transcribe: async (body) => { calls.push(body); if (calls.length === 1) { await first; return { text: '项目进度' }; } return { text: '项目进度然后上线' }; } });
  stream.on('final', (event) => finals.push(event)); stream.send(pcm(0.5)); stream.send(pcm(0.4));
  let stopped = false; const stopping = stream.stop().then(() => { stopped = true; }); await new Promise((r) => setTimeout(r, 5)); assert.equal(stopped, false);
  release(); await stopping; assert.equal(calls.length, 2); assert.deepEqual(finals.map((item) => item.text), ['项目进度', '然后上线']);
  assert.equal(stream.send(pcm(1)), false); assert.equal(calls.length, 2);
});

test('fatal inference error 结构化且关闭 session', async () => {
  const errors = []; const stream = localRealtime(settings, { config, transcribe: async () => { throw Object.assign(new Error('daemon down'), { code: 'DAEMON_DOWN' }); } });
  stream.on('error', (error) => errors.push(error)); stream.send(pcm(0.5)); await assert.rejects(stream.stop(), /daemon down/);
  assert.deepEqual(errors[0], { code: 'DAEMON_DOWN', message: 'daemon down', provider: 'local', model: 'Qwen/test', fatal: true });
  assert.equal(stream.snapshot().state, 'closed');
});
