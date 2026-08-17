/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTestDirs, rmTestDirs, authHeaders } from '../helpers/tempdir.js';

const { dataDir, modelsDir } = makeTestDirs();
const { createServer } = await import('../../server/index.js');
const { saveSettings } = await import('../../server/services/store/jsonstore.js');
const { SETTINGS_FILE, DATA_DIR } = await import('../../server/config.js');

let srv;
let port;
let token;

before(async () => {
  srv = createServer({ port: 0, host: '127.0.0.1' });
  token = srv.apiToken;
  port = await srv.start();
});

after(async () => {
  if (srv) await srv.stop();
  await rmTestDirs(dataDir, modelsDir);
});

function url(p) { return `http://127.0.0.1:${port}${p}`; }

test('无令牌访问 API 应 401', async () => {
  const res = await fetch(url('/api/meetings'));
  assert.equal(res.status, 401);
});

test('有令牌访问 API 应通', async () => {
  const res = await fetch(url('/api/health'), { headers: authHeaders(token) });
  assert.equal(res.status, 200);
});

test('GET /api/settings 不返回完整 apiKey', async () => {
  await saveSettings({ llm: { apiKey: 'sk-real-secret-key-value' } });
  const res = await fetch(url('/api/settings'), { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.notEqual(data.llm.apiKey, 'sk-real-secret-key-value');
  assert.ok(!JSON.stringify(data).includes('sk-real-secret-key-value'));
  assert.equal(data.llm.apiKey, '********');
});

test('CORS 对随意第三方 origin 仍 403', async () => {
  const res = await fetch(url('/api/health'), {
    headers: { ...authHeaders(token), Origin: 'https://evil.example' }
  });
  assert.equal(res.status, 403);
});

test('settings 文件 0600、数据目录 0700', async () => {
  await saveSettings({ ui: { theme: 'dark' } });
  const fileMode = fs.statSync(SETTINGS_FILE).mode & 0o777;
  const dirMode = fs.statSync(DATA_DIR).mode & 0o777;
  assert.equal(fileMode, 0o600);
  assert.equal(dirMode, 0o700);
});
