import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const packageDir = path.resolve(process.argv[2] || path.join(root, 'release', 'desktop'));

async function walk(directory) {
  const result = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file)); else result.push(file);
  }
  return result;
}

function selectExecutable(files) {
  if (process.platform === 'darwin') {
    return files.find((file) => file.endsWith(`${path.sep}MeetingNotes.app${path.sep}Contents${path.sep}MacOS${path.sep}MeetingNotes`));
  }
  if (process.platform === 'win32') {
    return files.find((file) => file.endsWith(`${path.sep}win-unpacked${path.sep}MeetingNotes.exe`));
  }
  return files.find((file) => file.endsWith('.AppImage'));
}

const executable = selectExecutable(await walk(packageDir));
if (!executable) throw new Error(`[startup-smoke] packaged executable not found under ${packageDir}`);

const args = process.platform === 'linux' ? ['--appimage-extract-and-run', '--no-sandbox', '--disable-gpu'] : [];
const startedAt = performance.now();
const child = spawn(executable, args, {
  cwd: root,
  env: { ...process.env, ELECTRON_SMOKE_TEST: '1', ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
const collect = (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text); };
child.stdout.on('data', collect); child.stderr.on('data', collect);
const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
clearTimeout(timeout);
const wallMs = Math.round(performance.now() - startedAt);
if (exitCode !== 0 || !output.includes('[smoke] PASS')) {
  throw new Error(`[startup-smoke] failed exit=${exitCode} wall=${wallMs}ms`);
}
const milestones = Object.fromEntries([...output.matchAll(/\[startup\] ([\w-]+) \+([\d.]+)ms/g)]
  .map((match) => [match[1], Number(match[2])]));
for (const required of ['app-ready', 'splash-visible', 'server-listening', 'main-window-created', 'renderer-finished-load']) {
  if (!Number.isFinite(milestones[required])) throw new Error(`[startup-smoke] missing milestone: ${required}`);
}
console.log(`[startup-smoke] PASS platform=${os.platform()} wall=${wallMs}ms milestones=${JSON.stringify(milestones)}`);
