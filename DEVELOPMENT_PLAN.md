# 本地 Web 端会议记录总结工具 —— 开发计划与模块拆分

> 目标：一款**纯本地**运行的 Web 会议工具，支持实时语音转写、录音文件转写、LLM 智能梳理总结，输出美观的会议纪要。无数据库、全部数据本地持久化。云端/本地模型统一走 OpenAI 接口，云端 ASR 支持千问/火山/MiMo 三家，本地 ASR 支持 whisper 多尺寸与 Qwen3-ASR 的一键下载/切换/删除。

---

## 一、总体架构

```
┌────────────────────────────── 浏览器 (React + Vite + Tailwind) ──────────────────────────────┐
│  会议列表 / 实时转写台 / 纪要展示(苹果风排版) / 设置中心 / 模型管理                                   │
└──────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                     HTTP / WebSocket (Socket.IO)
┌──────────────────────────────────────────┴─────────────── Node.js 后端 ──────────────────────┐
│  BFF 服务 (Express + Socket.IO)                                                            │
│  ├─ 会议仓库(本地 JSON 文件)  ├─ 音频入参归一化(FFmpeg)  ├─ 任务队列                          │
│  ├─ ASR 适配器层(云端3家 + 本地代理)  ├─ LLM 适配器层(OpenAI 兼容)  ├─ 提示词引擎 / 纠错       │
│  └─ 模型管理(本地模型下载/切换/删除)  └─ 设置存储(本地 JSON)                                    │
└──────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                     HTTP / WebSocket
┌──────────────────────────────────────────┴─────────── 本地 Python 推理服务 ──────────────────┐
│  FastAPI: /models(下载/列表/删除/切换) /transcribe(whisper) /transcribe_qwen(Qwen3-ASR)      │
│  模型文件存放: ~/.meeting/models/  (faster-whisper + transformers)                            │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

外部：千问 / 火山 / MiMo 云端 ASR；任意 OpenAI 兼容 LLM(base_url + api_key + model)
```

### 技术选型
- **前端**：React 18 + Vite + Tailwind CSS + React Router + Zustand（状态）+ Socket.IO-client
- **后端**：Node.js 26 + Express + Socket.IO + `openai` SDK（统一 LLM/OpenAI 兼容 ASR）
- **本地推理**：Python FastAPI 子进程，faster-whisper + transformers(whisper) / Sensevoice/Qwen3-ASR
- **音频处理**：FFmpeg（多格式转码为 16kHz/16bit/单声道 PCM/WAV）
- **持久化**：纯本地 JSON 文件（无数据库），模型文件存磁盘
- **实时通信**：Socket.IO（麦克风流 → 后端 → 云端/本地 ASR → 实时回推）

---

## 二、目录结构

```
meeting/
├─ package.json
├─ server/                      # Node 后端
│  ├─ index.js                  # 入口，启动 Express + Socket.IO + 拉起 Python 子进程
│  ├─ config.js                 # 端口、路径、默认参数
│  ├─ routes/
│  │  ├─ meetings.js            # 会议 CRUD / 持久化
│  │  ├─ settings.js            # 设置读写（云端Key、模型选择）
│  │  ├─ models.js              # 委托 Python 的模型下载/切换/删除代理
│  │  └─ llm.js                 # 总结/纠错/排版 端点
│  ├─ services/
│  │  ├─ asr/
│  │  │  ├─ index.js            # ASR 工厂（按 providers 分发）
│  │  │  ├─ qwen.js             # 千问：实时(WS) + 文件转写(async)
│  │  │  ├─ volc.js             # 火山：WebSocket 二进制流
│  │  │  ├─ mimo.js             # MiMo：OpenAI 兼容 chat/completions
│  │  │  └─ local.js            # 本地 Python ASR 代理
│  │  ├─ llm/openai.js          # OpenAI 兼容文本模型封装(流式)
│  │  ├─ audio/ffmpeg.js        # 音频格式探测 + 转码
│  │  ├─ store/jsonstore.js     # JSON 文件持久化读写
│  │  ├─ prompts/               # 提示词模板
│  │  │  ├─ correct.js          # 错别字/口语纠正
│  │  │  ├─ summary.js          # 会议梳理总结
│  │  │  └─ speaker.js          # 说话人分离文本重排
│  │  └─ queue.js               # 文件转写任务队列 + 轮询
│  └─ socket/
│     ├─ realtime.js            # 实时转写事件收发
│     └─ progress.js            # 任务进度推送
├─ python/                      # 本地 Python 推理服务
│  ├─ requirements.txt
│  ├─ main.py                   # FastAPI 入口
│  ├─ model_manager.py          # 模型下载(hf/tf)/列表/切换/删除
│  ├─ transcribe_whisper.py     # faster-whisper 推理
│  ├─ transcribe_qwen.py        # Qwen3-ASR/SenseVoice 推理
│  └─ workers.py                # 后台推理线程
├─ web/                         # 前端 React
│  ├─ index.html
│  ├─ vite.config.js
│  ├─ src/
│  │  ├─ main.jsx
│  │  ├─ App.jsx
│  │  ├─ api/                   # HTTP 封装
│  │  ├─ socket/                # Socket.IO 封装
│  │  ├─ store/                 # Zustand
│  │  ├─ pages/
│  │  │  ├─ Home.jsx            # 会议列表(苹果风卡片)
│  │  │  ├─ Meeting.jsx         # 实时转写台
│  │  │  ├─ Summary.jsx         # 纪要展示(苹果风排版)
│  │  │  ├─ Settings.jsx        # 设置中心
│  │  │  └─ Models.jsx          # 本地模型管理
│  │  └─ components/            # 通用组件(SegmentedControl, Toggle, Card...)
│  └─ public/
├─ data/                        # 运行时生成：meetings/*.json, settings.json
└─ DEVELOPMENT_PLAN.md
```

