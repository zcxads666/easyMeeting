# 会议记录汇总工具 —— 开发需求规格说明书

> 版本：v0.1.0　|　类型：需求规格说明书（SRS）　|　关联文档：`DEVELOPMENT_PLAN.md`（开发计划/模块拆分）

---

## 一、项目背景与目标

### 1.1 背景
在会议、采访、课堂等场景中，人工整理会议纪要成本高、效率低。现需一款**纯本地运行**的 Web 工具，将会议中的语音自动转化为文字，并借助大模型智能梳理成结构化的会议纪要。

### 1.2 目标
- 提供**实时语音转写**与**录音文件转写**两种模式。
- 通过 **LLM 智能总结**输出美观、结构化的会议纪要。
- 支持**云端多 ASR 供应商**与**本地模型**双路线，保证网络不佳时仍可离线使用。
- **无需数据库**，全部数据本地持久化，重视隐私与数据安全。

### 1.3 非目标
- 不做多人协作、云同步、账号体系。
- 不提供多用户并发（单用户本地使用）。
- 不做视频会议本体，仅做会议记录与转写。

---

## 二、用户与使用场景

### 2.1 目标用户
- 需要整理会议纪要的职场人士。
- 需要访谈/课程记录的师生、记者。
- 有隐私要求、希望本地处理数据的用户。

### 2.2 核心使用场景
1. 用户打开页面，新建会议，点击「开始录音」，实时字幕滚动显示，结束后生成纪要。
2. 用户上传已有录音文件（mp3/m4a/wav 等），后台转写并显示进度，完成后生成纪要。
3. 用户在设置中心配置云端 ASR Key 或下载本地模型，切换 ASR 供应商与 LLM。
4. 用户查看、编辑、导出会议纪要（Markdown/HTML/PDF）。

---

## 三、总体需求

### 3.1 系统架构
采用 **浏览器前端 + Node.js 后端（BFF）+ 本地 Python 推理服务** 三层结构：

```
浏览器 (React + Vite + Tailwind)
        │ HTTP / WebSocket (Socket.IO)
Node.js 后端 (Express + Socket.IO)
        ├─ 会议仓库(本地 JSON)   ├─ 音频归一化(FFmpeg)
        ├─ ASR 适配器(云端3家+本地) ├─ LLM 适配器(OpenAI 兼容)
        ├─ 任务队列             ├─ 模型管理代理
        └─ 设置存储(本地 JSON)
        │ HTTP / WebSocket
本地 Python 推理服务 (FastAPI) —— 本地 ASR 推理 / 模型下载
外部服务：千问 / 火山 / MiMo 云端 ASR；任意 OpenAI 兼容 LLM
```

### 3.2 技术选型
| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + Tailwind CSS + React Router + Zustand + Socket.IO-client |
| 后端 | Node.js + Express + Socket.IO + `openai` SDK |
| 本地推理 | Python FastAPI（faster-whisper / transformers） |
| 音频处理 | FFmpeg（统一转码为 16kHz/16bit/mono PCM/WAV） |
| 持久化 | 本地 JSON 文件（无数据库），模型文件存磁盘 |
| 实时通信 | Socket.IO（麦克风流 → ASR → 实时回推） |

---

## 四、功能需求

### 4.1 会议列表与会议管理
| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-1.1 | 会议列表以卡片形式展示，支持搜索、置顶、删除 | 高 | 列表信息清晰，可找到并删除目标会议 |
| FR-1.2 | 新建会议，记录标题、创建时间、来源（实时/文件）、时长 | 高 | 可创建并进入会议 |
| FR-1.3 | 会议状态流转：`recording → transcribed → summarized` | 高 | 状态随处理自动更新 |

