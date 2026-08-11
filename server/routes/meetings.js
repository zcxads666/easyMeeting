import { Router, json } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  listMeetings, getMeeting, saveMeeting, deleteMeeting
} from '../services/store/jsonstore.js';
import { isSupported, probe } from '../services/audio/ffmpeg.js';
import { transcribeFile } from '../services/asr/index.js';
import { queue } from '../services/queue.js';
import { getSettings } from '../services/store/jsonstore.js';
import { UPLOADS_DIR } from '../config.js';

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
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

// 新建
router.post('/', async (req, res) => {
  const { title = '未命名会议' } = req.body || {};
  const meeting = {
    id: randomUUID(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    duration: 0,
    source: 'realtime',
    segments: [],
    rawText: '',
    corrected: '',
    summary: null,
    status: 'recording'
  };
  await saveMeeting(meeting);
  res.json(meeting);
});

// 更新字段
router.patch('/:id', async (req, res) => {
  const m = await getMeeting(req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const next = { ...m, ...req.body };
  const saved = await saveMeeting(next);
  res.json(saved);
});

// 删除
router.delete('/:id', async (req, res) => {
  await deleteMeeting(req.params.id);
  res.json({ ok: true });
});

// 上传录音并转写
router.post('/:id/transcribe', upload.single('audio'), async (req, res) => {
  const meeting = await getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  if (!isSupported(req.file.originalname)) {
    return res.status(400).json({ error: `不支持的格式，支持: ${['mp3','wav','ogg','webm','flac','aac','m4a','amr','opus','mp4','mkv','mov'].join(', ')}` });
  }
  const settings = await getSettings();
  const taskId = randomUUID();

  res.json({ taskId });

  (async () => {
    try {
      const info = await probe(req.file.path);
      queue.progress(taskId, { stage: 'transcoding', percent: 5 });
      const result = await transcribeFile(settings.asr.provider, {
        filePath: req.file.path,
        fileName: req.file.originalname
      }, settings);
      queue.progress(taskId, { stage: 'done', percent: 100 });
      meeting.source = 'file';
      meeting.audioRef = req.file.path;
      meeting.rawText = result.text;
      meeting.segments = result.segments;
      meeting.duration = Number(info.format?.duration) || 0;
      meeting.status = 'transcribed';
      await saveMeeting(meeting);
      queue.events.emit('result', { taskId, ok: true, meetingId: meeting.id });
    } catch (err) {
      queue.events.emit('result', { taskId, ok: false, error: err.message });
    }
  })();
});

export default router;