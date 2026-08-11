import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, transcribeFile, createRealtimeStream, PROVIDERS } from '../../server/services/asr/index.js';

test('工厂包含四家 provider', () => {
  for (const key of ['qwen', 'volc', 'mimo', 'local']) {
    assert.ok(PROVIDERS[key], `缺少 ${key}`);
    assert.equal(typeof PROVIDERS[key].file, 'function');
    assert.equal(typeof PROVIDERS[key].realtime, 'function');
  }
});

test('getProvider 未知类型回退 qwen', () => {
  assert.equal(getProvider('unknown'), PROVIDERS.qwen);
  assert.equal(getProvider('qwen'), PROVIDERS.qwen);
  assert.equal(getProvider('local'), PROVIDERS.local);
});

test('千问文件转写：未配置 API Key 抛错', async () => {
  const settings = { asr: { qwen: { apiKey: '', model: 'x' } } };
  await assert.rejects(
    transcribeFile('qwen', { filePath: '/tmp/a.wav' }, settings),
    /未配置千问 API Key/
  );
});

test('千问实时：未配置 API Key 抛错', () => {
  const settings = { asr: { qwen: { apiKey: '' } } };
  assert.throws(() => createRealtimeStream('qwen', settings), /未配置千问 API Key/);
});

test('火山文件转写：未配置 appid/token 抛错', async () => {
  const settings = { asr: { volc: { appid: '', token: '' } } };
  await assert.rejects(
    transcribeFile('volc', { filePath: '/tmp/a.wav' }, settings),
    /未配置火山/
  );
});

test('火山实时：未配置 appid/token 抛错', () => {
  const settings = { asr: { volc: { appid: '', token: '' } } };
  assert.throws(() => createRealtimeStream('volc', settings), /未配置火山/);
});

test('MiMo 文件转写：未配置 API Key 抛错', async () => {
  const settings = { asr: { mimo: { apiKey: '', model: 'x' } } };
  await assert.rejects(
    transcribeFile('mimo', { filePath: '/tmp/a.wav' }, settings),
    /未配置 MiMo API Key/
  );
});

test('本地实时流返回统一接口', () => {
  const settings = { asr: { local: { engine: 'whisper', model: 'whisper-small' } } };
  const stream = createRealtimeStream('local', settings);
  assert.equal(typeof stream.on, 'function');
  assert.equal(typeof stream.send, 'function');
  assert.equal(typeof stream.start, 'function');
  assert.equal(typeof stream.stop, 'function');
  assert.equal(typeof stream.close, 'function');
});
