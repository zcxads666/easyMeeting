import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveRealtimeCapability } from '../../server/services/asr/capabilities.js';
import { localVllmRealtime } from '../../server/services/asr/localVllm.js';
import { RecordingWriter } from '../../server/services/audio/recording.js';
import { enqueuePostProcessing } from '../../server/services/post-processing.js';

const local = (mode = 'auto', engine = 'qwen') => ({ realtime: { mode }, asr: { provider: 'local', local: { engine, model: 'Qwen/test' } } });

test('realtime capability auto 可解析 true-streaming 或可观察的 chunked fallback', async () => {
  const ready = await resolveRealtimeCapability(local(), { streaming: { available: true } });
  assert.equal(ready.resolvedMode, 'true-streaming'); assert.equal(ready.supportsRealtimeTimestamps, false);
  const fallback = await resolveRealtimeCapability(local(), { streaming: { available: false, reason: 'CUDA unavailable' } });
  assert.equal(fallback.resolvedMode, 'chunked'); assert.equal(fallback.reason, 'CUDA unavailable');
  await assert.rejects(resolveRealtimeCapability(local('true-streaming'), { streaming: { available: false, reason: 'no vLLM' } }),
    (error) => error.code === 'TRUE_STREAMING_UNAVAILABLE');
  const whisper = await resolveRealtimeCapability(local('auto', 'whisper'), {});
  assert.equal(whisper.resolvedMode, 'chunked'); assert.match(whisper.reason, /Whisper/);
});

test('vLLM adapter 缓存 start 前音频，partial 来自 backend 且 final 不伪造 timestamp', async () => {
  const calls = []; const events = { partial: [], final: [], metrics: [] };
  const stream = localVllmRealtime(local().asr ? local() : {}, { request: async (endpoint, body) => {
    calls.push([endpoint, body]);
    if (endpoint === '/streaming/start') return { sessionId: 's1' };
    if (endpoint === '/streaming/send') return { changed: true, text: '真实增量' };
    return { text: '最终文本' };
  } });
  for (const name of Object.keys(events)) stream.on(name, (value) => events[name].push(value));
  stream.send(Buffer.alloc(3200));
  await stream.start(); await stream.stop();
  assert.deepEqual(calls.map(([endpoint]) => endpoint), ['/streaming/start', '/streaming/send', '/streaming/stop']);
  assert.equal(events.partial[0].text, '真实增量');
  assert.deepEqual({ start: events.final[0].start, end: events.final[0].end, timing: events.final[0].timing },
    { start: null, end: null, timing: 'unknown' });
  assert.equal(events.metrics[0].audioDuration, .1);
});

test('RecordingWriter 流式写 PCM 并原子 finalize 为有效 WAV', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'meeting-recording-'));
  const raw = path.join(root, 'meeting.partial.pcm'); const final = path.join(root, 'meeting.wav');
  try {
    const writer = new RecordingWriter(raw, final); writer.write(Buffer.alloc(3200, 1)); writer.write(Buffer.alloc(3200, 2));
    const result = await writer.finalize(); const data = await fsp.readFile(final);
    assert.equal(result.duration, .2); assert.equal(data.subarray(0, 4).toString(), 'RIFF');
    assert.equal(data.readUInt32LE(24), 16000); assert.equal(data.readUInt16LE(22), 1); assert.equal(data.length, 44 + 6400);
    await assert.rejects(fsp.access(raw));
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('post-processing 保留已成功步骤且后一步失败不回滚', async () => {
  let definition; const manager = { create(value) { definition = value; return { id: 'post-1' }; } };
  const task = enqueuePostProcessing('m1', { alignment: {}, diarization: {}, postProcessing: { autoAlign: true, autoDiarize: true } }, {
    taskManager: manager, runAlignment: async () => ({ timeline: 'aligned' }),
    runDiarization: async () => { throw Object.assign(new Error('gated'), { code: 'HF_AUTH_REQUIRED' }); }
  });
  assert.equal(task.id, 'post-1'); assert.equal(definition.lane, 'local');
  const result = await definition.run({ isCancellationRequested: () => false });
  assert.equal(result.steps.alignment.status, 'completed'); assert.equal(result.steps.diarization.status, 'failed');
  assert.equal(result.steps.diarization.error.code, 'HF_AUTH_REQUIRED');
});
