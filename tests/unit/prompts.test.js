import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRECT_SYSTEM, correctUser, SUMMARY_SYSTEM, summaryUser, SPEAKER_SYSTEM, speakerUser
} from '../../server/services/prompts/index.js';

test('纠错提示词：要求保留原意与术语', () => {
  assert.match(CORRECT_SYSTEM, /错别字/);
  assert.match(CORRECT_SYSTEM, /不得改变/);
  assert.match(CORRECT_SYSTEM, /专有名词/);
  assert.equal(correctUser('测试文本'), '测试文本');
});

test('总结提示词：包含完整 JSON schema 字段', () => {
  for (const field of ['title', 'participants', 'topics', 'decisions', 'todos', 'timeline', 'speakers', 'summary']) {
    assert.ok(SUMMARY_SYSTEM.includes(`"${field}"`), `schema 缺少 ${field}`);
  }
  assert.ok(summaryUser('x').includes('x'));
});

test('说话人提示词：输出 [说话人] 格式', () => {
  assert.match(SPEAKER_SYSTEM, /\[说话人/);
  assert.equal(speakerUser('你好'), '你好');
});
