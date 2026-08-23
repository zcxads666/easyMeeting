import { Router, json } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  listMeetings, getMeeting, saveMeeting, deleteMeeting, updateMeeting
} from '../services/store/jsonstore.js';
import { isSupported, probe } from '../services/audio/ffmpeg.js';
import { transcribeFile } from '../services/asr/index.js';
import { taskManager } from '../services/queue.js';
import { getSettings } from '../services/store/jsonstore.js';
import { UPLOADS_DIR } from '../config.js';
import { mimeFor } from '../services/audio/ffmpeg.js';
import { resolveMeetingAudio } from '../services/audio/access.js';
import { runAlignment } from '../services/alignment.js';
import { buildSrt, buildVtt, SubtitleError } from '../services/subtitles.js';
import { MEETING_SCHEMA_VERSION } from '../services/timeline.js';

const router = Router();

// 惰性目录：multer 的 diskStorage 构造时会立即 mkdir，
// 若在模块加载阶段执行可能拿到错误的 DATA_DIR（如只读的 app.asar 路径），
// 因此改用函数形式，仅在真正上传时创建目录。
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}_${randomUUID()}${path.extname(file.originalname)}`)
  })
});

router.use(json({ limit: '50mb' }));

// 列表
router.get('/', async (_req, res) => {
  res.json(await listMeetings());
});

// 详情
router.get('/:id', async (req, res) => {
  const m = await getMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(m);
});

router.get('/:id/audio', async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });
  if (!meeting.audioRef) return res.status(404).json({ error: 'audio not found' });
  try {
    const { path: audio, stat } = await resolveMeetingAudio(meeting);
    const range = req.get('range');
    res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', mimeFor(audio));
    if (!range) {
      res.setHeader('Content-Length', stat.size); return fs.createReadStream(audio).pipe(res);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) { res.setHeader('Content-Range', `bytes */${stat.size}`); return res.sendStatus(416); }
    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);
    if (start == null) { const suffix = end; if (!suffix || suffix < 1) return res.sendStatus(416); start = Math.max(0, stat.size - suffix); end = stat.size - 1; }
    else end = end == null ? stat.size - 1 : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= stat.size || end < start) {
      res.setHeader('Content-Range', `bytes */${stat.size}`); return res.sendStatus(416);
    }
    end = Math.min(end, stat.size - 1);
    res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1); return fs.createReadStream(audio, { start, end }).pipe(res);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    console.error('[security] audio access failed:', error.message);
    return res.status(500).json({ error: 'audio access failed' });
  }
});

router.post('/:id/audio-token', async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'meeting not found' });
  if (!meeting.audioRef) return res.status(404).json({ error: 'audio not found' });
  if (!req.issueMediaToken) return res.json({ url: `/api/meetings/${meeting.id}/audio`, expiresAt: null });
  const ttlMs = 5 * 60 * 1000;
  const mediaToken = req.issueMediaToken(meeting.id, ttlMs);
  return res.json({ url: `/api/meetings/${meeting.id}/audio?mediaToken=${encodeURIComponent(mediaToken)}`, expiresAt: Date.now() + ttlMs });
});

// 新建
router.post('/', async (req, res) => {
  const { title = '未命名会议' } = req.body || {};
  const meeting = {
    id: randomUUID(),
    schemaVersion: MEETING_SCHEMA_VERSION,
    segmentTimeUnit: 'seconds',
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    duration: 0,
    source: 'realtime',
    segments: [],
    timeline: { words: [], segments: [], source: 'asr', status: 'provisional', updatedAt: Date.now() },
    timelineStatus: 'provisional',
    alignment: null,
    diarization: null,
    speakerLabels: {},
    postProcessing: { autoAlign: false, autoDiarize: false },
    rawText: '',
    corrected: '',
    summary: null,
    status: 'idle'
  };
  await saveMeeting(meeting);
  res.json(meeting);
});

// 更新字段（忽略 body.id，禁止改写主键/路径穿越）
router.patch('/:id', async (req, res) => {
  const m = await getMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const { id: _ignored, ...rest } = req.body || {};
  const next = { ...m, ...rest, id: m.id };
  const saved = await saveMeeting(next);
  res.json(saved);
});

// 删除
router.delete('/:id', async (req, res) => {
  await deleteMeeting(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/align', async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: '会议不存在', code: 'MEETING_NOT_FOUND' });
  const task = taskManager.create({ type: 'alignment', lane: 'local', metadata: { meetingId: meeting.id },
    run: (context) => runAlignment(meeting.id, req.body || {}, context) });
  return res.status(202).json({ taskId: task.id });
});

function exportSubtitles(kind) {
  return async (req, res) => {
    const meeting = await getMeeting(req.params.id);
    if (!meeting) return res.status(404).json({ error: '会议不存在', code: 'MEETING_NOT_FOUND' });
    try {
      const options = { allowEstimated: req.query.allowEstimated === '1', includeSpeaker: req.query.includeSpeaker === '1' };
      const result = kind === 'srt' ? buildSrt(meeting, options) : buildVtt(meeting, options);
      res.setHeader('Content-Type', kind === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="meeting-${meeting.id}.${kind}"`);
      res.setHeader('X-Timeline-Precision', result.precision);
      if (result.warning) res.setHeader('X-Timeline-Warning', encodeURIComponent(result.warning));
      return res.send(result.content);
    } catch (error) {
      if (error instanceof SubtitleError) return res.status(409).json({ error: error.message, code: error.code });
      throw error;
    }
  };
}

