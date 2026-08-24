import fsp from 'node:fs/promises';
import path from 'node:path';

export const SECRET_PATHS = ['llm.apiKey', 'asr.qwen.apiKey', 'asr.mimo.apiKey', 'asr.volc.token', 'huggingFace.token'];

export class InMemorySecretStore {
  constructor(initial = {}, backend = 'memory') { this.values = new Map(Object.entries(initial)); this.backend = backend; }
  async get(key) { return this.values.get(key) || ''; }
  async set(key, value) { this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
}

export class EncryptedFileSecretStore {
  constructor({ file, encrypt, decrypt, available = () => true }) {
    this.file = file; this.encrypt = encrypt; this.decrypt = decrypt; this.available = available;
    this.backend = 'electron-safe-storage';
  }
  async _read() {
    try { return JSON.parse(await fsp.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async _write(data) {
    await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); await fsp.rename(tmp, this.file);
  }
  async get(key) {
    const data = await this._read(); if (!data[key]) return '';
    return this.decrypt(Buffer.from(data[key], 'base64'));
  }
  async set(key, value) {
    if (!this.available()) throw new Error('Electron safeStorage 当前不可用');
    const data = await this._read(); data[key] = this.encrypt(String(value)).toString('base64'); await this._write(data);
  }
  async delete(key) { const data = await this._read(); delete data[key]; await this._write(data); }
}

export class EnvironmentSecretStore {
  constructor(env = process.env) { this.env = env; this.backend = 'environment'; }
  async get(key) { return this.env[ENV_SECRET_KEYS[key]] || ''; }
  async set() { throw new Error('环境变量 SecretStore 是只读的'); }
  async delete() { throw new Error('环境变量 SecretStore 是只读的'); }
}

export const ENV_SECRET_KEYS = {
  'llm.apiKey': 'MEETING_LLM_API_KEY', 'asr.qwen.apiKey': 'MEETING_QWEN_API_KEY',
  'asr.mimo.apiKey': 'MEETING_MIMO_API_KEY', 'asr.volc.token': 'MEETING_VOLC_TOKEN',
  'huggingFace.token': 'MEETING_HUGGINGFACE_TOKEN'
};

let configuredStore = null;
export function configureSecretStore(store) { configuredStore = store; }
export function getSecretStore() { return configuredStore; }
export function secretStorageBackend() { return configuredStore?.backend || 'plaintext-settings'; }

export function getPath(object, dotted) { return dotted.split('.').reduce((value, key) => value?.[key], object); }
export function setPath(object, dotted, value) {
  const parts = dotted.split('.'); let target = object;
  for (const key of parts.slice(0, -1)) target = target[key] ||= {};
  target[parts.at(-1)] = value;
}

export function isMaskedSecret(value) { return typeof value === 'string' && (/^\*+$/.test(value) || /^•+$/.test(value)); }
export function resolveSecretUpdate(current, incoming) {
  return incoming == null || isMaskedSecret(incoming) ? (current || '') : incoming;
}

export async function migratePlaintextSecrets(settings, store, persist) {
  const plaintext = SECRET_PATHS.filter((secretPath) => Boolean(getPath(settings, secretPath)));
  if (!plaintext.length) return settings;
  for (const secretPath of plaintext) {
    const value = getPath(settings, secretPath);
    await store.set(secretPath, value);
    if (await store.get(secretPath) !== value) throw new Error(`secret migration verification failed: ${secretPath}`);
  }
  const sanitized = structuredClone(settings);
  for (const secretPath of SECRET_PATHS) setPath(sanitized, secretPath, '');
  sanitized.schemaVersion = 5; sanitized.secretMigrationVersion = 1;
  await persist(sanitized);
  return sanitized;
}
