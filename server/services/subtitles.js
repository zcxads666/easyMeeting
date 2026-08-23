const exactTimings = new Set(['aligned', 'native']);

export class SubtitleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function pad(value, width = 2) { return String(value).padStart(width, '0'); }

export function formatTimestamp(seconds, kind = 'srt') {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${kind === 'srt' ? ',' : '.'}${pad(millis, 3)}`;
}

export function subtitleCues(meeting, { allowEstimated = false, includeSpeaker = false } = {}) {
  if (meeting.alignment?.stale || meeting.timelineStatus === 'stale') {
    throw new SubtitleError('ALIGNMENT_STALE', '文本或音频已变化，请重新运行精确对齐');
  }
  const segments = meeting.timeline?.segments || meeting.segments || [];
  const usable = segments.filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end));
  if (!usable.length) throw new SubtitleError('SUBTITLE_TIMELINE_REQUIRED', '没有可用于字幕的时间轴，请先运行精确对齐');
  const estimated = usable.some((segment) => segment.timing === 'estimated');
  const unknown = usable.some((segment) => !exactTimings.has(segment.timing) && segment.timing !== 'estimated');
  if (unknown) throw new SubtitleError('SUBTITLE_TIMELINE_UNKNOWN', '时间轴不完整，不能生成字幕');
  if (estimated && !allowEstimated) throw new SubtitleError('SUBTITLE_ESTIMATED_REQUIRES_CONFIRMATION', '当前只有粗略时间轴；请先精确对齐，或明确允许粗略字幕');
  return { precision: estimated ? 'estimated' : 'precise', warning: estimated ? '字幕使用粗略音频窗口时间' : null,
    cues: usable.map((segment) => {
      const label = includeSpeaker && segment.speaker ? meeting.speakerLabels?.[segment.speaker] || segment.speaker : null;
      return { start: segment.start, end: segment.end, text: `${label ? `[${label}] ` : ''}${segment.text}` };
    }) };
}

export function buildSrt(meeting, options) {
  const result = subtitleCues(meeting, options);
  return { ...result, content: result.cues.map((cue, index) => `${index + 1}\n${formatTimestamp(cue.start, 'srt')} --> ${formatTimestamp(cue.end, 'srt')}\n${cue.text}`).join('\n\n') + '\n' };
}

export function buildVtt(meeting, options) {
  const result = subtitleCues(meeting, options);
  return { ...result, content: `WEBVTT\n\n${result.cues.map((cue) => `${formatTimestamp(cue.start, 'vtt')} --> ${formatTimestamp(cue.end, 'vtt')}\n${cue.text}`).join('\n\n')}\n` };
}
