/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTestDirs, rmTestDirs } from '../helpers/tempdir.js';
import { resolveProjectPython } from '../../scripts/python-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PY = await resolveProjectPython(ROOT, { explicit: process.env.MEETING_TEST_PYTHON });

test('产品目录使用可下载的 Qwen3-ASR Hub id，不含 Flash/FileTrans', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'python/model_manager.py'), 'utf8');
  assert.doesNotMatch(src, /Qwen3-ASR-Flash/);
  assert.doesNotMatch(src, /FileTrans/);
  assert.match(src, /Qwen\/Qwen3-ASR-0\.6B-hf/);
  assert.match(src, /Qwen\/Qwen3-ASR-1\.7B-hf/);
  assert.match(src, /MODEL_CATALOG/);
});

test('FastAPI delete 路由支持带斜杠 model_id', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'python/main.py'), 'utf8');
  assert.match(src, /models\/\{model_id:path\}/);
});

test('未知模型 download 立刻 failed；斜杠 id 的 delete 能匹配', async () => {
  await fsp.access(PY);
  const { modelsDir } = makeTestDirs();
  const script = `
import asyncio, json, os, sys
from fastapi import HTTPException
os.environ["MEETING_MODELS_DIR"] = sys.argv[1]
import main

async def run():
    try:
        await main.download(main.DownloadReq(id="not-a-real-model"))
        dl_code, dl_body = 200, {}
    except HTTPException as exc:
        dl_code, dl_body = exc.status_code, {"detail": exc.detail}
    st_body = main.download_status()
    try:
        del_body = await main.delete_model("Qwen/Qwen3-ASR-0.6B-hf")
        del_code = 200
    except HTTPException as exc:
        del_code, del_body = exc.status_code, {"detail": exc.detail}
    main.model_manager.download_manager.records["whisper-tiny"] = {"status": "downloading", "progress": None}
    again_body = await main.download(main.DownloadReq(id="whisper-tiny"))
    print(json.dumps({"download_status": dl_code, "download_body": dl_body,
      "status_map": st_body.get("downloads", {}), "delete_status": del_code,
      "delete_body": del_body, "completed_again": again_body}))

asyncio.run(run())
`;
  const out = await new Promise((resolve, reject) => {
    const child = spawn(PY, ['-c', script, modelsDir], {
      cwd: path.join(ROOT, 'python'),
      env: { ...process.env, MEETING_MODELS_DIR: modelsDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || stdout || `exit ${code}`));
      else resolve(stdout);
    });
  });
  const result = JSON.parse(out.trim().split('\n').filter(Boolean).at(-1));
  assert.equal(result.download_status, 400);
  assert.match(JSON.stringify(result.download_body), /未知模型/);
  const unk = result.status_map['not-a-real-model'];
  assert.equal(unk, undefined, '未知模型不应污染受支持模型状态');
  assert.notEqual(result.delete_status, 404, `斜杠 id delete 应能匹配路由, got ${result.delete_status} ${JSON.stringify(result.delete_body)}`);
  assert.equal(result.completed_again?.alreadyDownloading, true);
  await rmTestDirs(modelsDir);
});

test('Express 模型删除路由匹配带斜杠 id', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'server/routes/models.js'), 'utf8');
  assert.match(src, /delete\(\/\^\\\/\(\.\+\)\$\//);
  assert.match(src, /encodeURIComponent\(id\)/);
});
