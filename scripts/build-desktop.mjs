import { access, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release', 'desktop');
const isMac = process.platform === 'darwin';
const args = process.argv.slice(2);
const command = process.execPath;
const builderCli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
const builderArgs = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--publish' || arg === '-p') {
    index += 1;
    continue;
  }
  if (arg.startsWith('--publish=')) continue;
  builderArgs.push(arg);
}

function builderEnvironment() {
  const env = { ...process.env };
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    for (const name of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'WIN_CSC_LINK',
      'WIN_CSC_KEY_PASSWORD',
      'CSC_INSTALLER_LINK',
      'CSC_INSTALLER_KEY_PASSWORD'
    ]) delete env[name];
  }
  return env;
}

function runBuilder(outputDir) {
  return new Promise((resolve, reject) => {
    let outputTail = '';
    const child = spawn(command, [
      builderCli,
      ...builderArgs,
      '--publish',
      'never',
      `--config.directories.output=${outputDir}`
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: builderEnvironment() });
    const forward = (chunk, target) => {
      const text = chunk.toString();
      target.write(text);
      outputTail = `${outputTail}${text}`.slice(-16000);
    };
    child.stdout.on('data', (chunk) => forward(chunk, process.stdout));
    child.stderr.on('data', (chunk) => forward(chunk, process.stderr));
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`electron-builder exited with code ${code}\n${outputTail}`)));
  });
}

async function verifyMacArtifacts(outputDir) {
  const entries = await readdir(outputDir);
  const dmgs = entries.filter((entry) => entry.endsWith('.dmg'));
  const zips = entries.filter((entry) => entry.endsWith('.zip'));
  if (!dmgs.length || !zips.length) {
    throw new Error(`[desktop-build] expected DMG and ZIP in ${outputDir}`);
  }
  for (const dmg of dmgs) execFileSync('hdiutil', ['verify', path.join(outputDir, dmg)], { stdio: 'inherit' });
  for (const zip of zips) execFileSync('unzip', ['-tq', path.join(outputDir, zip)], { stdio: 'inherit' });
  const app = path.join(outputDir, `mac-${process.arch}`, 'MeetingNotes.app');
  const runtime = path.join(app, 'Contents', 'Resources', 'runtime', 'meeting-runtime', 'meeting-runtime');
  await access(runtime);
  execFileSync(runtime, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      MEETING_RUNTIME_VERIFY_ONLY: '1',
      MEETING_MODELS_DIR: path.join(os.tmpdir(), 'meeting-desktop-runtime-verify'),
      FFMPEG_PATH: path.join(app, 'Contents', 'Resources', 'tools', 'ffmpeg', 'ffmpeg'),
      FFPROBE_PATH: path.join(app, 'Contents', 'Resources', 'tools', 'ffmpeg', 'ffprobe')
    }
  });
  console.log(`[desktop-build] macOS artifacts and bundled Runtime verified: ${outputDir}`);
}

async function copyArtifacts(sourceDir) {
  await mkdir(releaseDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    await cp(
      path.join(sourceDir, entry.name),
      path.join(releaseDir, entry.name),
      { recursive: entry.isDirectory(), force: true, verbatimSymlinks: true }
    );
  }
  console.log(`[desktop-build] copied verified artifacts to ${releaseDir}`);
}

const localOutput = isMac
  ? await mkdtemp(path.join(os.tmpdir(), 'meeting-desktop-build-'))
  : releaseDir;

try {
  await runBuilder(localOutput);
  if (isMac) {
    await verifyMacArtifacts(localOutput);
    await copyArtifacts(localOutput);
    await verifyMacArtifacts(releaseDir);
  }
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const annotation = message
      .replaceAll('%', '%25')
      .replaceAll('\r', '%0D')
      .replaceAll('\n', '%0A')
      .slice(-9000);
    console.error(`::error title=Desktop packaging failed::${annotation}`);
  }
  throw error;
} finally {
  if (isMac) await rm(localOutput, { recursive: true, force: true });
}
