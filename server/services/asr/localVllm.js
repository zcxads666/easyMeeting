import { getPythonUrl } from '../python.js';

async function request(path, body, timeoutMs = 120000) {
  const response = await fetch(`${getPythonUrl()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) { const detail = value.detail || value; throw Object.assign(new Error(detail.message || 'vLLM streaming 请求失败'), { code: detail.code || 'TRUE_STREAMING_FAILED' }); }
  return value;
}

export function localVllmRealtime(settings, options = {}) {
  const call = options.request || request; const handlers = new Map();
  const emit = (name, value) => (handlers.get(name) || []).forEach((handler) => handler(value));
  const model = settings.asr.local.model; let sessionId = null; let queue = Promise.resolve(); let closed = false; let failure = null;
  const pending = [];
  const startedAt = performance.now(); let firstPartialAt = null; let audioBytes = 0; let lastText = '';
  const enqueue = (pcm) => {
    queue = queue.then(async () => {
      if (failure || closed) return;
      const result = await call('/streaming/send', { session_id: sessionId, pcm: pcm.toString('base64') });
      if (result.changed && result.text && result.text !== lastText) {
        lastText = result.text; firstPartialAt ??= performance.now();
        emit('partial', { text: result.text, provider: 'local', model, mode: 'true-streaming' });
      }
    }).catch((error) => {
      failure = error;
      emit('error', { code: error.code || 'TRUE_STREAMING_FAILED', message: error.message,
        provider: 'local', model, fatal: true });
    });
  };
  return {
    mode: 'true-streaming',
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    async start() {
      const result = await call('/streaming/start', { model }); sessionId = result.sessionId;
      for (const pcm of pending.splice(0)) enqueue(pcm);
      emit('open', { mode: 'true-streaming', backend: 'qwen-asr-vllm' });
    },
    send(chunk) {
      if (closed || failure) return false;
      const pcm = Buffer.from(chunk); audioBytes += pcm.length;
      if (!sessionId) pending.push(pcm); else enqueue(pcm);
      return true;
    },
    async stop() {
      if (closed) return;
      if (!sessionId) throw Object.assign(new Error('true-streaming 会话尚未启动'), { code: 'TRUE_STREAMING_NOT_STARTED' });
      for (const pcm of pending.splice(0)) enqueue(pcm);
      await queue; closed = true;
      if (failure) throw failure;
      const result = await call('/streaming/stop', { session_id: sessionId }, 300000);
      const finalLatencyMs = performance.now() - startedAt; const audioDuration = audioBytes / 2 / 16000;
      if (result.text) emit('final', { text: result.text, start: null, end: null, speaker: null, confidence: null,
        timing: 'unknown', provider: 'local', model, mode: 'true-streaming' });
      emit('metrics', { firstPartialLatencyMs: firstPartialAt == null ? null : firstPartialAt - startedAt,
        finalLatencyMs, audioDuration, inferenceDuration: null, latencyMs: finalLatencyMs, realtimeFactor: null });
      emit('close', { mode: 'true-streaming' });
    },
    close() { closed = true; }
  };
}
