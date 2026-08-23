export const TIMING_VALUES = new Set(['native', 'aligned', 'estimated', 'unknown']);

function finiteOrNull(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) ? null : number;
}

export function normalizeSegment(segment = {}, { timestampUnit = 'seconds', defaultTiming } = {}) {
  const divisor = timestampUnit === 'milliseconds' ? 1000 : 1;
  let start = finiteOrNull(segment.start);
  let end = finiteOrNull(segment.end);
  if (start != null) start /= divisor;
  if (end != null) end /= divisor;
  let timing = TIMING_VALUES.has(segment.timing) ? segment.timing : defaultTiming;
  if (!timing) timing = start != null && end != null ? 'native' : 'unknown';
  if (start == null || end == null || end < start) timing = 'unknown';
  if (timing === 'unknown') { start = null; end = null; }
  return {
    start,
    end,
    speaker: typeof segment.speaker === 'string' ? segment.speaker : null,
    text: String(segment.text || '').trim(),
    confidence: finiteOrNull(segment.confidence),
    timing
  };
}

export function normalizeAsrResult(raw = {}, context = {}) {
  const text = String(raw.text || '').trim();
  let segments = Array.isArray(raw.segments)
    ? raw.segments.map((segment) => normalizeSegment(segment, context)).filter((segment) => segment.text)
    : [];
  if (!segments.length && text) {
    segments = [normalizeSegment({ text, timing: 'unknown' }, context)];
  }
  const duration = finiteOrNull(raw.duration ?? context.duration);
  const latencyMs = finiteOrNull(raw.latencyMs ?? context.latencyMs);
  const inferenceSeconds = latencyMs == null ? null : latencyMs / 1000;
  const realtimeFactor = finiteOrNull(raw.realtimeFactor)
    ?? (duration != null && duration > 0 && inferenceSeconds > 0 ? duration / inferenceSeconds : null);
  return {
    text: text || segments.map((segment) => segment.text).join('\n'),
    segments,
    language: raw.language || null,
    duration,
    provider: context.provider || raw.provider || 'unknown',
    model: raw.model || context.model || null,
    device: raw.device || context.device || null,
    latencyMs,
    realtimeFactor,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : []
  };
}

export function normalizeRealtimeFinal(payload = {}, context = {}) {
  return {
    ...normalizeSegment(payload, context),
    provider: payload.provider || context.provider || null,
    model: payload.model || context.model || null
  };
}

export function normalizeRealtimeMetrics(metrics = {}) {
  return {
    latencyMs: finiteOrNull(metrics.latencyMs),
    audioDuration: finiteOrNull(metrics.audioDuration),
    inferenceDuration: finiteOrNull(metrics.inferenceDuration),
    realtimeFactor: finiteOrNull(metrics.realtimeFactor),
    firstPartialLatencyMs: finiteOrNull(metrics.firstPartialLatencyMs),
    finalLatencyMs: finiteOrNull(metrics.finalLatencyMs)
  };
}
