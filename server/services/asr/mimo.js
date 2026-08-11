import { transcodeToWav, toBase64DataUri, mimeFor } from '../audio/ffmpeg.js';

/* MiMo：OpenAI 兼容 chat/completions，input_audio base64 */
const BASE = 'https://api.xiaomimimo.com/v1';

async function chatCompletions(settings, { audioDataUri, stream = false }) {
  const { apiKey, model } = settings.asr.mimo;
  if (!apiKey) throw new Error('未配置 MiMo API Key');
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: audioDataUri } }] }],
      asr_options: { language: 'auto' }
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`MiMo 调用失败: ${JSON.stringify(json)}`);
  return json;
}

export async function mimoFileTranscribe({ filePath, fileName }, settings) {
  const wavPath = await transcodeToWav(filePath, `mimo_${Date.now()}.wav`);
  const dataUri = await toBase64DataUri(wavPath, mimeFor('.wav'));
  const json = await chatCompletions(settings, { audioDataUri: dataUri });
  const text = (json.choices?.[0]?.message?.content || '').trim();
  return { segments: splitSegments(text), text };
}

export function mimoRealtime(settings) {
  // MiMo 无 WebSocket 实时；用短音频片段周期性调用 chat/completions
  const emitMap = new Map();
  const emit = (n, d) => (emitMap.get(n) || []).forEach((fn) => fn(d));
  const buffer = [];
  const MAX = 8 * 16000 * 2; // 8 秒 pcm
  let timer = null;

  return {
    on(evt, fn) { emitMap.set(evt, [...(emitMap.get(evt) || []), fn]); },
    send(chunk) {
      buffer.push(Buffer.from(chunk));
      let total = buffer.reduce((s, b) => s + b.length, 0);
      if (total >= MAX) flush();
    },
    start() {
      timer = setInterval(() => {
        if (buffer.length) flush();
      }, 5000);
      emit('open', {});
    },
    async stop() { await flush(); },
    close() { clearInterval(timer); }
  };

  async function flush() {
    if (!buffer.length) return;
    const pcm = Buffer.concat(buffer.splice(0, buffer.length));
    try {
      const dataUri = `data:audio/pcm;base64,${pcm.toString('base64')}`;
      const json = await chatCompletions(settings, { audioDataUri: dataUri });
      const text = (json.choices?.[0]?.message?.content || '').trim();
      if (text) emit('final', { text });
    } catch (e) {
      emit('error', e);
    }
  }
}

function splitSegments(text) {
  return text.split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean)
    .map((t) => ({ start: 0, end: 0, text: t }));
}