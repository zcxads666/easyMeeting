import { getMeeting, saveMeeting, getSettings } from '../services/store/jsonstore.js';
import { createRealtimeStream as defaultCreateStream } from '../services/asr/index.js';

const sessions = new Map(); // meetingId -> { stream, segments, buffer, startTime, saveTimer, socketId }

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
          segments: meeting.segments || [],
          buffer: Buffer.alloc(0),
          startTime: Date.now(),
          saveTimer: null,
          socketId: socket.id
        };
        sessions.set(meetingId, session);

        stream.on('open', () => socket.emit('rt:status', { state: 'listening' }));
        stream.on('error', (e) => socket.emit('rt:error', { error: e.message }));
        stream.on('close', () => socket.emit('rt:status', { state: 'stopped' }));

        stream.on('partial', ({ text }) => {
          socket.emit('rt:partial', { text, meetingId });
        });

        stream.on('final', ({ text }) => {
          const now = Date.now() - session.startTime;
          const seg = { start: now, end: now, text };
          session.segments.push(seg);
          meeting.segments = session.segments;
          meeting.rawText = session.segments.map((s) => s.text).join('\n');
          meeting.status = 'recording';
          scheduleSave(session, meeting);
          socket.emit('rt:final', { text, meetingId, segments: session.segments });
        });

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
        try { session.stream.send(chunk); } catch {}
      }
    });

    socket.on('rt:stop', async ({ meetingId }) => {
      await persistAndClose(meetingId);
      socket.emit('rt:status', { state: 'stopped' });
    });

    socket.on('disconnect', () => {
      for (const [meetingId, session] of [...sessions.entries()]) {
        if (session.socketId !== socket.id) continue;
        persistAndClose(meetingId).catch(() => {});
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
    try { session.stream.send(session.buffer); } catch {}
  }
  await Promise.resolve(session.stream.stop?.()).catch(() => {});
  session.stream.close?.();
  const meeting = await getMeeting(meetingId);
  if (!meeting) return;
  meeting.segments = session.segments;
  meeting.rawText = session.segments.map((s) => s.text).join('\n');
  meeting.status = 'transcribed';
  await saveMeeting(meeting);
}

function scheduleSave(session, meeting) {
  if (session.saveTimer) clearTimeout(session.saveTimer);
  session.saveTimer = setTimeout(() => {
    saveMeeting(meeting).catch(() => {});
    session.saveTimer = null;
  }, 1000);
}
