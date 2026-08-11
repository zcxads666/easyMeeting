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
import { spawnPython } from './services/python.js';

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

async function main() {
  await spawnPython();
  server.listen(PORT, () => {
    console.log(`[meeting] server running at http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  console.error('启动失败:', e);
  // 即使 Python 失败也启动 web
  server.listen(PORT, () => console.log(`[meeting] server running at http://localhost:${PORT}`));
});