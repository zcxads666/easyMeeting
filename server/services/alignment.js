import fsp from 'node:fs/promises';
import { getMeeting, saveMeeting } from './store/jsonstore.js';
import { resolveMeetingAudio } from './audio/access.js';
import { transcodeToPcm } from './audio/ffmpeg.js';
import { ensureFreshPython, getPythonUrl } from './python.js';
import { runtimeManager } from './runtime-manager.js';
import { audioIdentity, buildCanonicalTimeline, stableTextHash, transcriptForSource } from './timeline.js';

export const DEFAULT_ALIGNER_MODEL = 'Qwen/Qwen3-ForcedAligner-0.6B-hf';

function alignmentError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

export async function runAlignment(meetingId, options = {}, context = { update() {}, isCancellationRequested: () => false }, deps = {}) {
  const meeting = await (deps.getMeeting || getMeeting)(meetingId);
  if (!meeting) throw alignmentError('MEETING_NOT_FOUND', '会议不存在');
  if (!meeting.audioRef) throw alignmentError('ALIGNMENT_AUDIO_REQUIRED', '精确对齐需要会议音频');
  const { source, text } = transcriptForSource(meeting, options.source || 'auto');
  if (!text) throw alignmentError('ALIGNMENT_EMPTY_TRANSCRIPT', '转写文本为空，无法对齐');
  const language = options.language || meeting.asr?.language || meeting.language;
  if (!language) throw alignmentError('ALIGNMENT_LANGUAGE_REQUIRED', '精确对齐需要指定语言');
  const runtime = await (deps.inspectRuntime || (() => runtimeManager.inspect()))();
  if (!['ready', 'running'].includes(runtime.status)) throw alignmentError('RUNTIME_NOT_READY', '本地 AI Runtime 未就绪');

  context.update('preparing');
  const audio = await (deps.resolveAudio || resolveMeetingAudio)(meeting);
  const identity = await (deps.audioIdentity || audioIdentity)(audio.path);
  let pcmPath;
  try {
    pcmPath = await (deps.transcode || transcodeToPcm)(audio.path, `alignment_${meeting.id}_${Date.now()}.pcm`);
    if (context.isCancellationRequested()) return null;
    context.update('loading_model');
    await (deps.ensurePython || ensureFreshPython)();
    context.update('aligning');
    const response = await (deps.fetch || fetch)(`${(deps.pythonUrl || getPythonUrl)()}/align`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: pcmPath, text, language, model: options.model || DEFAULT_ALIGNER_MODEL, device: options.device || 'auto' }),
      signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(60 * 60 * 1000)]) : AbortSignal.timeout(60 * 60 * 1000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result.detail || result;
      throw alignmentError(detail.code || 'ALIGNMENT_FAILED', detail.message || 'Forced Alignment 失败');
    }
    if (context.isCancellationRequested()) return null;
    context.update('building_timeline');
    const timeline = buildCanonicalTimeline(result.words, { textSource: source });
    if (!timeline.words.length) throw alignmentError('ALIGNMENT_EMPTY_RESULT', 'Forced Aligner 未返回有效时间轴');
    context.update('saving');
    const latest = await (deps.getMeeting || getMeeting)(meetingId);
    if (!latest) throw alignmentError('MEETING_DELETED', '会议已删除，对齐结果未保存');
    const latestSource = transcriptForSource(latest, source);
    if (stableTextHash(latestSource.text) !== stableTextHash(text) || latest.audioRef !== meeting.audioRef) {
      throw alignmentError('ALIGNMENT_INPUT_CHANGED', '对齐期间文本或音频发生变化，请重新运行');
    }
    latest.timeline = timeline;
    latest.segments = timeline.segments;
    latest.timelineStatus = 'aligned';
    latest.alignment = { model: result.model || options.model || DEFAULT_ALIGNER_MODEL, backend: result.backend || 'transformers',
      device: result.device || options.device || 'auto', dtype: result.dtype || null, language: result.language || language,
      textSource: source, textHash: stableTextHash(text), audioIdentity: identity, createdAt: Date.now(), stale: false };
    await (deps.saveMeeting || saveMeeting)(latest);
    return { meetingId, timeline, alignment: latest.alignment };
  } finally {
    if (pcmPath) await fsp.unlink(pcmPath).catch(() => {});
  }
}
