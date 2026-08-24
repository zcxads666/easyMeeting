# Local AI Runtime

桌面 App、AI Runtime、模型文件、会议数据和日志使用独立目录。打包应用不会写 `app.asar` 或 Program Files。

官方桌面安装包内置按平台原生构建的基础 Runtime（PyTorch、Transformers、faster-whisper 等）以及 FFmpeg/FFprobe，普通用户不需要安装 Python、pip 或 FFmpeg。Runtime 以 PyInstaller onedir 形式位于应用 resources 目录，模型权重仍保存在用户数据目录并按需下载。开发模式继续使用项目 venv。

标准离线 Runtime 是签名安装包中的只读组件，不能用 pip 原地修改。日语/韩语对齐、Speaker Diarization 和 Linux CUDA vLLM 等可选能力应由后续增强版安装包提供；标准版请求安装这些能力时会返回 `RUNTIME_BUNDLED_FEATURE_UNAVAILABLE`，不会写 Program Files 或 App bundle。

开发环境：

```bash
npm run setup:python
npm run test:python
```

测试 runner 在 Windows 使用 `python/.venv/Scripts/python.exe`，在 macOS/Linux 使用 `python/.venv/bin/python`。Runtime health 区分 daemon、依赖、FFmpeg 和 model runtime；官方桌面包直接使用 resources 中捆绑的 FFmpeg/FFprobe。

## Optional feature packs

- `alignment-ja` installs `nagisa` only when Japanese alignment is requested.
- `alignment-ko` installs `soynlp` only when Korean alignment is requested.
- `diarization` installs `pyannote.audio`; the Community-1 pipeline weights remain a separate gated model download.
- `qwen-streaming-vllm` installs `qwen-asr[vllm]` explicitly. Capability detection currently requires Linux and CUDA; unsupported systems remain on chunked near-realtime.

Optional feature installation is user initiated and stage-based. Cancellation can leave an incomplete environment, which is reported as broken and can be repaired. No optional package or model is downloaded by ordinary CI.

上述可选安装流程仅适用于源码开发版或未携带离线 Runtime 的兼容构建；官方标准离线包不会修改内置 Runtime。

ASR, aligner and diarization caches are isolated. Local TaskManager concurrency remains one; model deletion is rejected while the per-model operation lock or true-streaming session retains it. Allocation failures return `MODEL_OUT_OF_MEMORY` and never trigger a silent device fallback.
