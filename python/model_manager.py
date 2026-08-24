"""Verified local model lifecycle and observable download management."""
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import deque
from contextlib import contextmanager
from pathlib import Path

MODELS_DIR = Path(os.environ.get("MEETING_MODELS_DIR", Path.home() / ".meeting" / "models"))
DOWNLOADS_DIR_NAME = ".downloads"
MANIFEST_NAME = ".meeting-model.json"
logger = logging.getLogger("meeting.model")
WHISPER_SIZES = ["tiny", "base", "small", "medium", "large-v3"]
QWEN_MODELS = ["Qwen/Qwen3-ASR-0.6B-hf", "Qwen/Qwen3-ASR-1.7B-hf"]
ALIGNER_MODELS = ["Qwen/Qwen3-ForcedAligner-0.6B-hf"]
DIARIZATION_MODELS = ["pyannote/speaker-diarization-community-1"]
DEFAULT_SOURCE = os.environ.get("MEETING_MODEL_SOURCE", "huggingface")
REFERENCE_SIZES_GB = {
    "whisper-tiny": .08, "whisper-base": .15, "whisper-small": .5,
    "whisper-medium": 1.5, "whisper-large-v3": 3.0,
    "Qwen/Qwen3-ASR-0.6B-hf": 1.6, "Qwen/Qwen3-ASR-1.7B-hf": 3.8,
    "Qwen/Qwen3-ForcedAligner-0.6B-hf": 1.8,
    "pyannote/speaker-diarization-community-1": 0.05,
}
MODEL_CATALOG = [
    *[{"id": f"whisper-{s}", "label": f"Whisper {s}", "role": "asr", "engine": "whisper", "backend": "faster-whisper",
       "source": "modelscope" if DEFAULT_SOURCE == "modelscope" else "huggingface",
       "estimatedSize": int(REFERENCE_SIZES_GB[f"whisper-{s}"] * 1024 ** 3),
       "supportedDevices": ["cpu", "cuda"], "recommendedDevice": "cuda" if s in ("medium", "large-v3") else "auto",
       "computeTypes": {"cpu": ["int8", "float32"], "cuda": ["float16", "int8_float16", "float32"]},
       "supportsTimestamps": True, "supportsStreaming": False} for s in WHISPER_SIZES],
    *[{"id": mid, "label": mid.removeprefix("Qwen/"), "role": "asr", "engine": "qwen", "backend": "transformers",
       "source": "huggingface", "estimatedSize": int(REFERENCE_SIZES_GB[mid] * 1024 ** 3),
       "supportedDevices": ["cpu", "cuda", "mps"], "recommendedDevice": "auto",
       "supportsTimestamps": False, "supportsStreaming": False} for mid in QWEN_MODELS],
    *[{"id": mid, "label": mid.removeprefix("Qwen/"), "role": "aligner", "engine": "qwen-forced-aligner",
       "backend": "transformers", "source": "huggingface",
       "estimatedSize": int(REFERENCE_SIZES_GB[mid] * 1024 ** 3),
       "supportedDevices": ["cpu", "cuda", "mps"], "recommendedDevice": "auto",
       "supportedLanguages": ["Chinese", "English", "Cantonese", "French", "German", "Italian",
                              "Japanese", "Korean", "Portuguese", "Russian", "Spanish"],
       "supportsTimestamps": True, "supportsStreaming": False} for mid in ALIGNER_MODELS],
    *[{"id": mid, "label": "Speaker Diarization Community-1", "role": "diarization", "engine": "pyannote",
       "backend": "pyannote.audio", "source": "huggingface", "gated": True, "bundle": True,
       "estimatedSize": int(REFERENCE_SIZES_GB[mid] * 1024 ** 3),
       "supportedDevices": ["cpu", "cuda"], "recommendedDevice": "auto",
       "supportsTimestamps": True, "supportsStreaming": False} for mid in DIARIZATION_MODELS],
]
CATALOG_BY_ID = {item["id"]: item for item in MODEL_CATALOG}
_size_cache = {}
_repository_revisions = {}
_model_locks = {model_id: threading.Lock() for model_id in CATALOG_BY_ID}
_model_users = {model_id: 0 for model_id in CATALOG_BY_ID}
_model_users_guard = threading.Lock()


