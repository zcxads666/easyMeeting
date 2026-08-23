import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractFile, listPackage, uncache } from '@electron/asar';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
async function findArchives(directory) {
  const archives = [];
  async function walk(current) {
  for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) await walk(file); else if (entry.name === 'app.asar') archives.push(file);
  }
  }
  await walk(directory); return archives;
}
const required = ['electron/main.js', 'electron/preload.cjs', 'server/index.js', 'web/dist/index.html',
  'python/main.py', 'python/model_manager.py', 'python/forced_aligner.py', 'python/diarization.py',
  'python/streaming_vllm.py', 'python/requirements.txt', 'python/requirements-diarization.txt',
  'python/requirements-streaming.txt', 'package.json'];
const forbidden = [/^python\/\.venv(\/|$)/, /^models(\/|$)/, /^data(\/|$)/,
  /^settings\.json$/, /^logs?(\/|$)/, /^secrets\.json$/, /^(?:python\/)?\.cache(\/|$)/,
  /^(?:meetings|uploads)(\/|$)/, /(?:pyannote|qwen|vllm).*(?:\.safetensors|\.bin)$/i];
export async function verifyPackage(input) {
 const target = path.resolve(input); const archives = await findArchives(target);
 if (!archives.length) throw new Error(`[verify-package] app.asar not found under ${target}; package with electron-builder first`);
 const verified = [];
 for (const archive of archives) {
  uncache(archive);
  const listed = listPackage(archive).map((line) => line.replace(/^[/\\]/, '').replaceAll('\\', '/')).filter(Boolean);
  for (const file of required) if (!listed.includes(file)) throw new Error(`[verify-package] ${path.basename(path.dirname(archive))}: missing ${file}`);
  const forbiddenFile = listed.find((file) => forbidden.some((pattern) => pattern.test(file)));
  if (forbiddenFile) throw new Error(`[verify-package] forbidden path: ${forbiddenFile}`);
  const textCandidates = listed.filter((file) => /\.(?:js|json|html|py|md|txt)$/.test(file) && !file.startsWith('node_modules/'));
  for (const file of textCandidates) {
    let content;
    try { content = extractFile(archive, file).toString('utf8'); }
    catch { continue; }
    if (content.includes('SECRET_TEST_123456')) throw new Error(`[verify-package] test credential found in ${file}`);
  }
  console.log(`[verify-package] PASS ${archive} (${listed.length} entries)`);
  verified.push({ archive, entries: listed.length });
 }
 return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await verifyPackage(process.argv[2] || path.join(root, 'release', 'desktop'));
}
