import { getMeeting, saveMeeting, getSettings } from '../services/store/jsonstore.js';
import { normalizeRealtimeFinal, normalizeRealtimeMetrics } from '../services/asr/contract.js';
import { resolveRealtimeCapability } from '../services/asr/capabilities.js';
import { RecordingWriter, cleanupPartialRecordings } from '../services/audio/recording.js';
import { enqueuePostProcessing } from '../services/post-processing.js';
import { MEETING_SCHEMA_VERSION } from '../services/timeline.js';

const sessions = new Map();
const logError = (message, error) => console.error(`[realtime] ${message}:`, error?.stack || error?.message || error);

export function setupRealtime(io, injectedCreateStream = null) {
  cleanupPartialRecordings().catch((error) => logError('partial recording cleanup failed', error));
  io.on('connection', (socket) => {
    socket.on('rt:start', async ({ meetingId }) => {
      try {
        if (sessions.has(meetingId)) return socket.emit('rt:error', { error: '已有进行中的转写' });
        const settings = await getSettings();
        const meeting = await getMeeting(meetingId);
        if (!meeting) return socket.emit('rt:error', { error: '会议不存在' });
        const capability = await resolveRealtimeCapability(settings);
        meeting.status = 'recording';
        meeting.timelineStatus = 'provisional';
        await saveMeeting(meeting);
        const recording = await RecordingWriter.create(meetingId);
        let stream = null; let streamError = null;
        try {
          const createStream = injectedCreateStream || (await import('../services/asr/index.js')).createRealtimeStream;
          stream = createStream(settings.asr.provider, settings, capability);
        }
        catch (error) { streamError = error; }
        const session = {
          stream,
          recording,
          capability,
          settings,
          segments: meeting.segments || [],
          buffer: Buffer.alloc(0),
          saveTimer: null,
          socketId: socket.id,
          stopping: false,
          failed: Boolean(streamError)
        };
        sessions.set(meetingId, session);
        socket.emit('rt:capability', { meetingId, ...capability });
        if (streamError) socket.emit('rt:error', { error: streamError.message, detail: { code: streamError.code || 'REALTIME_START_FAILED',
          message: streamError.message, provider: settings.asr.provider, fatal: true }, recordingContinues: true });

        stream?.on('open', () => socket.emit('rt:status', { state: 'listening', mode: capability.resolvedMode }));
        stream?.on('error', (error) => {
          session.failed = true;
          const payload = error instanceof Error
            ? { code: error.code || 'REALTIME_ERROR', message: error.message, provider: settings.asr.provider, model: null, fatal: true }
            : error;
          socket.emit('rt:error', { error: payload?.message || '实时转写失败', detail: payload, recordingContinues: true });
        });
        stream?.on('close', () => socket.emit('rt:status', { state: session.stopping ? 'stopping' : 'asr-stopped', mode: capability.resolvedMode }));

        stream?.on('partial', ({ text, provider = settings.asr.provider, model = null }) => {
          socket.emit('rt:partial', { text, meetingId, provider, model });
        });

        stream?.on('final', (payload) => {
          const seg = normalizeRealtimeFinal(payload, { provider: settings.asr.provider });
          if (!seg.text) return;
          session.segments.push(seg);
          meeting.segments = session.segments;
          meeting.rawText = session.segments.map((s) => s.text).join('\n');
          meeting.status = 'recording';
          meeting.timeline = { words: [], segments: session.segments, source: 'asr', status: 'provisional', updatedAt: Date.now() };
          scheduleSave(session, meeting);
          socket.emit('rt:final', { ...seg, meetingId, segments: session.segments });
        });

        stream?.on('metrics', (metrics) => socket.emit('rt:metrics', {
          ...normalizeRealtimeMetrics(metrics), meetingId
        }));

        if (stream) Promise.resolve(stream.start?.()).catch((error) => {
          session.failed = true; socket.emit('rt:error', { error: error.message, detail: { code: error.code || 'REALTIME_START_FAILED',
            message: error.message, fatal: true }, recordingContinues: true });
        });
        socket.emit('rt:status', { state: stream ? 'starting' : 'recording-without-asr', mode: capability.resolvedMode });
      } catch (e) {
        socket.emit('rt:error', { error: e.message });
      }
    });

    socket.on('rt:audio', async ({ meetingId, data }) => {
      const session = sessions.get(meetingId);
      if (!session || session.stopping) return;
      const buf = Buffer.from(data, 'base64');
      try { session.recording.write(buf); }
      catch (error) { session.recordingFailed = error; logError('recording write failed', error); socket.emit('rt:error', {
        error: '录音写入失败', detail: { code: error.code || 'RECORDING_WRITE_FAILED', message: error.message, fatal: true } }); }
      if (!session.stream) return;
      session.buffer = Buffer.concat([session.buffer, buf]);
      if (session.buffer.length >= 6400) {
        const chunk = session.buffer;
        session.buffer = Buffer.alloc(0);
        try { session.stream.send(chunk); }
        catch (error) { logError('audio send failed', error); socket.emit('rt:error', { error: error.message }); }
      }
    });

    socket.on('rt:stop', async ({ meetingId }) => {
      try {
        await persistAndClose(meetingId);
        socket.emit('rt:status', { state: 'stopped' });
      } catch (error) {
        logError(`stop failed meeting=${meetingId}`, error);
        socket.emit('rt:error', { error: '停止并保存会议失败', detail: { code: error.code || 'REALTIME_STOP_FAILED', message: error.message, fatal: true } });
      }
    });

    socket.on('disconnect', () => {
      for (const [meetingId, session] of [...sessions.entries()]) {
        if (session.socketId !== socket.id) continue;
        persistAndClose(meetingId).catch((error) => logError(`disconnect persist failed meeting=${meetingId}`, error));
      }
    });
  });
}

