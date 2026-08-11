import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR, MEETINGS_DIR, UPLOADS_DIR, TRASH_DIR, SETTINGS_FILE, DEFAULT_SETTINGS
} from '../../config.js';

export function ensureDirs() {
  for (const dir of [DATA_DIR, MEETINGS_DIR, UPLOADS_DIR, TRASH_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
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
  return readJson(path.join(MEETINGS_DIR, `${id}.json`), null);
}

export async function saveMeeting(meeting) {
  meeting.updatedAt = Date.now();
  await ensureDirs();
  await writeJson(path.join(MEETINGS_DIR, `${meeting.id}.json`), meeting);
  return meeting;
}

export async function deleteMeeting(id) {
  const file = path.join(MEETINGS_DIR, `${id}.json`);
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
  await ensureDirs();
  await writeJson(SETTINGS_FILE, next);
  return next;
}