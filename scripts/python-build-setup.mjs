import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const venv = path.join(root, 'release', 'runtime-venv');
const venvPython = process.platform === 'win32'
  ? path.join(venv, 'Scripts', 'python.exe')
  : path.join(venv, 'bin', 'python');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

try {
  await access(venvPython);
} catch {
  const systemPython = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  await mkdir(path.dirname(venv), { recursive: true });
  console.log(`[runtime-build-setup] creating isolated build environment ${venv}`);
  await run(systemPython, ['-m', 'venv', venv]);
}

await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
await run(venvPython, ['-m', 'pip', 'install',
  '-r', path.join(root, 'python', 'requirements.txt'),
  '-r', path.join(root, 'python', 'requirements-build.txt')]);
console.log(`[runtime-build-setup] ready ${venvPython}`);
