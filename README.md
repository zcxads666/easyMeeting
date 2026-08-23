# easyMeeting

面向桌面的本地优先会议记录与会议纪要应用，支持云端 ASR、本地 Whisper、本地 Qwen3-ASR 和 OpenAI 兼容 LLM。

## Features

- 实时会议记录与音频文件转写
- Qwen、火山引擎、MiMo 云端 ASR
- faster-whisper 与 Hugging Face Transformers Qwen3-ASR 本地推理
- AI 文本纠错和结构化会议总结
- Electron 桌面应用及浏览器 + Node standalone 模式
- 本地会议存储、受控音频访问、加密桌面凭据
- 可取消的任务队列、模型验证、真实下载字节状态和本机 Benchmark

## Architecture

```text
Electron / Browser
        ↓
React Renderer
        ↓
Node.js Core Server
 ├─ TaskManager / Meeting Store
 ├─ Cloud ASR / LLM Providers
 └─ Python Local Runtime
      ├─ faster-whisper
      └─ Transformers Qwen3-ASR
```

Node.js 负责产品 API、配置、任务、文件、Socket 和云服务。Python 仅管理本地模型、硬件检测及本地推理。详见 [架构说明](docs/architecture.md)。

## ASR Providers

| Provider | 类型 | 文件 | 实时 | 时间戳 | 设备 |
|---|---|---:|---:|---|---|
| Qwen Cloud | 云端 | ✓ | ✓ | 无字段时 `unknown` | 云端 |
| Volc | 云端 | ✓ | ✓ | 文件结果可使用原生时间；否则 `unknown` | 云端 |
| MiMo | 云端 | ✓ | 分块近实时 | `unknown` | 云端 |
| Whisper | 本地 | ✓ | chunked near-realtime | 文件原生；实时窗口 `estimated` | CPU / CUDA |
| Qwen3-ASR | 本地 | ✓ | chunked near-realtime | 当前为 `unknown`；实时窗口 `estimated` | CPU / CUDA / MPS |

本地 realtime 是带静音切分、overlap 和去重的 near-realtime，不是 token streaming。

## Local Models

- Whisper tiny / base / small / medium / large-v3
- `Qwen/Qwen3-ASR-0.6B-hf`
- `Qwen/Qwen3-ASR-1.7B-hf`

Qwen3-ASR 可以在 CPU 上运行，GPU 不是必需条件。Whisper 的 faster-whisper/CTranslate2 backend 不支持 MPS；Apple 设备可选择 Whisper CPU 或 Qwen MPS。

模型先下载到 `.downloads` 临时目录，通过关键文件验证后才写入 manifest 并转为 ready。旧版本已下载的合法模型会原地验证并生成 manifest，不会要求重新下载。中断下载可“继续/重试”，其含义是复用 Hugging Face/ModelScope backend 的缓存能力，不是自研 HTTP Range downloader。

## Local Runtime

生产桌面端不会在启动时静默安装 PyTorch。本地 AI Runtime 是可选组件，由用户在模型页面显式安装或修复；Runtime 不可用不影响会议浏览、Cloud ASR 和 Cloud LLM。首次安装包含 PyTorch 等依赖，体积较大并需要稳定网络。详见 [Runtime 文档](docs/runtime.md)。

支持并测试 Python 3.12；开发目标范围为 Python 3.10–3.12。该范围与当前 CI、Transformers 5.x、PyTorch 和 faster-whisper 依赖组合保持保守一致。

## Privacy

- 会议 JSON 和上传音频默认保存在本机数据目录。
- 选择本地 ASR 时，音频不会发送给云端 ASR Provider。
- 选择云端 ASR/LLM 时，相应音频或文本会发送至所选服务商，请同时阅读服务商隐私条款。
- Electron 模式使用 `safeStorage` 加密 API credential；Renderer 只能取得 mask。
- standalone server 没有系统 keychain，优先使用环境变量，并保留明确标记的明文 settings fallback。
- 诊断包不包含 settings、会议内容、音频、模型或 credential。

## Development

需要 Node.js 22、Python 3.10–3.12 和 FFmpeg。

```bash
npm install
npm run setup:python
npm run dev
```

Electron 开发模式：

```bash
npm run desktop:dev
```

## Testing

```bash
npm test
npm run test:python
npm run build
```

`npm run test:python` 会跨平台选择 `python/.venv`，不会误用缺少项目依赖的系统 Python。

## Desktop Build

```bash
npm run desktop:dist
npm run verify:package
```

产物位于 `release/desktop/`。package verification 会检查 Electron、server、Web build 和 Python 源码存在，并拒绝 `.venv`、模型、用户数据、settings、日志及测试 credential。

## Model Management and Benchmark

模型页面提供下载、真实 byte progress（仓库能返回 total 时才显示百分比）、取消、继续/重试、验证、删除和性能测试。Benchmark 使用用户选择的已有会议音频，默认一次预热和一次测量，报告冷/热状态、加载时间、推理时间、RTF 和 realtime factor。结果受后台负载、散热及电源模式影响，不是硬件排名。

## Troubleshooting

- **Runtime 未安装/损坏**：在模型页选择“安装”或“修复”；失败后导出诊断包。
- **FFmpeg missing**：安装 FFmpeg 并确认 `ffmpeg`、`ffprobe` 在 PATH，或配置对应环境变量。
- **模型 broken**：先“验证”；关键文件不完整时选择“继续/重试”，应用不会自动删除旧文件。
- **磁盘空间不足**：清理模型目录所在磁盘；下载前会按预估模型大小加安全余量检查。
- **CUDA unavailable**：确认 PyTorch/CTranslate2 和驱动组合支持当前 CUDA；显式选择 CUDA 不会静默回退 CPU。
- **MPS**：仅 Qwen Transformers backend 支持；Whisper 请使用 CPU。
- **下载网络中断**：点击“继续/重试”，backend 会尽可能复用缓存；无法取得仓库 total 时 UI 不显示虚假百分比。
- **safeStorage unavailable**：检查系统 keyring/桌面会话；桌面端不会静默降级为明文 credential。
- **报告问题**：设置 → 诊断 → 导出诊断包。导出前仍建议快速检查文件内容。

发布前请遵循 [Release Checklist](docs/release-checklist.md)。
