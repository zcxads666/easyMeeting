import { transcodeToWav, toBase64DataUri, mimeFor } from '../audio/ffmpeg.js';

function normalizeSegments(rawText, baseMs = 0, stepMs = 3000) {
  const sentences = rawText
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let offset = 0;
  return sentences.map((text) => {
    const seg = { start: baseMs + offset, end: baseMs + offset + Math.max(stepMs, text.length * 120), text };
    offset += seg.end - seg.start;
    return seg;
  });
}

export const QWEN_ASR_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const QWEN_FILE_MODEL = 'qwen3-asr-flash';

function fileAsrModel(model) {
  const m = model || QWEN_FILE_MODEL;
  return /filetrans/i.test(m) ? QWEN_FILE_MODEL : m;
}

function extractQwenText(json) {
  const content = json.output?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((c) => c.text || c.transcript || '').join('').trim();
  }
  return (json.output?.text || json.text || '').trim();
}

/* ---------------- 千问 ---------------- */

// 本地文件：DashScope 同步 ASR（qwen3-asr-flash + base64 Data URL），禁止 file://
export async function qwenFileTranscribe({ filePath, fileName }, settings) {
  const { apiKey } = settings.asr.qwen;
  if (!apiKey) throw new Error('未配置千问 API Key');
  const model = fileAsrModel(settings.asr.qwen.model);
  const mime = mimeFor(fileName || filePath);
  let dataUri;
  try {
    dataUri = await toBase64DataUri(filePath, mime === 'application/octet-stream' ? 'audio/wav' : mime);
  } catch (e) {
    const wavPath = await transcodeToWav(filePath, `qwen_${Date.now()}.wav`);
    dataUri = await toBase64DataUri(wavPath, mimeFor('.wav'));
  }

  const res = await fetch(QWEN_ASR_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          { role: 'system', content: [{ text: '' }] },
          { role: 'user', content: [{ audio: dataUri }] }
        ]
      },
      parameters: { asr_options: { enable_itn: true } }
    })
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new Error(`千问鉴权失败: ${json.message || json.code || res.status}`);
  }
  if (!res.ok) {
    throw new Error(`千问转写失败: ${json.message || json.code || JSON.stringify(json) || res.status}`);
  }
  const text = extractQwenText(json);
  if (!text) throw new Error(`千问转写未返回文本: ${JSON.stringify(json).slice(0, 300)}`);
  return { segments: normalizeSegments(text), text };
}

// 实时：DashScope WebSocket duplex
export function qwenRealtime(settings) {
  const { apiKey, model } = settings.asr.qwen;
  if (!apiKey) throw new Error('未配置千问 API Key');
  const url = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
  let ws = null;
  let taskStarted = false;
  const taskId = cryptoRandom();

  const emitMap = new Map();
  const emit = (name, data) => (emitMap.get(name) || []).forEach((fn) => fn(data));

  return {
    on(evt, fn) { emitMap.set(evt, [...(emitMap.get(evt) || []), fn]); },
    async start() {
      try {
      const { default: WebSocket } = await import('ws');
      ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      ws.on('open', () => {
        ws.send(JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters: { sample_rate: 16000, format: 'pcm' }, input: {} }
        }));
        emit('open', {});
      });
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        const event = msg.header?.event;
        if (event === 'task-started') taskStarted = true;
        else if (event === 'result-generated') {
          const text = msg.payload?.output?.sentence?.text;
          if (text) emit('partial', { text });
          if (msg.payload?.output?.sentence?.isSentenceEnd) emit('final', { text });
        } else if (event === 'task-finished') { emit('close', {}); ws?.close(); }
        else if (event === 'task-failed') emit('error', new Error(msg.header?.error_message || '千问任务失败'));
      });
      ws.on('error', (e) => emit('error', e));
      } catch (e) { emit('error', e); }
    },
    send(chunk) {
      if (ws && ws.readyState === 1) {
        ws.send(Buffer.from(chunk));
      }
    },
    async stop() {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
      }
    },
    close() { try { ws?.close(); } catch {} }
  };
}

function cryptoRandom() {
  return (globalThis.crypto?.randomUUID?.() || 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx').replace(/-/g, '').slice(0, 32);
}
/* ---------------- 千问 ---------------- */

// 轻量可用性验证：DashScope OpenAI 兼容模式 models 列表
export async function qwenTest(settings) {
  const { apiKey } = settings.asr.qwen;
  if (!apiKey) throw new Error('未配置千问 API Key');
  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`鉴权失败: ${body.message || body.error?.message || res.statusText || res.status}`);
  }
  return '千问 API Key 有效，模型列表可达';
}
