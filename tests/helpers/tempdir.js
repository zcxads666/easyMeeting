/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';

/** 为本测试进程设置独立数据/模型目录。必须在 import config/jsonstore 之前调用。 */
export function makeTestDirs() {
  const dataDir = path.join(os.tmpdir(), `meeting-test-${randomUUID()}`);
  const modelsDir = path.join(os.tmpdir(), `meeting-models-${randomUUID()}`);
  process.env.MEETING_DATA_DIR = dataDir;
  process.env.MEETING_MODELS_DIR = modelsDir;
  return { dataDir, modelsDir };
}

export async function rmTestDirs(...dirs) {
  await Promise.all(dirs.map((d) => fsp.rm(d, { recursive: true, force: true })));
}
