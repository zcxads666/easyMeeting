import http from 'node:http';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, PYTHON_SERVE_URL } from '../config.js';

let child = null;

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

export async function spawnPython() {
  // 已健康则跳过
  if (await isHealthy()) return true;

  const pyMain = path.join(ROOT, 'python', 'main.py');
  const venvPython = path.join(ROOT, 'python', '.venv', 'bin', 'python');
  const pythonBin = (await exists(venvPython)) ? venvPython : 'python3';
  child = spawn(pythonBin, ['-u', pyMain], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });
  child.stdout.on('data', (d) => process.stdout.write(`[python] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[python:err] ${d}`));
  child.on('exit', (code) => {
    console.log(`[python] exited with code ${code}`);
    child = null;
  });

  // 等待就绪
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await isHealthy()) { console.log('[python] inference service ready'); return true; }
  }
  console.log('[python] inference service not ready (will retry on demand)');
  return false;
}

export function stopPython() {
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