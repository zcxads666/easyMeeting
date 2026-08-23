import { access } from 'node:fs/promises';
import path from 'node:path';

export function projectPythonCandidates(root, platform = process.platform) {
  const venv = path.join(root, 'python', '.venv');
  return platform === 'win32'
    ? [path.join(venv, 'Scripts', 'python.exe')]
    : [path.join(venv, 'bin', 'python3'), path.join(venv, 'bin', 'python')];
}

export async function resolveProjectPython(root, options = {}) {
  const candidates = options.explicit
    ? [path.resolve(options.explicit)]
    : projectPythonCandidates(root, options.platform);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next platform-appropriate executable name.
    }
  }

  throw new Error(
    `Project Python environment not found (${candidates.join(', ')}). ` +
    'Run: npm run setup:python'
  );
}
