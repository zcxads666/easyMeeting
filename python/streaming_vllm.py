"""Optional official qwen-asr vLLM streaming backend.

The official API is stateful: init_streaming_state -> streaming_transcribe ->
finish_streaming_transcribe. It does not return timestamps.
"""
from __future__ import annotations

import importlib.util
import logging
import platform
import threading
import uuid

import numpy as np

import model_manager
import runtime

logger = logging.getLogger("meeting.streaming")
_model = None
_model_key = None
_model_guard = threading.Lock()
_sessions = {}
_sessions_guard = threading.Lock()


class StreamingRuntimeError(RuntimeError):
    def __init__(self, code, message, **details):
        super().__init__(message); self.code = code; self.details = details


def capability(torch_module=None):
    system = platform.system().lower()
    try:
        torch = torch_module or runtime._torch()
        cuda = bool(torch.cuda.is_available())
    except RuntimeError: cuda = False
    qwen_asr = importlib.util.find_spec("qwen_asr") is not None
    vllm = importlib.util.find_spec("vllm") is not None
    supported_platform = system == "linux"
    available = supported_platform and cuda and qwen_asr and vllm
    reasons = []
    if not supported_platform: reasons.append("vLLM true streaming 当前仅支持 Linux")
    if not cuda: reasons.append("未检测到 CUDA")
    if not qwen_asr or not vllm: reasons.append("qwen-asr[vllm] optional Runtime 未安装")
    return {"available": available, "supported": supported_platform, "cudaRequired": True,
            "backend": "qwen-asr-vllm", "reason": "; ".join(reasons) if reasons else None}


def load(model_id, **kwargs):
    global _model, _model_key
    cap = capability()
    if not cap["available"]: raise StreamingRuntimeError("TRUE_STREAMING_UNAVAILABLE", cap["reason"], capability=cap)
    state = model_manager.verify_model(model_id)
    if state["status"] != "ready": raise StreamingRuntimeError("MODEL_NOT_READY", "本地 Qwen 模型尚未就绪", status=state["status"])
    local = str(model_manager.model_dir(model_id))
    key = (model_id, local, "qwen-asr-vllm")
    with _model_guard:
        if _model is not None and _model_key == key: return _model
        if _sessions: raise StreamingRuntimeError("MODEL_BUSY", "仍有 true-streaming 会话使用当前模型")
        from qwen_asr import Qwen3ASRModel
        try:
            _model = Qwen3ASRModel.LLM(model=local, gpu_memory_utilization=float(kwargs.get("gpu_memory_utilization", .8)), max_new_tokens=32)
        except Exception as exc:
            logger.exception("vLLM streaming model load failed type=%s", type(exc).__name__)
            raise StreamingRuntimeError("TRUE_STREAMING_LOAD_FAILED", "vLLM streaming 模型加载失败", technical=f"{type(exc).__name__}: {exc}") from exc
        _model_key = key
        return _model


def start(model_id, **kwargs):
    model = load(model_id, **kwargs)
    state = model.init_streaming_state(unfixed_chunk_num=2, unfixed_token_num=5, chunk_size_sec=2.0)
    session_id = str(uuid.uuid4())
    model_manager.retain_model(model_id)
    with _sessions_guard: _sessions[session_id] = {"model": model, "model_id": model_id, "state": state, "lastText": ""}
    return {"sessionId": session_id, "mode": "true-streaming", "backend": "qwen-asr-vllm", "supportsTimestamps": False}


def send(session_id, pcm_bytes):
    with _sessions_guard: session = _sessions.get(session_id)
    if not session: raise StreamingRuntimeError("STREAMING_SESSION_NOT_FOUND", "true-streaming 会话不存在")
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    session["model"].streaming_transcribe(samples, session["state"])
    text = str(session["state"].text or "")
    changed = text != session["lastText"]; session["lastText"] = text
    return {"text": text, "language": getattr(session["state"], "language", None), "changed": changed,
            "timing": "unknown", "start": None, "end": None}


def stop(session_id):
    with _sessions_guard: session = _sessions.pop(session_id, None)
    if not session: raise StreamingRuntimeError("STREAMING_SESSION_NOT_FOUND", "true-streaming 会话不存在")
    try:
        session["model"].finish_streaming_transcribe(session["state"])
        return {"text": str(session["state"].text or ""), "language": getattr(session["state"], "language", None),
                "timing": "unknown", "start": None, "end": None}
    finally: model_manager.release_model(session["model_id"])


def release():
    global _model, _model_key
    with _sessions_guard:
        if _sessions: raise StreamingRuntimeError("MODEL_BUSY", "仍有 true-streaming 会话，不能释放模型")
    _model = None; _model_key = None