async function persistAndClose(meetingId) {
  const session = sessions.get(meetingId);
  if (!session) return;
  if (session.stopping) return session.stopPromise;
  session.stopping = true;
  session.stopPromise = closeSession();
  return session.stopPromise;

  async function closeSession() {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
    }
    if (session.stream && session.buffer.length) {
      try { session.stream.send(session.buffer); }
      catch (error) { logError('final audio send failed', error); }
    }
    try { await Promise.resolve(session.stream?.stop?.()); }
    catch (error) { session.failed = true; logError('stream stop failed', error); }
    session.stream?.close?.();
    let recordingResult = { path: null, duration: 0 };
    try { recordingResult = await session.recording.finalize(); }
    catch (error) { session.recordingFailed = error; logError('recording finalize failed', error); }
    const meeting = await getMeeting(meetingId);
    if (!meeting) { sessions.delete(meetingId); return; }
    meeting.segments = session.segments;
    meeting.timeline = { words: [], segments: session.segments, source: 'asr', status: 'provisional', updatedAt: Date.now() };
    meeting.timelineStatus = 'provisional';
    meeting.schemaVersion = MEETING_SCHEMA_VERSION;
    meeting.segmentTimeUnit = 'seconds';
    meeting.rawText = session.segments.map((s) => s.text).join('\n');
    if (recordingResult.path) meeting.audioRef = recordingResult.path;
    meeting.duration = Math.max(meeting.duration || 0, recordingResult.duration || 0);
    meeting.realtime = { requestedMode: session.capability.requestedMode, resolvedMode: session.capability.resolvedMode,
      backend: session.capability.realtimeBackend, reason: session.capability.reason || null };
    meeting.status = session.recordingFailed ? 'recording_error' : session.failed ? 'recorded_with_asr_error' : 'transcribed';
    await saveMeeting(meeting);
    sessions.delete(meetingId);
    if (!session.recordingFailed && recordingResult.path) enqueuePostProcessing(meetingId, session.settings);
  }
}

function scheduleSave(session, meeting) {
  if (session.saveTimer) clearTimeout(session.saveTimer);
  session.saveTimer = setTimeout(() => {
    saveMeeting(meeting).catch((error) => logError(`scheduled save failed meeting=${meeting.id}`, error));
    session.saveTimer = null;
  }, 1000);
}
