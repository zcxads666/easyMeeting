import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPackage } from '@electron/asar';
import { verifyPackage } from '../../scripts/verify-package.mjs';
import { projectPythonCandidates } from '../../scripts/python-path.mjs';
import { lazyRouter } from '../../server/services/lazy-router.js';

test('lazyRouter 只在首次请求加载模块并复用 Router', async () => {
  let loads = 0; let calls = 0;
  const middleware = lazyRouter(async () => {
    loads++;
    return { default: (_req, _res, next) => { calls++; next(); } };
  });
  const invoke = () => new Promise((resolve, reject) => middleware({}, {}, (error) => error ? reject(error) : resolve()));
  assert.equal(loads, 0);
  await invoke(); await invoke();
  assert.equal(loads, 1); assert.equal(calls, 2);
});

test('Models UI 覆盖 lifecycle、真实 progress、benchmark 取消和自动切换', async () => {
  const source = await fsp.readFile('web/src/pages/Models.jsx', 'utf8');
  for (const state of ['not_installed', 'checking', 'queued', 'downloading', 'verifying', 'ready', 'cancelled', 'broken', 'deleting', 'error']) assert.match(source, new RegExp(state));
  assert.match(source, /downloadedBytes/); assert.match(source, /speedBytesPerSecond/);
  assert.match(source, /modelLoadMs/); assert.match(source, /realtimeFactor/); assert.match(source, /性能测试/);
  assert.match(source, /onCancelBenchmark/); assert.match(source, /provider: 'local'/); assert.match(source, /自动切换/);
  assert.doesNotMatch(source, /width:\s*dlStatus[^\n]*40%/, '不得保留伪造 40% 下载进度');
});

test('benchmark 只处理短音频并提供心跳/超时，避免长时间无反馈', async () => {
  const [route, python] = await Promise.all([
    fsp.readFile('server/routes/models.js', 'utf8'), fsp.readFile('python/main.py', 'utf8')
  ]);
  assert.match(route, /BENCHMARK_MAX_SECONDS = 15/);
  assert.match(route, /durationSeconds: BENCHMARK_MAX_SECONDS/);
  assert.match(route, /setInterval\(\(\) =>/);
  assert.match(route, /10 \* 60 \* 1000/);
  assert.match(python, /BENCHMARK_MAX_SECONDS = 15/);
});

test('Python test runner 明确选择项目 venv 的跨平台路径', async () => {
  const [runner, pkg] = await Promise.all([fsp.readFile('scripts/python-test.mjs', 'utf8'), fsp.readFile('package.json', 'utf8')]);
  assert.match(projectPythonCandidates('/repo', 'win32')[0], /python[\\/]\.venv[\\/]Scripts[\\/]python\.exe$/);
  assert.match(projectPythonCandidates('/repo', 'linux')[0], /python[\\/]\.venv[\\/]bin[\\/]python3$/);
  assert.match(runner, /resolveProjectPython/);
  assert.match(pkg, /node scripts\/python-test\.mjs/);
});

test('桌面包强制构建并加载离线 Runtime 与媒体工具', async () => {
  const [pkg, main, pythonService, artifactHook, desktopBuild] = await Promise.all([
    fsp.readFile('package.json', 'utf8'), fsp.readFile('electron/main.js', 'utf8'),
    fsp.readFile('server/services/python.js', 'utf8'), fsp.readFile('scripts/artifact-build-completed.cjs', 'utf8'),
    fsp.readFile('scripts/build-desktop.mjs', 'utf8')
  ]);
  assert.match(pkg, /npm run build:runtime && node scripts\/build-desktop\.mjs/);
  for (const resource of ['runtime/meeting-runtime', 'tools/ffmpeg', 'tools/ffprobe']) assert.match(pkg, new RegExp(resource));
  assert.match(main, /MEETING_BUNDLED_RUNTIME_DIR/); assert.match(main, /FFMPEG_PATH/); assert.match(main, /FFPROBE_PATH/);
  assert.match(pythonService, /BUNDLED_RUNTIME_EXECUTABLE/); assert.match(pythonService, /RUNTIME_BUNDLED_FEATURE_UNAVAILABLE/);
  assert.match(pkg, /artifact-build-completed\.cjs/); assert.match(artifactHook, /ditto/); assert.match(artifactHook, /buildBlockMap/);
  assert.match(desktopBuild, /hdiutil/); assert.match(desktopBuild, /verbatimSymlinks/); assert.match(desktopBuild, /MEETING_RUNTIME_VERIFY_ONLY/);
});

test('package verifier 接受内置 Runtime/FFmpeg 的完整包并拒绝用户 settings', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'meeting-asar-')); const source = path.join(temp, 'source');
  const required = ['electron/main.js', 'electron/preload.cjs', 'server/index.js', 'web/dist/index.html',
    'python/main.py', 'python/model_manager.py', 'python/forced_aligner.py', 'python/diarization.py', 'python/streaming_vllm.py',
    'python/requirements.txt', 'python/requirements-diarization.txt', 'python/requirements-streaming.txt', 'package.json'];
  for (const file of required) { const target = path.join(source, file); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, '{}'); }
  const out = path.join(temp, 'artifact'); await fsp.mkdir(out);
  for (const file of ['runtime/meeting-runtime/meeting-runtime', 'tools/ffmpeg/ffmpeg', 'tools/ffmpeg/LICENSE',
    'tools/ffprobe/ffprobe', 'tools/ffprobe/LICENSE']) {
    const target = path.join(out, file); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, 'binary');
  }
  await fsp.writeFile(path.join(out, 'runtime/meeting-runtime/runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch }));
  await createPackage(source, path.join(out, 'app.asar'));
  const good = await verifyPackage(out); assert.equal(good.length, 1);
  await fsp.mkdir(path.join(source, 'data'), { recursive: true }); await fsp.writeFile(path.join(source, 'data/settings.json'), '{}');
  await fsp.rm(path.join(out, 'app.asar'));
  await createPackage(source, path.join(out, 'app.asar'));
  await assert.rejects(verifyPackage(out), /forbidden path/);
  await fsp.rm(temp, { recursive: true, force: true });
});
