import { app, BrowserWindow, shell, dialog, safeStorage, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedRendererNavigation, isSafeExternalUrl } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');
const smokeTest = process.env.ELECTRON_SMOKE_TEST === '1' || process.argv.includes('--smoke-test');
const startupStartedAt = performance.now();

if (process.env.MEETING_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MEETING_USER_DATA_DIR));
}

const DEV_URL = 'http://localhost:5173';
let mainWindow = null;
let splashWindow = null;
let serverPort = null;
let apiToken = '';
let stopPython = null;
let electronLogger = null;
let showFallbackTimer = null;

function markStartup(stage, context = {}) {
  const elapsedMs = Math.round((performance.now() - startupStartedAt) * 10) / 10;
  const payload = { stage, elapsedMs, ...context };
  console.log(`[startup] ${stage} +${elapsedMs}ms`);
  electronLogger?.info('startup milestone', payload);
  return payload;
}

function smokeMarkerPath() {
  const fromEnv = process.env.ELECTRON_SMOKE_MARKER;
  if (fromEnv) return fromEnv;
  const fromArg = process.argv.find((arg) => arg.startsWith('--smoke-marker='));
  return fromArg ? fromArg.slice('--smoke-marker='.length) : null;
}

function writeSmokeMarker(status, context = {}) {
  if (!smokeTest) return;
  const marker = smokeMarkerPath();
  if (!marker) return;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ status, ...context }), 'utf8');
  } catch (error) {
    console.error('[smoke] marker write failed:', error.message);
  }
}

function applyPersistedStoragePaths() {
  const defaultDataRoot = isDev ? path.join(__dirname, '..', 'data') : path.join(app.getPath('userData'), 'data');
  const dataRoot = path.resolve(process.env.MEETING_DATA_DIR || defaultDataRoot);
  const settingsFile = path.join(dataRoot, 'settings.json');
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const storage = saved?.storage || {};
    if (typeof storage.modelsDir === 'string' && storage.modelsDir.trim()) {
      process.env.MEETING_MODELS_DIR = path.resolve(storage.modelsDir);
    }
    if (typeof storage.mediaDir === 'string' && storage.mediaDir.trim()) {
      process.env.MEETING_MEDIA_DIR = path.resolve(storage.mediaDir);
    }
  } catch {
    // 首次启动或旧版设置不存在时使用默认路径。
  }
}

function registerDesktopIpc() {
  ipcMain.handle('select-directory', async (_event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: typeof options.title === 'string' ? options.title : '选择文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle('restart-app', () => {
    app.relaunch();
    app.exit(0);
    return true;
  });
}

