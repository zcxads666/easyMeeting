import { transcodeToPcm, transcodeToWav, toBase64DataUri, mimeFor } from '../audio/ffmpeg.js';
import { PYTHON_SERVE_URL } from '../../config.js';

function normalizeSegments(rawText, baseMs = 0, stepMs = 3000) {
  // 简单切分：按句号/换行切句，为每句分配时间戳
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

/* ---------------- 千问 ---------------- */

// 非实时文件转写：DashScope 异步提交 + 轮询
export async function qwenFileTranscribe({ filePath, fileName }, settings) {
  const { apiKey, model } = settings.asr.qwen;
  if (!apiKey) throw new Error('未配置千问 API Key');

  // 服务端需公网 URL 或本地 file:// 路径；本地路径用 file://
  const fileUrl = `file://${filePath}`;
  const base = 'https://dashscope.aliyuncs.com';

  const submit = await fetch(`${base}/api/v1/services/audio/asr/transcription`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model, input: { file_url: fileUrl }, parameters: { channel_id: [0] } })
  });
  const submitJson = await submit.json();
  if (!submit.ok) throw new Error(`千问提交失败: ${JSON.stringify(submitJson)}`);
  const taskId = submitJson.output?.task_id;
  if (!taskId) throw new Error('千问未返回 task_id');

  // 轮询
  let result;
  for (let i = 0; i < 300; i++) {
    await sleep(3000);
    const q = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const qj = await q.json();
    const status = qj.output?.task_status;
    if (status === 'SUCCEEDED') { result = qj.output; break; }
    if (status === 'FAILED' || status === 'UNKNOWN') throw new Error('千问转写失败');
  }
  if (!result) throw new Error('千问转写超时');

  // 拉取转写结果 URL
  const texts = [];
  const segments = [];
  for (const r of result.results || []) {
    if (r.subtask_status !== 'SUCCEEDED') continue;
    const url = r.transcription_url;
    const resJson = await (await fetch(url)).json();
    for (const t of resJson.transcripts || []) {
      const channelSegs = (t.sentences || []).map((s) => ({
        start: (s.begin_time ?? 0) * 1,
        end: (s.end_time ?? 0) * 1,
        speaker: s.speaker || undefined,
        text: s.text.trim()
      }));
      segments.push(...channelSegs);
      const full = t.text || '';
      if (full) texts.push(full.trim());
    }
  }
  return { segments, text: texts.join('\n') };
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
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
