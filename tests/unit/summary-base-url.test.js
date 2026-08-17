/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Summary.jsx 流式纪要 fetch 必须拼 BASE_URL，禁止相对路径', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'web/src/pages/Summary.jsx'), 'utf8');
  assert.match(src, /from ['"]\.\.\/env['"]/, '应 import BASE_URL');
  assert.match(src, /fetch\(`\$\{BASE_URL\}\/api\/llm\/summary\/stream`/, 'fetch 第一参数须拼 BASE_URL');
  assert.doesNotMatch(src, /fetch\(\s*['"`]\/api\/llm\/summary\/stream/, '不得用相对路径 /api/llm/summary/stream');
});
