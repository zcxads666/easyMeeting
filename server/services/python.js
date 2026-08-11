import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, PYTHON_SERVE_URL } from '../config.js';

const execFileAsync = promisify(execFile);

let child = null;
let restartTimer = null;
let shouldRun = false; // 是否应保持运行（用户未主动停止）
let consecutiveRestarts = 0;

const PY_DIR = path.join(ROOT, 'python');
const VENV_DIR = path.join(PY_DIR, '.venv');
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
  console.log(`[python] 使用 ${systemPython} 创建虚拟环境 python/.venv …`);
  await execFileAsync(systemPython, ['-m', 'venv', VENV_DIR]);
  console.log('[python] 正在安装依赖（首次可能需要几分钟，请耐心等待）…');
  await pipInstall(VENV_PYTHON, ['--upgrade', 'pip', ...(await readRequirements())]);
  return VENV_PYTHON;
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
  child = spawn(pythonBin, ['-u', pyMain], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });
  child.stdout.on('data', (d) => process.stdout.write(`[python] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[python:err] ${d}`));
  child.on('exit', (code) => {
    console.log(`[python] exited with code ${code}`);
    child = null;
    // 异常退出时自动重启（指数退避，最多 5 次）
    if (shouldRun && code !== 0) {
      consecutiveRestarts++;
      if (consecutiveRestarts > 5) {
        console.error('[python] 重启次数过多，放弃自动重启');
        shouldRun = false;
        consecutiveRestarts = 0;
        return;
      }
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
  // 已健康则跳过
  if (await isHealthy()) { shouldRun = true; return true; }

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
    const res = await fetch(`${PYTHON_SERVE_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
