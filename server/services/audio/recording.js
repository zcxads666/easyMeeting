import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { UPLOADS_DIR } from '../../config.js';

const SAMPLE_RATE = 16000; const CHANNELS = 1; const BITS = 16;

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22); header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BITS / 8, 28); header.writeUInt16LE(CHANNELS * BITS / 8, 32);
  header.writeUInt16LE(BITS, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  return header;
}

export class RecordingWriter {
  static async create(meetingId) {
    await fsp.mkdir(UPLOADS_DIR, { recursive: true, mode: 0o700 });
    const stem = `realtime_${meetingId}_${Date.now()}_${randomUUID()}`;
    const rawPath = path.join(UPLOADS_DIR, `${stem}.partial.pcm`);
    return new RecordingWriter(rawPath, path.join(UPLOADS_DIR, `${stem}.wav`));
  }
  constructor(rawPath, finalPath) {
    this.rawPath = rawPath; this.finalPath = finalPath; this.bytes = 0; this.finalized = false; this.error = null;
    this.stream = fs.createWriteStream(rawPath, { flags: 'wx', mode: 0o600 });
    this.stream.on('error', (error) => { this.error = error; });
  }
  write(chunk) {
    if (this.finalized) return false;
    if (this.error) throw Object.assign(new Error(`录音写入失败: ${this.error.message}`), { code: 'RECORDING_WRITE_FAILED' });
    const value = Buffer.from(chunk); if (value.length % 2) throw Object.assign(new Error('PCM16 chunk 长度无效'), { code: 'INVALID_PCM_CHUNK' });
    this.bytes += value.length; return this.stream.write(value);
  }
  async finalize() {
    if (this.finalized) return { path: this.finalPath, duration: this.bytes / 2 / SAMPLE_RATE };
    this.finalized = true;
    if (this.error) throw Object.assign(new Error(`录音写入失败: ${this.error.message}`), { code: 'RECORDING_WRITE_FAILED' });
    await new Promise((resolve, reject) => { this.stream.end(resolve); this.stream.once('error', reject); });
    if (this.error) throw Object.assign(new Error(`录音写入失败: ${this.error.message}`), { code: 'RECORDING_WRITE_FAILED' });
    if (!this.bytes) { await fsp.unlink(this.rawPath).catch(() => {}); return { path: null, duration: 0 }; }
    const wavPartial = `${this.finalPath}.partial`;
    try {
      await fsp.writeFile(wavPartial, wavHeader(this.bytes), { flag: 'wx', mode: 0o600 });
      await pipeline(fs.createReadStream(this.rawPath), fs.createWriteStream(wavPartial, { flags: 'a' }));
      await fsp.rename(wavPartial, this.finalPath); await fsp.unlink(this.rawPath);
      return { path: this.finalPath, duration: this.bytes / 2 / SAMPLE_RATE };
    } catch (error) {
      await fsp.unlink(wavPartial).catch(() => {});
      throw Object.assign(new Error(`录音 finalize 失败: ${error.message}`), { code: 'RECORDING_FINALIZE_FAILED' });
    }
  }
}

export async function cleanupPartialRecordings({ olderThanMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const entries = await fsp.readdir(UPLOADS_DIR, { withFileTypes: true }).catch(() => []); let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.includes('.partial')) continue;
    const target = path.join(UPLOADS_DIR, entry.name); const stat = await fsp.stat(target).catch(() => null);
    if (stat && now - stat.mtimeMs > olderThanMs) { await fsp.unlink(target).catch(() => {}); removed++; }
  }
  return removed;
}
