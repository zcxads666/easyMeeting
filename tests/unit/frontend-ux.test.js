/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('会议 404 显示错误态，切 id 重置 state', async () => {
  const meeting = await fsp.readFile(path.join(ROOT, 'web/src/pages/Meeting.jsx'), 'utf8');
  const summary = await fsp.readFile(path.join(ROOT, 'web/src/pages/Summary.jsx'), 'utf8');
  for (const [name, src] of [['Meeting', meeting], ['Summary', summary]]) {
    assert.match(src, /setMeeting\(null\)/, `${name} 切 id 应重置 meeting`);
    assert.match(src, /!meeting && error/, `${name} 404 应走错误态而非永远加载中`);
    assert.match(src, /会议不存在/, `${name} 应提示会议不存在`);
  }
});

test('删除会议需要 confirm', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'web/src/pages/Home.jsx'), 'utf8');
  assert.match(src, /confirm\(['"]确定删除该会议/);
});

test('标题 blur 再 PATCH，输入过程不立刻请求', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'web/src/pages/Meeting.jsx'), 'utf8');
  assert.match(src, /onBlur=\{\(e\) => \{\s*api\(`\/meetings\/\$\{id\}`, \{ method: 'PATCH', body: \{ title:/);
  assert.doesNotMatch(src, /onChange=\{\(e\) => \{\s*setMeeting[\s\S]{0,80}api\(/);
});

test('jsonstore/api 测试隔离临时目录，不下载用户 whisper-tiny', async () => {
  const jsonstore = await fsp.readFile(path.join(ROOT, 'tests/unit/jsonstore.test.js'), 'utf8');
  const api = await fsp.readFile(path.join(ROOT, 'tests/system/api.test.js'), 'utf8');
  assert.match(jsonstore, /makeTestDirs/);
  assert.doesNotMatch(jsonstore, /backupDir/);
  assert.doesNotMatch(jsonstore, /fsp\.rm\(DATA_DIR/);
  assert.match(api, /MEETING_MODELS_DIR/);
  assert.doesNotMatch(api, /whisper-tiny/);
});
