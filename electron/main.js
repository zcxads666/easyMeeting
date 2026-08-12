import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');

const DEV_URL = 'http://localhost:5173';
let mainWindow = null;
let serverPort = null;
let stopPython = null;

// 全局错误兜底：防止主进程未捕获异常导致静默崩溃
process.on('uncaughtException', (err) => {
  console.error('[electron] uncaughtException:', err.message, err.stack?.split('\n')[1] || '');
});
process.on('unhandledRejection', (reason) => {
  console.error('[electron] unhandledRejection:', reason?.message || reason);
});

// ---------- 单实例锁（本地工具防多开） ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  bootstrap();
}

async function bootstrap() {
  // 必须在 import server 模块之前设置数据目录环境变量：
  // server 模块顶层会基于 DATA_DIR 创建 multer 存储目录（见 routes/meetings.js），
  // 打包后 app.asar 是只读的，若仍指向 ROOT/data 会在加载时崩溃。
  if (!isDev && !process.env.MEETING_DATA_DIR) {
    process.env.MEETING_DATA_DIR = path.join(app.getPath('userData'), 'data');
  }

  // 动态 import：确保上面环境变量设置先于 server 模块加载
  const { createServer } = await import('../server/index.js');
  const python = await import('../server/services/python.js');
  stopPython = python.stopPython;

  // 内嵌会议服务（随机端口，仅监听 127.0.0.1，纯内部通信通道）
  const srv = createServer({ port: 0 });
  serverPort = await srv.start();
  console.log(`[electron] meeting server on 127.0.0.1:${serverPort}`);

  // 后台拉起 Python 推理服务（不阻塞）
  python.spawnPython().catch(() => {});

  await app.whenReady();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '会议纪要',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [
        `--meeting-base-url=${baseUrl}`,
        `--meeting-version=${app.getVersion()}`
      ]
    }
  });

  // 外部链接一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    // 开发模式：等待 vite dev server 就绪后加载
    waitForUrl(DEV_URL, 60).then(() => mainWindow.loadURL(DEV_URL));
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  // 冒烟测试：ELECTRON_SMOKE_TEST=1 时加载完成后自动退出（验证迁移链路）
  if (process.env.ELECTRON_SMOKE_TEST === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      console.log('[smoke] window loaded');
      try {
        const bridge = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify(window.meetingBridge || {})'
        );
        console.log('[smoke] bridge:', bridge);
        const health = await mainWindow.webContents.executeJavaScript(
          `fetch('${baseUrl}/api/health').then(r => r.json()).then(JSON.stringify)`
        );
        console.log('[smoke] health via renderer:', health);
        console.log('[smoke] PASS');
        app.exit(0);
      } catch (e) {
        console.error('[smoke] FAIL:', e.message);
        app.exit(1);
      }
    });
    mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`[smoke] load failed (${code}): ${desc}`);
      app.exit(1);
    });
  }
}

async function waitForUrl(url, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[electron] 等待 dev server 超时: ${url}`);
}

// ---------- 生命周期 ----------
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopPython?.();
});
