/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestDirs, rmTestDirs, authHeaders } from '../helpers/tempdir.js';

const { dataDir, modelsDir } = makeTestDirs();

const {
  getMeeting, saveMeeting, deleteMeeting, ensureDirs, writeJson, getSettings
} = await import('../../server/services/store/jsonstore.js');
const { SETTINGS_FILE, MEETINGS_DIR } = await import('../../server/config.js');
const { createServer } = await import('../../server/index.js');

let srv;
let port;
const SECRET = 'sk-path-traversal-secret-do-not-leak';

before(async () => {
  await ensureDirs();
  await writeJson(SETTINGS_FILE, {
    llm: { apiKey: SECRET, baseUrl: '', model: '' },
    asr: { provider: 'qwen' }
  });
  srv = createServer({ port: 0, host: '127.0.0.1' });
  port = await srv.start();
});

after(async () => {
  if (srv) await srv.stop();
  await rmTestDirs(dataDir, modelsDir);
});

function meetingStub(id, extra = {}) {
  return {
    id,
    title: '合法会议',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'transcribed',
    segments: [],
    rawText: '',
    ...extra
  };
}

test('getMeeting 拒绝 ../ 与编码点，不得读到 settings/apiKey', async () => {
  for (const id of ['../settings', '..%2Fsettings', '%2e%2e%2fsettings', '..\\settings']) {
    const got = await getMeeting(id);
    assert.equal(got, null, `getMeeting(${id}) 应拒绝`);
    if (got) assert.notEqual(got.llm?.apiKey, SECRET);
  }
});

test('saveMeeting 拒绝写出目录外', async () => {
  const beforeSettings = await fsp.readFile(SETTINGS_FILE, 'utf8');
  await assert.rejects(
    () => saveMeeting(meetingStub('../settings', { title: 'hack' })),
    /invalid|非法|id/i
  );
  const afterSettings = await fsp.readFile(SETTINGS_FILE, 'utf8');
  assert.equal(afterSettings, beforeSettings);
  const leaked = path.join(dataDir, 'settings.json');
  const parsed = JSON.parse(afterSettings);
  assert.equal(parsed.llm.apiKey, SECRET);
  assert.ok(leaked);
});

test('deleteMeeting 不得删目录外文件', async () => {
  await fsp.access(SETTINGS_FILE);
  await deleteMeeting('../settings');
  await deleteMeeting('%2e%2e%2fsettings');
  await fsp.access(SETTINGS_FILE);
  const settings = await getSettings();
  assert.equal(settings.llm.apiKey, SECRET);
});

test('合法 UUID CRUD 仍通过', async () => {
  const id = randomUUID();
  await saveMeeting(meetingStub(id, { title: 'ok' }));
  const loaded = await getMeeting(id);
  assert.equal(loaded.title, 'ok');
  await deleteMeeting(id);
  assert.equal(await getMeeting(id), null);
  const files = await fsp.readdir(MEETINGS_DIR);
  assert.ok(!files.includes(`${id}.json`));
});

function tokenHeaders(extra = {}) {
  return authHeaders(srv.apiToken, extra);
}

test('GET /api/meetings/..%2Fsettings 不得读到 apiKey', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/meetings/..%2Fsettings`, { headers: tokenHeaders() });
  const body = await res.text();
  assert.ok(res.status === 400 || res.status === 404, `status=${res.status} body=${body.slice(0, 200)}`);
  assert.ok(!body.includes(SECRET), '响应不得包含 settings apiKey');
});

test('GET %2e%2e%2f 同样拒绝', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/meetings/%2e%2e%2fsettings`, { headers: tokenHeaders() });
  const body = await res.text();
  assert.ok(res.status === 400 || res.status === 404, `status=${res.status}`);
  assert.ok(!body.includes(SECRET));
});

test('PATCH body.id 不得改写为目录外路径', async () => {
  const id = randomUUID();
  await saveMeeting(meetingStub(id));
  const res = await fetch(`http://127.0.0.1:${port}/api/meetings/${id}`, {
    method: 'PATCH',
    headers: tokenHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: '../settings', title: 'patched-title' })
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.id, id, 'id 必须保持原 UUID');
  assert.notEqual(data.id, '../settings');
  const settings = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
  assert.equal(settings.llm.apiKey, SECRET);
  assert.notEqual(settings.title, 'patched-title');
  const onDisk = JSON.parse(await fsp.readFile(path.join(MEETINGS_DIR, `${id}.json`), 'utf8'));
  assert.equal(onDisk.id, id);
  assert.equal(onDisk.title, 'patched-title');
  await deleteMeeting(id);
});

test('DELETE 穿越 id 不得删 settings', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/meetings/..%2Fsettings`, {
    method: 'DELETE',
    headers: tokenHeaders()
  });
  await res.json().catch(() => ({}));
  await fsp.access(SETTINGS_FILE);
  const settings = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
  assert.equal(settings.llm.apiKey, SECRET);
});
