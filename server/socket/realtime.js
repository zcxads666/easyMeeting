import { getMeeting, saveMeeting, getSettings } from '../services/store/jsonstore.js';
import { createRealtimeStream } from '../services/asr/index.js';

// 管理实时转写会话
const sessions = new Map(); // meetingId -> { stream, segments, buffer, startTime, saveTimer }

let saveTimer = null;

export function setupRealtime(io) {
  io.on('connection', (socket) => {
    socket.on('rt:start', async ({ meetingId }) => {
      try {
        if (sessions.has(meetingId)) return socket.emit('rt:error', { error: '已有进行中的转写' });
        const settings = await getSettings();
        const meeting = await getMeeting(meetingId);
        if (!meeting) return socket.emit('rt:error', { error: '会议不存在' });

        const stream = createRealtimeStream(settings.asr.provider, settings);
        const session = {
          stream,
          segments: meeting.segments || [],
          buffer: Buffer.alloc(0),
          startTime: Date.now()
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
          // 防抖保存
          scheduleSave(meeting);
          socket.emit('rt:final', { text, meetingId, segments: session.segments });
        });

        stream.start().catch((e) => socket.emit('rt:error', { error: e.message }));
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
      // 每 ~200ms 累积发送（6400 bytes = 3200 samples = 200ms @16kHz s16le）
      if (session.buffer.length >= 6400) {
        const chunk = session.buffer;
        session.buffer = Buffer.alloc(0);
        try { session.stream.send(chunk); } catch {}
      }
    });

    socket.on('rt:stop', async ({ meetingId }) => {
      const session = sessions.get(meetingId);
      if (!session) return;
      if (session.buffer.length) {
        try { session.stream.send(session.buffer); } catch {}
      }
      session.buffer = Buffer.alloc(0);
      await session.stream.stop?.().catch(() => {});
      session.stream.close?.();
      sessions.delete(meetingId);
      const meeting = await getMeeting(meetingId);
      if (meeting) {
        meeting.status = 'transcribed';
        await saveMeeting(meeting);
      }
      socket.emit('rt:status', { state: 'stopped' });
    });

    // 断线清理
    socket.on('disconnect', () => {
      for (const [meetingId, session] of sessions) {
        try {
          session.stream.stop?.().catch(() => {});
          session.stream.close?.();
        } catch {}
        sessions.delete(meetingId);
      }
    });
  });
}

// 防抖保存：1 秒内多次 final 只写一次盘
function scheduleSave(meeting) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveMeeting(meeting).catch(() => {});
    saveTimer = null;
  }, 1000);
}