---

## 三、功能模块拆分（按可交付里程碑）

### 阶段 0：项目脚手架与基础设施
| 模块 | 内容 | 验收 |
|---|---|---|
| 项目骨架 | monorepo 目录、npm scripts（`dev` 同时起 server+web+python） | `npm run dev` 一键启动 |
| 本地存储层 | `jsonstore.js`：原子写 JSON、防抖保存、路径隔离 | 会议/设置可持久化到 `data/` |
| 音频处理 | FFmpeg 探测格式、转码 `→ 16kHz/16bit/mono PCM/WAV` | mp3/m4a/wav/ogg/webm/flac/aac 统一入参 |
| 统一设置 | `settings.json` 结构：asr.云端配置文件、llm 配置 | 前端可读写 |

### 阶段 1：云端 ASR 三选一（文件转写）
| 模块 | 内容 | 验收 |
|---|---|---|
| 千问-文件 | DashScope 异步提交 `api/v1/services/audio/asr/transcription` + 轮询 `api/v1/tasks/{id}`，解析 sentences/时间戳/说话人 | 上传录音→进度→转写文本+时间戳 |
| 火山-文件 | 火山 WebSocket 二进制流（鉴权 appid/token，100ms 分帧发送，静默帧结束） | 同上 |
| MiMo-文件 | OpenAI 兼容 `POST /v1/chat/completions`，`input_audio` base64 + `asr_options` | 同上 |
| 转写任务队列 | `queue.js` + 进度推送 | 大文件后台任务、断点提示 |

### 阶段 2：实时语音识别（麦克风）
| 模块 | 内容 | 验收 |
|---|---|---|
| 麦克风采集 | 浏览器 `getUserMedia` + `AudioWorklet` 采集 16kHz PCM | 前端流式上传 |
| 实时通道 | Socket.IO 双向：音频帧 → ASR，识别半成品/成品 → 前端滚动字幕 | 实时字幕 |
| 千问-实时 | `wss://dashscope.aliyuncs.com/api-ws/v1/inference` run-task/duplex 音频流 | 分句最终结果 `sentenceEnd` |
| 火山-实时 | 火山 WS 二进制流实时 | 实时回推 |
| MiMo-实时 | MiMo `input_audio` 流式（短片段） | 分段调用 |
| 本地-实时 | 本地 whisper/qwen 流式（分块+滑动窗口） | 实时回推 |
| 实时字幕 UI | 正在说/已确认双态、可边记边摘录 | 字幕流畅 |

### 阶段 3：本地 ASR + 模型管理
| 模块 | 内容 | 验收 |
|---|---|---|
| Python 服务 | FastAPI + 子进程管理（Node 启动/健康检查/重启） | 健康检查通过 |
| 模型管理 API | `GET/POST/DELETE /models`：whisper 多尺寸(tiny~large-v3) + Qwen3-ASR/SenseVoice | 列表/当前选中 |
| 一键下载 | HuggingFace/ModelScope 下载、进度回调、断点续传 | 前端显示下载进度 |
| 切换/删除 | 切换当前推理模型；删除释放磁盘 | 即时生效 |
| 本地文件转写 | faster-whisper/qwen 转录音频，返回时间戳文本 | 与云端一致接口 |
| 本地实时转写 | 分块推理流式回推 | 本地实时可用 |

