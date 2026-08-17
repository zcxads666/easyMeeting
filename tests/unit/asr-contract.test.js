/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { transcribeFile } from '../../server/services/asr/index.js';
import { volcFileTranscribe, volcTest, VOLC_FLASH_URL } from '../../server/services/asr/volc.js';
import { qwenFileTranscribe, QWEN_ASR_URL } from '../../server/services/asr/qwen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origFetch = globalThis.fetch;

function silenceWav() {
  return Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([36 + 8000, 0, 0, 0]), Buffer.from('WAVE'),
    Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), Buffer.from([1, 0]), Buffer.from([1, 0]),
    Buffer.from([0x40, 0x1f, 0, 0]), Buffer.from([0x80, 0x3e, 0, 0]),
    Buffer.from([2, 0]), Buffer.from([16, 0]),
    Buffer.from('data'), Buffer.from([0x40, 0x1f, 0, 0]),
    Buffer.alloc(8000)
  ]);
}

afterEach(() => { globalThis.fetch = origFetch; });

test('火山源码不再请求已死 URL', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'server/services/asr/volc.js'), 'utf8');
  assert.doesNotMatch(src, /api\/v3\/auth/);
  assert.doesNotMatch(src, /auc\/apitranscribe/);
  assert.match(src, /auc\/bigmodel\/recognize\/flash/);
  for (const dead of ['api/v3/auth', 'auc/apitranscribe']) {
    assert.ok(!src.includes(dead), `不得包含 ${dead}`);
  }
});

test('千问文件转写不把 file:// 本地路径当 file_url', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asr-qwen-'));
  const filePath = path.join(dir, 'a.wav');
  await fsp.writeFile(filePath, silenceWav());
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body) };
    return {
      ok: false,
      status: 401,
      json: async () => ({ message: 'InvalidApiKey', code: 'InvalidApiKey' })
    };
  };
  await assert.rejects(
    qwenFileTranscribe({ filePath, fileName: 'a.wav' }, { asr: { qwen: { apiKey: 'sk-test', model: 'qwen3-asr-flash' } } }),
    /鉴权|InvalidApiKey|401|失败/
  );
  assert.ok(captured, '应发出请求');
  assert.equal(captured.url, QWEN_ASR_URL);
  const dumped = JSON.stringify(captured.body);
  assert.ok(!dumped.includes('file://'), '不得传 file://');
  assert.ok(!captured.body.input?.file_url, '不得使用 file_url 本地路径');
  const audio = captured.body.input?.messages?.find((m) => m.role === 'user')?.content?.[0]?.audio;
  assert.ok(typeof audio === 'string' && audio.startsWith('data:'), '应用 data URI / base64');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('火山文件转写请求现行 flash 端点，失败必须 throw', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asr-volc-'));
  const filePath = path.join(dir, 'a.wav');
  await fsp.writeFile(filePath, silenceWav());
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), body: JSON.parse(opts.body), headers: opts.headers };
    return {
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({ message: 'unauthorized' })
    };
  };
  await assert.rejects(
    volcFileTranscribe({ filePath }, { asr: { volc: { appid: 'app', token: 'tok' } } }),
    /火山|401|鉴权|失败/
  );
  assert.equal(captured.url, VOLC_FLASH_URL);
  assert.ok(captured.body.audio?.data, '应传 base64 audio.data');
  assert.ok(!JSON.stringify(captured.body).includes('file://'));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('火山 WS/HTTP 错误不得当成空转写成功', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asr-volc2-'));
  const filePath = path.join(dir, 'a.wav');
  await fsp.writeFile(filePath, silenceWav());
  globalThis.fetch = async () => {
    throw new Error('socket hang up');
  };
  await assert.rejects(
    transcribeFile('volc', { filePath }, { asr: { volc: { appid: 'a', token: 'b' } } }),
    /socket hang up|火山/
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('火山/千问现行端点存在（无 Key 的 401 不算产品失败）', async () => {
  const volc = await fetch(VOLC_FLASH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(8000)
  }).catch((e) => ({ status: 0, error: e }));
  assert.notEqual(volc.status, 404, `火山 flash 不应 404，got ${volc.status}`);

  const qwen = await fetch(QWEN_ASR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer' },
    body: '{}',
    signal: AbortSignal.timeout(8000)
  }).catch((e) => ({ status: 0, error: e }));
  assert.notEqual(qwen.status, 404, `千问 ASR 不应 404，got ${qwen.status}`);
});

test('volcTest 未配置时抛错，不请求已死 auth', async () => {
  await assert.rejects(volcTest({ asr: { volc: { appid: '', token: '' } } }), /未配置火山/);
});
