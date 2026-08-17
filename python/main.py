import json
import base64
import threading
import time
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional

import model_manager
import transcribe_whisper
import transcribe_qwen

app = FastAPI(title="Meeting Local Inference")


class TranscribeReq(BaseModel):
    file: Optional[str] = None
    pcm: Optional[str] = None  # base64
    engine: str = "whisper"
    model: str = "whisper-small"
    language: Optional[str] = None


class DownloadReq(BaseModel):
    id: str


class SwitchReq(BaseModel):
    id: str


# 后台下载状态追踪
_download_status = {}  # id -> {status, progress, error, started}
_download_lock = threading.Lock()


@app.get("/health")
def health():
    return {"ok": True, "models_dir": str(model_manager.MODELS_DIR)}


@app.get("/models")
def list_models():
    return {"models": model_manager.list_models(), "disk_usage": model_manager.disk_usage()}


@app.get("/models/download/status")
def download_status():
    with _download_lock:
        return {"downloads": dict(_download_status)}


def _do_download(model_id: str):
    try:
        model_manager.download(model_id)
        with _download_lock:
            _download_status[model_id] = {"status": "completed", "progress": 100}
    except Exception as e:
        with _download_lock:
            _download_status[model_id] = {"status": "failed", "error": str(e)}


@app.post("/models/download")
async def download(req: DownloadReq):
    if req.id not in model_manager.known_ids():
        with _download_lock:
            _download_status[req.id] = {"status": "failed", "error": f"未知模型: {req.id}"}
        raise HTTPException(status_code=400, detail=f"未知模型: {req.id}")
    with _download_lock:
        existing = _download_status.get(req.id)
        if existing and existing.get("status") == "downloading":
            return {"ok": True, "id": req.id, "status": "already_downloading"}
        if existing and existing.get("status") == "completed":
            return {"ok": True, "id": req.id, "status": "completed"}
        _download_status[req.id] = {"status": "downloading", "progress": 0, "started": time.time()}
    t = threading.Thread(target=_do_download, args=(req.id,), daemon=True)
    t.start()
    return {"ok": True, "id": req.id, "status": "downloading"}


@app.post("/models/switch")
async def switch_model(req: SwitchReq):
    try:
        m = model_manager.switch(req.id)
        return {"ok": True, "model": m}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/models/{model_id:path}")
async def delete_model(model_id: str):
    try:
        return model_manager.delete(model_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _read_uploads_file(file_path: str) -> bytes:
    data_dir = os.environ.get("MEETING_DATA_DIR")
    if not data_dir:
        raise HTTPException(status_code=400, detail="未配置数据目录，拒绝读取本地文件")
    root = (Path(data_dir) / "uploads").resolve()
    p = Path(file_path).resolve()
    try:
        p.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="file 仅允许 uploads 目录")
    if not p.is_file():
        raise HTTPException(status_code=400, detail="文件不存在")
    return p.read_bytes()


@app.post("/transcribe")
def transcribe(req: TranscribeReq):
    if req.file:
        pcm = _read_uploads_file(req.file)
    elif req.pcm:
        pcm = base64.b64decode(req.pcm)
    else:
        raise HTTPException(status_code=400, detail="需提供 file 或 pcm")

    try:
        if req.engine == "qwen":
            return transcribe_qwen.transcribe_pcm(pcm, req.model, req.language)
        else:
            size = req.model.replace("whisper-", "")
            return transcribe_whisper.transcribe_pcm(pcm, size, req.language)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"转写失败: {e}")


if __name__ == "__main__":
    import uvicorn
    # 端口由 Node 侧动态分配（被占用时自动更换），默认 8300
    port = int(os.environ.get("MEETING_PY_PORT", "8300"))
    uvicorn.run(app, host="127.0.0.1", port=port)
