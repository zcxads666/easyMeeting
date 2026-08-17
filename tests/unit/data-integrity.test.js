/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { makeTestDirs, rmTestDirs, authHeaders } from '../helpers/tempdir.js';

const { dataDir, modelsDir } = makeTestDirs();
const {
  saveMeeting, getMeeting, deleteMeeting, updateMeeting,
  saveSettings, getSettings, ensureDirs
} = await import('../../server/services/store/jsonstore.js');
const { SETTINGS_FILE } = await import('../../server/config.js');
const { createServer } = await import('../../server/index.js');

let srv;
let port;

before(async () => {
  await ensureDirs();
  srv = createServer({ port: 0, host: '127.0.0.1' });
  port = await srv.start();
});

after(async () => {
  if (srv) await srv.stop();
  await rmTestDirs(dataDir, modelsDir);
});

function stub(id, extra = {}) {
  return {
    id,
    title: 't',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'recording',
    segments: [],
    rawText: '',
    ...extra
  };
}

test('并行写同一会议不 ENOENT', async () => {
  const id = randomUUID();
  await saveMeeting(stub(id));
  await Promise.all(Array.from({ length: 30 }, (_, i) =>
    saveMeeting(stub(id, { title: `并发${i}`, rawText: 'x'.repeat(i + 1) }))
  ));
  const loaded = await getMeeting(id);
  assert.ok(loaded);
  assert.equal(loaded.id, id);
  await deleteMeeting(id);
});

test('转写中途改标题，结束合并后标题仍在', async () => {
  const id = randomUUID();
  await saveMeeting(stub(id, { title: '原标题' }));
  const patched = await getMeeting(id);
  patched.title = '新标题';
  await saveMeeting(patched);
  const saved = await updateMeeting(id, { rawText: '转写正文', status: 'transcribed' });
  assert.equal(saved.title, '新标题');
  assert.equal(saved.rawText, '转写正文');
  assert.equal((await getMeeting(id)).title, '新标题');
  await deleteMeeting(id);
});

test('删除后转写结束不应把会议写回', async () => {
  const id = randomUUID();
  await saveMeeting(stub(id));
  await deleteMeeting(id);
  const saved = await updateMeeting(id, { rawText: 'zombie', status: 'transcribed' });
  assert.equal(saved, null);
  assert.equal(await getMeeting(id), null);
});

test('asr/llm test 失败后 settings 密钥不变', async () => {
  await saveSettings({
    llm: { apiKey: 'sk-keep-llm', baseUrl: 'http://127.0.0.1:9', model: 'x' },
    asr: { qwen: { apiKey: 'sk-keep-asr' } }
  });
  const h = authHeaders(srv.apiToken, { 'Content-Type': 'application/json' });
  const llm = await fetch(`http://127.0.0.1:${port}/api/settings/llm/test`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ llm: { apiKey: 'sk-other-llm', baseUrl: '', model: '' } })
  });
  assert.equal(llm.status, 400);
  const asr = await fetch(`http://127.0.0.1:${port}/api/settings/asr/test`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ asr: { provider: 'qwen', qwen: { apiKey: 'sk-other-asr' } } })
  });
  assert.equal(asr.status, 400);
  const disk = await getSettings();
  assert.equal(disk.llm.apiKey, 'sk-keep-llm');
  assert.equal(disk.asr.qwen.apiKey, 'sk-keep-asr');
});

test('损坏 settings.json 时 GET 5xx 且文件不被默认值覆盖', async () => {
  const broken = '{not json';
  await fsp.writeFile(SETTINGS_FILE, broken, 'utf8');
  const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    headers: authHeaders(srv.apiToken)
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error || '', /损坏/);
  const onDisk = await fsp.readFile(SETTINGS_FILE, 'utf8');
  assert.equal(onDisk, broken);
});
