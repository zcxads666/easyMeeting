import { qwenFileTranscribe, qwenRealtime } from './qwen.js';
import { volcFileTranscribe, volcRealtime } from './volc.js';
import { mimoFileTranscribe, mimoRealtime } from './mimo.js';
import { localFileTranscribe, localRealtime } from './local.js';

export const PROVIDERS = {
  qwen: { label: '千问', file: qwenFileTranscribe, realtime: qwenRealtime },
  volc: { label: '火山', file: volcFileTranscribe, realtime: volcRealtime },
  mimo: { label: 'MiMo', file: mimoFileTranscribe, realtime: mimoRealtime },
  local: { label: '本地', file: localFileTranscribe, realtime: localRealtime }
};

export function getProvider(type) {
  return PROVIDERS[type] || PROVIDERS.qwen;
}

// 统一文件转写入口：返回 { segments: [{start,end,speaker,text}], text }
export async function transcribeFile(type, params, settings) {
  const provider = getProvider(type);
  return provider.file(params, settings);
}

// 统一实时流入口：返回 { send(audioChunk), onFinal(cb), onPartial(cb), close() }
export function createRealtimeStream(type, settings) {
  const provider = getProvider(type);
  return provider.realtime(settings);
}