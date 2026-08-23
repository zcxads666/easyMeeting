import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateMeeting } from '../../server/services/timeline.js';
import { runAlignment } from '../../server/services/alignment.js';
import { runDiarization, renameSpeakers } from '../../server/services/diarization.js';
import { buildSrt, buildVtt } from '../../server/services/subtitles.js';

const context = () => ({ update() {}, isCancellationRequested: () => false, signal: new AbortController().signal });

test('P3 full pipeline: ASR → align → diarize → attribute → rename → SRT/VTT', async () => {
  let meeting = migrateMeeting({ id: 'pipeline', schemaVersion: 2, audioRef: '/uploads/pipeline.wav',
    rawText: '你好世界。Next step.', corrected: '', asr: { language: 'zh' }, segments: [
      { text: '你好世界。', start: null, end: null, timing: 'unknown' },
      { text: 'Next step.', start: null, end: null, timing: 'unknown' }
    ] });
  const shared = { getMeeting: async () => structuredClone(meeting), saveMeeting: async (value) => { meeting = structuredClone(value); },
    inspectRuntime: async () => ({ status: 'ready' }), resolveAudio: async () => ({ path: meeting.audioRef }),
    audioIdentity: async () => 'sha256:pipeline', ensurePython: async () => {} };
  await runAlignment(meeting.id, { language: 'zh', source: 'raw' }, context(), { ...shared,
    transcode: async () => '/tmp/p3-pipeline.pcm', pythonUrl: () => 'http://python',
    fetch: async () => ({ ok: true, json: async () => ({ model: 'aligner', backend: 'transformers', device: 'cpu',
      language: 'Chinese', words: [{ text: '你好', start: 0, end: .5 }, { text: '世界。', start: .5, end: 1.1 },
        { text: 'Next ', start: 1.5, end: 1.9 }, { text: 'step.', start: 1.9, end: 2.4 }] }) }) });
  assert.equal(meeting.timelineStatus, 'aligned'); assert.equal(meeting.timeline.words.length, 4);

  const turns = [{ start: 0, end: 1.2, speaker: 'SPEAKER_00' }, { start: 1.3, end: 2.5, speaker: 'SPEAKER_01' }];
  await runDiarization(meeting.id, { numSpeakers: 2 }, context(), { ...shared,
    transcode: async () => '/tmp/p3-pipeline.wav', pythonUrl: () => 'http://python',
    fetch: async () => ({ ok: true, json: async () => ({ model: 'community-1', backend: 'pyannote.audio', device: 'cpu',
      speakerCount: 2, speakerTurns: turns, exclusiveSpeakerTurns: turns }) }) });
  assert.equal(meeting.timelineStatus, 'speaker-attributed'); assert.equal(meeting.timeline.words[0].speaker, 'SPEAKER_00');
  assert.equal(meeting.timeline.words[3].speaker, 'SPEAKER_01');

  meeting.speakerLabels = renameSpeakers(meeting, { SPEAKER_00: '张三', SPEAKER_01: '李四' });
  const srt = buildSrt(meeting, { includeSpeaker: true }).content;
  const vtt = buildVtt(meeting, { includeSpeaker: true }).content;
  assert.match(srt, /1\n00:00:00,000 --> 00:00:01,100\n\[张三\] 你好世界。/);
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000/m); assert.match(vtt, /\[李四\] Next step\./);
});

test('P3 realtime final pipeline 保留 provisional，post-session 后切换 final timeline', async () => {
  const provisional = migrateMeeting({ schemaVersion: 3, audioRef: '/uploads/realtime.wav', rawText: '实时会议',
    timelineStatus: 'provisional', timeline: { words: [], status: 'provisional', source: 'asr',
      segments: [{ text: '实时会议', start: 0, end: 2, timing: 'estimated' }] } });
  assert.equal(provisional.timeline.status, 'provisional'); assert.equal(provisional.timeline.segments[0].timing, 'estimated');
  // The persisted WAV makes the same ASR-independent alignment/diarization services available after rt:stop.
  assert.ok(provisional.audioRef); assert.equal(provisional.schemaVersion, 3);
});

