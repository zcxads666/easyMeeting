import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveProjectPython } from './python-path.mjs';

const root = path.resolve(import.meta.dirname, '..');
let python;
try {
  python = await resolveProjectPython(root, { explicit: process.env.MEETING_TEST_PYTHON });
} catch (error) {
  console.error(`[python-test] ${error.message}`);
  process.exit(2);
}
const child = spawn(python, ['-m', 'unittest', 'discover', '-s', 'python/tests', '-p', 'test_*.py'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
});
child.on('error', (error) => { console.error(`[python-test] 无法启动 ${python}: ${error.message}`); process.exit(2); });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
