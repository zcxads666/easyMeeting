import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/** 现行：录音文件极速识别 HTTP（官方 2026 文档） */
export const VOLC_FLASH_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
/** 现行：大模型流式识别 WebSocket */
export const VOLC_SAUC_WS = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

function volcHeaders(appid, token, resourceId) {
  return {
    'X-Api-App-Key': String(appid),
    'X-Api-Access-Key': String(token),
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Sequence': '-1'
  };
}

function silenceWav() {
  return Buffer.concat([
    Buffer.from('RIFF'), Buffer.from([36 + 1600, 0, 0, 0]), Buffer.from('WAVE'),
    Buffer.from('fmt '), Buffer.from([16, 0, 0, 0]), Buffer.from([1, 0]), Buffer.from([1, 0]),
    Buffer.from([0x40, 0x1f, 0, 0]), Buffer.from([0x80, 0x3e, 0, 0]),
    Buffer.from([2, 0]), Buffer.from([16, 0]),
    Buffer.from('data'), Buffer.from([0x40, 0x06, 0, 0]),
    Buffer.alloc(1600)
  ]);
}

export async function volcFileTranscribe({ filePath, signal }, settings) {
  const { appid, token } = settings.asr.volc;
  if (!appid || !token) throw new Error('未配置火山 appid/token');
  const raw = await fsp.readFile(filePath);
  const res = await fetch(VOLC_FLASH_URL, {
    method: 'POST',
    headers: {
      ...volcHeaders(appid, token, 'volc.bigasr.auc_turbo'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      user: { uid: String(appid) },
      audio: { data: raw.toString('base64') },
      request: { model_name: 'bigmodel', enable_itn: true, show_utterances: true }
    }), signal
  });
  return parseFlashResult(res);
}

async function parseFlashResult(res) {
  const json = await res.json().catch(() => ({}));
  const code = res.headers.get?.('X-Api-Status-Code') || '';
  const msg = res.headers.get?.('X-Api-Message') || json.message || json.error || '';
  if (res.status === 401 || res.status === 403) {
    throw new Error(`火山鉴权失败: ${res.status} ${msg}`.trim());
  }
  if (res.status === 404) throw new Error('火山 ASR 端点不可用（404）');
  if (!res.ok) throw new Error(`火山转写失败: HTTP ${res.status} ${msg || JSON.stringify(json)}`);
  if (code && code !== '20000000' && code !== '20000003') {
    throw new Error(`火山转写失败: ${code} ${msg}`);
  }
  const text = json.result?.text || '';
  const segments = (json.result?.utterances || []).map((u) => ({
    start: u.start_time ?? 0,
    end: u.end_time ?? 0,
    speaker: u.speaker,
    text: (u.text || '').trim()
  })).filter((s) => s.text);
  if (!text && !segments.length && code !== '20000003') {
    throw new Error(`火山转写失败: 空结果 ${msg || JSON.stringify(json)}`);
  }
  return { segments, text: text || segments.map((s) => s.text).join('\n') };
}

function buildWsHeader(messageType, flags, serialization, compression) {
  const buf = Buffer.alloc(4);
  buf[0] = 0x11;
  buf[1] = (messageType << 4) | flags;
  buf[2] = (serialization << 4) | compression;
  buf[3] = 0;
  return buf;
}

async function packJsonRequest(obj) {
  const payload = await gzip(Buffer.from(JSON.stringify(obj)));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([buildWsHeader(0x1, 0, 0x1, 0x1), size, payload]);
}

async function packAudio(pcm, last) {
  const payload = await gzip(pcm);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([buildWsHeader(0x2, last ? 0x2 : 0, 0, 0x1), size, payload]);
}

async function parseWsFrame(buf) {
  if (!buf || buf.length < 8) return null;
  const headerSize = (buf[0] & 0x0f) * 4;
  const msgType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const compress = buf[2] & 0x0f;
  let offset = headerSize;
  if (flags === 0x1 || flags === 0x3) offset += 4;
  if (msgType === 0xf) offset += 4;
  if (offset + 4 > buf.length) return null;
  const payloadSize = buf.readUInt32BE(offset);
  offset += 4;
  let payload = buf.subarray(offset, offset + payloadSize);
  if (compress === 1 && payload.length) payload = await gunzip(payload);
  const text = payload.toString('utf8');
  try { return { msgType, json: JSON.parse(text) }; } catch { return { msgType, text }; }
}

