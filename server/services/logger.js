import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LOGS_DIR } from '../config.js';

const PRIVATE_KEY = /(authorization|api[-_ ]?key|token|secret|password|transcript|rawtext|corrected|audio(?:ref|data|binary|filename)?)/i;
const MAX_BYTES = 2 * 1024 * 1024;
const ROTATIONS = 3;
function sanitize(value, key = '') {
  if (PRIVATE_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  return value;
}
export function redactLogText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(api[-_ ]?key|access[-_ ]?token|authorization)\s*[:=]\s*[^\s,;}]+/gi, '$1=[REDACTED]')
    .replace(/SECRET_TEST_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(?:[^\s/\\]+\.(?:wav|mp3|m4a|flac|ogg|opus|webm|aac))/gi, '[AUDIO_FILE]');
}
function logFile(index = 0) { return path.join(LOGS_DIR, index ? `app.${index}.log` : 'app.log'); }
function rotate() {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(logFile()) || fs.statSync(logFile()).size < MAX_BYTES) return;
    try { fs.rmSync(logFile(ROTATIONS), { force: true }); } catch { /* optional */ }
    for (let index = ROTATIONS - 1; index >= 0; index--) {
      const from = logFile(index), to = logFile(index + 1);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  } catch (error) { console.warn('[logger] rotation failed:', error.message); }
}
function append(level, component, message, context) {
  const record = { timestamp: new Date().toISOString(), level, component, message: redactLogText(message),
    ...(context === undefined ? {} : { context: sanitize(context) }) };
  try { rotate(); fs.appendFileSync(logFile(), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 }); }
  catch (error) { console.warn('[logger] file write failed:', error.message); }
}
export function createLogger(component) {
  const write = (level, message, context) => {
    console[level === 'debug' ? 'debug' : level](`[${component}] ${message}`, context ? sanitize(context) : '');
    append(level, component, message, context);
  };
  return { debug: (m, c) => write('debug', m, c), info: (m, c) => write('info', m, c),
    warn: (m, c) => write('warn', m, c), error: (m, c) => write('error', m, c) };
}
export async function diagnosticLogs() {
  const result = [];
  for (let index = 0; index <= ROTATIONS; index++) {
    try { result.push({ name: path.basename(logFile(index)), content: redactLogText(await fsp.readFile(logFile(index), 'utf8')) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
export { sanitize as redactLogContext, MAX_BYTES as LOG_MAX_BYTES, ROTATIONS as LOG_ROTATIONS };
