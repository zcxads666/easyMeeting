const PROVIDERS = new Set(['qwen', 'volc', 'mimo', 'local']);
const DEVICES = new Set(['auto', 'cpu', 'cuda', 'mps']);
const ENGINES = new Set(['whisper', 'qwen']);
const ALLOWED = {
  '': new Set(['schemaVersion', 'secretMigrationVersion', 'llm', 'asr', 'correction', 'ui']),
  llm: new Set(['baseUrl', 'apiKey', 'model', 'temperature']),
  asr: new Set(['provider', 'qwen', 'volc', 'mimo', 'local']),
  'asr.qwen': new Set(['apiKey', 'model']), 'asr.volc': new Set(['appid', 'token', 'cluster']),
  'asr.mimo': new Set(['apiKey', 'model']), 'asr.local': new Set(['engine', 'model', 'device', 'computeType']),
  correction: new Set(['enabled']), ui: new Set(['theme'])
};

function fail(message) { const error = new Error(message); error.code = 'INVALID_SETTINGS'; throw error; }
function validateObject(value, path = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path || 'settings'} 必须是对象`);
  const allowed = ALLOWED[path];
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !allowed?.has(key)) fail(`未知设置字段: ${path ? `${path}.` : ''}${key}`);
    const child = path ? `${path}.${key}` : key;
    if (ALLOWED[child]) validateObject(value[key], child);
  }
}
const shortString = (value, name, max = 256) => { if (typeof value !== 'string' || value.length > max) fail(`${name} 必须是长度不超过 ${max} 的字符串`); };

export function validateSettingsPatch(patch) {
  validateObject(patch);
  if (patch.llm?.baseUrl != null) {
    shortString(patch.llm.baseUrl, 'llm.baseUrl', 2048);
    if (patch.llm.baseUrl) { let url; try { url = new URL(patch.llm.baseUrl); } catch { fail('llm.baseUrl 必须是有效 URL'); }
      if (!['http:', 'https:'].includes(url.protocol)) fail('llm.baseUrl 只允许 http/https'); }
  }
  if (patch.llm?.model != null) shortString(patch.llm.model, 'llm.model');
  if (patch.llm?.temperature != null && (!Number.isFinite(patch.llm.temperature) || patch.llm.temperature < 0 || patch.llm.temperature > 2)) fail('llm.temperature 必须在 0 到 2 之间');
  if (patch.asr?.provider != null && !PROVIDERS.has(patch.asr.provider)) fail('无效的 asr.provider');
  if (patch.asr?.local?.engine != null && !ENGINES.has(patch.asr.local.engine)) fail('无效的 asr.local.engine');
  if (patch.asr?.local?.device != null && !DEVICES.has(patch.asr.local.device)) fail('无效的 asr.local.device');
  if (patch.asr?.local?.model != null) shortString(patch.asr.local.model, 'asr.local.model');
  if (patch.ui?.theme != null && !['light', 'dark'].includes(patch.ui.theme)) fail('无效的 ui.theme');
  if (patch.correction?.enabled != null && typeof patch.correction.enabled !== 'boolean') fail('correction.enabled 必须是 boolean');
  for (const path of ['llm.apiKey', 'asr.qwen.apiKey', 'asr.mimo.apiKey', 'asr.volc.token']) {
    const value = path.split('.').reduce((target, key) => target?.[key], patch); if (value != null) shortString(value, path, 4096);
  }
  return patch;
}

export function migrateSettings(input) {
  const settings = structuredClone(input || {}); let version = Number(settings.schemaVersion) || 1;
  if (version > 3) fail(`不支持的 settings schemaVersion: ${version}`);
  if (version < 2) { settings.asr ||= {}; settings.asr.local ||= {}; settings.asr.local.device ||= 'auto'; version = 2; }
  if (version < 3) version = 3;
  settings.schemaVersion = version;
  return settings;
}
