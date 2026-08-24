import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSupported, mimeFor, SUPPORTED_EXT, FFMPEG_BIN, FFPROBE_BIN } from '../../server/services/audio/ffmpeg.js';

const execFileAsync = promisify(execFile);

test('离线 FFmpeg 与 FFprobe 二进制可执行', async () => {
  await access(FFMPEG_BIN); await access(FFPROBE_BIN);
  const [ffmpeg, ffprobe] = await Promise.all([
    execFileAsync(FFMPEG_BIN, ['-version']), execFileAsync(FFPROBE_BIN, ['-version'])
  ]);
  assert.match(ffmpeg.stdout, /^ffmpeg version/m); assert.match(ffprobe.stdout, /^ffprobe version/m);
});

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
