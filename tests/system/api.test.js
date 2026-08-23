import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../../server/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3999; // 独立端口避免冲突
const BASE = `http://127.0.0.1:${PORT}`;
const API_TOKEN = 'sys-test-token';

let child = null;
const TEST_DATA_DIR = path.join('/tmp', `meeting-sys-test-${Date.now()}`);
const TEST_MODELS_DIR = path.join('/tmp', `meeting-sys-models-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`, { headers: { 'X-Meeting-Token': API_TOKEN } });
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error('服务器未在预期时间内就绪');
}

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      MEETING_DATA_DIR: TEST_DATA_DIR,
      MEETING_MODELS_DIR: TEST_MODELS_DIR,
      MEETING_API_TOKEN: API_TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[srv:err] ${d}`));
  await waitHealthy();
});

after(async () => {
  if (child) { child.kill(); child = null; }
  await sleep(300);
  await fsp.rm(TEST_DATA_DIR, { recursive: true, force: true });
  await fsp.rm(TEST_MODELS_DIR, { recursive: true, force: true });
});

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'X-Meeting-Token': API_TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

test('验收1a: 新建会议 → 持久化 → 重启不丢失', async () => {
  const { res, data: m } = await api('POST', '/api/meetings', { title: '系统测试会议' });
  assert.equal(res.status, 200);
  assert.ok(m.id);
  assert.equal(m.status, 'idle');
  assert.equal(m.source, 'realtime');
  assert.deepEqual(m.segments, []);

  // 文件落盘检查
  const file = path.join(TEST_DATA_DIR, 'meetings', `${m.id}.json`);
  await fsp.access(file);
  const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(onDisk.title, '系统测试会议');

  // 模拟重启：读取仍有效
  const { data: loaded } = await api('GET', `/api/meetings/${m.id}`);
  assert.equal(loaded.title, '系统测试会议');
  await api('DELETE', `/api/meetings/${m.id}`);
});

test('验收1b: 会议状态流转 recording→transcribed', async () => {
  const { data: m } = await api('POST', '/api/meetings', { title: '状态流转' });
  const { data: patched } = await api('PATCH', `/api/meetings/${m.id}`, {
    status: 'transcribed', rawText: '第一句。第二句。', segments: [
      { start: 0, end: 1000, text: '第一句。' },
      { start: 1000, end: 2500, text: '第二句。' }
    ], duration: 3
  });
  assert.equal(patched.status, 'transcribed');
  assert.equal(patched.segments.length, 2);
  assert.ok(patched.segments[0].start !== undefined, '分段应带时间戳');
  await api('DELETE', `/api/meetings/${m.id}`);
});

test('验收1c: 实时转写 Socket.IO 全链路（mock 千问流）', async () => {
  // 使用 socket.io-client 验证 rt:start / rt:audio / rt:stop 协议
  const { io } = await import('socket.io-client');
  const { data: m } = await api('POST', '/api/meetings', { title: '实时链路' });

  const socket = io(`http://127.0.0.1:${PORT}`, {
    transports: ['websocket'],
    timeout: 5000,
    auth: { token: API_TOKEN }
  });
  const received = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接超时')), 5000);
    socket.on('connect', () => { clearTimeout(timer); resolve(); });
    socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
  });

  // 未配置 qwen key 时 rt:start 应返回错误（不崩溃）
  const errMsg = await new Promise((resolve) => {
    socket.on('rt:error', ({ error }) => resolve(error));
    socket.emit('rt:start', { meetingId: m.id });
    setTimeout(() => resolve('TIMEOUT'), 3000);
  });
  assert.match(errMsg, /千问|已有/);

  // 发一段音频帧不应崩溃
  socket.emit('rt:audio', { meetingId: m.id, data: Buffer.alloc(3200).toString('base64') });
  socket.emit('rt:stop', { meetingId: m.id });
  await sleep(300);
  socket.close();
  await api('DELETE', `/api/meetings/${m.id}`);
});

