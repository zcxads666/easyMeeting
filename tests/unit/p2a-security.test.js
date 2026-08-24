import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { InMemorySecretStore, EncryptedFileSecretStore, migratePlaintextSecrets, resolveSecretUpdate } from '../../server/services/secrets.js';
import { migrateSettings, validateSettingsPatch } from '../../server/services/settings-schema.js';
import { RuntimeManager } from '../../server/services/runtime-manager.js';
import { isSafeExternalUrl, isAllowedRendererNavigation } from '../../electron/security.js';
import { redactLogContext as redact } from '../../server/services/logger.js';

test('SecretStore save/load/clear 与加密文件不含明文', async () => {
  const memory = new InMemorySecretStore();
  await memory.set('llm.apiKey', 'secret-value');
  assert.equal(await memory.get('llm.apiKey'), 'secret-value');
  await memory.delete('llm.apiKey'); assert.equal(await memory.get('llm.apiKey'), '');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'meeting-secret-'));
  const file = path.join(dir, 'secrets.json');
  const store = new EncryptedFileSecretStore({ file, encrypt: (v) => Buffer.from(v).reverse(), decrypt: (v) => Buffer.from(v).reverse().toString() });
  await store.set('asr.qwen.apiKey', 'never-plaintext');
  assert.equal(await store.get('asr.qwen.apiKey'), 'never-plaintext');
  assert.doesNotMatch(await fsp.readFile(file, 'utf8'), /never-plaintext/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('settings migration 保留旧值并严格验证 patch', () => {
  const migrated = migrateSettings({ llm: { model: 'old-model' }, asr: { local: { engine: 'whisper' } } });
  assert.equal(migrated.schemaVersion, 4); assert.equal(migrated.llm.model, 'old-model'); assert.equal(migrated.asr.local.device, 'auto');
  assert.throws(() => migrateSettings({ schemaVersion: 99 }), /不支持/);
  assert.throws(() => validateSettingsPatch({ asr: { provider: 'evil' } }), /provider/);
  assert.throws(() => validateSettingsPatch(JSON.parse('{"__proto__":{"polluted":true}}')), /未知/);
  assert.throws(() => validateSettingsPatch({ llm: { baseUrl: 'file:///etc/passwd' } }), /http/);
  assert.doesNotThrow(() => validateSettingsPatch({ llm: { temperature: 1.2 }, asr: { local: { device: 'cpu' } } }));
});

test('plaintext secret migration 成功后才清除；失败保留源数据', async () => {
  const source = { schemaVersion: 2, llm: { apiKey: 'legacy-key' }, asr: { qwen: {}, mimo: {}, volc: {} } };
  let persisted = null;
  const migrated = await migratePlaintextSecrets(source, new InMemorySecretStore(), async (value) => { persisted = value; });
  assert.equal(migrated.llm.apiKey, ''); assert.equal(persisted.secretMigrationVersion, 1); assert.equal(source.llm.apiKey, 'legacy-key');
  const failing = { set: async () => { throw new Error('keychain unavailable'); }, get: async () => '' };
  let wrote = false;
  await assert.rejects(migratePlaintextSecrets(source, failing, async () => { wrote = true; }), /keychain/);
  assert.equal(wrote, false); assert.equal(source.llm.apiKey, 'legacy-key');
  assert.equal(resolveSecretUpdate('real-key', '********'), 'real-key');
  assert.equal(resolveSecretUpdate('real-key', ''), '');
});

test('RuntimeManager 安装去重、daemon 验证和失败状态', async () => {
  let installs = 0; let running = false;
  const adapter = { installRuntime: async () => { installs++; await new Promise((r) => setTimeout(r, 15)); },
    inspectRuntime: async () => ({ status: running ? 'running' : 'ready' }), spawnPython: async () => { running = true; return true; }, restartRuntime: async () => true };
  const manager = new RuntimeManager(adapter);
  const [a, b] = await Promise.all([manager.install(), manager.install()]);
  assert.equal(installs, 1); assert.equal(a.status, 'running'); assert.equal(b.status, 'running');
  const bad = new RuntimeManager({ ...adapter, installRuntime: async () => { throw Object.assign(new Error('pip failed'), { code: 'PIP_FAILED' }); } });
  await assert.rejects(bad.install(), /pip failed/); assert.equal(bad.status, 'error'); assert.equal(bad.error.code, 'PIP_FAILED');
});

test('Electron URL allowlist 拒绝危险协议和目录逃逸', () => {
  assert.equal(isSafeExternalUrl('https://example.com/x'), true);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'shell:open']) assert.equal(isSafeExternalUrl(url), false);
  assert.equal(isAllowedRendererNavigation('http://127.0.0.1:3000/settings', { baseUrl: 'http://127.0.0.1:3000' }), true);
  assert.equal(isAllowedRendererNavigation('https://evil.example', { baseUrl: 'http://127.0.0.1:3000' }), false);
  assert.equal(isAllowedRendererNavigation('file:///tmp/dist/index.html', { isDev: false, baseUrl: 'http://127.0.0.1:3000', distRoot: '/tmp/dist' }), true);
  assert.equal(isAllowedRendererNavigation('file:///tmp/other/index.html', { isDev: false, baseUrl: 'http://127.0.0.1:3000', distRoot: '/tmp/dist' }), false);
});

test('Electron 主窗口保持隔离、sandbox 和窄 preload surface', async () => {
  const [main, preload, html] = await Promise.all([
    fsp.readFile(path.resolve('electron/main.js'), 'utf8'), fsp.readFile(path.resolve('electron/preload.cjs'), 'utf8'), fsp.readFile(path.resolve('web/index.html'), 'utf8')
  ]);
  assert.match(main, /contextIsolation:\s*true/); assert.match(main, /nodeIntegration:\s*false/); assert.match(main, /sandbox:\s*true/);
  assert.match(main, /show:\s*false/); assert.match(main, /ready-to-show/); assert.match(main, /createSplashWindow/);
  assert.doesNotMatch(main, /\.spawnPython\(/, '桌面普通启动不得自动拉起 Python Runtime');
  assert.doesNotMatch(preload, /\brequire\(['"](?:fs|child_process)['"]\)/);
  assert.doesNotMatch(preload, /ipcRenderer|shell|webFrame/);
  assert.match(html, /Content-Security-Policy/); assert.doesNotMatch(html, /script-src[^;]*\*/);
  assert.doesNotMatch(html, /frame-ancestors/, 'meta CSP 不支持 frame-ancestors');
});

test('logger redaction 不泄露 credential', () => {
  const value = redact({ Authorization: 'Bearer secret', nested: { apiKey: 'abc', transcript: 'private words' } });
  assert.equal(value.Authorization, '[REDACTED]'); assert.equal(value.nested.apiKey, '[REDACTED]');
  assert.equal(value.nested.transcript, '[REDACTED]'); assert.doesNotMatch(JSON.stringify(value), /Bearer secret|abc|private words/);
});
