const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

const execFileAsync = promisify(execFile);

async function findApp(directory, depth = 0) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) return file;
    if (entry.isDirectory() && depth < 1) {
      const nested = await findApp(file, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

module.exports = async function artifactBuildCompleted(event) {
  if (process.platform !== 'darwin' || !event.file.endsWith('.zip')) return;
  const app = await findApp(path.dirname(event.file));
  if (!app) throw new Error(`[mac-zip] .app not found beside ${event.file}`);

  const temporary = `${event.file}.native.tmp`;
  await fs.rm(temporary, { force: true });
  await execFileAsync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, temporary]);
  await execFileAsync('unzip', ['-tq', temporary]);
  await fs.rename(temporary, event.file);

  const blockMapFile = `${event.file}.blockmap`;
  event.updateInfo = await buildBlockMap(event.file, 'gzip', blockMapFile);
  console.log(`[mac-zip] rebuilt and verified with ditto: ${event.file}`);
};
