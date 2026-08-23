"""Qwen3 Forced Aligner adapter using the native Transformers API."""
from __future__ import annotations

import importlib.util
import logging
from dataclasses import asdict, is_dataclass
from typing import Any

import numpy as np

import runtime
from model_manager import ALIGNER_MODELS, exists, model_dir

logger = logging.getLogger("meeting.aligner")
DEFAULT_MODEL = ALIGNER_MODELS[0]

_LANGUAGE_ALIASES = {
    "zh": "Chinese", "zh-cn": "Chinese", "zh-hans": "Chinese", "chinese": "Chinese", "中文": "Chinese",
    "yue": "Cantonese", "zh-yue": "Cantonese", "cantonese": "Cantonese", "粤语": "Cantonese",
    "en": "English", "en-us": "English", "en-gb": "English", "english": "English",
    "fr": "French", "fr-fr": "French", "french": "French",
    "de": "German", "de-de": "German", "german": "German",
    "it": "Italian", "it-it": "Italian", "italian": "Italian",
    "ja": "Japanese", "ja-jp": "Japanese", "japanese": "Japanese", "日本語": "Japanese",
    "ko": "Korean", "ko-kr": "Korean", "korean": "Korean", "한국어": "Korean",
    "pt": "Portuguese", "pt-br": "Portuguese", "pt-pt": "Portuguese", "portuguese": "Portuguese",
    "ru": "Russian", "ru-ru": "Russian", "russian": "Russian",
    "es": "Spanish", "es-es": "Spanish", "es-mx": "Spanish", "spanish": "Spanish",
}
SUPPORTED_LANGUAGES = tuple(dict.fromkeys(_LANGUAGE_ALIASES.values()))
_OPTIONAL_LANGUAGE_PACKAGES = {"Japanese": "nagisa", "Korean": "soynlp"}
_active = None


class AlignmentRuntimeError(RuntimeError):
    def __init__(self, code: str, message: str, *, model: str, device: str, cause: Exception | None = None, **details):
        super().__init__(message)
        self.code = code
        self.context = {
            "type": type(cause).__name__ if cause else type(self).__name__,
            "technicalMessage": str(cause) if cause else message,
            "model": model,
            "device": device,
            "backend": "transformers",
            **details,
        }


def normalize_language(value: str | None) -> str:
    if not value or not str(value).strip():
        raise AlignmentRuntimeError("ALIGNMENT_LANGUAGE_REQUIRED", "精确对齐需要指定语言", model=DEFAULT_MODEL, device="unknown")
    key = str(value).strip().lower().replace("_", "-")
    normalized = _LANGUAGE_ALIASES.get(key)
    if not normalized:
        raise AlignmentRuntimeError(
            "ALIGNMENT_LANGUAGE_UNSUPPORTED", f"Forced Aligner 不支持语言: {value}",
            model=DEFAULT_MODEL, device="unknown", supportedLanguages=list(SUPPORTED_LANGUAGES),
        )
    package = _OPTIONAL_LANGUAGE_PACKAGES.get(normalized)
    if package and importlib.util.find_spec(package) is None:
        raise AlignmentRuntimeError(
            "ALIGNMENT_LANGUAGE_DEPENDENCY_MISSING",
            f"{normalized} 对齐需要可选依赖 {package}", model=DEFAULT_MODEL, device="unknown",
            feature=f"alignment-{'ja' if normalized == 'Japanese' else 'ko'}", dependency=package,
        )
    return normalized


def release():
    global _active
    previous = _active
    _active = None
    if previous and previous[0][1] == "cuda":
        try:
            import torch
            torch.cuda.empty_cache()
        except (ImportError, RuntimeError) as exc:
            logger.warning("aligner CUDA cache cleanup failed type=%s", type(exc).__name__)