### 4.2 实时语音转写（麦克风）
| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-2.1 | `getUserMedia` + `AudioWorklet` 采集 16kHz PCM | 高 | 前端流式上传音频数据 |
| FR-2.2 | Socket.IO 双向通道：音频帧上行、识别结果下行 | 高 | 实时字幕流畅滚动 |
| FR-2.3 | 支持千问 / 火山 / MiMo / 本地四种实时 ASR | 高 | 切换供应商后实时可用 |
| FR-2.4 | 字幕双态：半成品（intermediate，灰字可替换）+ 成品（final，固定追加） | 高 | 字幕呈现正确 |
| FR-2.5 | 边记边摘录：可点击复制当前句 | 中 | 支持复制单句 |

### 4.3 录音文件转写
| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-3.1 | 上传 mp3/m4a/wav/ogg/webm/flac/aac 录音 | 高 | 多格式统一入参 |
| FR-3.2 | FFmpeg 转码为 16kHz/16bit/mono PCM/WAV | 高 | 格式统一 |
| FR-3.3 | 支持千问（异步提交+轮询）、火山（WS 流）、MiMo（OpenAI 兼容）、本地（whisper/qwen）文件转写 | 高 | 上传→进度→转写文本+时间戳 |
| FR-3.4 | 后台任务队列，大文件异步处理，进度实时推送 | 高 | 进度条/百分比可见 |
| FR-3.5 | 转写结果含时间戳与说话人（供应商支持时） | 中 | 文本含时间信息 |

### 4.4 本地 ASR 与模型管理
| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-4.1 | FastAPI 服务由 Node 启动、健康检查、异常重启 | 高 | 健康检查通过 |
| FR-4.2 | 模型列表/切换/删除 API：whisper 多尺寸 + Qwen3-ASR/SenseVoice | 高 | 可查看当前选中模型 |
| FR-4.3 | 一键下载（HuggingFace/ModelScope）、进度回调、断点续传 | 高 | 前端显示下载进度 |
| FR-4.4 | 切换推理模型即时生效；删除释放磁盘 | 中 | 即时生效 |
| FR-4.5 | 本地文件转写与实时转写可用 | 高 | 离线可用 |

### 4.5 LLM 总结与纠错
| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-5.1 | OpenAI 兼容适配器：用户填写 `base_url` + `api_key` + `model`，流式输出 | 高 | 任意兼容服务可用 |
| FR-5.2 | 错别字/口语纠正：纠正同音字、口语词，保留术语/数字/专有名词 | 高 | 转写文本被清洗 |
| FR-5.3 | 智能总结：输出议题、结论、待办、时间线、发言人等结构化 JSON | 高 | 结构化数据可排版 |
| FR-5.4 | 说话人整理：按上下文归并说话人，输出分人发言视图 | 中 | 分人展示 |
| FR-5.5 | 流式渲染（打字机效果），边生成边显示 | 中 | 实时生成 |

### 4.6 苹果风纪要排版与导出
| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-6.1 | 字节视觉：大标题、卡片摘要、时间线、待办清单、发言人标签；系统字体/留白/圆角/毛玻璃 | 高 | 简洁美观，类 Apple |
| FR-6.2 | 会话级编辑：本地修改转写与总结 | 中 | 可二次加工 |
| FR-6.3 | 导出 Markdown / HTML / PDF / 复制 | 高 | 一键导出 |

### 4.7 设置中心
| 编号 | 需求 | 优先级 | 验收标准 |
|---|---|---|---|
| FR-7.1 | 配置 LLM（baseUrl/apiKey/model/temperature） | 高 | 可读写 |
| FR-7.2 | 配置 ASR 供应商及其云端 Key/参数 | 高 | 可读写 |
| FR-7.3 | 选择默认 ASR 提供商与本地模型 | 高 | 立即生效 |
| FR-7.4 | 纠错开关、主题亮/暗、语言中英 | 中 | 可切换 |

---

## 五、非功能需求（NFR）

