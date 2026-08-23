"""faster-whisper inference with explicit device and compute-type resolution."""
import time
import numpy as np
from faster_whisper import WhisperModel
import runtime
from model_manager import WHISPER_SIZES, _whisper_local_dir, exists

_cache = {}

def resolve_whisper_runtime(requested_device="auto", requested_compute_type=None, torch_module=None):
    if requested_device == "auto":
        torch = torch_module
        if torch is None:
            import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = runtime.resolve_device(requested_device, torch_module)
    if device == "mps":
        raise RuntimeError("faster-whisper/CTranslate2 不支持 MPS；请选择 CPU，或在支持的机器上使用 CUDA")
    allowed = {"cpu": {"int8", "float32"}, "cuda": {"float16", "int8_float16", "float32"}}
    compute_type = requested_compute_type or ("int8" if device == "cpu" else "float16")
    if compute_type not in allowed[device]:
        raise ValueError(f"设备 {device} 不支持 Whisper compute type: {compute_type}")
    return device, compute_type

def _get_model(size, device="auto", compute_type=None):
    if size not in WHISPER_SIZES: raise ValueError(f"未知 Whisper 模型: whisper-{size}")
    local = _whisper_local_dir(size)
    if not exists(local): raise FileNotFoundError(f"模型未安装: whisper-{size}")
    resolved_device, resolved_compute = resolve_whisper_runtime(device, compute_type)
    key = (size, resolved_device, resolved_compute, "faster-whisper")
    if key not in _cache:
        _cache[key] = WhisperModel(str(local), device=resolved_device, compute_type=resolved_compute)
    return _cache[key], key

def transcribe_pcm(pcm_bytes, size="small", language=None, device="auto", compute_type=None):
    started = time.perf_counter()
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    model, key = _get_model(size, device, compute_type)
    segments, info = model.transcribe(samples, language=language, vad_filter=True)
    output, texts = [], []
    for segment in segments:
        text = segment.text.strip()
        if not text: continue
        output.append({"start": float(segment.start), "end": float(segment.end), "speaker": None,
                       "text": text, "confidence": None, "timing": "native"})
        texts.append(text)
    latency_ms = (time.perf_counter() - started) * 1000
    duration = len(samples) / 16000
    return {"segments": output, "text": "\n".join(texts), "language": getattr(info, "language", language),
            "duration": duration, "model": f"whisper-{size}", "device": key[1], "backend": key[3],
            "latencyMs": latency_ms, "realtimeFactor": duration / (latency_ms / 1000) if latency_ms > 0 else None,
            "warnings": []}

def transcribe_file_pcm(path, size="small", language=None, device="auto", compute_type=None):
    with open(path, "rb") as file: return transcribe_pcm(file.read(), size, language, device, compute_type)

def benchmark_pcm(pcm_bytes, size="small", device="auto", compute_type=None, warmup_runs=1, measured_runs=1):
    samples_duration = len(pcm_bytes) / 2 / 16000
    resolved_device, resolved_compute = resolve_whisper_runtime(device, compute_type)
    key = (size, resolved_device, resolved_compute, "faster-whisper")
    cold_start = key not in _cache
    load_started = time.perf_counter(); _get_model(size, resolved_device, resolved_compute)
    load_ms = (time.perf_counter() - load_started) * 1000 if cold_start else 0
    for _ in range(max(0, warmup_runs)): transcribe_pcm(pcm_bytes, size, None, resolved_device, resolved_compute)
    runs = []
    for _ in range(max(1, min(3, measured_runs))):
        started = time.perf_counter(); transcribe_pcm(pcm_bytes, size, None, resolved_device, resolved_compute)
        runs.append((time.perf_counter() - started) * 1000)
    runs.sort(); inference_ms = runs[len(runs) // 2]
    return {"model": f"whisper-{size}", "engine": "whisper", "backend": "faster-whisper",
            "device": resolved_device, "dtype": None, "computeType": resolved_compute,
            "audioDurationSeconds": samples_duration, "modelLoadMs": load_ms, "inferenceMs": inference_ms,
            "totalMs": load_ms + inference_ms, "rtf": inference_ms / 1000 / samples_duration if samples_duration else None,
            "realtimeFactor": samples_duration / (inference_ms / 1000) if inference_ms > 0 else None,
            "coldStart": cold_start, "warmupRuns": max(0, warmup_runs), "measuredRuns": len(runs)}

def release(): _cache.clear()
