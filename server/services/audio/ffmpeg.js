import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPLOADS_DIR } from '../../config.js';

const execFileAsync = promisify(execFile);

// 支持环境变量覆盖 ffmpeg/ffprobe 路径（发布时指向内置二进制，如 ffmpeg-static）
export const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

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

export async function transcodeToPcm(filePath, outName) {
  const out = path.join(UPLOADS_DIR, outName);
  await execFileAsync(FFMPEG_BIN, [
    '-y', '-i', filePath,
    '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
    '-f', 's16le', out
  ]);
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
