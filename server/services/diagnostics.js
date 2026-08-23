import os from 'node:os';
import fsp from 'node:fs/promises';
import { DATA_DIR, MODELS_DIR } from '../config.js';
import { getSettings } from './store/jsonstore.js';
import { getRuntimeHealth, getRuntimeCapabilities } from './python.js';
import { runtimeManager } from './runtime-manager.js';
import { checkFFmpeg } from './audio/ffmpeg.js';
import { secretStorageBackend } from './secrets.js';

const available = async (directory) => { try { await fsp.access(directory); return true; } catch { return false; } };
export async function diagnosticsSnapshot({ appVersion = 'unknown', authEnabled = true } = {}) {
  const settings = await getSettings();
  const [runtimeState, runtimeHealth, capabilities, ffmpeg, dataAvailable, modelsAvailable] = await Promise.all([
    runtimeManager.inspect(), getRuntimeHealth(), getRuntimeCapabilities(), checkFFmpeg(), available(DATA_DIR), available(MODELS_DIR)
  ]);
  const runtime = { status: runtimeState.status, python: capabilities?.python || runtimeState.python || null,
    torch: capabilities?.torch || null, transformers: capabilities?.transformers || runtimeHealth.modelRuntime?.version || null,
    fasterWhisper: runtimeHealth.dependencies?.packages?.faster_whisper || false, ffmpeg,
    error: runtimeState.error ? { code: runtimeState.error.code, message: runtimeState.error.message } : null };
  return {
    app: { version: appVersion, platform: process.platform, arch: process.arch, node: process.versions.node,
      electron: process.versions.electron || null },
    runtime,
    hardware: { cpu: os.cpus()[0]?.model || os.arch(), logicalCores: os.cpus().length,
      devices: capabilities?.devices || null },
    asr: { provider: settings.asr.provider, engine: settings.asr.local.engine,
      model: settings.asr.local.model, device: settings.asr.local.device },
    storage: { dataDirectoryAvailable: dataAvailable, modelsDirectoryAvailable: modelsAvailable },
    security: { secretStorage: secretStorageBackend(), apiAuthEnabled: authEnabled }
  };
}
