import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR, MEETINGS_DIR, UPLOADS_DIR, TRASH_DIR, SETTINGS_FILE, DEFAULT_SETTINGS
} from '../../config.js';

export function ensureDirs() {
  for (const dir of [DATA_DIR, MEETINGS_DIR, UPLOADS_DIR, TRASH_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* 非 POSIX 忽略 */ }
  }
}

async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
  try { await fsp.chmod(file, 0o600); } catch { /* 非 POSIX 忽略 */ }
}

export async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(file, data) {
  await atomicWrite(file, data);
}

/* ---------- 会议仓库 ---------- */

const MEETING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMeetingId(id) {
  return typeof id === 'string' && MEETING_ID_RE.test(id);
}

function meetingFile(id) {
  if (!isMeetingId(id)) {
    const err = new Error('invalid meeting id');
    err.code = 'INVALID_MEETING_ID';
    throw err;
  }
  const root = path.resolve(MEETINGS_DIR);
  const file = path.resolve(root, `${id}.json`);
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('invalid meeting id');
    err.code = 'INVALID_MEETING_ID';
    throw err;
  }
  return file;
}

export async function listMeetings() {
  await ensureDirs();
  const files = await fsp.readdir(MEETINGS_DIR).catch(() => []);
  const meetings = await Promise.all(
    files.filter((f) => f.endsWith('.json')).map(async (f) => {
      const m = await readJson(path.join(MEETINGS_DIR, f), null);
      return m && m.status ? m : null;
    })
  );
  return meetings
    .filter(Boolean)
    .sort((a, b) => {
      if ((a.pinned ? 1 : 0) !== (b.pinned ? 1 : 0)) return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

export async function getMeeting(id) {
  try {
    return await readJson(meetingFile(id), null);
  } catch (e) {
    if (e.code === 'INVALID_MEETING_ID') return null;
    throw e;
  }
}

export async function saveMeeting(meeting) {
  const file = meetingFile(meeting?.id);
  meeting.updatedAt = Date.now();
  await ensureDirs();
  await writeJson(file, meeting);
  return meeting;
}

export async function deleteMeeting(id) {
  let file;
  try {
    file = meetingFile(id);
  } catch (e) {
    if (e.code === 'INVALID_MEETING_ID') return;
    throw e;
  }
  try {
    await fsp.unlink(file);
  } catch { /* 不存在忽略 */ }
}

/* ---------- 设置 ---------- */

export async function getSettings() {
  await ensureDirs();
  const saved = await readJson(SETTINGS_FILE, {});
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    llm: { ...DEFAULT_SETTINGS.llm, ...(saved.llm || {}) },
    asr: {
      ...DEFAULT_SETTINGS.asr,
      ...(saved.asr || {}),
      qwen: { ...DEFAULT_SETTINGS.asr.qwen, ...(saved.asr?.qwen || {}) },
      volc: { ...DEFAULT_SETTINGS.asr.volc, ...(saved.asr?.volc || {}) },
      mimo: { ...DEFAULT_SETTINGS.asr.mimo, ...(saved.asr?.mimo || {}) },
      local: { ...DEFAULT_SETTINGS.asr.local, ...(saved.asr?.local || {}) }
    },
    correction: { ...DEFAULT_SETTINGS.correction, ...(saved.correction || {}) },
    ui: { ...DEFAULT_SETTINGS.ui, ...(saved.ui || {}) }
  };
}

function isMaskedSecret(v) {
  return typeof v === 'string' && (/^\*+$/.test(v) || /^•+$/.test(v));
}

function pickSecret(curr, incoming) {
  if (incoming == null || isMaskedSecret(incoming)) return curr || '';
  return incoming;
}

export function redactSettings(s) {
  const clone = structuredClone(s);
  const mask = (v) => (v ? '********' : '');
  if (clone.llm) clone.llm.apiKey = mask(clone.llm.apiKey);
  if (clone.asr?.qwen) clone.asr.qwen.apiKey = mask(clone.asr.qwen.apiKey);
  if (clone.asr?.mimo) clone.asr.mimo.apiKey = mask(clone.asr.mimo.apiKey);
  if (clone.asr?.volc) clone.asr.volc.token = mask(clone.asr.volc.token);
  return clone;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    llm: { ...current.llm, ...(patch.llm || {}) },
    asr: {
      ...current.asr,
      ...(patch.asr || {}),
      qwen: { ...current.asr.qwen, ...(patch.asr?.qwen || {}) },
      volc: { ...current.asr.volc, ...(patch.asr?.volc || {}) },
      mimo: { ...current.asr.mimo, ...(patch.asr?.mimo || {}) },
      local: { ...current.asr.local, ...(patch.asr?.local || {}) }
    },
    correction: { ...current.correction, ...(patch.correction || {}) },
    ui: { ...current.ui, ...(patch.ui || {}) }
  };
  next.llm.apiKey = pickSecret(current.llm.apiKey, patch.llm?.apiKey);
  next.asr.qwen.apiKey = pickSecret(current.asr.qwen.apiKey, patch.asr?.qwen?.apiKey);
  next.asr.mimo.apiKey = pickSecret(current.asr.mimo.apiKey, patch.asr?.mimo?.apiKey);
  next.asr.volc.token = pickSecret(current.asr.volc.token, patch.asr?.volc?.token);
  await ensureDirs();
  await writeJson(SETTINGS_FILE, next);
  return next;
}