class ModelLifecycleError(ValueError):
    def __init__(self, code, message, **details):
        super().__init__(message); self.code = code; self.details = details


def _walk_size(directory):
    total = 0
    for file in Path(directory).rglob("*"):
        if file.is_file():
            try: total += file.stat().st_size
            except OSError: pass
    return total


def _du_size(directory):
    try:
        out = subprocess.run(["du", "-sk", str(directory)], capture_output=True, text=True, timeout=30).stdout
        return int(out.split()[0]) * 1024
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
        logger.warning("du failed (%s), using portable walk", type(exc).__name__)
        return _walk_size(directory)


def dir_size_bytes(directory):
    directory = Path(directory)
    try: mtime = directory.stat().st_mtime_ns
    except OSError: return 0
    key = str(directory); cached = _size_cache.get(key)
    if cached and cached[0] == mtime: return cached[1]
    size = _du_size(directory) if os.name != "nt" else _walk_size(directory)
    _size_cache[key] = (mtime, size)
    return size


def ensure_dir():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    (MODELS_DIR / DOWNLOADS_DIR_NAME).mkdir(parents=True, exist_ok=True)


def _whisper_local_dir(size): return MODELS_DIR / f"whisper-{size}"
def _qwen_local_dir(model_id): return MODELS_DIR / f"qwen-{model_id.replace('/', '--')}"
def _diarization_local_dir(model_id): return MODELS_DIR / f"diarization-{model_id.replace('/', '--')}"
def model_dir(model_id):
    item = CATALOG_BY_ID.get(model_id)
    if not item: raise ModelLifecycleError("MODEL_UNKNOWN", f"未知模型: {model_id}")
    if item["engine"] == "whisper": return _whisper_local_dir(model_id.removeprefix("whisper-"))
    if item["role"] == "diarization": return _diarization_local_dir(model_id)
    return _qwen_local_dir(model_id)
def download_dir(model_id): return MODELS_DIR / DOWNLOADS_DIR_NAME / model_id.replace("/", "--")


def exists(directory):
    """Loader compatibility; product readiness is determined by verify_model()."""
    directory = Path(directory)
    return directory.is_dir() and any(f.is_file() for f in directory.rglob("*") if f.name != MANIFEST_NAME)


def _weight_exists(directory):
    names = {file.name for file in Path(directory).glob("*") if file.is_file()}
    return bool({"model.bin", "model.safetensors", "pytorch_model.bin"} & names) or any(
        name.endswith(".safetensors") or name.endswith(".index.json") for name in names)


def verify_structure(model_id, directory):
    directory = Path(directory); item = CATALOG_BY_ID.get(model_id)
    if not item: return False, "unknown model"
    if not directory.is_dir(): return False, "model directory missing"
    if item["role"] == "diarization":
        if not (directory / "config.yaml").is_file(): return False, "pipeline config.yaml missing"
        for component in ("segmentation", "embedding"):
            component_dir = directory / component
            if not component_dir.is_dir() or not _weight_exists(component_dir): return False, f"{component} component missing"
        if not (directory / "plda").is_dir(): return False, "plda component missing"
        return True, None
    if not (directory / "config.json").is_file(): return False, "config.json missing"
    if not _weight_exists(directory): return False, "model weights missing"
    if item["backend"] == "transformers" and not any((directory / name).is_file() for name in
                                               ("preprocessor_config.json", "processor_config.json")):
        return False, "processor config missing"
    return True, None


def _write_manifest(model_id, directory, revision=None):
    item = CATALOG_BY_ID[model_id]; target = Path(directory) / MANIFEST_NAME; tmp = target.with_suffix(".tmp")
    value = {"schemaVersion": 1, "modelId": model_id, "backend": item["backend"], "source": item["source"],
             "revision": revision, "installedAt": int(time.time() * 1000), "sizeBytes": dir_size_bytes(directory),
             "verifiedAt": int(time.time() * 1000)}
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"); os.replace(tmp, target)


