import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { socket } from '../socket';
import { api, uploadMeeting } from '../api';
import { connectSocket } from '../socket';
import { BASE_URL, API_TOKEN } from '../env';

export default function Meeting() {
  const { id } = useParams();
  const [meeting, setMeeting] = useState(null);
  const [recording, setRecording] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [taskStage, setTaskStage] = useState('');
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [copiedIdx, setCopiedIdx] = useState(-1);
  const [audioUrl, setAudioUrl] = useState('');
  const [activeSegment, setActiveSegment] = useState(-1);
  const [alignmentLanguage, setAlignmentLanguage] = useState('zh');
  const [postTask, setPostTask] = useState(null);
  const [speakerDrafts, setSpeakerDrafts] = useState({});
  const mediaRef = useRef(null);
  const playerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletRef = useRef(null);
  const segmentsRef = useRef([]);

  const stopCapture = () => {
    socket.emit('rt:stop', { meetingId: id });
    try {
      workletRef.current?.disconnect();
      mediaRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
    } catch {}
    workletRef.current = null;
    mediaRef.current = null;
    audioCtxRef.current = null;
  };

  useEffect(() => {
    setMeeting(null);
    setError('');
    segmentsRef.current = [];
    connectSocket();
    api(`/meetings/${id}`).then(async (value) => {
      setMeeting(value);
      setSpeakerDrafts(value.speakerLabels || {});
      setAlignmentLanguage(value.asr?.language || value.alignment?.language || 'zh');
      if (value.audioRef) {
        const token = await api(`/meetings/${id}/audio-token`, { method: 'POST' });
        setAudioUrl(`${BASE_URL}${token.url}`);
      } else setAudioUrl('');
    }).catch(() => setError('会议不存在或加载失败'));

    const onPartial = ({ text, meetingId }) => {
      if (meetingId && meetingId !== id) return;
      setPartial(text);
    };
    const onFinal = ({ text, segments, meetingId }) => {
      if (meetingId && meetingId !== id) return;
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
    window.addEventListener('beforeunload', stopCapture);

    return () => {
      window.removeEventListener('beforeunload', stopCapture);
      stopCapture();
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
    stopCapture();
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
      setActiveTaskId(taskId);
      const onProgress = ({ taskId: tid, stage }) => {
        if (tid !== taskId) return;
        setTaskStage(stage || 'queued');
      };
      const onDone = ({ taskId: tid, ok, error: err, status }) => {
        if (tid !== taskId) return;
        socket.off('task:progress', onProgress);
        socket.off('task:done', onDone);
        if (ok) {
          setProgress(100);
          api(`/meetings/${id}`).then(setMeeting).catch(() => {});
        } else {
          setError(status === 'cancelled' ? '任务已取消' : (err || '转写失败'));
        }
        setUploading(false);
        setActiveTaskId(null);
        setTaskStage('');
        setTimeout(() => setProgress(0), 1500);
      };
      socket.on('task:progress', onProgress);
      socket.on('task:done', onDone);
    } catch (e) {
      setError(e.message);
      setUploading(false);
      setActiveTaskId(null);
    }
  };

  const runAlignment = async () => {
    setError('');
    try {
      const { taskId } = await api(`/meetings/${id}/align`, { method: 'POST', body: { source: 'auto', language: alignmentLanguage, device: 'auto' } });
      setPostTask({ id: taskId, stage: 'queued' });
      const timer = setInterval(async () => {
        try {
          const task = await api(`/tasks/${taskId}`);
          setPostTask({ id: taskId, stage: task.stage, status: task.status });
          if (['completed', 'failed', 'cancelled'].includes(task.status)) {
            clearInterval(timer);
            if (task.status === 'completed') setMeeting(await api(`/meetings/${id}`));
            else setError(task.error?.message || '精确对齐失败');
          }
        } catch (e) { clearInterval(timer); setError(e.message); }
      }, 700);
    } catch (e) { setError(e.message); }
  };

  const runDiarization = async () => {
    setError('');
    try {
      const { taskId } = await api(`/meetings/${id}/diarize`, { method: 'POST', body: {} });
      setPostTask({ id: taskId, stage: 'queued', type: 'diarization' });
      const timer = setInterval(async () => {
        try {
          const task = await api(`/tasks/${taskId}`); setPostTask({ ...task, type: 'diarization' });
          if (['completed', 'failed', 'cancelled'].includes(task.status)) {
            clearInterval(timer);
            if (task.status === 'completed') { const value = await api(`/meetings/${id}`); setMeeting(value); setSpeakerDrafts(value.speakerLabels || {}); }
            else setError(task.error?.message || '说话人分离失败');
          }
        } catch (e) { clearInterval(timer); setError(e.message); }
      }, 700);
    } catch (e) { setError(e.message); }
  };

  const saveSpeaker = async (speaker) => {
    try {
      const value = await api(`/meetings/${id}/speakers`, { method: 'PATCH', body: { labels: { [speaker]: speakerDrafts[speaker] } } });
      setMeeting(value);
    } catch (e) { setError(e.message); }
  };

  const downloadSubtitle = async (kind) => {
    try {
      const speakerQuery = meeting?.diarization ? '?includeSpeaker=1' : '';
      const response = await fetch(`${BASE_URL}/api/meetings/${id}/export/${kind}${speakerQuery}`, {
        headers: API_TOKEN ? { 'X-Meeting-Token': API_TOKEN } : {}
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || '字幕导出失败');
      }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `meeting-${id}.${kind}`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e.message); }
  };

  const updateActiveSegment = () => {
    const time = playerRef.current?.currentTime;
    const segments = meeting?.timeline?.segments || meeting?.segments || [];
    if (!Number.isFinite(time) || !segments.length) return;
    let lo = 0; let hi = segments.length - 1; let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1; const segment = segments[mid];
      if (!Number.isFinite(segment.start) || time < segment.start) hi = mid - 1;
      else { found = mid; lo = mid + 1; }
    }
    if (found >= 0 && time <= segments[found].end) setActiveSegment(found); else setActiveSegment(-1);
  };

  const seekTo = (seconds) => {
    if (!playerRef.current || !Number.isFinite(seconds)) return;
    playerRef.current.currentTime = seconds; playerRef.current.play().catch(() => {});
  };

  if (!meeting && error) {
    return (
      <div className="pt-24 text-center text-gray-400">
        <p>{error}</p>
        <Link to="/" className="text-apple-blue text-sm mt-3 inline-block">返回列表</Link>
      </div>
    );
  }
  if (!meeting) return <div className="pt-24 text-center text-gray-400">加载中…</div>;

  return (
    <div className="pt-10">
      <div className="flex items-center gap-3 mb-6">
        <Link to="/" className="text-apple-blue text-sm">‹ 返回</Link>
        <input
          className="input flex-1 font-semibold text-lg"
          value={meeting.title}
          onChange={(e) => setMeeting((m) => ({ ...m, title: e.target.value }))}
          onBlur={(e) => {
            api(`/meetings/${id}`, { method: 'PATCH', body: { title: e.target.value } }).catch(() => {});
          }}
        />
      </div>

      {error && <div className="card p-4 mb-4 text-red-600 bg-red-50 border-red-100">{error}</div>}

      {audioUrl && (
        <div className="card p-4 mb-4">
          <audio ref={playerRef} controls src={audioUrl} className="w-full" onTimeUpdate={updateActiveSegment} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button className={recording ? 'btn bg-red-500 text-white hover:bg-red-600' : 'btn-primary'} onClick={toggleRecording}>
          {recording ? '■ 停止' : '● 开始录音'}
        </button>
        <label className="btn-secondary cursor-pointer relative overflow-hidden">
          {uploading ? taskStageLabel(taskStage) : '上传录音文件'}
          <input type="file" accept=".mp3,.wav,.ogg,.webm,.flac,.aac,.m4a,.amr,.opus,.mp4,.mkv,.mov,audio/*" className="hidden" onChange={(e) => onUpload(e.target.files)} disabled={uploading} />
        </label>
        {uploading && activeTaskId && (
          <button className="btn-secondary text-red-500" onClick={() => api(`/tasks/${activeTaskId}/cancel`, { method: 'POST' })}>
            取消任务
          </button>
        )}
        {meeting.rawText && (
          <Link to={`/summary/${id}`} className="btn-primary ml-auto">生成纪要 →</Link>
        )}
      </div>

      {meeting.rawText && meeting.audioRef && (
        <div className="card p-4 mb-6 flex flex-wrap gap-3 items-center">
          <span className="text-sm font-medium">精确时间轴</span>
          <select className="input py-1 text-sm" value={alignmentLanguage} onChange={(e) => setAlignmentLanguage(e.target.value)}>
            {[['zh','中文'],['en','English'],['yue','粤语'],['fr','Français'],['de','Deutsch'],['it','Italiano'],['ja','日本語'],['ko','한국어'],['pt','Português'],['ru','Русский'],['es','Español']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button className="btn-secondary" onClick={runAlignment} disabled={postTask && !['completed','failed','cancelled'].includes(postTask.status)}>
            {postTask && !['completed','failed','cancelled'].includes(postTask.status) ? taskStageLabel(postTask.stage) : meeting.alignment?.stale ? '重新对齐' : meeting.alignment ? '重新运行' : '运行精确对齐'}
          </button>
          <span className={`text-xs ${meeting.alignment?.stale ? 'text-amber-600' : 'text-gray-400'}`}>
            {meeting.alignment?.stale ? '已过期' : meeting.timelineStatus === 'aligned' ? '精确' : '未运行'}
          </span>
          <button className="btn-secondary ml-auto" onClick={() => downloadSubtitle('srt')} disabled={meeting.alignment?.stale}>导出 SRT</button>
          <button className="btn-secondary" onClick={() => downloadSubtitle('vtt')} disabled={meeting.alignment?.stale}>导出 VTT</button>
        </div>
      )}

      {meeting.rawText && meeting.audioRef && (
        <div className="card p-4 mb-6">
          <div className="flex items-center gap-3"><span className="text-sm font-medium">说话人分离</span>
            <button className="btn-secondary" onClick={runDiarization} disabled={postTask && !['completed','failed','cancelled'].includes(postTask.status)}>
              {postTask?.type === 'diarization' && !['completed','failed','cancelled'].includes(postTask.status) ? taskStageLabel(postTask.stage) : meeting.diarization ? '重新运行' : '运行说话人分离'}
            </button><span className="text-xs text-gray-400">{meeting.diarization ? `${meeting.diarization.speakerCount || 0} 位说话人 · ${meeting.diarization.speakerAttribution?.quality || 'unknown'}` : '未运行'}</span></div>
          {Object.keys(meeting.speakerLabels || {}).length > 0 && <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
            {Object.keys(meeting.speakerLabels).sort().map((speaker) => <label key={speaker} className="flex gap-2 items-center text-xs"><span className="w-24 text-gray-400">{speaker}</span>
              <input className="input py-1" value={speakerDrafts[speaker] ?? meeting.speakerLabels[speaker]} onChange={(e) => setSpeakerDrafts((value) => ({ ...value, [speaker]: e.target.value }))} onBlur={() => saveSpeaker(speaker)} /></label>)}
          </div>}
        </div>
      )}

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
        {(meeting.timeline?.segments || meeting.segments)?.length ? (
          <div className="space-y-3">
            {(meeting.timeline?.segments || meeting.segments).map((s, i) => (
              <div
                key={i}
                className={`flex gap-3 group cursor-pointer rounded-lg px-2 py-1 -mx-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${activeSegment === i ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}
                onClick={() => {
                  if (Number.isFinite(s.start)) seekTo(s.start);
                  else { navigator.clipboard.writeText(s.text || ''); setCopiedIdx(i); setTimeout(() => setCopiedIdx(-1), 1500); }
                }}
                title={Number.isFinite(s.start) ? '点击跳转并播放' : '点击复制此句'}
              >
                {Number.isFinite(s.start) && <button className="text-xs text-apple-blue shrink-0" onClick={(event) => { event.stopPropagation(); seekTo(s.start); }}>{formatClock(s.start)}</button>}
                {s.speaker && <span className="text-xs px-2 py-0.5 h-fit rounded-full bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 shrink-0">{meeting.speakerLabels?.[s.speaker] || s.speaker}</span>}
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

function taskStageLabel(stage) {
  return ({ queued: '等待中', preparing: '准备中', probing: '读取音频', transcoding: '转码中',
    loading_model: '加载模型', transcribing: '转写中', aligning: '对齐中', building_timeline: '构建时间轴',
    segmenting: '检测语音', embedding: '提取声纹', clustering: '聚类', attributing: '归属说话人', saving: '保存中', completed: '完成',
    failed: '失败', cancelled: '已取消' })[stage] || '处理中';
}

function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
