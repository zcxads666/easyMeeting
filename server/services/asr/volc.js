import { transcodeToPcm } from '../audio/ffmpeg.js';

/* 火山引擎语音识别：WebSocket 二进制流协议（2-bit 帧） */
// 鉴权：POST 鉴权接口取临时 token，再建立 wss 连接发送首帧(appid, token)

const AUTH_URL = 'https://openspeech.bytedance.com/api/v3/auth';
const WS_URL = 'wss://openspeech.bytedance.com/api/v3/auc/apitranscribe';

function buildHeader(appid, token, cluster) {
  const header = {
    app: { appid, cluster, token: 'access_token' },
    user: { uid: 'meeting-notes' },
  };
  return stringifyHeader(header, token);
}

// 简化：火山首帧需 base64(JSON(前端4字段) + 后端4字段) 并带 token 到 auth 字段
function stringifyHeader(header, token) {
  header.auth = { token };
  return base64Encode(JSON.stringify({
    app: header.app,
    user: header.user,
    audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
    request: { model_name: 'bigmodel', enable_itn: true, show_utterances: true },
    auth: header.auth
  }));
}

function base64Encode(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

async function getAppToken(appid, accessToken) {
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appid, access_token: accessToken })
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`火山鉴权失败: ${json.message}`);
  return json.data?.access_token || json.data?.token;
}

function parseResult(text) {
  // 火山返回 JSON 文本，含 utterances[]
  try {
    const data = JSON.parse(text);
    const segments = (data.result?.utterances || data.utterances || []).map((u) => ({
      start: (u.start_time ?? 0) * 1,
      end: (u.end_time ?? 0) * 1,
      speaker: u.speaker || undefined,
      text: (u.text || '').trim()
    }));
    const fullText = segments.map((s) => s.text).join('\n');
    return { segments, text: fullText || data.result?.text || '' };
  } catch {
    return { segments: [], text };
  }
}

/* ---- 文件转写：通过流式 WS 发送完整音频 ---- */
export async function volcFileTranscribe({ filePath }, settings) {
  const { appid, token, cluster } = settings.asr.volc;
  if (!appid || !token) throw new Error('未配置火山 appid/token');
  const accessToken = await getAppToken(appid, token);
  const pcmPath = await transcodeToPcm(filePath, `volc_${Date.now()}.pcm`);
  const { default: WebSocket } = await import('ws');
  const { readFile } = await import('node:fs/promises');

  const pcm = await readFile(pcmPath);
  const delay = new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer; ${accessToken}` } });
    let headerSent = false;
    let resultText = '';
    ws.on('open', () => {
      ws.send(stringifyHeader({ appid, token, cluster }, accessToken));
      headerSent = true;
    });
    ws.on('error', resolve);
    ws.on('message', (data) => {
      const buf = Buffer.from(data);
      // 简化：按文本/JSON 解析最后一帧
      resultText += buf.toString('utf8');
    });
    ws.on('close', () => resolve(resultText));
    // 发送音频（此处简化：整块发送，真实应分帧）
    const sendAudio = () => {
      if (!headerSent) { setTimeout(sendAudio, 50); return; }
      // 2-bit 帧：0x00 为音频帧
      const frame = Buffer.concat([Buffer.from([0x00]), pcm]);
      // 分块以免超大
      const CHUNK = 64 * 1024;
      let i = 0;
      const timer = setInterval(() => {
        const end = Math.min(i + CHUNK, frame.length);
        ws.send(frame.subarray(i, end));
        i = end;
        if (i >= frame.length) {
          clearInterval(timer);
          ws.send(Buffer.from([0x02])); // 结束帧
          setTimeout(() => ws.close(), 500);
        }
      }, 100);
    };
    sendAudio();
    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(resultText);
    }, 120000); // 兜底
  });
  const text = await delay;
  return normalize(text);
}

function normalize(text) {
  if (typeof text !== 'string') {
    return { segments: [], text: String(text?.message || text || '') };
  }
  // 尝试解析 JSON 帧
  const jsonMatches = text.match(/\{.*\}/g);
  if (jsonMatches) {
    let last = null;
    for (const m of jsonMatches) {
      try { last = JSON.parse(m); } catch {}
    }
    if (last && last.result) {
      const segments = (last.result.utterances || []).map((u) => ({
        start: (u.start_time ?? 0) * 1, end: (u.end_time ?? 0) * 1,
        speaker: u.speaker, text: (u.text || '').trim()
      }));
      return { segments, text: segments.map((s) => s.text).join('\n') };
    }
  }
  return { segments: [], text };
}

/* ---- 实时：WS 二进制流 ---- */
export function volcRealtime(settings) {
  const { appid, token, cluster } = settings.asr.volc;
  if (!appid || !token) throw new Error('未配置火山 appid/token');
  let ws = null, accessToken = '';
  const emitMap = new Map();
  const emit = (n, d) => (emitMap.get(n) || []).forEach((fn) => fn(d));

  return {
    on(evt, fn) { emitMap.set(evt, [...(emitMap.get(evt) || []), fn]); },
    async start() {
      try {
      accessToken = await getAppToken(appid, token);
      const { default: WebSocket } = await import('ws');
      ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer; ${accessToken}` } });
      ws.on('open', () => {
        ws.send(stringifyHeader({ appid, token, cluster }, accessToken));
        emit('open', {});
      });
      ws.on('message', (data) => {
        const buf = Buffer.from(data);
        const text = buf.toString('utf8');
        try {
          const json = JSON.parse(text);
          if (json.result) {
            const segs = (json.result.utterances || []).map((u) => u.text).join('');
            if (segs) emit('partial', { text: segs });
          }
        } catch {}
      });
      ws.on('error', (e) => emit('error', e));
      ws.on('close', () => emit('close', {}));
      } catch (e) { emit('error', e); }
    },
    send(chunk) {
      if (ws && ws.readyState === 1) {
        const frame = Buffer.concat([Buffer.from([0x00]), Buffer.from(chunk)]);
        ws.send(frame);
      }
    },
    async stop() {
      if (ws && ws.readyState === 1) ws.send(Buffer.from([0x02]));
    },
    close() { try { ws?.close(); } catch {} }
  };
}