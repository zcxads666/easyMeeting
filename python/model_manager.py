import os
import glob
import json
import shutil
import subprocess
from pathlib import Path

MODELS_DIR = Path(os.environ.get("MEETING_MODELS_DIR", Path.home() / ".meeting" / "models"))

# 可管理的本地模型目录
WHISPER_SIZES = ["tiny", "base", "small", "medium", "large-v3"]
QWEN_MODELS = ["Qwen/Qwen3-ASR-0.6B", "Qwen/Qwen3-ASR-1.7B"]

DEFAULT_SOURCE = os.environ.get("MEETING_MODEL_SOURCE", "modelscope")  # modelscope | huggingface

# 未安装模型的预估占用（GB，用于界面提示），安装后以实际 size_bytes 为准
REFERENCE_SIZES_GB = {
    "whisper-tiny": 0.08,
    "whisper-base": 0.15,
    "whisper-small": 0.5,
    "whisper-medium": 1.5,
    "whisper-large-v3": 3.0,
    "Qwen/Qwen3-ASR-0.6B": 1.2,
    "Qwen/Qwen3-ASR-1.7B": 3.4,
}


# 目录占用缓存：key=目录绝对路径，value=(目录 mtime_ns, size_bytes)
# 目录 mtime 在文件/子目录增删时变化（下载/删除模型会触发），缓存自动失效
_size_cache = {}


def _walk_size(d):
    total = 0
    for f in Path(d).rglob("*"):
        if f.is_file():
            try:
                total += f.stat().st_size
            except OSError:
                pass
    return total


def _du_size(d):
    """系统 du 快速统计（macOS/Linux，比 Python 遍历快数十倍）；失败回退遍历"""
    try:
        out = subprocess.run(
            ["du", "-sk", str(d)], capture_output=True, text=True, timeout=30
        ).stdout
        kb = int(out.split()[0])
        return kb * 1024
    except Exception:
        return _walk_size(d)


def dir_size_bytes(d):
    """统计目录占用（带缓存）：目录 mtime 未变化时直接返回缓存值"""
    d = Path(d)
    try:
        mtime = d.stat().st_mtime_ns
    except OSError:
        return 0
    key = str(d)
    cached = _size_cache.get(key)
    if cached and cached[0] == mtime:
        return cached[1]
    size = _du_size(d) if os.name != "nt" else _walk_size(d)
    _size_cache[key] = (mtime, size)
    return size


def ensure_dir():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)


def _whisper_local_dir(size):
    return MODELS_DIR / f"whisper-{size}"


def _qwen_local_dir(model_id):
    name = model_id.replace("/", "--")
    return MODELS_DIR / f"qwen-{name}"


def _append_model(models, mid, kind, label, d):
    installed = exists(d)
    models.append({
        "id": mid,
        "kind": kind,
        "label": label,
        "installed": installed,
        "path": str(d),
        "size_bytes": dir_size_bytes(d) if installed else 0,
        "estimated_size_bytes": int(REFERENCE_SIZES_GB.get(mid, 0) * 1024 ** 3),
    })


def list_models():
    ensure_dir()
    models = []
    for size in WHISPER_SIZES:
        _append_model(models, f"whisper-{size}", "whisper", f"Whisper {size}", _whisper_local_dir(size))
    for mid in QWEN_MODELS:
        _append_model(models, mid, "qwen", mid, _qwen_local_dir(mid))
    return models


def exists(d):
    """目录存在且包含实际文件（忽略下载中断残留的空目录/临时目录，如 ._____temp）"""
    if not d.is_dir():
        return False
    for f in d.rglob("*"):
        if f.is_file():
            return True
    return False


def _require(pkg, hint):
    try:
        __import__(pkg)
    except ImportError:
        raise RuntimeError(
            f"缺少依赖 {pkg}。{hint}"
        )


def download_whisper(size, progress_cb=None):
    ensure_dir()
    dest = _whisper_local_dir(size)
    if DEFAULT_SOURCE == "modelscope":
        # modelscope 对国内更快
        _require("modelscope", "请运行: python/.venv/bin/pip install modelscope")
        from modelscope import snapshot_download as ms_download
        ms_download(f"Systran/faster-whisper-{size}", local_dir=str(dest))
    else:
        _require("huggingface_hub", "请运行: python/.venv/bin/pip install huggingface_hub")
        from huggingface_hub import snapshot_download
        snapshot_download(
            repo_id=f"Systran/faster-whisper-{size}",
            local_dir=str(dest),
            local_dir_use_symlinks=False,
        )
    return dest


def download_qwen(model_id, progress_cb=None):
    ensure_dir()
    dest = _qwen_local_dir(model_id)
    _require("modelscope", "请运行: python/.venv/bin/pip install modelscope")
    from modelscope import snapshot_download as ms_download
    ms_download(model_id, local_dir=str(dest))
    return dest


def known_ids():
    return [f"whisper-{s}" for s in WHISPER_SIZES] + list(QWEN_MODELS)


def download(id, progress_cb=None):
    if id.startswith("whisper-"):
        size = id[len("whisper-"):]
        if size not in WHISPER_SIZES:
            raise ValueError(f"未知 whisper 尺寸: {size}")
        return download_whisper(size, progress_cb)
    if id in QWEN_MODELS:
        return download_qwen(id, progress_cb)
    raise ValueError(f"未知模型: {id}")


def switch(id):
    """校验模型可用，返回模型信息。实际推理时按 id 懒加载。"""
    models = list_models()
    m = next((x for x in models if x["id"] == id), None)
    if not m:
        raise ValueError(f"模型不存在: {id}")
    if not m["installed"]:
        raise ValueError(f"模型未安装: {id}")
    return m


def delete(id):
    models = list_models()
    m = next((x for x in models if x["id"] == id), None)
    if not m:
        raise ValueError(f"模型不存在: {id}")
    d = Path(m["path"])
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "id": id}


def disk_usage():
    ensure_dir()
    return dir_size_bytes(MODELS_DIR)