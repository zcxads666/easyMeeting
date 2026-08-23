import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const venv = path.join(root, 'python', '.venv');
const venvPython = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
try { await access(venvPython); }
catch {
  const systemPython = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  console.log(`[python-setup] creating ${venv}`); await run(systemPython, ['-m', 'venv', venv]);
}
await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
await run(venvPython, ['-m', 'pip', 'install', '-r', path.join(root, 'python', 'requirements.txt')]);
