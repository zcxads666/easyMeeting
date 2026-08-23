import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
// 支持环境变量覆盖数据目录（测试隔离用）
export const DATA_DIR = process.env.MEETING_DATA_DIR
  ? path.resolve(process.env.MEETING_DATA_DIR)
  : path.join(ROOT, 'data');
export const MEETINGS_DIR = path.join(DATA_DIR, 'meetings');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const TRASH_DIR = path.join(DATA_DIR, 'trash');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const LOGS_DIR = process.env.MEETING_LOG_DIR ? path.resolve(process.env.MEETING_LOG_DIR) : path.join(DATA_DIR, 'logs');

export const MODELS_DIR = process.env.MEETING_MODELS_DIR
  ? path.resolve(process.env.MEETING_MODELS_DIR)
  : path.join(os.homedir(), '.meeting', 'models');

// 推理服务默认端口（运行时可能被占用自动更换，见 services/python.js）
export const PYTHON_PORT = Number(process.env.MEETING_PY_PORT) || 8300;
export const PYTHON_SERVE_URL = `http://127.0.0.1:${PYTHON_PORT}`;

export const PORT = process.env.PORT || 3000;
// 桌面端默认只监听本机回环；需要局域网访问时设置 MEETING_BIND_HOST=0.0.0.0
export const BIND_HOST = process.env.MEETING_BIND_HOST || '127.0.0.1';

export const DEFAULT_SETTINGS = {
  schemaVersion: 4,
  secretMigrationVersion: 0,
  llm: { baseUrl: '', apiKey: '', model: '', temperature: 0.3 },
  asr: {
    provider: 'qwen',
    qwen: { apiKey: '', model: 'qwen3-asr-flash' },
    volc: { appid: '', token: '', cluster: 'volcengine_input_common' },
    mimo: { apiKey: '', model: 'mimo-v2.5-asr' },
    local: { engine: 'whisper', model: 'whisper-large-v3', device: 'auto' }
  },
  correction: { enabled: true },
  huggingFace: { token: '' },
  alignment: { model: 'Qwen/Qwen3-ForcedAligner-0.6B-hf', device: 'auto' },
  diarization: { model: 'pyannote/speaker-diarization-community-1', device: 'auto', numSpeakers: null, minSpeakers: null, maxSpeakers: null },
  postProcessing: { autoAlign: false, autoDiarize: false },
  realtime: { mode: 'auto' },
  ui: { theme: 'light' }
};
