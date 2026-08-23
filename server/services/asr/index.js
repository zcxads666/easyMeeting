import { qwenFileTranscribe, qwenRealtime } from './qwen.js';
import { volcFileTranscribe, volcRealtime } from './volc.js';
import { mimoFileTranscribe, mimoRealtime } from './mimo.js';
import { localFileTranscribe, localRealtime } from './local.js';
import { normalizeAsrResult } from './contract.js';
import { localVllmRealtime } from './localVllm.js';

export const PROVIDERS = {
  qwen: { label: '千问', file: qwenFileTranscribe, realtime: qwenRealtime, timestampUnit: 'seconds', realtimeMode: 'true-streaming', realtimeBackend: 'dashscope-websocket', supportsRealtimeTimestamps: false, supportsPartial: true },
  volc: { label: '火山', file: volcFileTranscribe, realtime: volcRealtime, timestampUnit: 'milliseconds', realtimeMode: 'true-streaming', realtimeBackend: 'volc-websocket', supportsRealtimeTimestamps: false, supportsPartial: true },
  mimo: { label: 'MiMo', file: mimoFileTranscribe, realtime: mimoRealtime, timestampUnit: 'seconds', realtimeMode: 'chunked', realtimeBackend: 'mimo-http-windows', supportsRealtimeTimestamps: false, supportsPartial: false },
  local: { label: '本地', file: localFileTranscribe, realtime: localRealtime, timestampUnit: 'seconds', realtimeMode: 'chunked', realtimeBackend: 'transformers/faster-whisper', supportsRealtimeTimestamps: true, supportsPartial: false }
};

export function getProvider(type) {
  const provider = PROVIDERS[type];
  if (!provider) throw new Error(`未知 ASR provider: ${type}`);
  return provider;
}

// 统一文件转写入口：返回 { segments: [{start,end,speaker,text}], text }
export async function transcribeFile(type, params, settings) {
  const provider = getProvider(type);
  const started = performance.now();
  const raw = await provider.file(params, settings);
  const local = settings.asr.local || {};
  const model = type === 'local' ? local.model : settings.asr[type]?.model;
  return normalizeAsrResult(raw, {
    provider: type, model, device: type === 'local' ? local.device || 'auto' : null,
    duration: params.duration, latencyMs: performance.now() - started,
    timestampUnit: provider.timestampUnit
  });
}

// 统一实时流入口：返回 { send(audioChunk), onFinal(cb), onPartial(cb), close() }
export function createRealtimeStream(type, settings, capability = null) {
  const provider = getProvider(type);
  if (type === 'local' && capability?.resolvedMode === 'true-streaming') return localVllmRealtime(settings);
  return provider.realtime(settings);
}