def verify_model(model_id, create_legacy_manifest=True):
    directory = model_dir(model_id)
    if not directory.exists(): return {"status": "not_installed", "error": None, "sizeBytes": 0}
    valid, reason = verify_structure(model_id, directory)
    if not valid:
        return {"status": "broken", "error": {"code": "MODEL_INCOMPLETE", "message": f"模型文件不完整: {reason}"},
                "sizeBytes": dir_size_bytes(directory)}
    manifest_file = directory / MANIFEST_NAME
    if not manifest_file.exists() and create_legacy_manifest: _write_manifest(model_id, directory)
    elif manifest_file.exists():
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
            if manifest.get("modelId") != model_id: raise ValueError("modelId mismatch")
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            return {"status": "broken", "error": {"code": "MODEL_MANIFEST_INVALID", "message": str(exc)},
                    "sizeBytes": dir_size_bytes(directory)}
    return {"status": "ready", "error": None, "sizeBytes": dir_size_bytes(directory)}


def known_ids(): return list(CATALOG_BY_ID)

def retain_model(model_id):
    if model_id not in CATALOG_BY_ID: raise ModelLifecycleError("MODEL_UNKNOWN", f"未知模型: {model_id}")
    with _model_users_guard: _model_users[model_id] += 1

def release_model(model_id):
    with _model_users_guard: _model_users[model_id] = max(0, _model_users.get(model_id, 0) - 1)

def model_in_use(model_id):
    with _model_users_guard: return _model_users.get(model_id, 0) > 0
def _repository(model_id): return f"Systran/faster-whisper-{model_id.removeprefix('whisper-')}" if model_id.startswith("whisper-") else model_id


def repository_total_bytes(model_id, token=None):
    if CATALOG_BY_ID[model_id]["source"] != "huggingface": return None
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(_repository(model_id), files_metadata=True, token=token)
        siblings = info.siblings
        _repository_revisions[model_id] = getattr(info, "sha", None)
        sizes = [getattr(file, "size", None) for file in siblings]
        return sum(sizes) if sizes and all(isinstance(size, int) for size in sizes) else None
    except Exception as exc:
        logger.warning("repository size unavailable model=%s type=%s", model_id, type(exc).__name__)
        return None


def _cancel_tqdm(cancel_event):
    from tqdm.auto import tqdm
    class CancelableTqdm(tqdm):
        def update(self, n=1):
            if cancel_event and cancel_event.is_set(): raise InterruptedError("模型下载已取消")
            return super().update(n)
        def refresh(self, *args, **kwargs):
            if cancel_event and cancel_event.is_set(): raise InterruptedError("模型下载已取消")
            return super().refresh(*args, **kwargs)
    return CancelableTqdm


def download(model_id, destination=None, cancel_event=None, token=None):
    if model_id not in CATALOG_BY_ID: raise ModelLifecycleError("MODEL_UNKNOWN", f"未知模型: {model_id}")
    ensure_dir(); destination = Path(destination or download_dir(model_id)); destination.mkdir(parents=True, exist_ok=True)
    item = CATALOG_BY_ID[model_id]; repository = _repository(model_id)
    if item["source"] == "modelscope":
        try: from modelscope.hub.snapshot_download import snapshot_download
        except ImportError as exc: raise RuntimeError("缺少依赖 modelscope") from exc
        snapshot_download(repository, local_dir=str(destination))
    else:
        try: from huggingface_hub import snapshot_download
        except ImportError as exc: raise RuntimeError("缺少依赖 huggingface_hub") from exc
        snapshot_download(repo_id=repository, local_dir=str(destination), local_dir_use_symlinks=False,
                          tqdm_class=_cancel_tqdm(cancel_event), token=token)
    if cancel_event and cancel_event.is_set(): raise InterruptedError("模型下载已取消")
    return destination


def _finalize(model_id, temporary):
    final = model_dir(model_id); backup = final.with_name(final.name + ".replaced")
    if backup.exists(): shutil.rmtree(backup)
    if final.exists(): os.replace(final, backup)
    try: os.replace(temporary, final)
    except Exception:
        if backup.exists() and not final.exists(): os.replace(backup, final)
        raise
    if backup.exists(): shutil.rmtree(backup)


@contextmanager
def model_operation(model_id, blocking=False):
    lock = _model_locks.get(model_id)
    if lock is None: raise ModelLifecycleError("MODEL_UNKNOWN", f"未知模型: {model_id}")
    if not lock.acquire(blocking=blocking): raise ModelLifecycleError("MODEL_BUSY", "模型正在下载、验证、删除或推理")
    try: yield
    finally: lock.release()


