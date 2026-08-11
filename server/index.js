import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
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

ensureDirs();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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

// 立即启动 web 服务，Python 后台异步拉起，不阻塞
async function main() {
  // 检查 ffmpeg
  const ffmpegOk = await checkFFmpeg();
  if (!ffmpegOk) console.warn('[meeting] 警告: 未检测到 FFmpeg，文件转写将不可用。请安装 ffmpeg。');

  server.listen(PORT, () => {
    console.log(`[meeting] server running at http://localhost:${PORT}`);
  });

  // 后台拉起 Python 推理服务（不阻塞，失败仅警告）
  spawnPython().then((ok) => {
    if (!ok) console.warn('[meeting] Python 推理服务未就绪，本地模型功能不可用。请运行 npm run setup:python');
  }).catch((e) => {
    console.warn('[meeting] Python 推理服务启动失败:', e.message);
  });
}

main().catch((e) => {
  console.error('启动失败:', e);
  server.listen(PORT, () => console.log(`[meeting] server running at http://localhost:${PORT}`));
});
// 全局错误兜底：防止未捕获的异常导致进程崩溃
process.on('uncaughtException', (err) => {
  console.error('[meeting] uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[meeting] unhandledRejection:', reason?.message || reason);
});
