/**
 * 一键构建发布包：
 *   1. 构建前端 (vite build)
 *   2. 组装 release/meeting-notes/ 目录（后端 + python 源码 + 前端产物 + 启动脚本）
 *   3. 压缩为 release/meeting-notes-<version>.zip
 *
 * 其他用户拿到 zip 后：解压 → npm install → npm start（Python 环境自动引导安装）
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const PKG_DIR = path.join(RELEASE_DIR, 'meeting-notes');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

// ---------- 1. 构建前端 ----------
console.log('[release] 构建前端 …');
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });

// ---------- 2. 组装目录 ----------
console.log('[release] 组装发布目录 …');
await rm(PKG_DIR, { recursive: true, force: true });
await mkdir(PKG_DIR, { recursive: true });

// 后端源码
await cp(path.join(ROOT, 'server'), path.join(PKG_DIR, 'server'), { recursive: true });
// 前端构建产物
await cp(path.join(ROOT, 'web', 'dist'), path.join(PKG_DIR, 'web', 'dist'), { recursive: true });
await cp(path.join(ROOT, 'docs'), path.join(PKG_DIR, 'docs'), { recursive: true });
// Python 推理服务源码（不含 venv，首次启动自动安装）
await mkdir(path.join(PKG_DIR, 'python'), { recursive: true });
for (const f of ['main.py', 'model_manager.py', 'runtime.py', 'transcribe_whisper.py', 'transcribe_qwen.py',
  'forced_aligner.py', 'diarization.py', 'streaming_vllm.py', 'requirements.txt',
  'requirements-diarization.txt', 'requirements-streaming.txt']) {
  await copyFile(path.join(ROOT, 'python', f), path.join(PKG_DIR, 'python', f));
}
await mkdir(path.join(PKG_DIR, 'scripts'), { recursive: true });
await copyFile(path.join(ROOT, 'scripts', 'python-setup.mjs'), path.join(PKG_DIR, 'scripts', 'python-setup.mjs'));
// 测试目录（便于用户验证）
await cp(path.join(ROOT, 'tests'), path.join(PKG_DIR, 'tests'), { recursive: true });

// ---------- 3. 精简 package.json ----------
console.log('[release] 生成生产版 package.json …');
const prodPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  description: '本地 Web 端会议记录总结工具（纯本地运行，支持实时/文件转写、LLM 纪要、本地模型）',
  scripts: {
    start: 'node server/index.js',
    'setup:python': 'node scripts/python-setup.mjs',
    test: pkg.scripts.test
  },
  dependencies: pkg.dependencies,
  engines: { node: '>=18' }
};
await writeFile(path.join(PKG_DIR, 'package.json'), JSON.stringify(prodPkg, null, 2) + '\n');

// ---------- 4. 启动脚本 ----------
console.log('[release] 生成启动脚本 …');
const sh = `#!/usr/bin/env bash
# 会议纪要工具 - 一键启动（macOS / Linux）
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "[start] 首次使用，安装 Node 依赖…"
  npm install || { echo "[start] npm install 失败"; exit 1; }
fi

echo "[start] 启动服务，请访问 http://localhost:3000"
echo "[start] 本地 AI Runtime 需要通过应用模型页显式安装；Cloud 功能可直接使用"
node server/index.js
`;
await writeFile(path.join(PKG_DIR, 'start.sh'), sh, { mode: 0o755 });

const bat = `@echo off
REM 会议纪要工具 - 一键启动（Windows）
cd /d "%~dp0"

if not exist node_modules (
  echo [start] 首次使用，安装 Node 依赖...
  call npm install
  if errorlevel 1 (
    echo [start] npm install 失败
    pause
    exit /b 1
  )
)

echo [start] 启动服务，请访问 http://localhost:3000
echo [start] 本地 AI Runtime 需要通过应用模型页显式安装；Cloud 功能可直接使用
node server/index.js
pause
`;
await writeFile(path.join(PKG_DIR, 'start.bat'), bat);

await copyFile(path.join(ROOT, 'README.md'), path.join(PKG_DIR, 'README.md'));

// ---------- 5. 压缩 ----------
console.log('[release] 压缩发布包 …');
const zipName = `meeting-notes-${version}.zip`;
const zipPath = path.join(RELEASE_DIR, zipName);
await rm(zipPath, { force: true });

if (os.platform() === 'win32') {
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path "${PKG_DIR}" -DestinationPath "${zipPath}" -Force`
  ]);
} else {
  execFileSync('zip', ['-r', '-q', zipPath, 'meeting-notes'], { cwd: RELEASE_DIR });
}

// ---------- 6. 统计 ----------
const { statSync } = await import('node:fs');
const size = statSync(zipPath).size;
console.log(`[release] 完成: ${path.relative(ROOT, zipPath)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
