/* \u4f5c\u8005\uff1a\u9648\u661f\u5408 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTestDirs, rmTestDirs } from '../helpers/tempdir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PY = path.join(ROOT, 'python/.venv/bin/python');

test('产品目录使用可下载的 Qwen3-ASR Hub id，不含 Flash/FileTrans', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'python/model_manager.py'), 'utf8');
  assert.doesNotMatch(src, /Qwen3-ASR-Flash/);
  assert.doesNotMatch(src, /FileTrans/);
  assert.match(src, /Qwen\/Qwen3-ASR-0\.6B/);
  assert.match(src, /Qwen\/Qwen3-ASR-1\.7B/);
});

test('FastAPI delete 路由支持带斜杠 model_id', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'python/main.py'), 'utf8');
  assert.match(src, /models\/\{model_id:path\}/);
});

test('未知模型 download 立刻 failed；斜杠 id 的 delete 能匹配', async () => {
  await fsp.access(PY);
  const { modelsDir } = makeTestDirs();
  const script = `
import json, os, sys, threading, time, socket
from urllib.request import Request, urlopen
from urllib.error import HTTPError

os.environ["MEETING_MODELS_DIR"] = sys.argv[1]
import uvicorn
import main

sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
sock.close()

def serve():
    uvicorn.run(main.app, host="127.0.0.1", port=port, log_level="error")

threading.Thread(target=serve, daemon=True).start()
for _ in range(80):
    try:
        urlopen(f"http://127.0.0.1:{port}/health", timeout=0.2)
        break
    except Exception:
        time.sleep(0.05)
else:
    raise SystemExit("uvicorn not ready")

def req(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    try:
        with urlopen(r, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except HTTPError as e:
        return e.code, json.loads(e.read().decode())

dl_code, dl_body = req("POST", "/models/download", {"id": "not-a-real-model"})
st_code, st_body = req("GET", "/models/download/status")
del_code, del_body = req("DELETE", "/models/Qwen/Qwen3-ASR-0.6B")
main._download_status["whisper-tiny"] = {"status": "completed", "progress": 100}
again_code, again_body = req("POST", "/models/download", {"id": "whisper-tiny"})
print(json.dumps({
  "download_status": dl_code,
  "download_body": dl_body,
  "status_map": st_body.get("downloads", {}),
  "delete_status": del_code,
  "delete_body": del_body,
  "completed_again": again_body
}))
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
  assert.equal(unk?.status, 'failed');
  assert.notEqual(unk?.status, 'downloading');
  assert.notEqual(result.delete_status, 404, `斜杠 id delete 应能匹配路由, got ${result.delete_status} ${JSON.stringify(result.delete_body)}`);
  assert.equal(result.completed_again?.status, 'completed');
  await rmTestDirs(modelsDir);
});

test('Express 模型删除路由匹配带斜杠 id', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'server/routes/models.js'), 'utf8');
  assert.match(src, /delete\(\/\^\\\/\(\.\+\)\$\//);
  assert.match(src, /encodeURIComponent\(id\)/);
});
