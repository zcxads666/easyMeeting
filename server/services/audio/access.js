import fsp from 'node:fs/promises';
import path from 'node:path';
import { UPLOADS_DIR } from '../../config.js';

export async function resolveMeetingAudio(meeting) {
  if (!meeting?.audioRef) throw Object.assign(new Error('会议没有可用音频'), { code: 'AUDIO_NOT_FOUND', status: 404 });
  try {
    const [root, audio] = await Promise.all([fsp.realpath(UPLOADS_DIR), fsp.realpath(path.resolve(meeting.audioRef))]);
    const relative = path.relative(root, audio);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw Object.assign(new Error('会议音频路径无效'), { code: 'AUDIO_PATH_INVALID', status: 403 });
    }
    const stat = await fsp.stat(audio);
    if (!stat.isFile()) throw Object.assign(new Error('会议音频不存在'), { code: 'AUDIO_NOT_FOUND', status: 404 });
    return { path: audio, stat };
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('会议音频不存在'), { code: 'AUDIO_NOT_FOUND', status: 404 });
    throw error;
  }
}
