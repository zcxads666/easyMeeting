import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalTimeline, migrateMeeting, stableTextHash, alignmentIsStale, markDependentArtifactsStale } from '../../server/services/timeline.js';
import { buildSrt, buildVtt, subtitleCues } from '../../server/services/subtitles.js';
import { issueMediaToken, verifyMediaToken } from '../../server/services/audio/media-token.js';
import { runAlignment } from '../../server/services/alignment.js';

const words = [
  { text: '今天', start: 0.1, end: .5 }, { text: '开会。', start: .5, end: 1.1 },
  { text: 'Next ', start: 2.5, end: 2.9 }, { text: 'step.', start: 2.9, end: 3.4 }
];

test('canonical timeline 只有 seconds/aligned word source，并处理中英文 cue', () => {
  const timeline = buildCanonicalTimeline(words, { textSource: 'corrected' });
  assert.equal(timeline.words[0].timing, 'aligned');
  assert.equal(timeline.segments.length, 2);
  assert.equal(timeline.segments[0].text, '今天开会。');
  assert.match(timeline.segments[1].text, /Next step\./);
});

test('meeting v1/v2 安全迁移到 v3，不原地修改输入', () => {
  const old = { id: 'x', schemaVersion: 1, segments: [{ start: 1234, end: 2500, text: '旧数据' }], rawText: '旧数据' };
  const migrated = migrateMeeting(old);
  assert.equal(old.schemaVersion, 1); assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.segments[0].start, 1.234); assert.equal(migrated.segmentTimeUnit, 'seconds');
  assert.deepEqual(migrated.speakerLabels, {});
  const v2 = migrateMeeting({ schemaVersion: 2, segments: [{ start: 1.5, end: 2, text: '秒' }] });
  assert.equal(v2.segments[0].start, 1.5);
});

test('alignment hash staleness 与依赖失效', () => {
  const meeting = migrateMeeting({ schemaVersion: 2, rawText: 'hello', corrected: '', segments: [] });
  meeting.alignment = { textSource: 'raw', textHash: stableTextHash('hello'), stale: false };
  assert.equal(alignmentIsStale(meeting), false);
  meeting.rawText = 'changed'; assert.equal(alignmentIsStale(meeting), true);
  const stale = markDependentArtifactsStale(meeting, 'transcript_changed');
  assert.equal(stale.alignment.stale, true); assert.equal(stale.timelineStatus, 'stale');
  meeting.diarization = { stale: false, speakerAttribution: { quality: 'aligned', stale: false } };
  const textOnly = markDependentArtifactsStale(meeting, 'transcript_changed');
  assert.equal(textOnly.diarization.stale, false); assert.equal(textOnly.diarization.speakerAttribution.stale, true);
  const audioChanged = markDependentArtifactsStale(meeting, 'audio_changed');
  assert.equal(audioChanged.diarization.stale, true); assert.equal(audioChanged.diarization.speakerAttribution.stale, true);
});

test('SRT/VTT 格式、精确策略、粗略警告和 unknown 拒绝', () => {
  const meeting = { timelineStatus: 'aligned', speakerLabels: {}, timeline: buildCanonicalTimeline(words) };
  assert.match(buildSrt(meeting).content, /1\n00:00:00,100 --> 00:00:01,100/);
  assert.match(buildVtt(meeting).content, /^WEBVTT\n\n00:00:00\.100/m);
  const estimated = { timeline: { segments: [{ text: '粗略', start: 0, end: 2, timing: 'estimated' }] } };
  assert.throws(() => subtitleCues(estimated), /粗略时间轴/);
  assert.equal(subtitleCues(estimated, { allowEstimated: true }).precision, 'estimated');
  assert.throws(() => subtitleCues({ timeline: { segments: [{ text: '未知', start: null, end: null, timing: 'unknown' }] } }), /时间轴/);
});

test('短期 media token 只允许目标 meeting 且会过期', () => {
  const token = issueMediaToken('secret', 'meeting-a', 1000, 100);
  assert.equal(verifyMediaToken('secret', token, 'meeting-a', 500), true);
  assert.equal(verifyMediaToken('secret', token, 'meeting-b', 500), false);
  assert.equal(verifyMediaToken('secret', token, 'meeting-a', 1101), false);
});

test('alignment task 构建 canonical timeline 并保存元数据', async () => {
  let saved;
  const meeting = migrateMeeting({ id: 'm', schemaVersion: 2, audioRef: '/uploads/a.wav', rawText: '你好', corrected: '', asr: { language: 'zh' }, segments: [] });
  const context = { update() {}, isCancellationRequested: () => false, signal: new AbortController().signal };
  const result = await runAlignment('m', { device: 'cpu' }, context, {
    getMeeting: async () => structuredClone(meeting), saveMeeting: async (value) => { saved = value; },
    inspectRuntime: async () => ({ status: 'ready' }), resolveAudio: async () => ({ path: '/uploads/a.wav' }),
    audioIdentity: async () => 'sha256:audio', transcode: async () => '/tmp/nonexistent-alignment.pcm', ensurePython: async () => {},
    pythonUrl: () => 'http://python', fetch: async () => ({ ok: true, json: async () => ({ model: 'aligner', device: 'cpu', language: 'Chinese',
      words: [{ text: '你', start: 0, end: .2 }, { text: '好', start: .2, end: .4 }] }) })
  });
  assert.equal(result.timeline.words.length, 2); assert.equal(saved.timelineStatus, 'aligned');
  assert.equal(saved.alignment.textHash, stableTextHash('你好')); assert.equal(saved.alignment.audioIdentity, 'sha256:audio');
});

test('Meeting UI 包含安全 audio token、seek、高亮和 stale 导出状态', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../../web/src/pages/Meeting.jsx', import.meta.url), 'utf8'));
  assert.match(source, /audio-token/); assert.match(source, /currentTime = seconds/); assert.match(source, /activeSegment/);
  assert.match(source, /alignment\?\.stale/); assert.match(source, /export\/\$\{kind\}/);
});
