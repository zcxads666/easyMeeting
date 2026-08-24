import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { PORT, ROOT } from './config.js';
import { ensureDirs } from './services/store/jsonstore.js';
import { taskManager } from './services/queue.js';
import meetingsRoute from './routes/meetings.js';
import settingsRoute from './routes/settings.js';
import { lazyRouter, lazyRouterFactory } from './services/lazy-router.js';
import { setupRealtime } from './socket/realtime.js';
import { checkFFmpeg } from './services/audio/ffmpeg.js';
import { createLogger } from './services/logger.js';
import { issueMediaToken, verifyMediaToken } from './services/audio/media-token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger('server');

function resolveApiToken(options) {
  if (process.env.MEETING_DISABLE_AUTH === '1') return '';
  return options.apiToken || process.env.MEETING_API_TOKEN || randomBytes(24).toString('hex');
}

/**
 * 创建会议服务（可嵌入 Electron 主进程，也可独立运行）。
 * @returns {{ app, server, io, apiToken, start, stop }}
 */
export function createServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? PORT;
  const apiToken = resolveApiToken(options);

  ensureDirs();

  const app = express();
  const server = http.createServer(app);

  const ALLOWED_ORIGINS = new Set([
    'null',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ]);
  const corsCheck = (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.has(origin));
  const io = new Server(server, { cors: { origin: corsCheck } });

  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'forbidden origin' });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Meeting-Token');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use((req, res, next) => {
    if (!apiToken) return next();
    if (!req.path.startsWith('/api/')) return next();
    const audioMatch = /^\/api\/meetings\/([0-9a-f-]+)\/audio$/i.exec(req.path);
    if (audioMatch && verifyMediaToken(apiToken, req.query.mediaToken, audioMatch[1])) return next();
    const got = req.get('x-meeting-token') || req.query.token || '';
    if (got !== apiToken) return res.status(401).json({ error: 'unauthorized' });
    req.issueMediaToken = (meetingId, ttlMs) => issueMediaToken(apiToken, meetingId, ttlMs);
    next();
  });

  if (apiToken) {
    io.use((socket, next) => {
      const got = socket.handshake.auth?.token || socket.handshake.query?.token || '';
      if (got !== apiToken) return next(new Error('unauthorized'));
      next();
    });
  }

  app.use('/api/meetings', meetingsRoute);
  app.use('/api/settings', settingsRoute);
  app.use('/api/models', lazyRouter(() => import('./routes/models.js')));
  app.use('/api/llm', lazyRouter(() => import('./routes/llm.js')));
  app.use('/api/tasks', lazyRouter(() => import('./routes/tasks.js')));
  app.use('/api/runtime', lazyRouter(() => import('./routes/runtime.js')));
  let appVersion = 'unknown';
  try { appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { /* optional metadata */ }
  app.use('/api/diagnostics', lazyRouterFactory(async () => {
    const { createDiagnosticsRoute } = await import('./routes/diagnostics.js');
    return createDiagnosticsRoute({ appVersion, authEnabled: Boolean(apiToken) });
  }));

  const dist = path.join(ROOT, 'web', 'dist');
  app.use(express.static(dist, { index: false }));
  app.get('/api/health', async (_req, res) => {
    const { getRuntimeHealth } = await import('./services/python.js');
    res.json({
      ffmpeg: await checkFFmpeg(),
      python: await getRuntimeHealth()
    });
  });

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    const index = path.join(dist, 'index.html');
    try {
      let html = fs.readFileSync(index, 'utf8');
      if (apiToken) {
        const nonce = randomBytes(18).toString('base64');
        html = html.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
        const inject = `<script nonce="${nonce}">window.meetingBridge=Object.assign({},window.meetingBridge||{},{apiToken:${JSON.stringify(apiToken)}})</script>`;
        html = html.includes('<head>') ? html.replace('<head>', `<head>${inject}`) : inject + html;
      }
      res.type('html').send(html);
    } catch {
      res.send('前端未构建，请运行 npm run dev 或 npm run build');
    }
  });

  setupRealtime(io, options.createRealtimeStream);

  const onTaskUpdated = (task) => {
    io.emit('task:progress', { taskId: task.id, ...task });
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      logger.info('task finished', { taskId: task.id, type: task.type, status: task.status, errorCode: task.error?.code });
      io.emit('task:done', { taskId: task.id, ok: task.status === 'completed', status: task.status,
        meetingId: task.result?.meetingId, error: task.error?.message, result: task.result });
    }
  };
  taskManager.events.on('updated', onTaskUpdated);

  return {
    app,
    server,
    io,
    apiToken,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      });
    },
    async stop() {
      taskManager.events.off('updated', onTaskUpdated);
      io.close();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

// ---------- 独立运行入口（node server/index.js） ----------
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const { stopPython } = await import('./services/python.js');
  process.on('uncaughtException', (err) => {
    console.error('[meeting] uncaughtException:', err.message);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[meeting] unhandledRejection:', reason?.message || reason);
  });
  process.on('SIGINT', () => { stopPython(); process.exit(0); });
  process.on('SIGTERM', () => { stopPython(); process.exit(0); });

  const srv = createServer();
  const actualPort = await srv.start();
  console.log(`[meeting] server running at http://localhost:${actualPort}`);

  // 检查 ffmpeg
  const ffmpegOk = await checkFFmpeg();
  if (!ffmpegOk) console.warn('[meeting] 警告: 未检测到 FFmpeg，文件转写将不可用。请安装 ffmpeg。');

  // Python Runtime 按需启动，不与普通浏览器首屏争抢资源。
}
