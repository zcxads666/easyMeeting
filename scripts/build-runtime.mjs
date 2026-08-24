import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(root, 'release', 'runtime');
const runtimeDir = path.join(outputRoot, 'meeting-runtime');
const workDir = path.join(root, 'release', 'runtime-build');
const cacheDir = path.join(workDir, 'pyinstaller-cache');
const buildVenv = path.join(root, 'release', 'runtime-venv');
const buildPython = process.platform === 'win32'
  ? path.join(buildVenv, 'Scripts', 'python.exe')
  : path.join(buildVenv, 'bin', 'python');
const executable = path.join(runtimeDir, process.platform === 'win32' ? 'meeting-runtime.exe' : 'meeting-runtime');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: options.env || process.env });
    let stdout = ''; let stderr = '';
    if (options.capture) {
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
    }
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}${stderr ? `\n${stderr}` : ''}`)));
  });
}

async function restoreMacTorchBinaries(python) {
  if (process.platform !== 'darwin') return;
  const { stdout } = await run(python, ['-c', 'import pathlib, torch; print(pathlib.Path(torch.__file__).parent)'], { capture: true });
  const sourceRoot = stdout.trim().split(/\r?\n/).at(-1);
  const targetRoot = path.join(runtimeDir, '_internal', 'torch');
  const restored = [];
  async function walk(relative = '') {
    const sourceDir = path.join(sourceRoot, relative);
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith('.dylib') || entry.name.endsWith('.so')) {
        const target = path.join(targetRoot, child);
        try { await access(target); } catch { continue; }
        await copyFile(path.join(sourceRoot, child), target);
        await run('codesign', ['--force', '--sign', '-', target]);
        restored.push(child);
      }
    }
  }
  await walk();
  console.log(`[runtime-build] restored ${restored.length} original Torch binaries after PyInstaller processing`);
}

const python = process.env.MEETING_RUNTIME_BUILD_PYTHON
  ? path.resolve(process.env.MEETING_RUNTIME_BUILD_PYTHON)
  : buildPython;
try { await run(python, ['-c', 'import PyInstaller']); }
catch { throw new Error('Offline Runtime build environment is missing. Run: npm run setup:runtime-build'); }

await rm(runtimeDir, { recursive: true, force: true });
await rm(workDir, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const collectAll = ['faster_whisper', 'ctranslate2'];
const collectSubmodules = ['transformers.models.qwen3', 'transformers.models.qwen3_asr'];
const hiddenImports = ['uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto',
  'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on',
  'modelscope.hub.snapshot_download'];
const args = ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'meeting-runtime',
  '--distpath', outputRoot, '--workpath', workDir, '--specpath', workDir, '--paths', path.join(root, 'python'),
  '--contents-directory', '_internal'];
for (const name of collectAll) args.push('--collect-all', name);
for (const name of collectSubmodules) args.push('--collect-submodules', name);
for (const name of hiddenImports) args.push('--hidden-import', name);
args.push(path.join(root, 'python', 'main.py'));

console.log(`[runtime-build] building ${process.platform}/${process.arch} with ${python}`);
await run(python, args, { env: { ...process.env, PYINSTALLER_CONFIG_DIR: cacheDir } });
await access(executable);
await restoreMacTorchBinaries(python);
const verification = await run(executable, [], {
  capture: true,
  env: { ...process.env, MEETING_RUNTIME_VERIFY_ONLY: '1', MEETING_MODELS_DIR: path.join(os.tmpdir(), 'meeting-runtime-models') }
});
const healthLine = verification.stdout.trim().split(/\r?\n/).findLast((line) => line.startsWith('{'));
if (!healthLine) throw new Error(`Bundled Runtime verification did not return JSON: ${verification.stdout} ${verification.stderr}`);
const health = JSON.parse(healthLine);
if (!health.dependencies?.ok) throw new Error(`Bundled Runtime dependency verification failed: ${healthLine}`);

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executableStat = await stat(executable);
const manifest = {
  schemaVersion: 1,
  appVersion: packageJson.version,
  platform: process.platform,
  arch: process.arch,
  buildPython: health.capabilities?.python || null,
  torch: health.capabilities?.torch || null,
  transformers: health.capabilities?.transformers || null,
  executableBytes: executableStat.size,
  bundledFeatures: ['base-runtime'],
  excludedFeatures: ['alignment-ja', 'alignment-ko', 'diarization', 'qwen-streaming-vllm'],
  builtAt: new Date().toISOString()
};
await writeFile(path.join(runtimeDir, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`[runtime-build] PASS ${runtimeDir}`);