markStartup('process-started', { packaged: !isDev });

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
  markStartup('app-ready');
  createSplashWindow();
  // 必须在 import server 模块之前设置数据目录环境变量：
  // server 模块顶层会基于 DATA_DIR 创建 multer 存储目录（见 routes/meetings.js），
  // 打包后 app.asar 是只读的，若仍指向 ROOT/data 会在加载时崩溃。
  if (!isDev) {
    // Python venv 放到 userData（unpacked 目录在 Windows Program Files 下不可写）
    process.env.MEETING_VENV_DIR ||= path.join(app.getPath('userData'), 'runtime', 'python');
    process.env.MEETING_DATA_DIR ||= path.join(app.getPath('userData'), 'data');
    process.env.MEETING_LOG_DIR ||= path.join(app.getPath('userData'), 'logs');
    process.env.MEETING_RUNTIME_AUTO_INSTALL = '0';
    const executableSuffix = process.platform === 'win32' ? '.exe' : '';
    process.env.MEETING_BUNDLED_RUNTIME_DIR ||= path.join(process.resourcesPath, 'runtime', 'meeting-runtime');
    process.env.FFMPEG_PATH ||= path.join(process.resourcesPath, 'tools', 'ffmpeg', `ffmpeg${executableSuffix}`);
    process.env.FFPROBE_PATH ||= path.join(process.resourcesPath, 'tools', 'ffprobe', `ffprobe${executableSuffix}`);
  }
  applyPersistedStoragePaths();
  registerDesktopIpc();

  // 动态 import：确保上面环境变量设置先于 server 模块加载
  const { createServer } = await import('../server/index.js');
  const { EncryptedFileSecretStore, configureSecretStore } = await import('../server/services/secrets.js');
  const { createLogger } = await import('../server/services/logger.js');
  markStartup('core-modules-loaded');
  electronLogger = createLogger('electron');
  configureSecretStore(new EncryptedFileSecretStore({
    file: path.join(app.getPath('userData'), 'secrets.json'),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
    available: () => safeStorage.isEncryptionAvailable()
  }));
  // 内嵌会议服务（随机端口，仅监听 127.0.0.1，纯内部通信通道）
  const srv = createServer({ port: 0 });
  serverPort = await srv.start();
  apiToken = srv.apiToken;
  markStartup('server-listening', { port: serverPort });
  console.log(`[electron] meeting server on 127.0.0.1:${serverPort}`);
  electronLogger.info('desktop core started', { port: serverPort, packaged: !isDev });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#f5f5f7',
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{text-align:center}.logo{width:58px;height:58px;margin:0 auto 20px;border-radius:18px;display:grid;place-items:center;background:#007aff;color:white;font-size:28px;font-weight:650;box-shadow:0 12px 30px #007aff33}.title{font-size:20px;font-weight:650}.status{margin-top:9px;color:#6e6e73}.bar{width:180px;height:3px;margin:22px auto 0;overflow:hidden;border-radius:3px;background:#d2d2d7}.bar:after{content:"";display:block;width:45%;height:100%;border-radius:3px;background:#007aff;animation:load 1.1s ease-in-out infinite}@keyframes load{from{transform:translateX(-110%)}to{transform:translateX(330%)}}</style>
    </head><body><div class="wrap"><div class="logo">会</div><div class="title">会议纪要</div><div class="status">正在启动本地服务…</div><div class="bar"></div></div></body></html>`;
  splashWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  splashWindow.on('closed', () => { splashWindow = null; });
  markStartup('splash-visible');
}

function showMainWindow(reason) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
  if (showFallbackTimer) { clearTimeout(showFallbackTimer); showFallbackTimer = null; }
  markStartup('main-window-visible', { reason });
  mainWindow.show();
  mainWindow.focus();
  splashWindow?.close();
  // 首屏已经可见后再加载清理钩子；这里只导入模块，不启动 Runtime。
  setImmediate(() => import('../server/services/python.js').then((python) => {
    stopPython = python.stopPython;
  }).catch((error) => electronLogger.warn('runtime module preload failed', { message: error.message })));
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
    show: false,
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
  markStartup('main-window-created');

  mainWindow.once('ready-to-show', () => showMainWindow('ready-to-show'));
  showFallbackTimer = setTimeout(() => showMainWindow('startup-timeout'), 15000);
  mainWindow.webContents.once('dom-ready', () => markStartup('renderer-dom-ready'));
  mainWindow.webContents.once('did-finish-load', () => markStartup('renderer-finished-load'));

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

  mainWindow.on('closed', () => {
    if (showFallbackTimer) { clearTimeout(showFallbackTimer); showFallbackTimer = null; }
    mainWindow = null;
  });

  // 冒烟测试：支持环境变量和命令行参数，macOS 可通过 Launch Services 启动。
  if (smokeTest) {
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
          writeSmokeMarker('fail', { reason: 'renderer-not-rendered' });
          app.exit(1);
          return;
        }
        console.log('[smoke] PASS');
        writeSmokeMarker('pass');
        app.exit(0);
      } catch (e) {
        console.error('[smoke] FAIL:', e.message);
        writeSmokeMarker('fail', { reason: e.message });
        app.exit(1);
      }
    });
    mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`[smoke] load failed (${code}): ${desc}`);
      writeSmokeMarker('fail', { reason: `load failed (${code}): ${desc}` });
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