def load(model_id=DEFAULT_MODEL, device="auto"):
    global _active
    if model_id not in ALIGNER_MODELS:
        raise AlignmentRuntimeError("ALIGNER_MODEL_UNKNOWN", f"未知 Forced Aligner 模型: {model_id}", model=model_id, device=device)
    local = model_dir(model_id)
    if not exists(local):
        raise AlignmentRuntimeError("ALIGNER_NOT_INSTALLED", "Forced Aligner 模型尚未安装", model=model_id, device=device)
    try:
        import torch
        device = runtime.resolve_device(device, torch)
        dtype = runtime.select_dtype(device, torch)
    except Exception as exc:
        raise AlignmentRuntimeError("ALIGNMENT_DEVICE_UNAVAILABLE", str(exc), model=model_id, device=device, cause=exc) from exc
    key = (model_id, device, runtime.dtype_name(dtype), "transformers")
    if _active and _active[0] == key:
        return _active[1], key
    release()
    try:
        from transformers import AutoModelForTokenClassification, AutoProcessor
        processor = AutoProcessor.from_pretrained(str(local), local_files_only=True)
        model = AutoModelForTokenClassification.from_pretrained(str(local), local_files_only=True, dtype=dtype).to(device).eval()
    except Exception as exc:
        error = AlignmentRuntimeError("ALIGNER_LOAD_FAILED", "Forced Aligner 模型加载失败", model=model_id, device=device, cause=exc)
        logger.exception("aligner load failed context=%s", error.context)
        raise error from exc
    _active = (key, (processor, model))
    return _active[1], key


def _move_inputs(inputs, model):
    if hasattr(inputs, "to"):
        return inputs.to(model.device, model.dtype)
    return {key: value.to(model.device) if hasattr(value, "to") else value for key, value in inputs.items()}


def _plain(item: Any) -> dict:
    if isinstance(item, dict):
        return item
    if is_dataclass(item):
        return asdict(item)
    return {key: getattr(item, key) for key in ("text", "word", "token", "start", "end", "start_time", "end_time", "confidence", "score") if hasattr(item, key)}


def normalize_decoded(decoded) -> list[dict]:
    if isinstance(decoded, dict):
        decoded = decoded.get("words") or decoded.get("items") or decoded.get("segments") or []
    if isinstance(decoded, tuple):
        decoded = decoded[0]
    if decoded and isinstance(decoded, list) and len(decoded) == 1 and isinstance(decoded[0], (list, tuple)):
        decoded = decoded[0]
    words = []
    for raw in decoded or []:
        item = _plain(raw)
        text = str(item.get("text") or item.get("word") or item.get("token") or "")
        start = item.get("start", item.get("start_time"))
        end = item.get("end", item.get("end_time"))
        if not text or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            continue
        words.append({"text": text, "start": float(start), "end": float(end), "speaker": None,
                      "confidence": item.get("confidence", item.get("score")), "timing": "aligned"})
    return words


def align_pcm(pcm_bytes: bytes, text: str, language: str, model_id=DEFAULT_MODEL, device="auto"):
    if not text or not text.strip():
        raise AlignmentRuntimeError("ALIGNMENT_EMPTY_TRANSCRIPT", "转写文本为空，无法对齐", model=model_id, device=device)
    normalized_language = normalize_language(language)
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    try:
        (processor, model), key = load(model_id, device)
        inputs, word_lists = processor.prepare_forced_aligner_inputs(
            audio=samples, transcript=text, language=normalized_language,
        )
        inputs = _move_inputs(inputs, model)
        import torch
        with torch.inference_mode():
            outputs = model(**inputs)
        decoded = processor.decode_forced_alignment(
            logits=outputs.logits,
            input_ids=inputs["input_ids"],
            word_lists=word_lists,
            timestamp_token_id=model.config.timestamp_token_id,
        )[0]
        words = normalize_decoded(decoded)
        if not words:
            raise AlignmentRuntimeError("ALIGNMENT_EMPTY_RESULT", "Forced Aligner 未返回有效时间戳", model=model_id, device=key[1])
        return {"words": words, "language": normalized_language, "model": model_id, "device": key[1], "dtype": key[2],
                "backend": "transformers", "audioDuration": len(samples) / 16000}
    except AlignmentRuntimeError:
        raise
    except Exception as exc:
        resolved = key[1] if "key" in locals() else device
        error = AlignmentRuntimeError("ALIGNMENT_FAILED", "Forced Alignment 推理失败", model=model_id, device=resolved, cause=exc)
        logger.exception("alignment failed context=%s", error.context)
        raise error from exc
