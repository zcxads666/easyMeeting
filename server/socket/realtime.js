import { randomUUID } from 'node:crypto';
import { createRealtimeStream } from '../services/asr/index.js';
import { getMeeting, saveMeeting } from '../services/store/jsonstore.js';
import { getSettings } from '../services/store/jsonstore.js';

// 管理实时转写会话
const sessions = new Map(); // meetingId -> { stream, segments, buffer }

export function setupRealtime(io) {
  io.on('connection', (socket) => {
    socket.on('rt:start', async ({ meetingId }) => {
      try {
        if (sessions.has(meetingId)) return socket.emit('rt:error', { error: '已有进行中的转写' });
        const settings = await getSettings();
        const meeting = await getMeeting(meetingId);
        if (!meeting) return socket.emit('rt:error', { error: '会议不存在' });

        const stream = createRealtimeStream(settings.asr.provider, settings);
        const session = { stream, segments: meeting.segments || [], buffer: Buffer.alloc(0) };
        sessions.set(meetingId, session);

        stream.on('open', () => socket.emit('rt:status', { state: 'listening' }));
        stream.on('error', (e) => socket.emit('rt:error', { error: e.message }));
        stream.on('close', () => socket.emit('rt:status', { state: 'stopped' }));

        // 半成品
        stream.on('partial', ({ text }) => {
          socket.emit('rt:partial', { text, meetingId });
        });

        // 成品一句
        stream.on('final', ({ text }) => {
          const seg = { start: Date.now(), end: Date.now(), text };
          session.segments.push(seg);
          meeting.segments = session.segments;
          meeting.rawText = session.segments.map((s) => s.text).join('\n');
          meeting.status = 'recording';
          saveMeeting(meeting).catch(() => {});
          socket.emit('rt:final', { text, meetingId, segments: session.segments });
        });

        stream.start();
        socket.emit('rt:status', { state: 'starting' });
      } catch (e) {
        socket.emit('rt:error', { error: e.message });
      }
    });

    // 前端推送音频帧（base64 PCM）
    socket.on('rt:audio', async ({ meetingId, data }) => {
      const session = sessions.get(meetingId);
      if (!session) return;
      const buf = Buffer.from(data, 'base64');
      session.buffer = Buffer.concat([session.buffer, buf]);
      // 每 100ms 累积发送
      if (session.buffer.length >= 6400) {
        const chunk = session.buffer;
        session.buffer = Buffer.alloc(0);
        session.stream.send(chunk);
      }
    });

    socket.on('rt:stop', async ({ meetingId }) => {
      const session = sessions.get(meetingId);
      if (!session) return;
      if (session.buffer.length) session.stream.send(session.buffer);
      session.buffer = Buffer.alloc(0);
      await session.stream.stop?.();
      session.stream.close();
      sessions.delete(meetingId);
      const meeting = await getMeeting(meetingId);
      if (meeting) {
        meeting.status = 'transcribed';
        await saveMeeting(meeting);
      }
      socket.emit('rt:status', { state: 'stopped' });
    });
  });
}