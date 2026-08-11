import { transcodeToPcm } from '../audio/ffmpeg.js';
import { PYTHON_SERVE_URL } from '../../config.js';

/* 本地 ASR：委托 Python 推理服务 */
async function callPython(path, body) {
  const res = await fetch(`${PYTHON_SERVE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`本地 ASR 失败: ${json.error || res.statusText}`);
  return json;
}

export async function localFileTranscribe({ filePath, fileName }, settings) {
  const pcmPath = await transcodeToPcm(filePath, `local_${Date.now()}.pcm`);
  const { engine, model } = settings.asr.local;
  const json = await callPython('/transcribe', { file: pcmPath, engine, model });
  return { segments: json.segments || [], text: json.text || '' };
}

/* 本地实时：分块推理（简化，滑动窗口） */
export function localRealtime(settings) {
  const emitMap = new Map();
  const emit = (n, d) => (emitMap.get(n) || []).forEach((fn) => fn(d));
  const buffer = [];
  let busy = false;
  const MAX = 5 * 16000 * 2;

  return {
    on(evt, fn) { emitMap.set(evt, [...(emitMap.get(evt) || []), fn]); },
    start() { emit('open', {}); },
    send(chunk) {
      buffer.push(Buffer.from(chunk));
      if (buffer.reduce((s, b) => s + b.length, 0) >= MAX) consume();
    },
    async stop() { await consume(); },
    close() {}
  };

  async function consume() {
    if (busy || !buffer.length) return;
    busy = true;
    const pcm = Buffer.concat(buffer.splice(0, buffer.length));
    try {
      const { engine, model } = settings.asr.local;
      const json = await callPython('/transcribe', { pcm: pcm.toString('base64'), engine, model });
      if (json.text) emit('final', { text: json.text });
    } catch (e) {
      emit('error', e);
    } finally {
      busy = false;
      if (buffer.length) consume();
    }
  }
}