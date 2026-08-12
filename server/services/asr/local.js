import { transcodeToPcm } from '../audio/ffmpeg.js';
import { getPythonUrl } from '../python.js';

/* 本地 ASR：委托 Python 推理服务 */
async function callPython(path, body) {
  const res = await fetch(`${getPythonUrl()}${path}`, {
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
/* ---------------- 本地 ---------------- */

// 轻量可用性验证：推理服务健康 + 当前模型已安装
export async function localTest(settings) {
  const { engine, model } = settings.asr.local;
  const health = await fetch(`${getPythonUrl()}/health`).catch(() => null);
  if (!health || !health.ok) throw new Error('本地推理服务未启动，请运行 npm run setup:python');
  if (!model) throw new Error('未配置本地模型，请前往「模型」页选择');
  const modelsRes = await fetch(`${getPythonUrl()}/models`).catch(() => null);
  const data = modelsRes?.ok ? await modelsRes.json() : { models: [] };
  const m = (data.models || []).find((x) => x.id === model);
  if (!m) throw new Error(`模型不存在: ${model}`);
  if (!m.installed) throw new Error(`模型未安装: ${model}，请前往「模型」页下载`);
  return `本地推理服务正常（${engine}），模型 ${model} 已安装`;
}