export function volcRealtime(settings) {
  const { appid, token } = settings.asr.volc;
  if (!appid || !token) throw new Error('未配置火山 appid/token');
  let ws = null;
  const emitMap = new Map();
  const emit = (n, d) => (emitMap.get(n) || []).forEach((fn) => fn(d));

  return {
    on(evt, fn) { emitMap.set(evt, [...(emitMap.get(evt) || []), fn]); },
    async start() {
      const { default: WebSocket } = await import('ws');
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };
        ws = new WebSocket(VOLC_SAUC_WS, {
          headers: volcHeaders(appid, token, 'volc.bigasr.sauc.duration')
        });
        ws.on('open', async () => {
          try {
            ws.send(await packJsonRequest({
              user: { uid: String(appid) },
              audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
              request: { model_name: 'bigmodel', enable_itn: true, show_utterances: true }
            }));
            emit('open', {});
            done();
          } catch (e) {
            emit('error', e);
            done(e);
          }
        });
        ws.on('message', async (data) => {
          try {
            const parsed = await parseWsFrame(Buffer.from(data));
            const json = parsed?.json;
            if (parsed?.msgType === 0xf) {
              emit('error', new Error(json?.error || json?.message || '火山流式识别失败'));
              return;
            }
            const result = json?.result || json;
            const segs = (result?.utterances || []).map((u) => u.text).join('');
            const text = result?.text || segs;
            if (text) {
            const definite = result?.utterances?.some((u) => u.definite) || result?.is_end;
              emit(definite ? 'final' : 'partial', { text, start: null, end: null, speaker: null,
                confidence: null, timing: 'unknown', provider: 'volc' });
            }
          } catch (error) {
            emit('error', { code: 'INVALID_PROVIDER_MESSAGE', message: error.message,
              provider: 'volc', model: null, fatal: false });
          }
        });
        ws.on('error', (e) => {
          emit('error', e);
          done(e);
        });
        ws.on('close', () => emit('close', {}));
      });
    },
    send(chunk) {
      if (ws && ws.readyState === 1) {
        packAudio(Buffer.from(chunk), false).then((buf) => ws.send(buf)).catch((e) => emit('error', e));
      }
    },
    async stop() {
      if (ws && ws.readyState === 1) {
        try { ws.send(await packAudio(Buffer.alloc(0), true)); }
        catch (error) { emit('error', { code: 'STOP_FAILED', message: error.message, provider: 'volc', model: null, fatal: false }); }
      }
    },
    close() { try { ws?.close(); }
      catch (error) { emit('error', { code: 'CLOSE_FAILED', message: error.message, provider: 'volc', model: null, fatal: false }); } }
  };
}

export async function volcTest(settings) {
  const { appid, token } = settings.asr.volc;
  if (!appid || !token) throw new Error('未配置火山 appid/token');
  const res = await fetch(VOLC_FLASH_URL, {
    method: 'POST',
    headers: {
      ...volcHeaders(appid, token, 'volc.bigasr.auc_turbo'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      user: { uid: String(appid) },
      audio: { data: silenceWav().toString('base64') },
      request: { model_name: 'bigmodel' }
    })
  });
  if (res.status === 401 || res.status === 403) throw new Error('火山 App ID / Token 无效或权限不足');
  if (res.status === 404) throw new Error('火山 ASR 端点不可用（404）');
  const code = res.headers.get?.('X-Api-Status-Code') || '';
  const msg = res.headers.get?.('X-Api-Message') || '';
  if (code === '20000000' || code === '20000003' || String(code).startsWith('450')) {
    return '火山鉴权通过，录音文件极速识别接口可达';
  }
  if (!res.ok && !code) throw new Error(`火山测试失败: HTTP ${res.status} ${msg}`);
  if (code && !String(code).startsWith('200') && !String(code).startsWith('450')) {
    throw new Error(`火山测试失败: ${code} ${msg}`);
  }
  return '火山鉴权通过，录音文件极速识别接口可达';
}
