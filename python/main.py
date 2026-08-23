import json
import base64
import os
import functools
import threading
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

import model_manager
import transcribe_whisper
import transcribe_qwen
import forced_aligner
import diarization
import streaming_vllm
import runtime

app = FastAPI(title="Meeting Local Inference")
_inference_lock = threading.RLock()


def _prepare_workload(kind, request=None):
    """Keep only the selected heavy cache and serialize local inference families."""
    if not kind.startswith("streaming") and streaming_vllm.active_sessions():
        raise HTTPException(status_code=409, detail={"code": "MODEL_BUSY", "message": "true-streaming 会话正在使用本地模型"})
    selected = kind
    if kind == "transcribe": selected = getattr(request, "engine", None)
    if kind == "benchmark": selected = "whisper" if getattr(request, "id", "").startswith("whisper-") else "qwen"
    if selected != "whisper": transcribe_whisper.release()
    if selected != "qwen": transcribe_qwen.release()
    if selected != "alignment": forced_aligner.release()
    if selected != "diarization": diarization.release()


def serialized_inference(kind):
    def decorate(function):
        @functools.wraps(function)
        def wrapped(*args, **kwargs):
            request = args[0] if args else next(iter(kwargs.values()), None)
            with _inference_lock:
                _prepare_workload(kind, request)
                return function(*args, **kwargs)
        return wrapped
    return decorate


class TranscribeReq(BaseModel):
    file: Optional[str] = None
    pcm: Optional[str] = None  # base64
    engine: str = "whisper"
    model: str = "whisper-small"
    language: Optional[str] = None
    device: str = "auto"
    compute_type: Optional[str] = None
    audio_start: Optional[float] = None
    audio_end: Optional[float] = None


class DownloadReq(BaseModel):
    id: str
    token: Optional[str] = None


class SwitchReq(BaseModel):
    id: str

class BenchmarkReq(BaseModel):
    id: str
    file: str
    device: str = "auto"
    compute_type: Optional[str] = None
    warmup_runs: int = Field(default=1, ge=0, le=3)
    measured_runs: int = Field(default=1, ge=1, le=3)


class AlignmentReq(BaseModel):
    file: str
    text: str
    language: str
    model: str = forced_aligner.DEFAULT_MODEL
    device: str = "auto"


class DiarizationReq(BaseModel):
    file: str
    model: str = diarization.DEFAULT_MODEL
    device: str = "auto"
    num_speakers: Optional[int] = Field(default=None, ge=1, le=100)
    min_speakers: Optional[int] = Field(default=None, ge=1, le=100)
    max_speakers: Optional[int] = Field(default=None, ge=1, le=100)


class StreamStartReq(BaseModel):
    model: str = "Qwen/Qwen3-ASR-0.6B-hf"


class StreamAudioReq(BaseModel):
    session_id: str
    pcm: str


class StreamStopReq(BaseModel):
    session_id: str


@app.get("/health")
def health():
    return {"ok": True, "models_dir": str(model_manager.MODELS_DIR)}

@app.get("/runtime/capabilities")
def runtime_capabilities(): return {**runtime.capabilities(), "streaming": streaming_vllm.capability()}

@app.get("/runtime/health")
def runtime_health(): return runtime.health()


@app.get("/models")
def list_models():
    return {"models": model_manager.list_models(), "disk_usage": model_manager.disk_usage()}


@app.get("/models/download/status")
def download_status():
    return {"downloads": model_manager.download_manager.all_status()}


@app.post("/models/download")
async def download(req: DownloadReq):
    try: return {"ok": True, "id": req.id, **model_manager.download_manager.start(req.id, req.token)}
    except model_manager.ModelLifecycleError as e:
        raise HTTPException(status_code=400, detail={"code": e.code, "message": str(e), **e.details})


@app.post("/models/download/cancel")
async def cancel_download(req: DownloadReq):
    accepted = model_manager.download_manager.cancel(req.id)
    return {"ok": accepted, "id": req.id, "status": model_manager.download_manager.status(req.id)}


@app.post("/models/verify")
async def verify_download(req: DownloadReq):
    try:
        if req.id not in model_manager.known_ids(): raise model_manager.ModelLifecycleError("MODEL_UNKNOWN", f"未知模型: {req.id}")
        model_manager.download_manager._set(req.id, status="checking", error=None)
        with model_manager.model_operation(req.id):
            result = model_manager.verify_model(req.id)
            model_manager.download_manager._set(req.id, status=result["status"], error=result.get("error"))
            return result
    except model_manager.ModelLifecycleError as e:
        model_manager.download_manager._set(req.id, status="error", error={"code": e.code, "message": str(e)})
        raise HTTPException(status_code=409, detail={"code": e.code, "message": str(e)})


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
        return model_manager.delete(model_id, lambda: (transcribe_whisper.release(), transcribe_qwen.release(), forced_aligner.release(), diarization.release(), streaming_vllm.release()))
    except model_manager.ModelLifecycleError as e:
        raise HTTPException(status_code=409 if e.code == "MODEL_BUSY" else 400,
                            detail={"code": e.code, "message": str(e), **e.details})
    except Exception as e: raise HTTPException(status_code=400, detail=str(e))