class DownloadManager:
    def __init__(self):
        self.records = {}; self.cancel_events = {}; self.guard = threading.Lock(); self._recover()
    @staticmethod
    def _record(status, **extra):
        return {"status": status, "downloadedBytes": 0, "totalBytes": None, "progress": None,
                "speedBytesPerSecond": None, "etaSeconds": None, "error": None, **extra}
    def _recover(self):
        if not MODELS_DIR.is_dir(): return
        for model_id in known_ids():
            temporary = download_dir(model_id)
            if temporary.exists() and _walk_size(temporary):
                self.records[model_id] = self._record("cancelled", downloadedBytes=_walk_size(temporary),
                    error={"code": "DOWNLOAD_INCOMPLETE", "message": "发现未完成下载，可继续/重试"})
    def status(self, model_id):
        with self.guard: return dict(self.records.get(model_id, self._record("not_installed")))
    def all_status(self):
        with self.guard: return {key: dict(value) for key, value in self.records.items()}
    def _set(self, model_id, **fields):
        with self.guard: self.records.setdefault(model_id, self._record("checking")).update(fields)
    def start(self, model_id, token=None):
        if model_id not in CATALOG_BY_ID: raise ModelLifecycleError("MODEL_UNKNOWN", f"未知模型: {model_id}")
        if CATALOG_BY_ID[model_id].get("gated") and not token:
            raise ModelLifecycleError("HF_AUTH_REQUIRED", "该模型需要 Hugging Face 授权 Token，并需先接受模型使用条款")
        with self.guard:
            existing = self.records.get(model_id)
            if existing and existing["status"] in ("queued", "downloading", "verifying"):
                return {"alreadyDownloading": True, **dict(existing)}
            event = threading.Event(); self.cancel_events[model_id] = event; self.records[model_id] = self._record("queued")
        threading.Thread(target=self._run, args=(model_id, event, token), daemon=True, name="model-download").start()
        return self.status(model_id)
    def cancel(self, model_id):
        with self.guard:
            event = self.cancel_events.get(model_id); record = self.records.get(model_id)
            if not event or not record or record["status"] not in ("queued", "downloading", "verifying"): return False
            event.set(); record["cancelRequested"] = True; return True
    def _monitor(self, model_id, temporary, total, stop_event):
        samples = deque(maxlen=20); maximum = 0
        while not stop_event.wait(.25):
            maximum = max(maximum, _walk_size(temporary)); now = time.monotonic(); samples.append((now, maximum))
            while samples and now - samples[0][0] > 5: samples.popleft()
            speed = None
            if len(samples) > 1 and samples[-1][0] > samples[0][0]: speed = max(0, (samples[-1][1] - samples[0][1]) / (samples[-1][0] - samples[0][0]))
            progress = round(min(100, maximum * 100 / total), 2) if total else None
            eta = (total - maximum) / speed if total and speed and speed > 1024 and total >= maximum else None
            self._set(model_id, downloadedBytes=maximum, totalBytes=total, progress=progress,
                      speedBytesPerSecond=speed, etaSeconds=eta if eta is None or eta < 604800 else None)
    def _run(self, model_id, cancel_event, token=None):
        temporary = download_dir(model_id); monitor_stop = threading.Event(); monitor = None
        try:
            with model_operation(model_id):
                estimated = CATALOG_BY_ID[model_id]["estimatedSize"]; ensure_dir(); available = shutil.disk_usage(MODELS_DIR).free
                present = _walk_size(temporary) if temporary.exists() else 0
                required = max(64 * 1024 ** 2, int(max(0, estimated - present) * 1.2))
                if available < required: raise ModelLifecycleError("DISK_SPACE_INSUFFICIENT", "磁盘空间不足", requiredBytes=required, availableBytes=available)
                total = repository_total_bytes(model_id, token)
                self._set(model_id, status="downloading", totalBytes=total, error=None, startedAt=int(time.time() * 1000))
                monitor = threading.Thread(target=self._monitor, args=(model_id, temporary, total, monitor_stop), daemon=True); monitor.start()
                if token: download(model_id, temporary, cancel_event, token)
                else: download(model_id, temporary, cancel_event)
                if cancel_event.is_set(): raise InterruptedError("模型下载已取消")
                self._set(model_id, status="verifying", progress=100 if total else None)
                valid, reason = verify_structure(model_id, temporary)
                if not valid: raise ModelLifecycleError("MODEL_INCOMPLETE", f"模型文件不完整: {reason}")
                _write_manifest(model_id, temporary, _repository_revisions.get(model_id)); _finalize(model_id, temporary); size = dir_size_bytes(model_dir(model_id))
                self._set(model_id, status="ready", downloadedBytes=size, totalBytes=total, progress=100 if total else None,
                          speedBytesPerSecond=None, etaSeconds=None, completedAt=int(time.time() * 1000), error=None)
        except InterruptedError:
            self._set(model_id, status="cancelled", progress=None, speedBytesPerSecond=None, etaSeconds=None,
                      error={"code": "DOWNLOAD_CANCELLED", "message": "模型下载已取消"})
        except ModelLifecycleError as exc:
            self._set(model_id, status="broken" if exc.code == "MODEL_INCOMPLETE" else "error", progress=None,
                      speedBytesPerSecond=None, etaSeconds=None, error={"code": exc.code, "message": str(exc), **exc.details})
        except Exception as exc:
            logger.exception("model download failed model=%s type=%s", model_id, type(exc).__name__)
            gated = type(exc).__name__ in {"GatedRepoError", "RepositoryNotFoundError"} or getattr(getattr(exc, "response", None), "status_code", None) in (401, 403)
            self._set(model_id, status="error", progress=None, speedBytesPerSecond=None, etaSeconds=None,
                      error={"code": "HF_AUTH_FAILED" if gated else "MODEL_DOWNLOAD_FAILED",
                             "message": "Hugging Face 授权失败；请确认已接受模型条款且 Token 有效" if gated else str(exc)})
        finally:
            monitor_stop.set()
            if monitor: monitor.join(timeout=1)
            with self.guard: self.cancel_events.pop(model_id, None)


