# Local AI Runtime

桌面 App、AI Runtime、模型文件、会议数据和日志使用独立目录。打包应用不会写 `app.asar` 或 Program Files。

生产桌面启动只检测已有 Runtime，不自动创建 venv 或执行 pip。用户在模型页发起安装后，Runtime task 依次创建环境、升级 pip、安装依赖、验证 imports、启动 daemon 并调用 health endpoint。取消 pip 会把 Runtime 标记为不完整，后续可修复。

开发环境：

```bash
npm run setup:python
npm run test:python
```

测试 runner 在 Windows 使用 `python/.venv/Scripts/python.exe`，在 macOS/Linux 使用 `python/.venv/bin/python`。Runtime health 区分 daemon、依赖、FFmpeg 和 model runtime；FFmpeg 不由当前安装器自动捆绑。

## Optional feature packs

- `alignment-ja` installs `nagisa` only when Japanese alignment is requested.
- `alignment-ko` installs `soynlp` only when Korean alignment is requested.
- `diarization` installs `pyannote.audio`; the Community-1 pipeline weights remain a separate gated model download.
- `qwen-streaming-vllm` installs `qwen-asr[vllm]` explicitly. Capability detection currently requires Linux and CUDA; unsupported systems remain on chunked near-realtime.

Optional feature installation is user initiated and stage-based. Cancellation can leave an incomplete environment, which is reported as broken and can be repaired. No optional package or model is downloaded by ordinary CI.

ASR, aligner and diarization caches are isolated. Local TaskManager concurrency remains one; model deletion is rejected while the per-model operation lock or true-streaming session retains it. Allocation failures return `MODEL_OUT_OF_MEMORY` and never trigger a silent device fallback.
