import { getRuntimeCapabilities } from '../python.js';

const CLOUD = {
  qwen: { realtimeMode: 'true-streaming', realtimeBackend: 'dashscope-websocket', supportsRealtimeTimestamps: false, supportsPartial: true },
  volc: { realtimeMode: 'true-streaming', realtimeBackend: 'volc-websocket', supportsRealtimeTimestamps: false, supportsPartial: true },
  mimo: { realtimeMode: 'chunked', realtimeBackend: 'mimo-http-windows', supportsRealtimeTimestamps: false, supportsPartial: false }
};

function unavailable(message, capability) {
  return Object.assign(new Error(message), { code: 'TRUE_STREAMING_UNAVAILABLE', capability });
}

export async function resolveRealtimeCapability(settings, runtimeCapabilities = undefined) {
  const provider = settings.asr.provider;
  if (provider !== 'local') return { provider, requestedMode: 'provider-native', resolvedMode: CLOUD[provider]?.realtimeMode || 'none',
    reason: null, ...CLOUD[provider] };
  const requestedMode = settings.realtime?.mode || 'auto';
  const engine = settings.asr.local?.engine;
  const chunked = { provider: 'local', requestedMode, resolvedMode: 'chunked', realtimeMode: 'chunked',
    realtimeBackend: engine === 'whisper' ? 'faster-whisper' : 'transformers', supportsRealtimeTimestamps: true,
    supportsPartial: false };
  if (requestedMode === 'chunked') return { ...chunked, reason: '用户选择 chunked near-realtime' };
  if (engine !== 'qwen') {
    const reason = 'Whisper faster-whisper backend 不支持 true streaming';
    if (requestedMode === 'true-streaming') throw unavailable(reason, chunked);
    return { ...chunked, reason };
  }
  const capabilities = runtimeCapabilities === undefined ? await getRuntimeCapabilities() : runtimeCapabilities;
  const streaming = capabilities?.streaming;
  if (streaming?.available) return { provider: 'local', requestedMode, resolvedMode: 'true-streaming', realtimeMode: 'true-streaming',
    realtimeBackend: 'qwen-asr-vllm', supportsRealtimeTimestamps: false, supportsPartial: true, reason: null };
  const reason = streaming?.reason || 'qwen-asr vLLM optional Runtime 不可用';
  if (requestedMode === 'true-streaming') throw unavailable(reason, streaming);
  return { ...chunked, reason };
}
