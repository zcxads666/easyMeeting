import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const MEETING_SCHEMA_VERSION = 3;

export function stableTextHash(value = '') {
  return createHash('sha256').update(String(value).normalize('NFC'), 'utf8').digest('hex');
}

export async function audioIdentity(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

function seconds(value, legacyMilliseconds) {
  return Number.isFinite(value) ? (legacyMilliseconds ? value / 1000 : value) : null;
}

export function canonicalSegment(segment, legacyMilliseconds = false) {
  const start = seconds(segment?.start, legacyMilliseconds);
  const end = seconds(segment?.end, legacyMilliseconds);
  const timing = ['native', 'aligned', 'estimated', 'unknown'].includes(segment?.timing)
    ? segment.timing : start == null || end == null ? 'unknown' : legacyMilliseconds ? 'estimated' : 'native';
  return { text: String(segment?.text || ''), start, end, speaker: segment?.speaker ?? null,
    confidence: Number.isFinite(segment?.confidence) ? segment.confidence : null, timing,
    words: Array.isArray(segment?.words) ? segment.words : [] };
}

export function migrateMeeting(input) {
  if (!input || typeof input !== 'object') return input;
  const meeting = structuredClone(input);
  const version = Number(meeting.schemaVersion) || 1;
  if (version > MEETING_SCHEMA_VERSION) return meeting;
  const legacyMilliseconds = version < 2 && meeting.segmentTimeUnit !== 'seconds';
  meeting.segments = (meeting.segments || []).map((segment) => canonicalSegment(segment, legacyMilliseconds));
  if (!meeting.timeline) {
    meeting.timeline = { words: [], segments: meeting.segments, source: 'asr', status: 'provisional', updatedAt: meeting.updatedAt || meeting.createdAt || null };
  } else {
    meeting.timeline.words = Array.isArray(meeting.timeline.words) ? meeting.timeline.words : [];
    meeting.timeline.segments = (meeting.timeline.segments || []).map((segment) => canonicalSegment(segment));
  }
  meeting.alignment ??= null;
  meeting.diarization ??= null;
  meeting.speakerLabels ??= {};
  meeting.postProcessing ??= { autoAlign: false, autoDiarize: false };
  meeting.timelineStatus ??= meeting.alignment?.stale ? 'stale' : meeting.timeline?.status || 'provisional';
  meeting.segmentTimeUnit = 'seconds';
  meeting.schemaVersion = MEETING_SCHEMA_VERSION;
  return meeting;
}

function shouldBreak(previous, word, currentText, currentStart, options) {
  if (!previous) return false;
  if (previous.speaker !== word.speaker && (previous.speaker || word.speaker)) return true;
  if (word.start - previous.end > options.maxGapSeconds) return true;
  if (word.end - currentStart > options.maxDurationSeconds) return true;
  if (currentText.length >= options.maxChars) return true;
  return /[。！？!?；;.]$/.test(previous.text) && currentText.length >= options.minChars;
}

export function buildCanonicalTimeline(words, { textSource = 'raw', maxGapSeconds = 1.2,
  maxDurationSeconds = 8, maxChars = 56, minChars = 12 } = {}) {
  const normalized = (words || []).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start)
    .map((word) => ({ text: String(word.text || ''), start: Number(word.start), end: Number(word.end),
      speaker: word.speaker ?? null, confidence: Number.isFinite(word.confidence) ? word.confidence : null, timing: 'aligned' }));
  const segments = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const text = group.map((word) => word.text).join('').replace(/\s+([,.;!?])/g, '$1').trim();
    segments.push({ text, start: group[0].start, end: group.at(-1).end,
      speaker: group.every((word) => word.speaker === group[0].speaker) ? group[0].speaker : null,
      confidence: null, timing: 'aligned', words: group });
    group = [];
  };
  for (const word of normalized) {
    const previous = group.at(-1);
    const currentText = group.map((item) => item.text).join('');
    if (shouldBreak(previous, word, currentText, group[0]?.start ?? word.start,
      { maxGapSeconds, maxDurationSeconds, maxChars, minChars })) flush();
    group.push(word);
  }
  flush();
  return { words: normalized, segments, source: 'alignment', textSource, status: 'aligned', updatedAt: Date.now() };
}

export function transcriptForSource(meeting, requested = 'auto') {
  const source = requested === 'auto' ? (meeting.corrected?.trim() ? 'corrected' : 'raw') : requested;
  if (!['raw', 'corrected'].includes(source)) throw Object.assign(new Error('无效的 transcript source'), { code: 'ALIGNMENT_SOURCE_INVALID' });
  const text = source === 'corrected' ? meeting.corrected : meeting.rawText;
  return { source, text: String(text || '').trim() };
}

export function alignmentIsStale(meeting) {
  if (!meeting?.alignment) return false;
  const { source, text } = transcriptForSource(meeting, meeting.alignment.textSource || 'raw');
  return source !== meeting.alignment.textSource || stableTextHash(text) !== meeting.alignment.textHash || Boolean(meeting.alignment.stale);
}

export function markDependentArtifactsStale(meeting, reason) {
  const next = migrateMeeting(meeting);
  if (next.alignment) next.alignment = { ...next.alignment, stale: true, staleReason: reason };
  if (next.diarization?.speakerAttribution) next.diarization.speakerAttribution = { ...next.diarization.speakerAttribution, stale: true, staleReason: reason };
  next.timelineStatus = next.alignment ? 'stale' : 'provisional';
  return next;
}