### 阶段 4：LLM 总结与纠错（OpenAI 统一接口）
| 模块 | 内容 | 验收 |
|---|---|---|
| LLM 适配器 | `openai` SDK，`base_url`+`api_key`+`model` 用户自由填写，流式输出 | 任意 OpenAI 兼容服务可用 |
| 错别字/口语纠正 | `correct.js` 提示词：纠正同音字/口语词，保留术语 | 转写文本被清洗 |
| 智能总结 | `summary.js` 提示词：议题、结论、待办、时间线、发言人 | 结构化 JSON 输出 |
| 说话人整理 | `speaker.js`：按说话人聚合/重排 | 分人发言视图 |
| 流式展示 | 总结边生成边渲染（打字机效果） | 实时生成 |

### 阶段 5：苹果风纪要排版与导出
| 模块 | 内容 | 验收 |
|---|---|---|
| 纪要视图 | 大标题、卡片化摘要、时间线、待办清单、发言人标签；系统字体、留白、圆角、毛玻璃 | 简洁美观、类 Apple |
| 会话级编辑 | 本地编辑/修正转写与总结 | 可二次加工 |
| 导出 | 导出 Markdown / HTML / PDF / 复制 | 一键导出 |
| 会议列表 | 卡片式列表、搜索、置顶、删除 | 信息清晰 |

### 阶段 6：打磨与健壮性
- 断线重连、ASR/LLM 错误提示与重试
- 设置校验（Key 合法性、模型可达性测试 `GET /models`）
- 并发单用户限制、内存/磁盘占用提示
- 本地化（中英）、主题亮/暗

---

## 四、核心数据结构（本地 JSON）

```jsonc
// data/settings.json
{
  "llm": { "baseUrl": "", "apiKey": "", "model": "", "temperature": 0.3 },
  "asr": {
    "provider": "qwen",          // qwen | volc | mimo | local
    "qwen": { "apiKey": "", "model": "qwen-audio-3.0-asr-flash-filetrans" },
    "volc": { "appid": "", "token": "", "cluster": "volcengine_input_common" },
    "mimo": { "apiKey": "", "model": "mimo-v2.5-asr" },
    "local": {
      "engine": "whisper",        // whisper | qwen3-asr
      "model": "whisper-large-v3" // 当前选中尺寸/模型
    }
  },
  "correction": { "enabled": true },
  "ui": { "theme": "light" }
}

// data/meetings/{id}.json
{
  "id": "uuid",
  "title": "季度产品评审会",
  "createdAt": 1720000000000,
  "updatedAt": 1720000000000,
  "duration": 3600,
  "source": "realtime | file",
  "audioRef": "uploads/xxx.mp3",          // 可选，文件来源
  "segments": [                            // 时间戳文本（实时+文件统一格式）
    { "start": 0, "end": 3200, "speaker": "张伟", "text": "...", "final": true }
  ],
  "rawText": "全文转写",
  "corrected": "纠正后全文",
  "summary": { "title": "...", "topics": [], "decisions": [], "todos": [], "timeline": [], "speakers": [] },
  "status": "recording | transcribed | summarized"
}
```

---

## 五、关键实现要点

### 1) 三家云端 ASR 适配（核心差异）
| 维度 | 千问 | 火山 | MiMo |
|---|---|---|---|
| 鉴权 | `Authorization: Bearer` | `appid` + `token`(预处理入报头) | `api-key` 或 `Authorization: Bearer` |
| 实时协议 | WebSocket(duplex or realtime) | WebSocket 二进制流 | OpenAI 兼容(片段式输入) |
| 文件转写 | 异步提交+轮询 | WS 流式发送 | `/v1/chat/completions` 同步 |
| 返回 | 时间戳/说话人/json | 时间戳 | 纯文本 |
| 统一出口 | 全部归一化 → `segments[]` | 同左 | 同左 |

- 设计 `asr/index.js` 工厂：`createProvider(type)` 返回统一接口 `{ transcribeFile(audio,opts), createRealtimeStream() }`，上层无感知切换。
- 千问文件转写用 DashScope 异步接口（支持说话人分离），注意需**公网可访问 URL 或本地路径**（本地用 `file://` 绝对路径，受限 100QPS）。
- 火山鉴权需先获取临时 token（鉴权 URL + 签名），实现 `volc.js` 中的 auth 预处理。