router.get('/:id/export/srt', exportSubtitles('srt'));
router.get('/:id/export/vtt', exportSubtitles('vtt'));

// 上传录音并转写
function unlinkUpload(file) {
  if (file?.path) fs.unlink(file.path, () => {});
}

router.post('/:id/transcribe', upload.single('audio'), async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) {
    unlinkUpload(req.file);
    return res.status(404).json({ error: 'not found' });
  }
  if (!req.file) return res.status(400).json({ error: 'no file' });
  if (!isSupported(req.file.originalname)) {
    unlinkUpload(req.file);
    return res.status(400).json({ error: `不支持的格式，支持: ${['mp3','wav','ogg','webm','flac','aac','m4a','amr','opus','mp4','mkv','mov'].join(', ')}` });
  }
  const settings = await getSettings();
  const lane = settings.asr.provider === 'local' ? 'local' : 'cloud';
  await updateMeeting(meeting.id, { status: 'queued' });
  const task = taskManager.create({ type: 'file_transcription', lane, metadata: { meetingId: meeting.id }, run: async (context) => {
    try {
      context.update('probing');
      const info = await probe(req.file.path);
      if (context.isCancellationRequested()) return null;
      context.update('transcribing');
      const duration = Number(info.format?.duration) || null;
      const result = await transcribeFile(settings.asr.provider, {
        filePath: req.file.path,
        fileName: req.file.originalname,
        duration,
        signal: lane === 'cloud' ? context.signal : undefined,
        updateStage: context.update
      }, settings);
      if (context.isCancellationRequested()) return null;
      context.update('saving');
      const saved = await updateMeeting(meeting.id, {
        schemaVersion: MEETING_SCHEMA_VERSION,
        segmentTimeUnit: 'seconds',
        source: 'file',
        audioRef: req.file.path,
        rawText: result.text,
        segments: result.segments,
        timeline: { words: [], segments: result.segments, source: 'asr', status: 'provisional', updatedAt: Date.now() },
        timelineStatus: 'provisional',
        alignment: null,
        duration: result.duration ?? duration ?? 0,
        asr: { provider: result.provider, model: result.model, device: result.device, language: result.language,
          latencyMs: result.latencyMs, realtimeFactor: result.realtimeFactor, warnings: result.warnings },
        status: 'transcribed'
      });
      if (!saved) throw Object.assign(new Error('会议已删除，转写结果未保存'), { code: 'MEETING_DELETED' });
      return { meetingId: meeting.id, asr: result };
    } catch (err) {
      if (!context.isCancellationRequested()) await updateMeeting(meeting.id, { status: 'error' });
      throw err;
    }
  }});
  res.json({ taskId: task.id });
});

export default router;
