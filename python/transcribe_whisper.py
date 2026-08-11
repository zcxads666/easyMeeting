import os
import base64
import tempfile
import numpy as np
from faster_whisper import WhisperModel

_cache = {}


def _get_model(size):
    if size in _cache:
        return _cache[size]
    from model_manager import _whisper_local_dir
    local = _whisper_local_dir(size)
    device = "cuda" if os.environ.get("MEETING_USE_CUDA") == "1" else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    model = WhisperModel(str(local), device=device, compute_type=compute)
    _cache[size] = model
    return model


def transcribe_pcm(pcm_bytes, size="small", language=None):
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    model = _get_model(size)
    segments, _info = model.transcribe(samples, language=language, vad_filter=True)
    out_segments = []
    texts = []
    for seg in segments:
        out_segments.append({
            "start": int(seg.start * 1000),
            "end": int(seg.end * 1000),
            "speaker": None,
            "text": seg.text.strip(),
        })
        texts.append(seg.text.strip())
    return {"segments": out_segments, "text": "\n".join(texts)}


def transcribe_file_pcm(path, size="small", language=None):
    with open(path, "rb") as f:
        pcm = f.read()
    return transcribe_pcm(pcm, size, language)


def release():
    _cache.clear()