import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { UPLOADS_DIR } from '../../config.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function resolveTool(envName, packageName, fallback) {
  if (process.env[envName]) return process.env[envName];
  try {
    const value = require(packageName);
    const candidate = typeof value === 'string' ? value : value?.path;
    return candidate ? candidate.replace('app.asar', 'app.asar.unpacked') : fallback;
  } catch { return fallback; }
}

// 支持环境变量覆盖 ffmpeg/ffprobe 路径（发布时指向内置二进制，如 ffmpeg-static）
export const FFMPEG_BIN = resolveTool('FFMPEG_PATH', 'ffmpeg-static', 'ffmpeg');
export const FFPROBE_BIN = resolveTool('FFPROBE_PATH', '@derhuerst/ffprobe-static', 'ffprobe');

export const SUPPORTED_EXT = [
  '.mp3', '.wav', '.ogg', '.webm', '.flac', '.aac', '.m4a', '.amr', '.opus', '.mp4', '.mkv', '.mov'
];

export function isSupported(fileName) {
  return SUPPORTED_EXT.includes(path.extname(fileName).toLowerCase());
}

export async function probe(filePath) {
  const { stdout } = await execFileAsync(FFPROBE_BIN, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  return JSON.parse(stdout);
}

export async function transcodeToPcm(filePath, outName, { durationSeconds = null } = {}) {
  const out = path.join(UPLOADS_DIR, outName);
  const args = [
    '-y', '-i', filePath,
    ...(Number.isFinite(durationSeconds) && durationSeconds > 0 ? ['-t', String(durationSeconds)] : []),
    '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
    '-f', 's16le', out
  ];
  await execFileAsync(FFMPEG_BIN, args);
  return out;
}

export async function transcodeToWav(filePath, outName) {
  const out = path.join(UPLOADS_DIR, outName);
  await execFileAsync(FFMPEG_BIN, [
    '-y', '-i', filePath,
    '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
    out
  ]);
  return out;
}

export async function toBase64DataUri(filePath, mime) {
  const buf = await fsp.readFile(filePath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export function mimeFor(fileName) {
  const map = {
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
    '.m4a': 'audio/mp4', '.webm': 'audio/webm'
  };
  return map[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}
/* ---------- 依赖检测 ---------- */

let _ffmpegOk = null;

export async function checkFFmpeg() {
  if (_ffmpegOk !== null) return _ffmpegOk;
  try {
    await execFileAsync(FFMPEG_BIN, ['-version']);
    _ffmpegOk = true;
  } catch {
    _ffmpegOk = false;
  }
  return _ffmpegOk;
}
