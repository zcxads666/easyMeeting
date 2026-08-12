import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, stat } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { ROOT, PYTHON_PORT } from '../config.js';

const execFileAsync = promisify(execFile);

let child = null;
let restartTimer = null;
let shouldRun = false; // 是否应保持运行（用户未主动停止）
let consecutiveRestarts = 0;
let startedAtMtime = 0; // 本次启动时推理源码的最新 mtime（用于检测代码更新）
let lastSpawnAttempt = 0; // 最近一次尝试拉起的时间（节流）

// 推理服务端口：默认 PYTHON_PORT（8300），被占用时自动递增更换空闲端口
let pyPort = PYTHON_PORT;

export function getPythonPort() { return pyPort; }
export function getPythonUrl() { return `http://127.0.0.1:${pyPort}`; }

// Electron 打包后 python 目录在 app.asar.unpacked（spawn 子进程需要真实文件路径）
function resolvePythonDir() {
  const candidates = [
    path.join(ROOT, 'python'),
    path.join(`${ROOT}.unpacked`, 'python')
  ];
  for (const p of candidates) {
    try { accessSync(p); return p; } catch { /* 继续尝试 */ }
  }
  return candidates[0];
}

const PY_DIR = resolvePythonDir();
// venv 目录默认跟随源码目录；Electron 生产环境应通过 MEETING_VENV_DIR
// 指向 userData 等可写位置（Windows 安装到 Program Files 时 unpacked 目录不可写）
const VENV_DIR = process.env.MEETING_VENV_DIR
  ? path.resolve(process.env.MEETING_VENV_DIR)
  : path.join(PY_DIR, '.venv');
// Windows 与 POSIX 的 venv 内 python 路径不同
const VENV_PYTHON = os.platform() === 'win32'
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');

// 依赖完整性检查（覆盖推理与模型下载所需核心包）
const CORE_IMPORTS = ['fastapi', 'uvicorn', 'numpy', 'faster_whisper', 'transformers', 'modelscope', 'torch'];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// 找出系统可用的 Python 解释器（多候选）
async function findSystemPython() {
  const candidates = os.platform() === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];
  for (const cmd of candidates) {
    try {
      await execFileAsync(cmd, ['--version']);
      return cmd;
    } catch { /* 下一个候选 */ }
  }
  return null;
}

async function pipInstall(pythonBin, args) {
  await new Promise((resolve, reject) => {
    const p = spawn(pythonBin, ['-m', 'pip', 'install', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => process.stdout.write(`[pip] ${d}`));
    p.stderr.on('data', (d) => process.stdout.write(`[pip] ${d}`));
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`pip 安装失败 (exit ${code})`)));
  });
}

// 从 requirements.txt 读取全量依赖清单
async function readRequirements() {
  const reqFile = path.join(PY_DIR, 'requirements.txt');
  const raw = await readFile(reqFile, 'utf8');
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// 确保虚拟环境存在且依赖可用，返回 venv 内 python 路径
async function ensureVenv() {
  if (await exists(VENV_PYTHON)) {
    // 检查核心依赖是否齐全
    try {
      await execFileAsync(VENV_PYTHON, ['-c', `import ${CORE_IMPORTS.join(',')}`]);
      return VENV_PYTHON;
    } catch {
      console.log('[python] venv 缺少依赖，正在安装（首次可能需要几分钟，请耐心等待）…');
      await pipInstall(VENV_PYTHON, await readRequirements());
      return VENV_PYTHON;
    }
  }

  // 创建虚拟环境
  const systemPython = await findSystemPython();
  if (!systemPython) {
    console.error('[python] 未找到 Python 3.9+，请先安装 Python（https://www.python.org/downloads/）');
    return null;
  }
  console.log(`[python] 使用 ${systemPython} 创建虚拟环境 ${VENV_DIR} …`);
  await execFileAsync(systemPython, ['-m', 'venv', VENV_DIR]);
  console.log('[python] 正在安装依赖（首次可能需要几分钟，请耐心等待）…');
  await pipInstall(VENV_PYTHON, ['--upgrade', 'pip', ...(await readRequirements())]);
  return VENV_PYTHON;
}

// 探测 TCP 端口是否被占用（区分"端口空闲"与"被占用但服务未就绪"）
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(1500);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(true); });
  });
}

// 从 start 起寻找第一个空闲端口（最多探测 20 个）
async function findFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    if (!(await portInUse(p))) return p;
  }
  return null;
}

