import os
import glob
import json
import shutil
from pathlib import Path

MODELS_DIR = Path(os.environ.get("MEETING_MODELS_DIR", Path.home() / ".meeting" / "models"))

# 可管理的本地模型目录
WHISPER_SIZES = ["tiny", "base", "small", "medium", "large-v3"]
QWEN_MODELS = ["Qwen/Qwen3-ASR-Flash", "Qwen/Qwen3-ASR-Flash-FileTrans"]

DEFAULT_SOURCE = os.environ.get("MEETING_MODEL_SOURCE", "modelscope")  # modelscope | huggingface


def ensure_dir():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)


def _whisper_local_dir(size):
    return MODELS_DIR / f"whisper-{size}"


def _qwen_local_dir(model_id):
    name = model_id.replace("/", "--")
    return MODELS_DIR / f"qwen-{name}"


def list_models():
    ensure_dir()
    models = []
    for size in WHISPER_SIZES:
        d = _whisper_local_dir(size)
        models.append({
            "id": f"whisper-{size}",
            "kind": "whisper",
            "label": f"Whisper {size}",
            "size": size,
            "installed": exists(d),
            "path": str(d),
        })
    for mid in QWEN_MODELS:
        d = _qwen_local_dir(mid)
        models.append({
            "id": mid,
            "kind": "qwen",
            "label": mid,
            "size": mid,
            "installed": exists(d),
            "path": str(d),
        })
    return models


def exists(d):
    # 目录存在且非空
    return d.is_dir() and any(d.iterdir())


def download_whisper(size, progress_cb=None):
    ensure_dir()
    dest = _whisper_local_dir(size)
    # 优先 modelscope，失败回退 huggingface
    from huggingface_hub import snapshot_download
    repo = f"Systran/faster-whisper-{size}"
    snapshot_download(
        repo_id=repo,
        local_dir=str(dest),
        local_dir_use_symlinks=False,
    )
    return dest


def download_qwen(model_id, progress_cb=None):
    ensure_dir()
    dest = _qwen_local_dir(model_id)
    from modelscope import snapshot_download as ms_download
    ms_download(model_id, local_dir=str(dest))
    return dest


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
    total = 0
    for f in MODELS_DIR.rglob("*"):
        if f.is_file():
            try:
                total += f.stat().st_size
            except OSError:
                pass
    return total