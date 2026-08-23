import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAsrResult, normalizeRealtimeFinal } from '../../server/services/asr/contract.js';

test('文件 ASR contract 字段完整且毫秒统一为秒', () => {
  const result = normalizeAsrResult({ text: 'hello', segments: [{ start: 1200, end: 2500, text: 'hello', confidence: 0.8 }] },
    { provider: 'volc', model: 'bigmodel', duration: 3, latencyMs: 600, timestampUnit: 'milliseconds' });
  assert.deepEqual(result.segments[0], { start: 1.2, end: 2.5, speaker: null, text: 'hello', confidence: 0.8, timing: 'native' });
  assert.equal(result.provider, 'volc'); assert.equal(result.duration, 3); assert.equal(result.realtimeFactor, 5);
  assert.deepEqual(result.warnings, []);
});

test('无 timestamp 必须 null/unknown，不能用 0 冒充', () => {
  const result = normalizeAsrResult({ text: '完整文本', segments: [{ text: '完整文本', timing: 'unknown', start: 0, end: 0 }] }, { provider: 'qwen' });
  assert.equal(result.segments[0].start, null); assert.equal(result.segments[0].end, null);
  assert.equal(result.segments[0].timing, 'unknown');
});

test('realtime 音频窗口保留 estimated 秒时间', () => {
  assert.deepEqual(normalizeRealtimeFinal({ text: '窗口', start: 10.2, end: 14.8, timing: 'estimated' }, { provider: 'local' }),
    { text: '窗口', start: 10.2, end: 14.8, speaker: null, confidence: null, timing: 'estimated', provider: 'local', model: null });
});
