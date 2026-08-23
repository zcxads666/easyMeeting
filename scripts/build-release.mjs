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
// Python 推理服务源码（不含 venv，首次启动自动安装）
await mkdir(path.join(PKG_DIR, 'python'), { recursive: true });
for (const f of ['main.py', 'model_manager.py', 'runtime.py', 'transcribe_whisper.py', 'transcribe_qwen.py', 'requirements.txt']) {
  await copyFile(path.join(ROOT, 'python', f), path.join(PKG_DIR, 'python', f));
}
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
    'setup:python': 'python3 -m venv python/.venv && python/.venv/bin/pip install --upgrade pip && python/.venv/bin/pip install -r python/requirements.txt',
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
echo "[start] 首次启动会自动安装 Python 推理环境（约 2-5 分钟），请耐心等待"
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
echo [start] 首次启动会自动安装 Python 推理环境，请耐心等待
node server/index.js
pause
`;
await writeFile(path.join(PKG_DIR, 'start.bat'), bat);

// 占位 config 说明（data 目录会自动创建）
await writeFile(
  path.join(PKG_DIR, 'README.md'),
  `# 会议纪要工具 v${version}

纯本地运行的 Web 会议记录工具：实时语音转写、录音转写、LLM 智能纪要、本地模型。

## 快速开始

### macOS / Linux
\`\`\`bash
./start.sh          # 一键启动（自动安装依赖）
# 或手动：npm install && npm start
\`\`\`

### Windows
双击 \`start.bat\`，或命令行：
\`\`\`
npm install
npm start
\`\`\`

首次启动会自动：
1. 创建 \`python/.venv\` 虚拟环境
2. 安装 Python 推理依赖（fastapi / faster-whisper / transformers / torch 等，约 2-5 分钟）
3. 拉起本地推理服务（端口 8300）

启动后浏览器访问 **http://localhost:3000**。

## 使用提示
- 云端转写/LLM：在「设置」页填入对应 Key（千问/火山/MiMo/任意 OpenAI 兼容 LLM）
- 本地转写：在「模型」页一键下载 whisper / Qwen3-ASR 模型（默认 ModelScope 源，国内快）
- 所有数据保存在本地 \`data/\` 目录，无数据库，重启不丢失

## 常见问题
- **Python 环境安装失败**：请先安装 Python 3.9+（https://www.python.org/downloads/），然后运行 \`npm run setup:python\`
- **本地模型不可用**：确认「模型」页已下载并切换模型；Qwen3-ASR 需要 torch（安装脚本已包含）
- **端口被占用**：设置环境变量 \`PORT\` 更换端口，如 \`PORT=8080 npm start\`
`
);

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
