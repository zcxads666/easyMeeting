"""Optional offline pyannote Community-1 adapter."""
from __future__ import annotations

import logging

import runtime
from model_manager import DIARIZATION_MODELS, exists, model_dir

logger = logging.getLogger("meeting.diarization")
DEFAULT_MODEL = DIARIZATION_MODELS[0]
_active = None


class DiarizationRuntimeError(RuntimeError):
    def __init__(self, code, message, *, model=DEFAULT_MODEL, device="unknown", cause=None, **details):
        super().__init__(message)
        self.code = code
        self.context = {"type": type(cause).__name__ if cause else type(self).__name__,
                        "technicalMessage": str(cause) if cause else message, "model": model,
                        "device": device, "backend": "pyannote.audio", **details}


def resolve_device(requested="auto", torch_module=None):
    if requested == "mps":
        raise DiarizationRuntimeError("DIARIZATION_DEVICE_UNSUPPORTED", "当前 pyannote backend 不支持 MPS", device=requested)
    if requested not in ("auto", "cpu", "cuda"):
        raise DiarizationRuntimeError("DIARIZATION_DEVICE_UNSUPPORTED", f"不支持的 diarization device: {requested}", device=requested)
    try:
        if requested == "auto":
            torch = torch_module or runtime._torch()
            return "cuda" if torch.cuda.is_available() else "cpu"
        resolved = runtime.resolve_device(requested, torch_module)
    except Exception as exc:
        raise DiarizationRuntimeError("DIARIZATION_DEVICE_UNAVAILABLE", str(exc), device=requested, cause=exc) from exc
    return resolved


def release():
    global _active
    previous = _active; _active = None
    if previous and previous[0][1] == "cuda":
        try:
            import torch
            torch.cuda.empty_cache()
        except (ImportError, RuntimeError) as exc:
            logger.warning("diarization CUDA cleanup failed type=%s", type(exc).__name__)


def load(model_id=DEFAULT_MODEL, device="auto"):
    global _active
    if model_id not in DIARIZATION_MODELS:
        raise DiarizationRuntimeError("DIARIZATION_MODEL_UNKNOWN", f"未知说话人分离模型: {model_id}", model=model_id, device=device)
    local = model_dir(model_id)
    if not exists(local):
        raise DiarizationRuntimeError("DIARIZATION_MODEL_NOT_INSTALLED", "说话人分离模型尚未安装", model=model_id, device=device)
    try:
        import torch
        resolved = resolve_device(device, torch)
    except DiarizationRuntimeError:
        raise
    key = (model_id, resolved, "pyannote.audio")
    if _active and _active[0] == key: return _active[1], key
    release()
    try:
        from pyannote.audio import Pipeline
        pipeline = Pipeline.from_pretrained(str(local))
        pipeline.to(torch.device(resolved))
    except ImportError as exc:
        raise DiarizationRuntimeError("DIARIZATION_RUNTIME_NOT_INSTALLED", "未安装可选 pyannote.audio Runtime", model=model_id, device=resolved, cause=exc, feature="diarization") from exc
    except Exception as exc:
        code = runtime.inference_error_code(exc, "DIARIZATION_LOAD_FAILED")
        error = DiarizationRuntimeError(code, runtime.inference_error_message(exc, "说话人分离 pipeline 加载失败"), model=model_id, device=resolved, cause=exc)
        logger.exception("diarization load failed context=%s", error.context)
        raise error from exc
    _active = (key, pipeline)
    return pipeline, key


def _turns(annotation):
    if annotation is None: return []
    result = []
    if hasattr(annotation, "itertracks"):
        iterator = ((turn, speaker) for turn, _, speaker in annotation.itertracks(yield_label=True))
    else:
        iterator = iter(annotation)
    for turn, speaker in iterator:
        result.append({"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker)})
    return result


def diarize_file(file_path, model_id=DEFAULT_MODEL, device="auto", num_speakers=None, min_speakers=None, max_speakers=None):
    pipeline, key = load(model_id, device)
    kwargs = {}
    if num_speakers is not None: kwargs["num_speakers"] = int(num_speakers)
    else:
        if min_speakers is not None: kwargs["min_speakers"] = int(min_speakers)
        if max_speakers is not None: kwargs["max_speakers"] = int(max_speakers)
    try:
        output = pipeline(str(file_path), **kwargs)
        regular = _turns(output.speaker_diarization)
        exclusive = _turns(output.exclusive_speaker_diarization)
        return {"speakerTurns": regular, "exclusiveSpeakerTurns": exclusive, "model": model_id,
                "device": key[1], "backend": key[2], "speakerCount": len({turn["speaker"] for turn in regular})}
    except Exception as exc:
        code = runtime.inference_error_code(exc, "DIARIZATION_FAILED")
        error = DiarizationRuntimeError(code, runtime.inference_error_message(exc, "说话人分离推理失败"), model=model_id, device=key[1], cause=exc)
        logger.exception("diarization inference failed context=%s", error.context)
        raise error from exc