download_manager = DownloadManager()


def list_models():
    ensure_dir(); models = []
    for item in MODEL_CATALOG:
        verified = verify_model(item["id"]); download_state = download_manager.status(item["id"])
        active = ("checking", "queued", "downloading", "verifying", "deleting")
        if download_state["status"] in active: state = download_state["status"]
        elif verified["status"] == "ready": state = "ready"
        elif download_state["status"] in ("cancelled", "error"): state = download_state["status"]
        else: state = verified["status"]
        error = download_state.get("error") if state in ("cancelled", "error") else verified.get("error")
        size = verified["sizeBytes"]
        models.append({**item, "kind": item["engine"], "status": state, "installed": verified["status"] == "ready",
          "sizeBytes": size, "size_bytes": size, "estimatedSizeBytes": item["estimatedSize"], "estimated_size_bytes": item["estimatedSize"],
          "downloadedBytes": download_state.get("downloadedBytes", 0), "totalBytes": download_state.get("totalBytes"),
          "progress": download_state.get("progress"), "speedBytesPerSecond": download_state.get("speedBytesPerSecond"),
          "etaSeconds": download_state.get("etaSeconds"), "error": error})
    return models


def switch(model_id):
    state = verify_model(model_id)
    if state["status"] != "ready": raise ModelLifecycleError("MODEL_NOT_READY", f"模型不可用: {model_id}", status=state["status"])
    return next(model for model in list_models() if model["id"] == model_id)


def delete(model_id, release=None):
    if download_manager.status(model_id)["status"] in ("queued", "downloading", "verifying"):
        raise ModelLifecycleError("MODEL_BUSY", "模型正在下载，不能删除")
    if model_in_use(model_id): raise ModelLifecycleError("MODEL_BUSY", "模型正在被实时会话使用，不能删除")
    try:
        with model_operation(model_id):
            download_manager._set(model_id, status="deleting", error=None)
            if release: release()
            directory = model_dir(model_id); temporary = download_dir(model_id)
            if directory.is_dir(): shutil.rmtree(directory)
            if temporary.is_dir(): shutil.rmtree(temporary)
            download_manager._set(model_id, **download_manager._record("not_installed"))
    except Exception as exc:
        if not isinstance(exc, ModelLifecycleError) or exc.code != "MODEL_BUSY":
            download_manager._set(model_id, status="error", error={"code": "MODEL_DELETE_FAILED", "message": str(exc)})
        raise
    return {"ok": True, "id": model_id, "status": "not_installed"}


def disk_usage(): ensure_dir(); return dir_size_bytes(MODELS_DIR)
