import { getMeeting, saveMeeting, getSettings } from '../services/store/jsonstore.js';
import { createRealtimeStream as defaultCreateStream } from '../services/asr/index.js';
import { normalizeRealtimeFinal, normalizeRealtimeMetrics } from '../services/asr/contract.js';

const sessions = new Map();
const logError = (message, error) => console.error(`[realtime] ${message}:`, error?.stack || error?.message || error);

export function setupRealtime(io, createStream = defaultCreateStream) {
  io.on('connection', (socket) => {
    socket.on('rt:start', async ({ meetingId }) => {
      try {
        if (sessions.has(meetingId)) return socket.emit('rt:error', { error: '已有进行中的转写' });
        const settings = await getSettings();
        const meeting = await getMeeting(meetingId);
        if (!meeting) return socket.emit('rt:error', { error: '会议不存在' });
        meeting.status = 'recording';
        await saveMeeting(meeting);

        const stream = createStream(settings.asr.provider, settings);
        const session = {
          stream,
          segments: meeting.schemaVersion >= 2 ? (meeting.segments || []) : (meeting.segments || []).map((segment) => ({
            ...segment, start: null, end: null, confidence: segment.confidence ?? null,
            speaker: segment.speaker ?? null, timing: 'unknown'
          })),
          buffer: Buffer.alloc(0),
          saveTimer: null,
          socketId: socket.id
        };
        sessions.set(meetingId, session);

        stream.on('open', () => socket.emit('rt:status', { state: 'listening' }));
        stream.on('error', (error) => {
          session.failed = true;
          const payload = error instanceof Error
            ? { code: error.code || 'REALTIME_ERROR', message: error.message, provider: settings.asr.provider, model: null, fatal: true }
            : error;
          socket.emit('rt:error', { error: payload?.message || '实时转写失败', detail: payload });
        });
        stream.on('close', () => socket.emit('rt:status', { state: 'stopped' }));

        stream.on('partial', ({ text, provider = settings.asr.provider, model = null }) => {
          socket.emit('rt:partial', { text, meetingId, provider, model });
        });

        stream.on('final', (payload) => {
          const seg = normalizeRealtimeFinal(payload, { provider: settings.asr.provider });
          if (!seg.text) return;
          session.segments.push(seg);
          meeting.segments = session.segments;
          meeting.rawText = session.segments.map((s) => s.text).join('\n');
          meeting.status = 'recording';
          scheduleSave(session, meeting);
          socket.emit('rt:final', { ...seg, meetingId, segments: session.segments });
        });

        stream.on('metrics', (metrics) => socket.emit('rt:metrics', {
          ...normalizeRealtimeMetrics(metrics), meetingId
        }));

        Promise.resolve(stream.start?.()).catch((e) => socket.emit('rt:error', { error: e.message }));
        socket.emit('rt:status', { state: 'starting' });
      } catch (e) {
        socket.emit('rt:error', { error: e.message });
      }
    });

    socket.on('rt:audio', async ({ meetingId, data }) => {
      const session = sessions.get(meetingId);
      if (!session) return;
      const buf = Buffer.from(data, 'base64');
      session.buffer = Buffer.concat([session.buffer, buf]);
      if (session.buffer.length >= 6400) {
        const chunk = session.buffer;
        session.buffer = Buffer.alloc(0);
        try { session.stream.send(chunk); }
        catch (error) { logError('audio send failed', error); socket.emit('rt:error', { error: error.message }); }
      }
    });

    socket.on('rt:stop', async ({ meetingId }) => {
      await persistAndClose(meetingId);
      socket.emit('rt:status', { state: 'stopped' });
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
  sessions.delete(meetingId);
  if (session.saveTimer) {
    clearTimeout(session.saveTimer);
    session.saveTimer = null;
  }
  if (session.buffer.length) {
    try { session.stream.send(session.buffer); }
    catch (error) { logError('final audio send failed', error); }
  }
  try { await Promise.resolve(session.stream.stop?.()); }
  catch (error) { logError('stream stop failed', error); }
  session.stream.close?.();
  const meeting = await getMeeting(meetingId);
  if (!meeting) return;
  meeting.segments = session.segments;
  meeting.schemaVersion = 2;
  meeting.segmentTimeUnit = 'seconds';
  meeting.rawText = session.segments.map((s) => s.text).join('\n');
  meeting.status = session.failed ? 'error' : 'transcribed';
  await saveMeeting(meeting);
}

function scheduleSave(session, meeting) {
  if (session.saveTimer) clearTimeout(session.saveTimer);
  session.saveTimer = setTimeout(() => {
    saveMeeting(meeting).catch((error) => logError(`scheduled save failed meeting=${meeting.id}`, error));
    session.saveTimer = null;
  }, 1000);
}
