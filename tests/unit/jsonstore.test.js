import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, SETTINGS_FILE, DEFAULT_SETTINGS } from '../../server/config.js';
import {
  ensureDirs, getMeeting, saveMeeting, deleteMeeting,
  listMeetings, getSettings, saveSettings, writeJson, readJson
} from '../../server/services/store/jsonstore.js';

// 备份原始 data 目录，测试后恢复
let backupDir = null;

before(async () => {
  try {
    await fsp.access(DATA_DIR);
    backupDir = path.join('/tmp', `meeting-data-backup-${Date.now()}`);
    await fsp.cp(DATA_DIR, backupDir, { recursive: true });
    // 清空运行数据，保证测试从干净状态开始
    await fsp.rm(DATA_DIR, { recursive: true, force: true });
  } catch { backupDir = null; }
});

after(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  if (backupDir) {
    await fsp.mkdir(path.dirname(DATA_DIR), { recursive: true });
    await fsp.cp(backupDir, DATA_DIR, { recursive: true });
    await fsp.rm(backupDir, { recursive: true, force: true });
  }
});

test('ensureDirs 创建数据目录', async () => {
  await ensureDirs();
  for (const sub of ['meetings', 'uploads', 'trash']) {
    await fsp.access(path.join(DATA_DIR, sub));
  }
});

test('会议 CRUD 全流程（持久化）', async () => {
  const m = {
    id: randomUUID(),
    title: '单元测试会议',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'realtime',
    segments: [{ start: 0, end: 1000, text: '测试' }],
    rawText: '测试',
    status: 'recording'
  };
  await saveMeeting(m);

  // 重新读取（模拟重启）
  const loaded = await getMeeting(m.id);
  assert.equal(loaded.title, '单元测试会议');
  assert.equal(loaded.segments.length, 1);
  assert.equal(loaded.segments[0].text, '测试');

  // 列表包含
  const list = await listMeetings();
  assert.ok(list.some((x) => x.id === m.id));

  // 更新
  m.status = 'summarized';
  await saveMeeting(m);
  const updated = await getMeeting(m.id);
  assert.equal(updated.status, 'summarized');
  assert.ok(updated.updatedAt >= m.updatedAt);

  // 删除
  await deleteMeeting(m.id);
  assert.equal(await getMeeting(m.id), null);
});

test('置顶排序：pinned 优先', async () => {
  const a = { id: randomUUID(), title: 'A', createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000, status: 'recording' };
  const b = { id: randomUUID(), title: 'B', createdAt: Date.now(), updatedAt: Date.now(), status: 'recording', pinned: true };
  await saveMeeting(a);
  await saveMeeting(b);
  const list = await listMeetings();
  assert.equal(list[0].id, b.id, '置顶会议应排在最前');
  await deleteMeeting(a.id);
  await deleteMeeting(b.id);
});

test('readJson 损坏文件返回 fallback', async () => {
  const f = path.join(DATA_DIR, 'corrupt.json');
  await writeJson(f, { ok: true });
  await fsp.writeFile(f, '{not json', 'utf8');
  const val = await readJson(f, 'fallback');
  assert.equal(val, 'fallback');
  await fsp.rm(f, { force: true });
});

test('设置：默认值与合并', async () => {
  const defaults = await getSettings();
  assert.deepEqual(defaults.llm, DEFAULT_SETTINGS.llm);
  assert.equal(defaults.asr.provider, 'qwen');
  assert.deepEqual(defaults.asr.local, DEFAULT_SETTINGS.asr.local);

  // 部分更新
  const saved = await saveSettings({ llm: { model: 'gpt-test' }, asr: { provider: 'local' } });
  assert.equal(saved.llm.model, 'gpt-test');
  assert.equal(saved.asr.provider, 'local');
  // 未更新字段保留默认
  assert.equal(saved.llm.baseUrl, DEFAULT_SETTINGS.llm.baseUrl);
  assert.equal(saved.asr.local.engine, 'whisper');

  // 重启后持久化（重新读取文件）
  const reloaded = await getSettings();
  assert.equal(reloaded.llm.model, 'gpt-test');
  assert.equal(reloaded.asr.provider, 'local');
});

test('原子写：临时文件不残留', async () => {
  const f = path.join(DATA_DIR, 'atomic.json');
  await writeJson(f, { a: 1 });
  const files = await fsp.readdir(DATA_DIR);
  assert.ok(!files.some((x) => x.includes('.tmp')), '不应残留 .tmp 文件');
  await fsp.rm(f, { force: true });
  assert.equal(await readJson(SETTINGS_FILE, null) !== null, true);
});
