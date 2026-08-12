import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { socket } from '../socket';
import { api, uploadMeeting } from '../api';
import { connectSocket } from '../socket';
import { BASE_URL } from '../env';

export default function Meeting() {
  const { id } = useParams();
  const [meeting, setMeeting] = useState(null);
  const [recording, setRecording] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [copiedIdx, setCopiedIdx] = useState(-1);
  const mediaRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletRef = useRef(null);
  const segmentsRef = useRef([]);

  useEffect(() => {
    connectSocket();
    api(`/meetings/${id}`).then(setMeeting).catch(() => setError('加载会议失败'));

    const onPartial = ({ text }) => setPartial(text);
    const onFinal = ({ text, segments }) => {
      setPartial('');
      segmentsRef.current = segments;
      setMeeting((m) => (m ? { ...m, segments, rawText: segments.map((s) => s.text).join('\n') } : m));
    };
    const onStatus = ({ state }) => {
      if (state === 'stopped') setRecording(false);
    };
    const onError = ({ error }) => setError(error);

    socket.on('rt:partial', onPartial);
    socket.on('rt:final', onFinal);
    socket.on('rt:status', onStatus);
    socket.on('rt:error', onError);

    return () => {
      socket.off('rt:partial', onPartial);
      socket.off('rt:final', onFinal);
      socket.off('rt:status', onStatus);
      socket.off('rt:error', onError);
    };
  }, [id]);

  const toggleRecording = async () => {
    if (recording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  };

  const startRecording = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000 } });
      mediaRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      await ctx.audioWorklet.addModule(`${BASE_URL}/audio-worklet.js`);
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-processor', {
        numberOfOutputs: 0,
        processorOptions: { frameSize: 1600 }
      });
      node.port.onmessage = (e) => {
        // e.data 为 Float32Array，转 16kHz->16bit PCM base64
        const pcm = float32ToPcm16(e.data);
        socket.emit('rt:audio', { meetingId: id, data: uint8ToBase64(pcm) });
      };
      source.connect(node);
      workletRef.current = node;
      socket.emit('rt:start', { meetingId: id });
      setRecording(true);
    } catch (e) {
      setError('无法访问麦克风：' + e.message);
    }
  };

  const stopRecording = async () => {
    socket.emit('rt:stop', { meetingId: id });
    try {
      workletRef.current?.disconnect();
      mediaRef.current?.getTracks().forEach((t) => t.stop());
      await audioCtxRef.current?.close();
    } catch {}
    // 稍后刷新会议
    setTimeout(() => api(`/meetings/${id}`).then(setMeeting).catch(() => {}), 800);
  };

  const onUpload = async (files) => {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    setProgress(0);
    setError('');
    try {
      const taskId = await uploadMeeting(id, file);
      const onProgress = ({ taskId: tid, percent, stage }) => {
        if (tid !== taskId) return;
        setProgress(percent || 0);
      };
      const onDone = ({ taskId: tid, ok, error: err }) => {
        if (tid !== taskId) return;
        socket.off('task:progress', onProgress);
        socket.off('task:done', onDone);
        if (ok) {
          setProgress(100);
          api(`/meetings/${id}`).then(setMeeting).catch(() => {});
        } else {
          setError(err || '转写失败');
        }
        setUploading(false);
        setTimeout(() => setProgress(0), 1500);
      };
      socket.on('task:progress', onProgress);
      socket.on('task:done', onDone);
    } catch (e) {
      setError(e.message);
      setUploading(false);
    }
  };

  if (!meeting) return <div className="pt-24 text-center text-gray-400">加载中…</div>;

  return (
    <div className="pt-10">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/" className="text-apple-blue text-sm">‹ 返回</Link>
        <input
          className="input flex-1 font-semibold text-lg"
          value={meeting.title}
          onChange={(e) => {
            setMeeting((m) => ({ ...m, title: e.target.value }));
            api(`/meetings/${id}`, { method: 'PATCH', body: { title: e.target.value } }).catch(() => {});
          }}
        />
      </div>

      {error && <div className="card p-4 mb-4 text-red-600 bg-red-50 border-red-100">{error}</div>}

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button className={recording ? 'btn bg-red-500 text-white hover:bg-red-600' : 'btn-primary'} onClick={toggleRecording}>
          {recording ? '■ 停止' : '● 开始录音'}
        </button>
        <label className="btn-secondary cursor-pointer relative overflow-hidden">
          {uploading ? `转写中 ${progress}%` : '上传录音文件'}
          <input type="file" accept=".mp3,.wav,.ogg,.webm,.flac,.aac,.m4a,.amr,.opus,.mp4,.mkv,.mov,audio/*" className="hidden" onChange={(e) => onUpload(e.target.files)} disabled={uploading} />
        </label>
        {meeting.rawText && (
          <Link to={`/summary/${id}`} className="btn-primary ml-auto">生成纪要 →</Link>
        )}
      </div>

      {/* 实时字幕 */}
      {recording && (
        <div className="card p-5 mb-6">
          <p className="text-gray-400 text-xs mb-2">实时转写</p>
          <p className="text-lg">
            {partial ? <span className="text-gray-400">{partial}</span> : <span className="text-gray-300">正在聆听…</span>}
          </p>
        </div>
      )}

      {/* 转写文本 */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">转写文本</h2>
          <span className="text-xs text-gray-400">{meeting.segments?.length || 0} 段</span>
        </div>
        {meeting.segments?.length ? (
          <div className="space-y-3">
            {meeting.segments.map((s, i) => (
              <div
                key={i}
                className="flex gap-3 group cursor-pointer rounded-lg px-2 py-1 -mx-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(s.text || '');
                  setCopiedIdx(i);
                  setTimeout(() => setCopiedIdx(-1), 1500);
                }}
                title="点击复制此句"
              >
                {s.speaker && <span className="text-xs px-2 py-0.5 h-fit rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 shrink-0">{s.speaker}</span>}
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed flex-1">{s.text}</p>
                {copiedIdx === i && <span className="text-xs text-green-500 self-center shrink-0">已复制</span>}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-300 text-center py-8">暂无转写内容</p>
        )}
      </div>
    </div>
  );
}

function float32ToPcm16(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function uint8ToBase64(uint8) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < uint8.length; i += chunkSize) {
    const chunk = uint8.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}