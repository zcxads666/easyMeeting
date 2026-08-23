"""Native Hugging Face Transformers Qwen3-ASR inference."""
import logging
import time
import numpy as np
import runtime
from model_manager import QWEN_MODELS, _qwen_local_dir, exists

logger = logging.getLogger("meeting.qwen")
_active = None

class QwenRuntimeError(RuntimeError):
    def __init__(self, message, *, model, device, backend="transformers", cause=None):
        super().__init__(message)
        self.context = {"type": type(cause).__name__ if cause else type(self).__name__,
                        "technicalMessage": str(cause) if cause else message, "model": model,
                        "device": device, "backend": backend}

def _release_active():
    global _active
    if not _active: return
    device = _active[0][1]
    _active = None
    if device == "cuda":
        try:
            import torch
            torch.cuda.empty_cache()
        except (ImportError, RuntimeError) as exc:
            logger.warning("CUDA cache cleanup failed: %s: %s", type(exc).__name__, exc)

def _load(model_id, requested_device="auto"):
    global _active
    if model_id not in QWEN_MODELS: raise ValueError(f"未知 Qwen3-ASR 模型: {model_id}")
    local = _qwen_local_dir(model_id)
    if not exists(local): raise FileNotFoundError(f"模型未安装: {model_id}")
    device = runtime.resolve_device(requested_device)
    import torch
    dtype = runtime.select_dtype(device, torch)
    key = (model_id, device, runtime.dtype_name(dtype), "transformers")
    if _active and _active[0] == key: return _active[1], key
    _release_active()
    try:
        from transformers import AutoModelForMultimodalLM, AutoProcessor
        processor = AutoProcessor.from_pretrained(str(local), local_files_only=True)
        model = AutoModelForMultimodalLM.from_pretrained(
            str(local), local_files_only=True, dtype=dtype
        ).to(device).eval()
    except Exception as exc:
        error = QwenRuntimeError("Qwen3-ASR 模型加载失败", model=model_id, device=device, cause=exc)
        logger.exception("Qwen load failed context=%s", error.context)
        raise error from exc
    _active = (key, (processor, model))
    return _active[1], key

def transcribe_pcm(pcm_bytes, model_id, language=None, device="auto"):
    started = time.perf_counter()
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    try:
        (processor, model), key = _load(model_id, device)
        inputs = processor.apply_transcription_request(audio=samples, language=language)
        inputs = inputs.to(model.device, model.dtype)
        import torch
        with torch.inference_mode():
            output_ids = model.generate(**inputs, max_new_tokens=256, do_sample=False)
        generated_ids = output_ids[:, inputs["input_ids"].shape[1]:]
        text = processor.decode(generated_ids, return_format="transcription_only")[0].strip()
    except (ValueError, FileNotFoundError, QwenRuntimeError):
        raise
    except Exception as exc:
        resolved = key[1] if "key" in locals() else device
        error = QwenRuntimeError("Qwen3-ASR 推理失败", model=model_id, device=resolved, cause=exc)
        logger.exception("Qwen inference failed context=%s", error.context)
        raise error from exc
    return {"segments": [{"start": None, "end": None, "speaker": None, "text": text,
                           "confidence": None, "timing": "unknown"}] if text else [],
            "text": text, "language": language, "model": model_id, "device": key[1],
            "backend": key[3], "latencyMs": round((time.perf_counter() - started) * 1000),
            "warnings": [] if text else ["模型未返回文本"]}

def transcribe_file_pcm(path, model_id, language=None, device="auto"):
    with open(path, "rb") as file: return transcribe_pcm(file.read(), model_id, language, device)

def release(): _release_active()
