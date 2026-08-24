import os from 'node:os';
import fsp from 'node:fs/promises';
import { DATA_DIR, MODELS_DIR, MEDIA_DIR } from '../config.js';
import { getSettings } from './store/jsonstore.js';
import { getRuntimeHealth, getRuntimeCapabilities } from './python.js';
import { runtimeManager } from './runtime-manager.js';
import { checkFFmpeg } from './audio/ffmpeg.js';
import { secretStorageBackend } from './secrets.js';
import { inspectModelsWithoutRuntime } from './models/catalog.js';
import { resolveRealtimeCapability } from './asr/capabilities.js';

const available = async (directory) => { try { await fsp.access(directory); return true; } catch { return false; } };
export async function diagnosticsSnapshot({ appVersion = 'unknown', authEnabled = true } = {}) {
  const settings = await getSettings();
  const [runtimeState, runtimeHealth, capabilities, ffmpeg, dataAvailable, modelsAvailable, mediaAvailable, models] = await Promise.all([
    runtimeManager.inspect(), getRuntimeHealth(), getRuntimeCapabilities(), checkFFmpeg(), available(DATA_DIR), available(MODELS_DIR), available(MEDIA_DIR), inspectModelsWithoutRuntime()
  ]);
  const runtime = { status: runtimeState.status, python: capabilities?.python || runtimeState.python || null,
    torch: capabilities?.torch || null, transformers: capabilities?.transformers || runtimeHealth.modelRuntime?.version || null,
    fasterWhisper: runtimeHealth.dependencies?.packages?.faster_whisper || false, ffmpeg,
    error: runtimeState.error ? { code: runtimeState.error.code, message: runtimeState.error.message } : null };
  let streaming;
  try { streaming = await resolveRealtimeCapability(settings, capabilities); }
  catch (error) { streaming = { requestedMode: settings.realtime?.mode || 'auto', resolvedMode: 'unavailable',
    reason: error.message, code: error.code || 'REALTIME_CAPABILITY_UNAVAILABLE' }; }
  const byRole = (role) => models.filter((model) => model.role === role)
    .map(({ id, status, backend }) => ({ id, status, backend }));
  return {
    app: { version: appVersion, platform: process.platform, arch: process.arch, node: process.versions.node,
      electron: process.versions.electron || null },
    runtime,
    hardware: { cpu: os.cpus()[0]?.model || os.arch(), logicalCores: os.cpus().length,
      devices: capabilities?.devices || null },
    asr: { provider: settings.asr.provider, engine: settings.asr.local.engine,
      model: settings.asr.local.model, device: settings.asr.local.device },
    alignment: { model: settings.alignment.model, device: settings.alignment.device, language: settings.alignment.language,
      models: byRole('aligner') },
    diarization: { model: settings.diarization.model, device: settings.diarization.device,
      runtimeFeatureAvailable: capabilities?.optionalFeatures?.diarization?.available || false, models: byRole('diarization') },
    streaming,
    postProcessing: { autoAlign: settings.postProcessing.autoAlign, autoDiarize: settings.postProcessing.autoDiarize },
    models: models.map(({ id, role, engine, backend, status, sizeBytes }) => ({ id, role, engine, backend, status, sizeBytes })),
    storage: { dataDirectory: DATA_DIR, modelsDirectory: MODELS_DIR, mediaDirectory: MEDIA_DIR,
      dataDirectoryAvailable: dataAvailable, modelsDirectoryAvailable: modelsAvailable, mediaDirectoryAvailable: mediaAvailable },
    security: { secretStorage: secretStorageBackend(), apiAuthEnabled: authEnabled }
  };
}