### 2) 音频入参归一化（多格式支持）
- 无论文件还是实时，统一在 FFmpeg 层转成 `16kHz/16bit/mono PCM`。
- 文件：`ffmpeg -i in.mp3 -ar 16000 -ac 1 -f s16le out.pcm`（或 wav）。
- 实时：浏览器 `AudioWorkletProcessor` 直接输出 16kHz PCM32 → 后端转 s16。

### 3) 统一 OpenAI 接口（LLM + MiMo/Qwen OpenAI 兼容 ASR）
- 封装 `lib/openaiClient(config)`，`baseURL`/`apiKey`/`model` 全部来自设置。
- 流式总结走 `chat.completions.create(stream:true)`，前端打字机渲染。
- 纠错/总结/说话人整理共用同一客户端，仅替换 `system` 提示词。

### 4) 提示词设计（涉及错字纠正与梳理）
- **纠错提示词 `correct.js`**：只改错别字/口语赘词，不改语义、不增删内容、保留专有名词/术语/数字。
- **总结提示词 `summary.js`**：要求输出固定 JSON schema（议题/结论/待办/时间线/发言人），便于结构化排版。
- **说话人提示词 `speaker.js`**：按代词/上下文归并说话人，输出 `speaker -> text` 映射。
- 全部提示词可放入设置中让用户自定义模板（`prompts` 章节的进阶项）。

### 5) 本地模型管理（一键下载/切换/删除）
- Python 侧 `model_manager.py`：以 `~/.meeting/models/` 为根，支持：
  - whisper 尺寸：`tiny / base / small / medium / large-v3`（faster-whisper，GGML/Safetensors）
  - Qwen3-ASR：`Qwen/Qwen3-ASR-Flash` 等（transformers）
- 下载：默认 ModelScope（国内快），可切 HuggingFace；支持分块写盘 + 进度回调。
- 切换：更新 `settings.asr.local.model`，推理层按 ID 懒加载。
- 删除：停用后删除目录，展示磁盘占用。

### 6) 实时字幕 UI 双态设计
- 半成品（intermediate）灰字、可被替换；成品（final）固定黑字并追加到 `segments`。
- 说话人标签（若支持）+ 时间戳，字幕区可点击复制当前句。

### 7) 苹果风排版（简洁美观）
- 字体栈：`-apple-system, BlinkMacSystemFont, "SF Pro", "PingFang SC", sans-serif`
- 大标题 + 大留白 + 卡片圆角(16px) + 细分割线 + 毛玻璃导航 + 系统灰阶。
- 纪要区：议题卡片🡒结论高亮🡒待办清单（勾选）🡒时间线🡒发言人区块。

### 8) 无数据库持久化
- 会议、设置均为 JSON 文件；音频存 `data/uploads/`。
- 写操作防抖 + 原子替换（写临时文件再 rename），避免并发损坏。

---

## 六、开发顺序（建议迭代节奏）

1. **D0 脚手架 + 存储 + FFmpeg** —— 打通"上传→转码→落盘"
2. **D1 云端文件转写（千问→火山→MiMo）** —— 先做出最稳定的"录音→文字"
3. **D2 实时识别（千问实时→本地实时）** —— 核心实时体验
4. **D3 本地模型管理 + Python 服务** —— 离线可用
5. **D4 LLM 总结/纠错** —— 从"文字"到"纪要"
6. **D5 纪要排版 + 导出** —— 颜值与交付
7. **D6 健壮性打磨**

> 每阶段结束都有一个可运行、可演示的产物；云端 ASR 三家可并行开发（共用工厂与直播间）。

---

## 七、风险与对策
| 风险 | 对策 |
|---|---|
| 千问文件转写需公网 URL | 本地也支持 `file://` 绝对路径；或集成 OSS 可选 |
| 火山鉴权复杂 | 独立封装 auth，提供在线测试按钮 |
| 本地 whisper 体积大 | 按尺寸分级下载、进度显示、磁盘占用提示 |
| 实时流式长时稳定性 | VAD 分句、断线重连、心跳 |
| 各家返回结构差异 | ASR 工厂统一归一化 `segments[]` |
| JS 端 Python 依赖 | 启动时自动 `pip install -r requirements.txt`，健康检查兜底 |

---

*本文档为开发蓝图，确认后按阶段 D0→D6 迭代实现。*