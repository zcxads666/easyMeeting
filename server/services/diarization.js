import fsp from 'node:fs/promises';
import { getMeeting, saveMeeting } from './store/jsonstore.js';
import { resolveMeetingAudio } from './audio/access.js';
import { transcodeToWav } from './audio/ffmpeg.js';
import { ensureFreshPython, getPythonUrl } from './python.js';
import { runtimeManager } from './runtime-manager.js';
import { audioIdentity, buildCanonicalTimeline } from './timeline.js';

export const DEFAULT_DIARIZATION_MODEL = 'pyannote/speaker-diarization-community-1';

function overlap(a, b) { return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)); }

export function assignSpeaker(item, turns, midpointTolerance = .2) {
  if (!Number.isFinite(item?.start) || !Number.isFinite(item?.end)) return null;
  let best = null; let bestOverlap = 0;
  for (const turn of turns || []) {
    const value = overlap(item, turn);
    if (value > bestOverlap) { best = turn.speaker; bestOverlap = value; }
  }
  if (bestOverlap > 0) return best;
  const midpoint = (item.start + item.end) / 2;
  const containing = (turns || []).filter((turn) => midpoint >= turn.start - midpointTolerance && midpoint <= turn.end + midpointTolerance);
  return containing.length === 1 ? containing[0].speaker : null;
}

export function attributeSpeakers(timeline, exclusiveTurns) {
  if (timeline?.words?.length) {
    const words = timeline.words.map((word) => ({ ...word, speaker: assignSpeaker(word, exclusiveTurns) }));
    const attributed = buildCanonicalTimeline(words, { textSource: timeline.textSource || 'raw' });
    attributed.status = 'speaker-attributed';
    return { timeline: attributed, quality: 'aligned' };
  }
  const segments = (timeline?.segments || []).map((segment) => ({ ...segment, speaker: assignSpeaker(segment, exclusiveTurns) }));
  const usable = segments.some((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end));
  return { timeline: { ...(timeline || {}), segments, status: usable ? 'speaker-attributed' : 'provisional', updatedAt: Date.now() },
    quality: usable ? 'coarse' : 'unknown' };
}

function taskError(code, message) { return Object.assign(new Error(message), { code }); }

export async function runDiarization(meetingId, options = {}, context = { update() {}, isCancellationRequested: () => false }, deps = {}) {
  const meeting = await (deps.getMeeting || getMeeting)(meetingId);
  if (!meeting) throw taskError('MEETING_NOT_FOUND', '会议不存在');
  if (!meeting.audioRef) throw taskError('DIARIZATION_AUDIO_REQUIRED', '说话人分离需要会议音频');
  const runtime = await (deps.inspectRuntime || (() => runtimeManager.inspect()))();
  if (!['ready', 'running'].includes(runtime.status)) throw taskError('RUNTIME_NOT_READY', '本地 AI Runtime 未就绪');
  context.update('preparing');
  const audio = await (deps.resolveAudio || resolveMeetingAudio)(meeting);
  const identity = await (deps.audioIdentity || audioIdentity)(audio.path);
  let wavPath;
  try {
    wavPath = await (deps.transcode || transcodeToWav)(audio.path, `diarization_${meeting.id}_${Date.now()}.wav`);
    if (context.isCancellationRequested()) return null;
    context.update('loading_model'); await (deps.ensurePython || ensureFreshPython)();
    context.update('segmenting');
    const response = await (deps.fetch || fetch)(`${(deps.pythonUrl || getPythonUrl)()}/diarize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: context.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]) : AbortSignal.timeout(2 * 60 * 60 * 1000),
      body: JSON.stringify({ file: wavPath, model: options.model || DEFAULT_DIARIZATION_MODEL, device: options.device || 'auto',
        num_speakers: options.numSpeakers ?? null, min_speakers: options.minSpeakers ?? null, max_speakers: options.maxSpeakers ?? null })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { const detail = result.detail || result; throw taskError(detail.code || 'DIARIZATION_FAILED', detail.message || '说话人分离失败'); }
    if (context.isCancellationRequested()) return null;
    context.update('attributing');
    const attributed = attributeSpeakers(meeting.timeline, result.exclusiveSpeakerTurns || result.speakerTurns || []);
    context.update('saving');
    const latest = await (deps.getMeeting || getMeeting)(meetingId);
    if (!latest) throw taskError('MEETING_DELETED', '会议已删除，说话人结果未保存');
    if (latest.audioRef !== meeting.audioRef) throw taskError('DIARIZATION_INPUT_CHANGED', '处理期间会议音频发生变化，请重新运行');
    latest.timeline = attributed.timeline;
    latest.segments = attributed.timeline.segments;
    latest.timelineStatus = attributed.quality === 'unknown' ? latest.timelineStatus : 'speaker-attributed';
    latest.diarization = { model: result.model || options.model || DEFAULT_DIARIZATION_MODEL, backend: result.backend || 'pyannote.audio',
      device: result.device || options.device || 'auto', speakerTurns: result.speakerTurns || [],
      exclusiveSpeakerTurns: result.exclusiveSpeakerTurns || [], speakerCount: result.speakerCount ?? null,
      audioIdentity: identity, createdAt: Date.now(), stale: false,
      speakerAttribution: { quality: attributed.quality, stale: false } };
    for (const turn of result.speakerTurns || []) {
      const index = Number.parseInt(turn.speaker.match(/(\d+)$/)?.[1] || '0', 10) + 1;
      latest.speakerLabels[turn.speaker] ??= `Speaker ${index}`;
    }
    await (deps.saveMeeting || saveMeeting)(latest);
    return { meetingId, diarization: latest.diarization, timeline: latest.timeline };
  } finally { if (wavPath) await fsp.unlink(wavPath).catch(() => {}); }
}

export function renameSpeakers(meeting, labels) {
  const known = new Set((meeting.diarization?.speakerTurns || []).map((turn) => turn.speaker));
  const next = { ...(meeting.speakerLabels || {}) };
  for (const [speaker, label] of Object.entries(labels || {})) {
    if (!known.has(speaker)) throw taskError('SPEAKER_UNKNOWN', `未知 speaker id: ${speaker}`);
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw taskError('SPEAKER_LABEL_INVALID', '说话人名称需为 1 到 80 个字符');
    next[speaker] = label.trim();
  }
  return next;
}
