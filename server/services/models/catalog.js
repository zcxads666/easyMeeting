import fsp from 'node:fs/promises';
import path from 'node:path';
import { MODELS_DIR } from '../../config.js';

const GB = 1024 ** 3;
export const MODEL_CATALOG = [
  ...[['tiny', .08], ['base', .15], ['small', .5], ['medium', 1.5], ['large-v3', 3]].map(([size, gb]) => ({
    id: `whisper-${size}`, label: `Whisper ${size}`, role: 'asr', engine: 'whisper', kind: 'whisper', backend: 'faster-whisper', source: 'huggingface',
    estimatedSizeBytes: Math.round(gb * GB), supportedDevices: ['cpu', 'cuda']
  })),
  ...[['Qwen/Qwen3-ASR-0.6B-hf', 1.6], ['Qwen/Qwen3-ASR-1.7B-hf', 3.8]].map(([id, gb]) => ({
    id, label: id.replace('Qwen/', ''), role: 'asr', engine: 'qwen', kind: 'qwen', backend: 'transformers', source: 'huggingface',
    estimatedSizeBytes: Math.round(gb * GB), supportedDevices: ['cpu', 'cuda', 'mps']
  })),
  { id: 'Qwen/Qwen3-ForcedAligner-0.6B-hf', label: 'Qwen3-ForcedAligner-0.6B-hf', role: 'aligner',
    engine: 'qwen-forced-aligner', kind: 'qwen-forced-aligner', backend: 'transformers', source: 'huggingface',
    estimatedSizeBytes: Math.round(1.8 * GB), supportedDevices: ['cpu', 'cuda', 'mps'] },
  { id: 'pyannote/speaker-diarization-community-1', label: 'Speaker Diarization Community-1', role: 'diarization',
    engine: 'pyannote', kind: 'pyannote', backend: 'pyannote.audio', source: 'huggingface', gated: true, bundle: true,
    estimatedSizeBytes: Math.round(3 * GB), supportedDevices: ['cpu', 'cuda'] }
];

function directoryFor(model) {
  if (model.engine === 'whisper') return path.join(MODELS_DIR, model.id);
  if (model.role === 'diarization') return path.join(MODELS_DIR, `diarization-${model.id.replaceAll('/', '--')}`);
  return path.join(MODELS_DIR, `qwen-${model.id.replaceAll('/', '--')}`);
}
async function files(directory) { try { return await fsp.readdir(directory); } catch { return null; } }
async function size(directory) {
  let total = 0; const stack = [directory];
  while (stack.length) { const current = stack.pop(); for (const entry of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) stack.push(target); else if (entry.isFile()) total += (await fsp.stat(target)).size;
  } }
  return total;
}
export async function inspectModelsWithoutRuntime() {
  return Promise.all(MODEL_CATALOG.map(async (model) => {
    const directory = directoryFor(model); const names = await files(directory);
    if (!names) return { ...model, status: 'not_installed', installed: false, sizeBytes: 0, error: null };
    const isDiarization = model.role === 'diarization';
    const hasConfig = isDiarization ? names.includes('config.yaml') : names.includes('config.json');
    const hasWeights = names.some((name) => name === 'model.bin' || name === 'pytorch_model.bin' || name.endsWith('.safetensors') || name.endsWith('.index.json'));
    const hasProcessor = model.backend !== 'transformers' || names.includes('preprocessor_config.json') || names.includes('processor_config.json');
    const hasBundle = !isDiarization || ['segmentation', 'embedding', 'plda'].every((name) => names.includes(name));
    const ready = hasConfig && (isDiarization || hasWeights) && hasProcessor && hasBundle;
    return { ...model, status: ready ? 'ready' : 'broken', installed: ready, sizeBytes: await size(directory),
      error: ready ? null : { code: 'MODEL_INCOMPLETE', message: '模型文件不完整；Runtime 可用后可执行验证或重新下载' } };
  }));
}
