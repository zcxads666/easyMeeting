import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('诊断日志文件轮转路径可写且导出内容脱敏', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meeting-logs-'));
  const script = `
    const { createLogger, diagnosticLogs } = await import('./server/services/logger.js');
    createLogger('test').error('request Bearer TOKEN_VALUE', {
      apiKey: 'SECRET_TEST_123456', transcript: 'FAKE_TRANSCRIPT_PRIVATE', audioFilename: 'private-audio.wav'
    });
    console.log('RESULT=' + JSON.stringify(await diagnosticLogs()));
  `;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, MEETING_LOG_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe']
    }); let text = ''; child.stdout.on('data', (data) => { text += data; }); child.stderr.on('data', (data) => { text += data; });
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve(text) : reject(new Error(text)));
  });
  const exported = output.slice(output.indexOf('RESULT='));
  assert.doesNotMatch(exported, /SECRET_TEST_123456|TOKEN_VALUE|FAKE_TRANSCRIPT_PRIVATE|private-audio\.wav/);
  assert.match(exported, /REDACTED|AUDIO_FILE/);
  await fsp.rm(dir, { recursive: true, force: true });
});
