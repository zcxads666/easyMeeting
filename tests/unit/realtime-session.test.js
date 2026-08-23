/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestDirs, rmTestDirs, authHeaders } from '../helpers/tempdir.js';
import { localRealtime } from '../../server/services/asr/local.js';
import { mimoRealtime } from '../../server/services/asr/mimo.js';

const { dataDir, modelsDir } = makeTestDirs();
const { createServer } = await import('../../server/index.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFakeStream() {
  const handlers = {};
  return {
    on(ev, fn) { (handlers[ev] ||= []).push(fn); },
    emit(ev, data) { for (const fn of handlers[ev] || []) fn(data); },
    start() { return Promise.resolve(); },
    send() {},
    async stop() {},
    close() {}
  };
}

let srv;
let port;
let lastStream;

before(async () => {
  srv = createServer({
    port: 0,
    host: '127.0.0.1',
    createRealtimeStream: () => {
      lastStream = makeFakeStream();
      return lastStream;
    }
  });
  port = await srv.start();
});

after(async () => {
  if (srv) await srv.stop();
  await rmTestDirs(dataDir, modelsDir);
});

async function api(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: authHeaders(srv.apiToken, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function connectSocket() {
  const { io } = await import('socket.io-client');
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    timeout: 5000,
    auth: { token: srv.apiToken }
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接超时')), 5000);
    socket.on('connect', () => { clearTimeout(t); resolve(); });
    socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
  return socket;
}

test('两个会议断一个，另一个会话仍在，不可重新 start', async () => {
  const { data: a } = await api('POST', '/api/meetings', { title: 'A' });
  const { data: b } = await api('POST', '/api/meetings', { title: 'B' });
  const s1 = await connectSocket();
  const s2 = await connectSocket();
  s1.emit('rt:start', { meetingId: a.id });
  s2.emit('rt:start', { meetingId: b.id });
  await sleep(80);
  s1.disconnect();
  await sleep(80);

  const err = await new Promise((resolve) => {
    s2.on('rt:error', ({ error }) => resolve(error));
    s2.emit('rt:start', { meetingId: b.id });
    setTimeout(() => resolve('TIMEOUT'), 1500);
  });
  assert.match(err, /已有/);
  s2.disconnect();
  await api('DELETE', `/api/meetings/${a.id}`);
  await api('DELETE', `/api/meetings/${b.id}`);
});

test('stop 后磁盘含未在 stop 前 flush 的 final 段落', async () => {
  const { data: m } = await api('POST', '/api/meetings', { title: 'flush' });
  const socket = await connectSocket();
  socket.emit('rt:start', { meetingId: m.id });
  await sleep(50);
  lastStream.emit('final', { text: '未flush的一句' });
  await sleep(30);
  socket.emit('rt:stop', { meetingId: m.id });
  await sleep(80);
  socket.close();
  const { data: loaded } = await api('GET', `/api/meetings/${m.id}`);
  assert.ok(loaded.segments?.some((s) => s.text === '未flush的一句'), JSON.stringify(loaded.segments));
  assert.match(loaded.rawText || '', /未flush的一句/);
  await api('DELETE', `/api/meetings/${m.id}`);
});

test('实时 PCM 独立持久化为 WAV，stop 在文件和 meeting 保存后才完成', async () => {
  const { data: m } = await api('POST', '/api/meetings', { title: 'recording' });
  const socket = await connectSocket(); socket.emit('rt:start', { meetingId: m.id }); await sleep(50);
  const pcm = Buffer.alloc(3200, 1).toString('base64'); socket.emit('rt:audio', { meetingId: m.id, data: pcm });
  const stopped = new Promise((resolve) => socket.on('rt:status', ({ state }) => state === 'stopped' && resolve()));
  socket.emit('rt:stop', { meetingId: m.id }); await stopped; socket.close();
  const { data: loaded } = await api('GET', `/api/meetings/${m.id}`);
  assert.match(loaded.audioRef, /realtime_.*\.wav$/); assert.equal(loaded.duration, .1);
  const wav = await fsp.readFile(loaded.audioRef); assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  await api('DELETE', `/api/meetings/${m.id}`);
});

test('ASR fatal 后录音继续并安全保存，不因转写故障丢音频', async () => {
  const { data: m } = await api('POST', '/api/meetings', { title: 'asr-crash-recording' });
  const socket = await connectSocket(); socket.emit('rt:start', { meetingId: m.id }); await sleep(50);
  lastStream.emit('error', { code: 'DAEMON_DOWN', message: 'python crashed', fatal: true });
  socket.emit('rt:audio', { meetingId: m.id, data: Buffer.alloc(3200, 7).toString('base64') });
  const stopped = new Promise((resolve) => socket.on('rt:status', ({ state }) => state === 'stopped' && resolve()));
  socket.emit('rt:stop', { meetingId: m.id }); await stopped; socket.close();
  const { data: loaded } = await api('GET', `/api/meetings/${m.id}`);
  assert.equal(loaded.status, 'recorded_with_asr_error'); assert.match(loaded.audioRef, /\.wav$/);
  assert.equal((await fsp.stat(loaded.audioRef)).size, 44 + 3200);
  await api('DELETE', `/api/meetings/${m.id}`);
});

test('local/mimo start().catch 不炸', async () => {
  const local = localRealtime({ asr: { local: { engine: 'whisper', model: 'whisper-tiny' } } });
  await local.start().catch((e) => { throw e; });
  local.close();
  const mimo = mimoRealtime({ asr: { mimo: { apiKey: 'x', model: 'm' } } });
  await mimo.start().catch((e) => { throw e; });
  mimo.close();
});

test('Meeting.jsx cleanup 含 stop 轨道与 rt:stop', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'web/src/pages/Meeting.jsx'), 'utf8');
  assert.match(src, /beforeunload/);
  assert.match(src, /rt:stop/);
  assert.match(src, /getTracks\(\)/);
  assert.match(src, /\.stop\(\)/);
  assert.match(src, /audioCtxRef[\s\S]{0,80}close\(/);
});
