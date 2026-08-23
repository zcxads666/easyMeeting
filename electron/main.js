import { app, BrowserWindow, shell, dialog, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedRendererNavigation, isSafeExternalUrl } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');

const DEV_URL = 'http://localhost:5173';
let mainWindow = null;
let serverPort = null;
let apiToken = '';
let stopPython = null;
let electronLogger = null;

// 全局错误兜底：防止主进程未捕获异常导致静默崩溃
process.on('uncaughtException', (err) => {
  console.error('[electron] uncaughtException:', err.message, err.stack?.split('\n')[1] || '');
  electronLogger?.error('uncaught exception', { errorCode: err.code, message: err.message });
});
process.on('unhandledRejection', (reason) => {
  console.error('[electron] unhandledRejection:', reason?.message || reason);
  electronLogger?.error('unhandled rejection', { errorCode: reason?.code, message: reason?.message || String(reason) });
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
  await app.whenReady();
  // 必须在 import server 模块之前设置数据目录环境变量：
  // server 模块顶层会基于 DATA_DIR 创建 multer 存储目录（见 routes/meetings.js），
  // 打包后 app.asar 是只读的，若仍指向 ROOT/data 会在加载时崩溃。
  if (!isDev) {
    // Python venv 放到 userData（unpacked 目录在 Windows Program Files 下不可写）
    process.env.MEETING_VENV_DIR ||= path.join(app.getPath('userData'), 'runtime', 'python');
    process.env.MEETING_DATA_DIR ||= path.join(app.getPath('userData'), 'data');
    process.env.MEETING_LOG_DIR ||= path.join(app.getPath('userData'), 'logs');
    process.env.MEETING_RUNTIME_AUTO_INSTALL = '0';
  }

  // 动态 import：确保上面环境变量设置先于 server 模块加载
  const { createServer } = await import('../server/index.js');
  const python = await import('../server/services/python.js');
  const { EncryptedFileSecretStore, configureSecretStore } = await import('../server/services/secrets.js');
  const { createLogger } = await import('../server/services/logger.js');
  electronLogger = createLogger('electron');
  configureSecretStore(new EncryptedFileSecretStore({
    file: path.join(app.getPath('userData'), 'secrets.json'),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
    available: () => safeStorage.isEncryptionAvailable()
  }));
  stopPython = python.stopPython;

  // 内嵌会议服务（随机端口，仅监听 127.0.0.1，纯内部通信通道）
  const srv = createServer({ port: 0 });
  serverPort = await srv.start();
  apiToken = srv.apiToken;
  console.log(`[electron] meeting server on 127.0.0.1:${serverPort}`);
  electronLogger.info('desktop core started', { port: serverPort, packaged: !isDev });

  // 生产模式只启动已经安装且验证通过的 Runtime，不执行 pip install。
  python.spawnPython().catch(() => {});
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
      sandbox: true,
      additionalArguments: [
        `--meeting-base-url=${baseUrl}`,
        `--meeting-api-token=${apiToken}`,
        `--meeting-version=${app.getVersion()}`
      ]
    }
  });

  const distRoot = path.join(__dirname, '..', 'web', 'dist');
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererNavigation(url, { isDev, devUrl: DEV_URL, baseUrl, distRoot })) event.preventDefault();
  });

  if (isDev) {
    // 开发模式：等待 vite dev server 就绪后加载
    waitForUrl(DEV_URL, 60).then(() => mainWindow.loadURL(DEV_URL));
  } else {
    const distIndex = path.join(__dirname, '..', 'web', 'dist', 'index.html');
    if (!fs.existsSync(distIndex)) {
      console.error('[electron] 缺少前端构建产物 web/dist，请先运行 npm run build');
      dialog.showErrorBox('启动失败', '缺少前端构建产物 web/dist\n\n请先运行: npm run build');
      app.exit(1);
      return;
    }
    mainWindow.loadFile(distIndex);
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  // 冒烟测试：ELECTRON_SMOKE_TEST=1 时加载完成后自动退出（验证迁移链路）
  if (process.env.ELECTRON_SMOKE_TEST === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      console.log('[smoke] window loaded');
      try {
        // preload 注入
        const bridge = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify(window.meetingBridge || {})'
        );
        console.log('[smoke] bridge available:', Boolean(JSON.parse(bridge).baseUrl));
        // 渲染进程 API 连通
        const health = await mainWindow.webContents.executeJavaScript(
          `fetch('${baseUrl}/api/health', { headers: { 'X-Meeting-Token': window.meetingBridge?.apiToken || '' } }).then(r => r.json()).then(JSON.stringify)`
        );
        console.log('[smoke] health:', health);
        // React 应用是否真正渲染（#root 有内容 = JS 加载并挂载成功，防白屏）
        const rendered = await mainWindow.webContents.executeJavaScript(
          `JSON.stringify({
            rootChildren: document.querySelector('#root')?.children.length || 0,
            hasTitle: document.body.innerText.includes('会议纪要'),
            scriptsLoaded: [...document.scripts].map(s => s.src)
          })`
        );
        console.log('[smoke] rendered:', rendered);
        const info = JSON.parse(rendered);
        if (info.rootChildren === 0) {
          console.error('[smoke] FAIL: 页面 JS 未渲染（白屏），资源加载可能失败');
          app.exit(1);
          return;
        }
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
// 关窗口即退出（含 macOS）：避免"只关前端、后端 Python 残留占用端口"
app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  stopPython?.();
});

// 收到终止信号时同样清理 Python 子进程
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopPython?.();
    app.quit();
  });
}
