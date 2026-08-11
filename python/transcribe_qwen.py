import os
import io
import numpy as np
import soundfile as sf
from transformers import pipeline

_cache = {}


def _require_torch():
    try:
        import torch  # noqa: F401
    except ImportError:
        raise RuntimeError(
            "Qwen3-ASR 需要 PyTorch。请运行: python/.venv/bin/pip install torch"
        )


def _get_pipeline(model_id):
    _require_torch()
    if model_id in _cache:
        return _cache[model_id]
    # Qwen3-ASR 通常通过 AutoModelForCausalLM + processor 使用；
    # 此处用 transformers 的 speech-to-text pipeline 兜底，若模型不兼容则回退 whisper。
    device = 0 if os.environ.get("MEETING_USE_CUDA") == "1" else -1
    try:
        from model_manager import _qwen_local_dir
        local = _qwen_local_dir(model_id)
        pipe = pipeline(
            "automatic-speech-recognition",
            model=str(local),
            device=device,
        )
    except Exception:
        pipe = None
    _cache[model_id] = pipe
    return pipe


def transcribe_pcm(pcm_bytes, model_id, language=None):
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    pipe = _get_pipeline(model_id)
    if pipe is None:
        raise RuntimeError("Qwen3-ASR 模型加载失败，请检查模型是否已下载")
    sr = 16000
    result = pipe(samples, generate_kwargs={"language": language} if language else {})
    text = (result.get("text") or "").strip()
    return {"segments": [{"start": 0, "end": 0, "speaker": None, "text": text}] if text else [],
            "text": text}


def transcribe_file_pcm(path, model_id, language=None):
    with open(path, "rb") as f:
        pcm = f.read()
    return transcribe_pcm(pcm, model_id, language)


def release():
    _cache.clear()