### 5.1 数据与隐私
- **NFR-1**：无数据库，会议/设置为本地 JSON 文件，音频存 `data/uploads/`。
- **NFR-2**：默认本地处理；云端调用需用户显式配置 Key 并知晓数据上传。
- **NFR-3**：写操作防抖 + 原子替换（临时文件再 rename），防止并发损坏。

### 5.2 性能
- **NFR-4**：实时转写延迟尽量低，字幕流畅（final 结果及时回推）。
- **NFR-5**：大文件转写后台异步，不阻塞前端操作。
- **NFR-6**：下载进度显示，断点续传。

### 5.3 兼容与健壮性
- **NFR-7**：断线重连、ASR/LLM 失败提示与重试。
- **NFR-8**：设置校验（Key 合法性、模型可达性测试）。
- **NFR-9**：单用户并发限制，内存/磁盘占用提示。
- **NFR-10**：FFmpeg、Python 依赖缺失时给予明确提示（启动时自动安装 + 健康检查兜底）。

### 5.4 界面与体验
- **NFR-11**：苹果风简洁排版，类系统字体栈。
- **NFR-12**：支持亮/暗主题，中英语言。

---

## 六、数据定义（本地 JSON）

### 6.1 `data/settings.json`
```jsonc
{
  "llm": { "baseUrl": "", "apiKey": "", "model": "", "temperature": 0.3 },
  "asr": {
    "provider": "qwen",                             // qwen | volc | mimo | local
    "qwen": { "apiKey": "", "model": "qwen-audio-3.0-asr-flash-filetrans" },
    "volc": { "appid": "", "token": "", "cluster": "volcengine_input_common" },
    "mimo": { "apiKey": "", "model": "mimo-v2.5-asr" },
    "local": { "engine": "whisper", "model": "whisper-large-v3" }
  },
  "correction": { "enabled": true },
  "ui": { "theme": "light" }
}
```

### 6.2 `data/meetings/{id}.json`
```jsonc
{
  "id": "uuid",
  "title": "季度产品评审会",
  "createdAt": 1720000000000,
  "updatedAt": 1720000000000,
  "duration": 3600,
  "source": "realtime | file",
  "audioRef": "uploads/xxx.mp3",                    // 可选
  "segments": [                                     // 时间戳文本（实时+文件统一）
    { "start": 0, "end": 3200, "speaker": "张伟", "text": "…", "final": true }
  ],
  "rawText": "全文转写",
  "corrected": "纠正后全文",
  "summary": {
    "title": "…", "topics": [], "decisions": [],
    "todos": [], "timeline": [], "speakers": []
  },
  "status": "recording | transcribed | summarized"
}
```

---

## 七、接口概要

| 分组 | 方法/路径 | 说明 |
|---|---|---|
| 会议 | `GET/POST /api/meetings`、`GET/PUT/DELETE /api/meetings/:id` | 会议 CRUD 与持久化 |
| 设置 | `GET/PUT /api/settings` | 设置读写 |
| 模型 | `GET/POST/DELETE /api/models` | 委托 Python 的模型下载/切换/删除 |
| LLM | `POST /api/llm/*` | 总结/纠错/排版 |
| 实时 | Socket.IO 事件 `audio`/`result` | 实时转写收发 |
| 任务 | Socket.IO 事件 `task:progress` / `task:done` | 文件转写进度与结果推送 |

---

## 八、验收总体标准

- 能新建会议，完成**实时**与**文件**两种转写并得到带时间戳文本。
- 能在云端（千问/火山/MiMo）与本地模型间自由切换实时与文件转写。
- 能一键下载本地模型并断点续传、切换、删除。
- 能通过 LLM 生成结构化纪要并以苹果风排版呈现，支持导出。
- 全程无数据库，数据本地持久化，重启不丢失。

---

*本文档与 `DEVELOPMENT_PLAN.md` 配合使用：本文档定义「做什么」（需求），开发计划定义「怎么做/何时做」（里程碑 D0→D6）。*