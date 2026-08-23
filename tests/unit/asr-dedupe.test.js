import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeTextOverlap } from '../../server/services/asr/dedupe.js';

test('中文 overlap', () => assert.equal(removeTextOverlap('今天我们讨论项目进度', '项目进度然后下周上线'), '然后下周上线'));
test('英文 overlap 忽略大小写', () => assert.equal(removeTextOverlap('we discuss project progress', 'Project progress and launch'), 'and launch'));
test('标点差异不影响 overlap', () => assert.equal(removeTextOverlap('今天讨论：项目进度。', '项目进度，然后上线'), '然后上线'));
test('无 overlap 保留全文', () => assert.equal(removeTextOverlap('第一句', '完全不同'), '完全不同'));
test('短 utterance 不过度删除', () => assert.equal(removeTextOverlap('好', '好的'), '好的'));
test('重复口头词保守去除窗口重复', () => assert.equal(removeTextOverlap('然后然后我们开始', '我们开始讨论'), '讨论'));
