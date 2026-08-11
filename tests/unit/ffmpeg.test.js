import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSupported, mimeFor, SUPPORTED_EXT } from '../../server/services/audio/ffmpeg.js';

test('isSupported 接受多格式', () => {
  for (const ext of ['.mp3', '.wav', '.ogg', '.webm', '.flac', '.aac', '.m4a', '.amr', '.opus', '.mp4', '.mkv', '.mov']) {
    assert.ok(isSupported(`audio${ext}`), `${ext} 应被支持`);
  }
  assert.ok(isSupported('audio.MP3'), '大写扩展名也应支持');
  assert.ok(!isSupported('audio.txt'), 'txt 不支持');
  assert.ok(!isSupported('audio'), '无扩展名不支持');
  assert.ok(!isSupported(''), '空文件名不支持');
});

test('SUPPORTED_EXT 覆盖 REQUIREMENTS.md 列表', () => {
  const required = ['mp3', 'm4a', 'wav', 'ogg', 'webm', 'flac', 'aac'];
  for (const ext of required) {
    assert.ok(SUPPORTED_EXT.includes(`.${ext}`), `缺少 .${ext}`);
  }
});

test('mimeFor 返回正确 MIME', () => {
  assert.equal(mimeFor('a.wav'), 'audio/wav');
  assert.equal(mimeFor('a.mp3'), 'audio/mpeg');
  assert.equal(mimeFor('a.ogg'), 'audio/ogg');
  assert.equal(mimeFor('a.opus'), 'audio/ogg');
  assert.equal(mimeFor('a.flac'), 'audio/flac');
  assert.equal(mimeFor('a.m4a'), 'audio/mp4');
  assert.equal(mimeFor('a.unknown'), 'application/octet-stream');
});