@app.post("/models/benchmark")
@serialized_inference("benchmark")
def benchmark(req: BenchmarkReq):
    pcm = _read_uploads_file(req.file)
    try:
        state = model_manager.verify_model(req.id)
        if state["status"] != "ready": raise model_manager.ModelLifecycleError("MODEL_NOT_READY", "模型尚未就绪", status=state["status"])
        with model_manager.model_operation(req.id):
            if req.id.startswith("whisper-"):
                return transcribe_whisper.benchmark_pcm(pcm, req.id.removeprefix("whisper-"), req.device,
                    req.compute_type, req.warmup_runs, req.measured_runs)
            return transcribe_qwen.benchmark_pcm(pcm, req.id, req.device, req.warmup_runs, req.measured_runs)
    except model_manager.ModelLifecycleError as e:
        raise HTTPException(status_code=409, detail={"code": e.code, "message": str(e), **e.details})


@app.post("/align")
@serialized_inference("alignment")
def align(req: AlignmentReq):
    pcm = _read_uploads_file(req.file)
    try:
        state = model_manager.verify_model(req.model)
        if state["status"] != "ready":
            raise model_manager.ModelLifecycleError("ALIGNER_NOT_INSTALLED", "Forced Aligner 模型尚未就绪", status=state["status"])
        with model_manager.model_operation(req.model):
            return forced_aligner.align_pcm(pcm, req.text, req.language, req.model, req.device)
    except model_manager.ModelLifecycleError as exc:
        raise HTTPException(status_code=409, detail={"code": exc.code, "message": str(exc), **exc.details})
    except forced_aligner.AlignmentRuntimeError as exc:
        status = 409 if exc.code in {"ALIGNER_NOT_INSTALLED", "ALIGNMENT_LANGUAGE_DEPENDENCY_MISSING"} else 400 if exc.code.startswith("ALIGNMENT_") else 500
        raise HTTPException(status_code=status, detail={"code": exc.code, "message": str(exc), **exc.context})


@app.post("/diarize")
@serialized_inference("diarization")
def diarize(req: DiarizationReq):
    _read_uploads_file(req.file)  # path boundary and existence check; pyannote streams the WAV itself.
    try:
        state = model_manager.verify_model(req.model)
        if state["status"] != "ready":
            raise model_manager.ModelLifecycleError("DIARIZATION_MODEL_NOT_INSTALLED", "说话人分离模型尚未就绪", status=state["status"])
        with model_manager.model_operation(req.model):
            return diarization.diarize_file(req.file, req.model, req.device, req.num_speakers, req.min_speakers, req.max_speakers)
    except model_manager.ModelLifecycleError as exc:
        raise HTTPException(status_code=409, detail={"code": exc.code, "message": str(exc), **exc.details})
    except diarization.DiarizationRuntimeError as exc:
        status = 409 if exc.code in {"DIARIZATION_RUNTIME_NOT_INSTALLED", "DIARIZATION_MODEL_NOT_INSTALLED"} else 400 if "DEVICE" in exc.code else 500
        raise HTTPException(status_code=status, detail={"code": exc.code, "message": str(exc), **exc.context})


def _stream_error(exc):
    return HTTPException(status_code=409 if exc.code in {"TRUE_STREAMING_UNAVAILABLE", "MODEL_NOT_READY", "MODEL_BUSY"} else 400,
                         detail={"code": exc.code, "message": str(exc), **exc.details})


@app.post("/streaming/start")
@serialized_inference("streaming")
def streaming_start(req: StreamStartReq):
    try: return streaming_vllm.start(req.model)
    except streaming_vllm.StreamingRuntimeError as exc: raise _stream_error(exc)


@app.post("/streaming/send")
@serialized_inference("streaming-send")
def streaming_send(req: StreamAudioReq):
    try: return streaming_vllm.send(req.session_id, base64.b64decode(req.pcm))
    except streaming_vllm.StreamingRuntimeError as exc: raise _stream_error(exc)


@app.post("/streaming/stop")
@serialized_inference("streaming-send")
def streaming_stop(req: StreamStopReq):
    try: return streaming_vllm.stop(req.session_id)
    except streaming_vllm.StreamingRuntimeError as exc: raise _stream_error(exc)


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
@serialized_inference("transcribe")
def transcribe(req: TranscribeReq):
    if req.file:
        pcm = _read_uploads_file(req.file)
    elif req.pcm:
        pcm = base64.b64decode(req.pcm)
    else:
        raise HTTPException(status_code=400, detail="需提供 file 或 pcm")

    try:
        with model_manager.model_operation(req.model):
            if req.engine == "qwen": return transcribe_qwen.transcribe_pcm(pcm, req.model, req.language, req.device)
            if req.engine == "whisper":
                size = req.model.replace("whisper-", "")
                return transcribe_whisper.transcribe_pcm(pcm, size, req.language, req.device, req.compute_type)
            raise ValueError(f"未知本地 ASR engine: {req.engine}")
    except (ValueError, FileNotFoundError) as e:
        raise HTTPException(status_code=400, detail={"message": str(e), "type": type(e).__name__})
    except transcribe_qwen.QwenRuntimeError as e:
        raise HTTPException(status_code=500, detail={"message": str(e), **e.context})
    except Exception as e:
        code = runtime.inference_error_code(e, "LOCAL_INFERENCE_FAILED")
        raise HTTPException(status_code=500, detail={"code": code,
            "message": runtime.inference_error_message(e, "本地模型推理失败"),
            "technical": f"{type(e).__name__}: {e}", "type": type(e).__name__})


if __name__ == "__main__":
    import uvicorn
    # 端口由 Node 侧动态分配（被占用时自动更换），默认 8300
    port = int(os.environ.get("MEETING_PY_PORT", "8300"))
    uvicorn.run(app, host="127.0.0.1", port=port)
