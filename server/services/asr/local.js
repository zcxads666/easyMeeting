import { transcodeToPcm } from '../audio/ffmpeg.js';
import { getPythonUrl } from '../python.js';
import { removeTextOverlap } from './dedupe.js';

export const LOCAL_REALTIME_DEFAULTS = Object.freeze({ sampleRate: 16000, bytesPerSample: 2,
  minSeconds: 1.5, targetSeconds: 5, maxSeconds: 9, overlapSeconds: 0.75,
  silenceSeconds: 0.8, silenceRms: 350 });

async function callPython(path, body, { signal } = {}) {
  const timeout = AbortSignal.timeout(120000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`${getPythonUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: combined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.detail || json.error || res.statusText;
    const message = typeof detail === 'string' ? detail : detail.message || JSON.stringify(detail);
    throw Object.assign(new Error(`本地 ASR 失败: ${message}`),
      { code: detail?.code || 'LOCAL_ASR_FAILED', detail });
  }
  return json;
}

export async function localFileTranscribe({ filePath, signal, updateStage }, settings) {
  updateStage?.('transcoding');
  const pcmPath = await transcodeToPcm(filePath, `local_${Date.now()}.pcm`);
  updateStage?.('loading_model');
  const { engine, model, device = 'auto' } = settings.asr.local;
  return callPython('/transcribe', { file: pcmPath, engine, model, device }, { signal });
}

function isTrailingSilence(buffer, config) {
  const bytes = Math.floor(config.silenceSeconds * config.sampleRate * config.bytesPerSample);
  if (buffer.length < bytes) return false;
  const tail = buffer.subarray(buffer.length - bytes);
  let sum = 0;
  for (let offset = 0; offset + 1 < tail.length; offset += 2) { const sample = tail.readInt16LE(offset); sum += sample * sample; }
  return Math.sqrt(sum / Math.max(1, tail.length / 2)) < config.silenceRms;
}

export function localRealtime(settings, options = {}) {
  const config = { ...LOCAL_REALTIME_DEFAULTS, ...(options.config || {}) };
  const transcribe = options.transcribe || ((body) => callPython('/transcribe', body));
  const handlers = new Map();
  const emit = (event, data) => (handlers.get(event) || []).forEach((fn) => fn(data));
  const bytesPerSecond = config.sampleRate * config.bytesPerSample;
  const overlapBytes = Math.floor(config.overlapSeconds * bytesPerSecond);
  let pending = Buffer.alloc(0), pendingStart = 0, totalSamples = 0, processedEnd = 0;
  let state = 'idle', processing = null, lastText = '';

  const api = {
    mode: 'chunked',
    on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
    start() { if (state === 'closed') throw new Error('stream closed'); emit('open', { mode: 'chunked' }); return Promise.resolve(); },
    send(chunk) {
      if (state === 'stopping' || state === 'closed') return false;
      const data = Buffer.from(chunk);
      if (data.length % config.bytesPerSample) throw Object.assign(new Error('PCM chunk 字节数不完整'), { code: 'INVALID_PCM_CHUNK' });
      pending = Buffer.concat([pending, data]); totalSamples += data.length / config.bytesPerSample; pump(false); return true;
    },
    async stop() {
      if (state === 'closed') return;
      state = 'stopping';
      while (processing) await processing;
      await pump(true);
      while (processing) await processing;
      state = 'closed'; emit('close', { mode: 'chunked' });
    },
    close() { if (state !== 'closed') { state = 'closed'; pending = Buffer.alloc(0); emit('close', { mode: 'chunked' }); } },
    snapshot() { return { state, totalSamples, processedEnd, pendingStart, pendingBytes: pending.length }; }
  };
  return api;

  function shouldProcess(force) {
    const duration = pending.length / bytesPerSecond;
    const hasNewAudio = pendingStart + duration > processedEnd + 1e-9;
    return hasNewAudio && (force || duration >= config.maxSeconds || duration >= config.targetSeconds
      || (duration >= config.minSeconds && isTrailingSilence(pending, config)));
  }

  function pump(force) {
    if (processing || state === 'closed' || !shouldProcess(force)) return processing;
    const duration = pending.length / bytesPerSecond;
    const cutSeconds = force ? duration : Math.min(duration, duration >= config.maxSeconds ? config.maxSeconds : config.targetSeconds);
    const cutBytes = Math.min(pending.length, Math.floor(cutSeconds * bytesPerSecond));
    const audio = pending.subarray(0, cutBytes), start = pendingStart, end = start + audio.length / bytesPerSecond;
    const retain = Math.min(overlapBytes, audio.length);
    pending = Buffer.concat([audio.subarray(audio.length - retain), pending.subarray(cutBytes)]);
    pendingStart = end - retain / bytesPerSecond;
    state = state === 'stopping' ? 'stopping' : 'processing';
    processing = runInference(audio, start, end).finally(() => {
      processedEnd = Math.max(processedEnd, end); processing = null;
      if (state !== 'stopping' && state !== 'closed') state = 'idle';
      if (state !== 'closed') pump(state === 'stopping');
    });
    return processing;
  }

  async function runInference(audio, start, end) {
    const { engine, model, device = 'auto' } = settings.asr.local;
    const began = performance.now();
    try {
      const result = await transcribe({ pcm: audio.toString('base64'), engine, model, device,
        audio_start: start, audio_end: end });
      const inferenceDuration = (performance.now() - began) / 1000, audioDuration = end - start;
      const text = removeTextOverlap(lastText, result.text || '');
      if (text) { lastText = result.text || text; emit('final', { text, start, end, speaker: null, confidence: null,
        timing: 'estimated', provider: 'local', model, mode: 'chunked' }); }
      emit('metrics', { latencyMs: inferenceDuration * 1000, audioDuration, inferenceDuration,
        realtimeFactor: inferenceDuration > 0 ? audioDuration / inferenceDuration : null });
    } catch (error) {
      state = 'closed'; pending = Buffer.alloc(0);
      emit('error', { code: error.code || 'LOCAL_INFERENCE_FAILED', message: error.message,
        provider: 'local', model, fatal: true });
      emit('close', { mode: 'chunked' });
      throw error;
    }
  }
}

export async function localTest(settings) {
  const { engine, model } = settings.asr.local;
  const health = await fetch(`${getPythonUrl()}/runtime/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!health || !health.ok) throw new Error('本地推理服务未启动，请运行 npm run setup:python');
  if (!model) throw new Error('未配置本地模型，请前往「模型」页选择');
  const modelsRes = await fetch(`${getPythonUrl()}/models`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  const data = modelsRes?.ok ? await modelsRes.json() : { models: [] };
  const selected = (data.models || []).find((item) => item.id === model);
  if (!selected) throw new Error(`模型不存在: ${model}`);
  if (!selected.installed) throw new Error(`模型未安装: ${model}，请前往「模型」页下载`);
  const runtime = await health.json();
  if (!runtime.dependencies?.ok || !runtime.modelRuntime?.available) throw new Error(`本地运行环境不完整: ${runtime.modelRuntime?.error || '缺少依赖'}`);
  return `本地推理服务正常（${engine}），模型 ${model} 已安装`;
}
