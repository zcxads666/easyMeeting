import json
import base64
import tempfile
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


@app.get("/health")
def health():
    return {"ok": True, "models_dir": str(model_manager.MODELS_DIR)}


@app.get("/models")
def list_models():
    return {"models": model_manager.list_models(), "disk_usage": model_manager.disk_usage()}


@app.post("/models/download")
async def download(req: DownloadReq):
    try:
        path = model_manager.download(req.id)
        return {"ok": True, "id": req.id, "path": str(path)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"下载失败: {e}")


@app.post("/models/switch")
async def switch_model(req: SwitchReq):
    try:
        m = model_manager.switch(req.id)
        return {"ok": True, "model": m}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/models/{model_id}")
async def delete_model(model_id: str):
    try:
        return model_manager.delete(model_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/transcribe")
def transcribe(req: TranscribeReq):
    if req.file:
        pcm = Path(req.file).read_bytes()
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
    uvicorn.run(app, host="127.0.0.1", port=8300)