async function launch() {
  let pythonBin;
  try {
    pythonBin = await ensureVenv();
  } catch (e) {
    console.error('[python] 环境准备失败:', e.message);
    console.error('[python] 请手动运行: npm run setup:python');
    return;
  }
  if (!pythonBin) return;

  const pyMain = path.join(PY_DIR, 'main.py');
  startedAtMtime = await pythonCodeMtime();
  child = spawn(pythonBin, ['-u', pyMain], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MEETING_PY_PORT: String(pyPort) }
  });
  child.stdout.on('data', (d) => process.stdout.write(`[python] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[python:err] ${d}`));
  child.on('exit', async (code) => {
    console.log(`[python] exited with code ${code}`);
    child = null;
    // 异常退出时自动重启（指数退避，最多 5 次）
    if (shouldRun && code !== 0) {
      if (consecutiveRestarts >= 5) {
        console.error('[python] 重启次数过多，放弃自动重启');
        shouldRun = false;
        consecutiveRestarts = 0;
        return;
      }
      // 若当前端口被外部进程抢占，自动更换空闲端口再重启
      if (await portInUse(pyPort)) {
        const free = await findFreePort(pyPort + 1);
        if (free) {
          console.warn(`[python] 端口 ${pyPort} 被占用，自动切换至 ${free}`);
          pyPort = free;
        }
      }
      consecutiveRestarts++;
      const delay = Math.min(30000, 2000 * consecutiveRestarts);
      console.log(`[python] 将在 ${delay}ms 后自动重启 (第 ${consecutiveRestarts} 次)…`);
      restartTimer = setTimeout(() => {
        launch();
        // 重置计数（如果稳定运行一段时间）
        setTimeout(() => { if (child) consecutiveRestarts = 0; }, 60000);
      }, delay);
    }
  });
}

export async function spawnPython() {
  // 已健康则跳过（可能是本进程此前 spawn 的服务）
  if (await isHealthy()) { shouldRun = true; return true; }

  // 默认端口被占用：自动更换空闲端口，避免与残留/外部进程冲突
  if (await portInUse(pyPort)) {
    const free = await findFreePort(pyPort + 1);
    if (free === null) {
      console.error('[python] 找不到可用端口，无法启动推理服务');
      return false;
    }
    console.warn(`[python] 端口 ${pyPort} 已被占用，自动切换至 ${free}`);
    pyPort = free;
  }

  shouldRun = true;
  consecutiveRestarts = 0;
  launch();

  // 等待就绪（首次安装依赖时给足时间）
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    if (await isHealthy()) { console.log('[python] inference service ready'); return true; }
  }
  console.log('[python] inference service not ready (will retry on demand)');
  return false;
}

export function stopPython() {
  shouldRun = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) { child.kill(); child = null; }
}

export async function isHealthy() {
  try {
    const res = await fetch(`${getPythonUrl()}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// 推理服务源码文件的最新 mtime（main.py / model_manager.py / transcribe_* / requirements.txt）
async function pythonCodeMtime() {
  const files = ['main.py', 'model_manager.py', 'transcribe_whisper.py', 'transcribe_qwen.py', 'requirements.txt'];
  let max = 0;
  for (const f of files) {
    try {
      const st = await stat(path.join(PY_DIR, f));
      max = Math.max(max, st.mtimeMs);
    } catch { /* 文件缺失忽略 */ }
  }
  return max;
}

// 重启推理服务并等待就绪（上限 waitMs，避免请求长时间阻塞）
async function restartPython(waitMs = 8000) {
  shouldRun = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) { child.kill(); child = null; }
  shouldRun = true;
  consecutiveRestarts = 0;
  launch();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await isHealthy()) { console.log('[python] inference service restarted'); return true; }
  }
  console.warn(`[python] 重启 ${waitMs}ms 内未就绪`);
  return false;
}

// 模型接口调用前调用：检测推理源码变更自动重启；未就绪时按节流拉起
export async function ensureFreshPython({ wait = true } = {}) {
  if (await isHealthy()) {
    // 仅重启本进程管理的子进程（child 存在）；外部/遗留服务不接管，避免端口冲突
    const current = await pythonCodeMtime();
    if (child && current > startedAtMtime) {
      console.log('[python] 检测到推理服务代码更新，自动重启…');
      if (wait) return restartPython(8000);
      // 非等待：后台重启，不阻塞当前请求
      restartPython(8000).catch(() => {});
      return true;
    }
    return true;
  }
  if (Date.now() - lastSpawnAttempt > 10000) {
    lastSpawnAttempt = Date.now();
    spawnPython().catch(() => {});
  }
  // 短暂等待就绪（最多 ~8s），避免长时间阻塞模型请求
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await isHealthy()) return true;
  }
  return false;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
