import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from 'socket.io';
import { PORT, ROOT, UPLOADS_DIR } from './config.js';
import { ensureDirs } from './services/store/jsonstore.js';
import { queue } from './services/queue.js';
import meetingsRoute from './routes/meetings.js';
import settingsRoute from './routes/settings.js';
import modelsRoute from './routes/models.js';
import llmRoute from './routes/llm.js';
import { setupRealtime } from './socket/realtime.js';
import { spawnPython, isHealthy } from './services/python.js';
import { checkFFmpeg } from './services/audio/ffmpeg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 创建会议服务（可嵌入 Electron 主进程，也可独立运行）。
 * @returns {{ app, server, io, start, stop }}
 */
export function createServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? PORT;

  ensureDirs();

  const app = express();
  const server = http.createServer(app);

  // CORS：仅允许桌面端 file:// 页面（Origin: null）与本地 dev server 跨源访问，
  // 阻止任意网页读取本地数据（127.0.0.1 随机端口 + 白名单）
  const ALLOWED_ORIGINS = new Set([
    'null', // file:// 页面在 CORS 中 Origin 为字符串 "null"
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ]);
  const corsCheck = (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.has(origin));
  const io = new Server(server, { cors: { origin: corsCheck } });
  app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    const allowed = ALLOWED_ORIGINS.has(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    // 无 Origin（同源/curl）不受影响；OPTIONS 预检按白名单放行
    if (req.method === 'OPTIONS') return res.sendStatus(allowed ? 204 : 403);
    next();
  });

  app.use('/api/meetings', meetingsRoute);
  app.use('/api/settings', settingsRoute);
  app.use('/api/models', modelsRoute);
  app.use('/api/llm', llmRoute);
  app.use('/uploads', express.static(UPLOADS_DIR));

  // 前端静态资源
  const dist = path.join(ROOT, 'web', 'dist');
  app.use(express.static(dist));
  // 健康检查：报告 ffmpeg 与 python 依赖状态
  app.get('/api/health', async (_req, res) => {
    res.json({
      ffmpeg: await checkFFmpeg(),
      python: await isHealthy()
    });
  });

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) res.send('前端未构建，请运行 npm run dev 或 npm run build');
    });
  });

  setupRealtime(io);

  // 文件转写进度/结果推送
  queue.onProgress(({ taskId, ...data }) => io.emit('task:progress', { taskId, ...data }));
  queue.onDone(() => {});
  queue.events.on('result', ({ taskId, ok, meetingId, error }) => {
    io.emit('task:done', { taskId, ok, meetingId, error });
  });

  return {
    app,
    server,
    io,
    /** 启动监听，返回实际端口（port=0 时随机分配） */
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

  // 后台拉起 Python 推理服务（不阻塞，失败仅警告）
  spawnPython().then((ok) => {
    if (!ok) console.warn('[meeting] Python 推理服务未就绪，本地模型功能不可用。请运行 npm run setup:python');
  }).catch((e) => {
    console.warn('[meeting] Python 推理服务启动失败:', e.message);
  });
}