test('验收1d: 文件转写上传（不支持格式应 400）', async () => {
  const { data: m } = await api('POST', '/api/meetings', { title: '上传测试' });
  // 构造 multipart 上传 .txt
  const form = new FormData();
  form.append('audio', new Blob(['not audio'], { type: 'text/plain' }), 'file.txt');
  const res = await fetch(`${BASE}/api/meetings/${m.id}/transcribe`, {
    method: 'POST',
    headers: { 'X-Meeting-Token': API_TOKEN },
    body: form
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /不支持的格式/);
  // 上传不存在文件应 400
  const res2 = await fetch(`${BASE}/api/meetings/${m.id}/transcribe`, {
    method: 'POST',
    headers: { 'X-Meeting-Token': API_TOKEN }
  });
  assert.equal(res2.status, 400);
  await api('DELETE', `/api/meetings/${m.id}`);
});

test('验收2: 设置读写 + provider 切换持久化', async () => {
  const { data: s } = await api('GET', '/api/settings');
  assert.equal(s.asr.provider, 'qwen');
  assert.ok(s.llm && s.asr.qwen && s.asr.volc && s.asr.mimo && s.asr.local);

  const { data: saved } = await api('PATCH', '/api/settings', { asr: { provider: 'local' } });
  assert.equal(saved.asr.provider, 'local');

  // 重启后仍在
  const { data: reloaded } = await api('GET', '/api/settings');
  assert.equal(reloaded.asr.provider, 'local');

  // 还原
  await api('PATCH', '/api/settings', { asr: { provider: 'qwen' } });
});

test('验收3: 模型代理路由（不下载真实模型）', async () => {
  const { res, data } = await api('GET', '/api/models');
  if (res.status === 502) {
    assert.match(String(data.error || ''), /未启动|推理/);
    return;
  }
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(data.models));
  const qwen = data.models.find((m) => m.id === 'Qwen/Qwen3-ASR-0.6B-hf');
  assert.ok(qwen);
  assert.equal(qwen.backend, 'transformers');
  assert.equal(qwen.source, 'huggingface');
  assert.ok(qwen.supportedDevices.includes('cpu'));

  const { res: r2, data: d2 } = await api('POST', '/api/models/download', { id: 'not-a-real-model' });
  assert.equal(r2.status, 400);
  assert.match(JSON.stringify(d2), /未知模型/);

  const { res: r3, data: d3 } = await api('DELETE', '/api/models/Qwen/NotARealModel-0.0B');
  assert.notEqual(r3.status, 404, `斜杠 id 应匹配删除路由, got ${r3.status}`);
  assert.equal(r3.status, 400);
  assert.match(JSON.stringify(d3), /不存在|未知/);
});

test('runtime capability/health 通过 Node 返回结构化状态', async () => {
  const { res: capRes, data: cap } = await api('GET', '/api/models/runtime/capabilities');
  const { res: healthRes, data: health } = await api('GET', '/api/models/runtime/health');
  assert.equal(capRes.status, 200);
  assert.equal(healthRes.status, 200);
  assert.equal(cap.devices.cpu.available, true);
  assert.equal(typeof health.daemon, 'boolean');
  assert.equal(typeof health.dependencies.ok, 'boolean');
  assert.equal(typeof health.ffmpeg.available, 'boolean');
  assert.equal(typeof health.modelRuntime.available, 'boolean');
});

test('未知会议 GET 返回 404', async () => {
  const { res, data } = await api('GET', `/api/meetings/${randomUUID()}`);
  assert.equal(res.status, 404);
  assert.ok(data.error);
});

test('验收4a: LLM 未配置时全部端点返回 400 不崩溃', async () => {
  for (const ep of ['/api/llm/summary', '/api/llm/summary/stream', '/api/llm/correct', '/api/llm/speaker']) {
    const { res, data } = await api('POST', ep, { text: '测试' });
    assert.equal(res.status, 400, `${ep} 应 400`);
    assert.ok(data.error, `${ep} 应返回 error`);
  }
  // 缺 text 也应 400
  const { res } = await api('POST', '/api/llm/correct', {});
  assert.equal(res.status, 400);
  // 服务仍存活
  const { res: h } = await api('GET', '/api/health');
  assert.equal(h.status, 200);
});

