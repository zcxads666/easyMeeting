import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const candidates = process.platform === 'win32'
  ? [path.join(root, 'python', '.venv', 'Scripts', 'python.exe')]
  : [path.join(root, 'python', '.venv', 'bin', 'python3'), path.join(root, 'python', '.venv', 'bin', 'python')];
let python = null;
for (const candidate of candidates) { try { await access(candidate); python = candidate; break; } catch { /* next */ } }
if (!python) {
  console.error('[python-test] 项目 Python 环境不存在。请先运行: npm run setup:python');
  process.exit(2);
}
const child = spawn(python, ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_*.py'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
});
child.on('error', (error) => { console.error(`[python-test] 无法启动 ${python}: ${error.message}`); process.exit(2); });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
