import { transcodeToWav, toBase64DataUri, mimeFor } from '../audio/ffmpeg.js';

/* MiMo：OpenAI 兼容 chat/completions，input_audio base64 */
const BASE = 'https://api.xiaomimimo.com/v1';

async function chatCompletions(settings, { audioDataUri, stream = false, signal }) {
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
    }), signal
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`MiMo 调用失败: ${JSON.stringify(json)}`);
  return json;
}

export async function mimoFileTranscribe({ filePath, fileName, signal, updateStage }, settings) {
  const { apiKey, model } = settings.asr.mimo;
  if (!apiKey) throw new Error('未配置 MiMo API Key');
  if (!model) throw new Error('未配置 MiMo 模型');
  updateStage?.('transcoding');
  const wavPath = await transcodeToWav(filePath, `mimo_${Date.now()}.wav`);
  updateStage?.('transcribing');
  const dataUri = await toBase64DataUri(wavPath, mimeFor('.wav'));
  const json = await chatCompletions(settings, { audioDataUri: dataUri, signal });
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
  let closed = false;

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
      return Promise.resolve();
    },
    async stop() { await flush(); },
    close() { clearInterval(timer); if (!closed) { closed = true; emit('close', {}); } }
  };

  async function flush() {
    if (!buffer.length) return;
    const pcm = Buffer.concat(buffer.splice(0, buffer.length));
    try {
      const wav = pcmToWav(pcm);
      const dataUri = `data:audio/wav;base64,${wav.toString('base64')}`;
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
    .map((t) => ({ start: null, end: null, speaker: null, confidence: null, timing: 'unknown', text: t }));
}

// 将 16kHz 16bit mono PCM Buffer 转为 WAV Buffer
export function pcmToWav(pcm) {
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const numChannels = 1;
  const dataLen = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28);
  header.writeUInt16LE(numChannels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

/* ---------------- MiMo ---------------- */

// 轻量可用性验证：0.1 秒静音 WAV 走真实转写接口，区分鉴权失败与链路问题
export async function mimoTest(settings) {
  const { apiKey, model } = settings.asr.mimo;
  if (!apiKey) throw new Error('未配置 MiMo API Key');
  if (!model) throw new Error('未配置 MiMo 模型');
  const silence = pcmToWav(Buffer.alloc(1600)); // 0.1s @16kHz s16le
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${silence.toString('base64')}` } }] }]
    })
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('MiMo API Key 无效或权限不足');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`调用失败: ${body.error?.message || body.message || res.statusText || res.status}`);
  }
  return 'MiMo API Key 有效，转写接口可达';
}
