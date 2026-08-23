"""Local inference runtime capability and device selection."""
import importlib.metadata
import importlib.util
import platform
import shutil
import sys

SUPPORTED_DEVICES = ("auto", "cpu", "cuda", "mps")

def _torch():
    try:
        import torch
        return torch
    except ImportError as exc:
        raise RuntimeError("缺少 PyTorch，本地模型运行环境不完整") from exc

def resolve_device(requested="auto", torch_module=None):
    if requested not in SUPPORTED_DEVICES:
        raise ValueError(f"不支持的设备: {requested}")
    torch = torch_module or _torch()
    cuda = bool(torch.cuda.is_available())
    mps_backend = getattr(torch.backends, "mps", None)
    mps = bool(mps_backend and mps_backend.is_available())
    if requested == "auto":
        return "cuda" if cuda else "mps" if mps else "cpu"
    if requested == "cuda" and not cuda:
        raise RuntimeError("已选择 CUDA，但当前 PyTorch 未检测到可用 CUDA 设备")
    if requested == "mps" and not mps:
        raise RuntimeError("已选择 MPS，但当前 PyTorch 未检测到可用 Apple MPS")
    return requested

def select_dtype(device, torch_module=None):
    torch = torch_module or _torch()
    if device == "cpu": return torch.float32
    if device == "cuda":
        return torch.bfloat16 if getattr(torch.cuda, "is_bf16_supported", lambda: False)() else torch.float16
    if device == "mps": return torch.float16
    raise ValueError(f"无法为未知设备选择 dtype: {device}")

def dtype_name(dtype):
    return str(dtype).replace("torch.", "")

def _version(distribution):
    try: return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError: return None

def _available(module):
    try: return importlib.util.find_spec(module) is not None
    except (ModuleNotFoundError, ValueError): return False

def capabilities(torch_module=None):
    torch = torch_module
    if torch is None and importlib.util.find_spec("torch"):
        import torch as torch_module
        torch = torch_module
    cuda_available = bool(torch and torch.cuda.is_available())
    mps_backend = getattr(getattr(torch, "backends", None), "mps", None)
    mps_available = bool(mps_backend and mps_backend.is_available())
    optional_features = {
        "alignment-ja": {"available": _available("nagisa"), "dependency": "nagisa"},
        "alignment-ko": {"available": _available("soynlp"), "dependency": "soynlp"},
        "diarization": {"available": _available("pyannote.audio"), "dependency": "pyannote.audio"},
        "qwen-streaming-vllm": {"available": _available("vllm"), "dependency": "vllm"},
    }
    return {
        "python": platform.python_version(), "platform": platform.platform(), "machine": platform.machine(),
        "torch": getattr(torch, "__version__", None), "transformers": _version("transformers"),
        "devices": {
            "cpu": {"available": True, "name": platform.processor() or platform.machine()},
            "cuda": {"available": cuda_available, "name": torch.cuda.get_device_name(0) if cuda_available else None,
                     "vram": torch.cuda.get_device_properties(0).total_memory if cuda_available else None},
            "mps": {"available": mps_available},
        },
        "optionalFeatures": optional_features,
    }

def health():
    required = ("fastapi", "uvicorn", "numpy", "faster_whisper", "transformers", "torch")
    packages = {name: importlib.util.find_spec(name) is not None for name in required}
    model_runtime, runtime_error = False, None
    if packages["torch"] and packages["transformers"]:
        try:
            from transformers import AutoModelForMultimodalLM, AutoProcessor  # noqa: F401
            model_runtime = True
        except Exception as exc:
            runtime_error = f"{type(exc).__name__}: {exc}"
    return {
        "daemon": True, "dependencies": {"ok": all(packages.values()), "packages": packages},
        "ffmpeg": {"available": shutil.which("ffmpeg") is not None, "path": shutil.which("ffmpeg")},
        "modelRuntime": {"available": model_runtime, "backend": "transformers",
                         "version": _version("transformers"), "error": runtime_error},
        "pythonExecutable": sys.executable,
    }
