/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeTestDirs, rmTestDirs, authHeaders } from '../helpers/tempdir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PY = path.join(ROOT, 'python/.venv/bin/python');
const { dataDir, modelsDir } = makeTestDirs();

const { saveMeeting, deleteMeeting, getMeeting, ensureDirs } = await import('../../server/services/store/jsonstore.js');
const { UPLOADS_DIR } = await import('../../server/config.js');
const { createServer } = await import('../../server/index.js');

let srv;
let port;
let token;

before(async () => {
  await ensureDirs();
  srv = createServer({ port: 0, host: '127.0.0.1' });
  token = srv.apiToken;
  port = await srv.start();
});

after(async () => {
  if (srv) await srv.stop();
  await rmTestDirs(dataDir, modelsDir);
});

test('删会议时删除 uploads 内 audioRef', async () => {
  await ensureDirs();
  const audio = path.join(UPLOADS_DIR, `clip-${randomUUID()}.wav`);
  await fsp.writeFile(audio, 'xx');
  const id = randomUUID();
  await saveMeeting({
    id, title: '有音频', createdAt: Date.now(), updatedAt: Date.now(),
    status: 'transcribed', audioRef: audio
  });
  await deleteMeeting(id);
  await assert.rejects(() => fsp.access(audio), { code: 'ENOENT' });
});

test('校验失败的上传会 unlink', async () => {
  const { res, data: m } = await json('POST', '/api/meetings', { title: '上传清理' });
  assert.equal(res.status, 200);
  const form = new FormData();
  form.append('audio', new Blob(['not audio'], { type: 'text/plain' }), 'file.txt');
  const up = await fetch(`http://127.0.0.1:${port}/api/meetings/${m.id}/transcribe`, {
    method: 'POST',
    headers: authHeaders(token),
    body: form
  });
  assert.equal(up.status, 400);
  const files = await fsp.readdir(UPLOADS_DIR);
  assert.ok(!files.some((f) => f.endsWith('.txt')), `应删掉非法上传, 仍有: ${files.join(',')}`);
  await json('DELETE', `/api/meetings/${m.id}`);
});

test('转写失败写入 status error', async () => {
  const { data: m } = await json('POST', '/api/meetings', { title: '失败态' });
  const form = new FormData();
  form.append('audio', new Blob(['not a wav'], { type: 'audio/wav' }), 'bad.wav');
  const up = await fetch(`http://127.0.0.1:${port}/api/meetings/${m.id}/transcribe`, {
    method: 'POST',
    headers: authHeaders(token),
    body: form
  });
  assert.equal(up.status, 200);
  let status = m.status;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const { data } = await json('GET', `/api/meetings/${m.id}`);
    status = data.status;
    if (status === 'error') break;
  }
  assert.equal(status, 'error');
  await json('DELETE', `/api/meetings/${m.id}`);
});

test('本地 ASR 透出 FastAPI detail；Vite 绑定 127.0.0.1；纠错开关已拿掉', async () => {
  const local = await fsp.readFile(path.join(ROOT, 'server/services/asr/local.js'), 'utf8');
  assert.match(local, /json\.detail/);
  const vite = await fsp.readFile(path.join(ROOT, 'web/vite.config.js'), 'utf8');
  assert.match(vite, /host:\s*['"]127\.0\.0\.1['"]/);
  const settings = await fsp.readFile(path.join(ROOT, 'web/src/pages/Settings.jsx'), 'utf8');
  assert.doesNotMatch(settings, /错别字纠正/);
  assert.doesNotMatch(settings, /correction\.enabled/);
});

test('Python /transcribe 拒绝 uploads 目录外路径', async () => {
  await fsp.access(PY);
  const script = `
import os, sys
os.environ["MEETING_DATA_DIR"] = sys.argv[1]
from fastapi import HTTPException
import main
try:
    main.transcribe(main.TranscribeReq(file="/etc/passwd"))
    print("no-throw")
except HTTPException as e:
    print(e.status_code)
    print(e.detail)
`;
  const out = await new Promise((resolve, reject) => {
    const child = spawn(PY, ['-c', script, dataDir], {
      cwd: path.join(ROOT, 'python'),
      env: { ...process.env, MEETING_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || stdout || `exit ${code}`));
      else resolve(stdout);
    });
  });
  assert.match(out, /^400/m);
  assert.match(out, /uploads/);
});

async function json(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: authHeaders(token, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}