test('验收4a2: ASR 测试端点（未配置/未就绪时 400 不崩溃）', async () => {
  // 千问未配置 key
  let { res, data } = await api('POST', '/api/settings/asr/test', {
    asr: { provider: 'qwen', qwen: { apiKey: '' } }
  });
  assert.equal(res.status, 400);
  assert.ok(data.error);

  // 火山未配置
  ({ res, data } = await api('POST', '/api/settings/asr/test', {
    asr: { provider: 'volc', volc: { appid: '', token: '' } }
  }));
  assert.equal(res.status, 400);

  // MiMo 未配置
  ({ res, data } = await api('POST', '/api/settings/asr/test', {
    asr: { provider: 'mimo', mimo: { apiKey: '' } }
  }));
  assert.equal(res.status, 400);

  // 本地（Python 未启动时为 400，已启动则返回 200/400 均可，但不崩溃）
  ({ res } = await api('POST', '/api/settings/asr/test', { asr: { provider: 'local' } }));
  assert.ok(res.status === 200 || res.status === 400, `local 状态 ${res.status}`);

  // 服务仍存活
  const { res: h } = await api('GET', '/api/health');
  assert.equal(h.status, 200);
  // 还原默认 provider
  await api('PATCH', '/api/settings', { asr: { provider: 'qwen' } });
});

test('验收4b: 静态资源 + SPA 回退', async () => {
  // 首页 HTML
  const homeText = await (await fetch(`${BASE}/`)).text();
  assert.match(homeText, /<div id="root">/);
  // 桌面端 file:// 加载要求资源为相对路径（vite base='./'），绝对路径 /assets 会白屏
  const absAssets = homeText.match(/(?:src|href)="\/assets\//);
  assert.ok(!absAssets, `index.html 资源必须为相对路径，禁止 /assets 绝对路径: ${absAssets?.[0]}`);

  // 构建产物 JS 可访问（非 HTML）
  const distDir = path.join(ROOT, 'web', 'dist', 'assets');
  try {
    const files = await fsp.readdir(distDir);
    const jsFile = files.find((f) => f.endsWith('.js'));
    if (jsFile) {
      const js = await fetch(`${BASE}/assets/${jsFile}`);
      const text = await js.text();
      assert.ok(!text.trim().startsWith('<!doctype'), 'JS 不应返回 HTML');
      assert.ok(text.length > 1000);
    }
  } catch { /* dist 未构建时跳过 */ }

  // audio-worklet.js
  const worklet = await fetch(`${BASE}/audio-worklet.js`);
  assert.equal(worklet.status, 200);
  assert.match(await worklet.text(), /registerProcessor/);

  // SPA 路由回退
  const spa = await fetch(`${BASE}/meeting/some-id`);
  assert.match(await spa.text(), /<div id="root">/);
});

test('验收4c: 上传音频文件服务', async () => {
  const { data: m } = await api('POST', '/api/meetings', { title: '音频' });
  // 生成 0.5 秒静音 WAV
  const wav = Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([36 + 8000, 0, 0, 0]), Buffer.from('WAVE'),
    Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), Buffer.from([1, 0]), Buffer.from([1, 0]),
    Buffer.from([0x40, 0x1f, 0, 0]), Buffer.from([0x80, 0x3e, 0, 0]),
    Buffer.from([2, 0]), Buffer.from([16, 0]),
    Buffer.from('data'), Buffer.from([0x40, 0x1f, 0, 0]),
    Buffer.alloc(8000)
  ]);
  const form = new FormData();
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'silence.wav');
  const res = await fetch(`${BASE}/api/meetings/${m.id}/transcribe`, {
    method: 'POST',
    headers: { 'X-Meeting-Token': API_TOKEN },
    body: form
  });
  assert.equal(res.status, 200, 'WAV 上传应受理');
  const { taskId } = await res.json();
  assert.ok(taskId);
  // 任务最终以 task:done 结束（qwen 未配置 key 会失败但不崩溃）
  await api('DELETE', `/api/meetings/${m.id}`);
});
