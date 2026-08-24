# Architecture

## Process boundaries

- **Electron main**：创建安全 BrowserWindow，配置 `safeStorage` adapter，启动仅监听 loopback 的 Node core。
- **React renderer**：通过受限 preload bridge 获取内部 API 地址与会话 token，不具备 Node/文件系统能力。
- **Node core**：会议、canonical timeline、设置、TaskManager、Provider contract、受控音频 Range endpoint、RuntimeManager 和 diagnostics。
- **Python runtime**：设备检测、模型 lifecycle、ASR、Forced Alignment、可选 pyannote/vLLM adapter 及 Benchmark。

## Core services

- `TaskManager` 使用内存 lane：local=1、cloud=3、runtime=1。ASR、Alignment、Diarization、post-processing 和 Benchmark 共享 local lane。
- `RuntimeManager` 将 Runtime 安装/验证与 daemon start/restart 分离。生产桌面必须由用户显式安装。
- `SecretStore` 在 Electron 使用 safeStorage 加密文件，standalone 优先环境变量。
- Python `DownloadManager` 为每个模型提供互斥锁、临时下载目录、取消、磁盘预检、ModelScope 优先/Hugging Face 回退、网络超时、关键文件验证、manifest 和原子 finalize。

## Model state and storage

```text
not_installed → queued → downloading → verifying → ready
                         ↘ cancelled
                         ↘ error
             invalid files → broken → retry/verify
```

完整模型位于 `MEETING_MODELS_DIR`；中断数据位于 `.downloads/`。最终模型或临时目录被判定为损坏时，下一次重试会清理对应下载目录，避免污染文件被继续复用。manifest 只包含模型 ID、backend、source、revision（可得时）、大小和时间，不包含 credential。

Runtime 与模型状态独立：Runtime broken 时 Node 仍可扫描模型目录并显示 ready/broken，但加载、下载和 Benchmark 会被禁用。

## Data contracts

ASR 内部时间单位统一为秒。无法取得时间戳时必须为 `start/end: null, timing: unknown`；本地 realtime 的窗口时间来自 PCM sample offset，标记为 `estimated`。

Benchmark 使用任务 API 返回，服务端只转码并测试所选音频的前 15 秒；任务提供阶段心跳、取消和 10 分钟超时，Python 将模型加载和推理分别计时。`RTF = inference/audio`，`realtimeFactor = audio/inference`。下载并验证成功的 ASR 模型由模型页自动写入本地默认设置。

用户可在设置中选择独立的模型目录和录音/转写媒体目录。路径写入 settings，Electron 重启时在加载 Node/Python 服务前注入 `MEETING_MODELS_DIR`、`MEETING_MEDIA_DIR`；已有文件不会自动迁移。

## Advanced meeting pipeline

```text
File audio / persisted realtime WAV
        ↓
ASR provider result (provisional)
        ↓
Qwen3 Forced Aligner (optional)
        ↓
canonical word/segment timeline
        ↓
pyannote exclusive speaker turns (optional)
        ↓
speaker attribution + label mapping
        ↓
UI seek/highlight + SRT/VTT
```

Realtime audio is forked to ASR and a streaming PCM16 WAV writer. ASR failure does not discard recording. Stop waits for ASR flush, WAV atomic finalize, meeting save, then enqueues optional post-processing. See [Timeline](timeline.md).
