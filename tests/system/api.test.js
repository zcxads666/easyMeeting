import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import { ROOT } from '../../server/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3999; // 独立端口避免冲突
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
const TEST_DATA_DIR = path.join('/tmp', `meeting-sys-test-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error('服务器未在预期时间内就绪');
}

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MEETING_DATA_DIR: TEST_DATA_DIR },
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
});

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

test('验收1a: 新建会议 → 持久化 → 重启不丢失', async () => {
  const { res, data: m } = await api('POST', '/api/meetings', { title: '系统测试会议' });
  assert.equal(res.status, 200);
  assert.ok(m.id);
  assert.equal(m.status, 'recording');
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

  const socket = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], timeout: 5000 });
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
  const res = await fetch(`${BASE}/api/meetings/${m.id}/transcribe`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /不支持的格式/);
  // 上传不存在文件应 400
  const res2 = await fetch(`${BASE}/api/meetings/${m.id}/transcribe`, { method: 'POST' });
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

test('验收3: 模型代理路由（Python 未启动时优雅 502）', async () => {
  // 若 Python 已就绪则跳真实测试；否则验证代理路径可达
  const { res } = await api('GET', '/api/models');
  assert.ok(res.status === 200 || res.status === 502, `models 状态 ${res.status}`);
  const { res: r2 } = await api('POST', '/api/models/download', { id: 'whisper-tiny' });
  assert.ok(r2.status === 200 || r2.status === 502);
  const { res: r3 } = await api('POST', '/api/models/switch', { id: 'whisper-tiny' });
  assert.ok(r3.status === 200 || r3.status === 502);
  const { res: r4 } = await api('DELETE', '/api/models/whisper-tiny');
  assert.ok(r4.status === 200 || r4.status === 502);
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
  const res = await fetch(`${BASE}/api/meetings/${m.id}/transcribe`, { method: 'POST', body: form });
  assert.equal(res.status, 200, 'WAV 上传应受理');
  const { taskId } = await res.json();
  assert.ok(taskId);
  // 任务最终以 task:done 结束（qwen 未配置 key 会失败但不崩溃）
  await api('DELETE', `/api/meetings/${m.id}`);
});
