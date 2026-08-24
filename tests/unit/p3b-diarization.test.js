import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSpeaker, attributeSpeakers, renameSpeakers, runDiarization } from '../../server/services/diarization.js';
import { buildCanonicalTimeline, migrateMeeting } from '../../server/services/timeline.js';
import { migrateSettings } from '../../server/services/settings-schema.js';

const turns = [{ start: 0, end: 1, speaker: 'SPEAKER_00' }, { start: 1, end: 2, speaker: 'SPEAKER_01' }];

test('word speaker attribution 使用 maximum overlap，有限 midpoint tolerance，不能随便找最近 speaker', () => {
  assert.equal(assignSpeaker({ start: .8, end: 1.4 }, turns), 'SPEAKER_01');
  assert.equal(assignSpeaker({ start: 2.05, end: 2.1 }, turns, .2), 'SPEAKER_01');
  assert.equal(assignSpeaker({ start: 5, end: 6 }, turns, .2), null);
  assert.equal(assignSpeaker({ start: null, end: null }, turns), null);
});

test('aligned words 归因并合并 speaker segments', () => {
  const timeline = buildCanonicalTimeline([{ text: 'A ', start: 0, end: .4 }, { text: 'B', start: .4, end: .8 },
    { text: 'C', start: 1.1, end: 1.5 }]);
  const result = attributeSpeakers(timeline, turns);
  assert.equal(result.quality, 'aligned'); assert.equal(result.timeline.words[0].speaker, 'SPEAKER_00');
  assert.equal(result.timeline.words[2].speaker, 'SPEAKER_01'); assert.equal(result.timeline.segments.length, 2);
});

test('没有 words 时按 segment overlap 粗粒度归因并标 coarse', () => {
  const result = attributeSpeakers({ words: [], segments: [{ text: 'x', start: .2, end: .8, timing: 'native' }] }, turns);
  assert.equal(result.quality, 'coarse'); assert.equal(result.timeline.segments[0].speaker, 'SPEAKER_00');
});

test('speaker rename 只更新 mapping，拒绝未知 cluster', () => {
  const meeting = { speakerLabels: {}, diarization: { speakerTurns: turns } };
  assert.equal(renameSpeakers(meeting, { SPEAKER_00: '张三' }).SPEAKER_00, '张三');
  assert.deepEqual(meeting.speakerLabels, {});
  assert.throws(() => renameSpeakers(meeting, { SPEAKER_99: '未知' }), /未知 speaker/);
});

test('diarization task 保存 regular/exclusive turns 和 attribution quality', async () => {
  let saved; const meeting = migrateMeeting({ id: 'm', schemaVersion: 2, audioRef: '/audio.wav', rawText: 'AB', segments: [] });
  meeting.timeline = buildCanonicalTimeline([{ text: 'A', start: 0, end: .8 }, { text: 'B', start: 1, end: 1.5 }]);
  const context = { update() {}, isCancellationRequested: () => false, signal: new AbortController().signal };
  const result = await runDiarization('m', { numSpeakers: 2 }, context, {
    getMeeting: async () => structuredClone(meeting), saveMeeting: async (value) => { saved = value; }, inspectRuntime: async () => ({ status: 'ready' }),
    resolveAudio: async () => ({ path: '/audio.wav' }), audioIdentity: async () => 'sha256:a', transcode: async () => '/tmp/missing.wav', ensurePython: async () => {},
    pythonUrl: () => 'http://python', fetch: async () => ({ ok: true, json: async () => ({ model: 'pyannote', device: 'cpu', speakerCount: 2,
      speakerTurns: turns, exclusiveSpeakerTurns: turns }) })
  });
  assert.equal(result.diarization.speakerAttribution.quality, 'aligned'); assert.equal(saved.timelineStatus, 'speaker-attributed');
  assert.equal(saved.speakerLabels.SPEAKER_00, 'Speaker 1');
});

test('settings v3→v4 migration 增加 optional features 且不丢原值', () => {
  const value = migrateSettings({ schemaVersion: 3, llm: { model: 'old' } });
  assert.equal(value.schemaVersion, 5); assert.equal(value.llm.model, 'old');
  assert.equal(value.postProcessing.autoDiarize, false); assert.equal(value.realtime.mode, 'auto');
});

test('UI 暴露 diarization、speaker rename 与安全 HF token 字段', async () => {
  const fs = await import('node:fs/promises');
  const meeting = await fs.readFile(new URL('../../web/src/pages/Meeting.jsx', import.meta.url), 'utf8');
  const settings = await fs.readFile(new URL('../../web/src/pages/Settings.jsx', import.meta.url), 'utf8');
  assert.match(meeting, /\/diarize/); assert.match(meeting, /\/speakers/); assert.match(meeting, /speakerLabels/);
  assert.match(settings, /Hugging Face Token/); assert.match(settings, /type="password"/);
});
