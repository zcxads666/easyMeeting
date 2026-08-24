import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../api';
import { useStore } from '../store';

export default function Models() {
  const [models, setModels] = useState([]);
  const [diskUsage, setDiskUsage] = useState(0);
  const [downloading, setDownloading] = useState(null);
  const [status, setStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [runtime, setRuntime] = useState(null);
  const [runtimeTask, setRuntimeTask] = useState(null);
  const [benchmarkMeeting, setBenchmarkMeeting] = useState('');
  const [meetings, setMeetings] = useState([]);
  const [benchmarks, setBenchmarks] = useState({});
  const settings = useStore((s) => s.settings);
  const pollRef = useRef(null);
  const retryTimerRef = useRef(null);
  const autoSwitchingRef = useRef(new Set());

  // 加载模型列表；失败或占用未计算完成时自动重试。
  // silent=true 时静默刷新（保留旧列表，避免闪烁/滚动跳动）
  const load = useCallback(async (retries = 3, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [runtimeState, data] = await Promise.all([api('/runtime'), api('/models')]);
      setRuntime(runtimeState);
      setModels(data.models || []);
      setDiskUsage(data.disk_usage || 0);
      setError('');
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      // 已安装模型占用尚未返回（如服务刚热重启）：1.5s 后静默重试直到拿到实际大小
      const pendingSize = (data.models || []).some((m) => m.installed && !m.size_bytes);
      if (pendingSize && retries > 0) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          load(retries - 1, true);
        }, 1500);
      }
    } catch (e) {
      if (!silent) setError('本地推理服务未启动：' + e.message);
      // 5 秒后静默重试
      if (!retryTimerRef.current) {
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          load(3, true);
        }, 5000);
      }
    } finally { if (!silent) setLoading(false); }
  }, []);

  const pollStatus = async () => {
    try {
      const data = await api('/models/download/status');
      setStatus(data.downloads || {});
    } catch { /* 忽略 */ }
  };

  useEffect(() => { load(); return () => { if (retryTimerRef.current) clearTimeout(retryTimerRef.current); }; }, [load]);

  // 有下载任务时轮询：只刷状态，下载完成后再刷新列表（避免下载期间频繁计算占用）
  useEffect(() => {
    if (downloading || models.some((m) => ['queued', 'downloading', 'verifying'].includes(m.status))) {
      pollStatus();
      pollRef.current = setInterval(() => { pollStatus(); }, 2000);
      return () => clearInterval(pollRef.current);
    }
  }, [downloading, models]);

  // 检测下载完成
  useEffect(() => {
    if (!downloading) return;
    const st = status[downloading];
    if (st && ['ready', 'cancelled', 'error', 'broken'].includes(st.status)) {
      const id = downloading;
      setDownloading(null);
      const downloaded = models.find((model) => model.id === id);
      (async () => {
        if (st.status === 'ready' && downloaded?.role === 'asr' && !autoSwitchingRef.current.has(id)) {
          autoSwitchingRef.current.add(id);
          try {
            await switchModel(id);
          } catch (e) {
            setError(`模型已下载，但自动切换失败：${e.message}`);
          } finally {
            autoSwitchingRef.current.delete(id);
          }
        }
        await load(3, true);
        if (['error', 'broken'].includes(st.status)) setError(`下载失败: ${st.error?.message || st.error || ''}`);
      })();
    }
  }, [status, downloading, models, load]);

  const download = async (id) => {
    setDownloading(id);
    setError('');
    try {
      await api('/models/download', { method: 'POST', body: { id } });
      await load(0, true);
    } catch (e) {
      setError(e.message);
      setDownloading(null);
    }
  };

  const cancelDownload = async (id) => {
    try { await api('/models/download/cancel', { method: 'POST', body: { id } }); await load(0, true); }
    catch (e) { setError(e.message); }
  };
  const verify = async (id) => {
    try {
      const result = await api('/models/verify', { method: 'POST', body: { id } });
      const model = models.find((item) => item.id === id);
      if (result.status === 'ready' && model?.role === 'asr') await switchModel(id);
      await load(0, true);
    }
    catch (e) { setError(e.message); }
  };

  const del = async (id) => {
    if (!confirm('确定删除该模型？')) return;
    try {
      await api(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load(3, true);
    } catch (e) { setError(e.message); }
  };

  const switchModel = async (id) => {
    try {
      await api('/models/switch', { method: 'POST', body: { id } });
      await useStore.getState().saveSettings({ asr: { provider: 'local', local: { engine: id.startsWith('whisper') ? 'whisper' : 'qwen', model: id } } });
      await load(3, true);
    } catch (e) { setError(e.message); }
  };

  const runtimeAction = async (action) => {
    setError('');
    try {
      const result = await api(`/runtime/${action}`, { method: 'POST' });
      if (result.taskId) setRuntimeTask(result.taskId); else await load(0, true);
    } catch (e) { setError(e.message); }
  };

  const installFeature = async (feature) => {
    setError('');
    try { const result = await api(`/runtime/features/${feature}/install`, { method: 'POST' }); if (result.taskId) setRuntimeTask(result.taskId); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => {
    if (!runtimeTask) return;
    const timer = setInterval(async () => {
      try {
        const task = await api(`/tasks/${runtimeTask}`);
        setRuntime((r) => ({ ...(r || {}), status: task.status === 'running' ? task.stage : r?.status }));
        if (['completed', 'failed', 'cancelled'].includes(task.status)) {
          clearInterval(timer); setRuntimeTask(null);
          if (task.status === 'failed') setError(task.error?.message || 'Runtime 安装失败');
          await load(0, true);
        }
      } catch (e) { clearInterval(timer); setRuntimeTask(null); setError(e.message); }
    }, 1000);
    return () => clearInterval(timer);
  }, [runtimeTask, load]);

  useEffect(() => { api('/meetings').then((items) => {
    const usable = (items || []).filter((meeting) => meeting.audioRef);
    setMeetings(usable); if (usable[0]) setBenchmarkMeeting(usable[0].id);
  }).catch(() => {}); }, []);

  const benchmark = async (id) => {
    if (!benchmarkMeeting) { setError('请先选择一个包含音频的会议'); return; }
    try {
      const { taskId } = await api(`/models/${encodeURIComponent(id)}/benchmark`, { method: 'POST', body: { meetingId: benchmarkMeeting } });
      setBenchmarks((value) => ({ ...value, [id]: { taskId, status: 'queued', stage: 'queued' } }));
    } catch (e) { setError(e.message); }
  };
  const cancelBenchmark = async (id) => {
    const taskId = benchmarks[id]?.taskId;
    if (!taskId) return;
    try {
      await api(`/tasks/${taskId}/cancel`, { method: 'POST' });
      const task = await api(`/tasks/${taskId}`);
      setBenchmarks((all) => ({ ...all, [id]: task }));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => {
    const active = Object.entries(benchmarks).filter(([, value]) => value.taskId && !['completed', 'failed', 'cancelled'].includes(value.status));
    if (!active.length) return;
    const timer = setInterval(() => active.forEach(async ([id, value]) => {
      try { const task = await api(`/tasks/${value.taskId}`); setBenchmarks((all) => ({ ...all, [id]: task })); }
      catch (e) { setError(e.message); }
    }), 1000);
    return () => clearInterval(timer);
  }, [benchmarks]);

  const current = settings?.asr?.local?.model;

  return (
    <div className="pt-12 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">本地模型</h1>
          <p className="text-gray-400 dark:text-gray-500 mt-1">Whisper 多种尺寸 · Qwen3-ASR，本地推理不依赖云端</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400 dark:text-gray-500">占用 {formatBytes(diskUsage)}</span>
          <button className="btn-secondary !py-1.5 text-sm" onClick={load} disabled={loading}>刷新</button>
        </div>
      </div>

      {error && (
        <div className="card p-4 mb-6 text-red-600 bg-red-50 border-red-100 dark:bg-red-950/30 dark:border-red-900 flex items-center justify-between gap-3">
          <div className="flex-1">
            <p className="font-medium">本地推理服务不可用</p>
            <p className="text-sm mt-0.5">{error}。正在自动重试…</p>
          </div>
          <button className="btn-secondary !py-1.5 text-sm shrink-0" onClick={load} disabled={loading}>立即重试</button>
        </div>
      )}

      {runtime && <RuntimePanel runtime={runtime} busy={Boolean(runtimeTask)} onAction={runtimeAction} onInstallFeature={installFeature} />}

      <div className="card p-4 mb-6 flex items-center gap-3">
        <div className="shrink-0"><label className="text-sm text-gray-500">性能测试音频</label><p className="text-xs text-gray-400 mt-1">仅测试前 15 秒，可随时取消</p></div>
        <select className="input flex-1" value={benchmarkMeeting} onChange={(e) => setBenchmarkMeeting(e.target.value)}>
          <option value="">请选择包含音频的会议</option>
          {meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="text-center text-gray-400 py-16">加载模型列表…</p>
      ) : models.length === 0 && !error ? (
        <div className="card p-12 text-center text-gray-400">
          <p className="text-4xl mb-3">📦</p>
          <p>暂无可用模型</p>
          <button className="btn-secondary mt-4" onClick={load}>重新加载</button>
        </div>
      ) : (
        <div className="space-y-4">
          <h2 className="font-semibold text-lg">Whisper</h2>
          {models.filter((m) => m.kind === 'whisper').map((m) => (
            <ModelRow key={m.id} m={m} current={current} downloading={downloading} status={status[m.id]} benchmark={benchmarks[m.id]} runtimeReady={['ready', 'running'].includes(runtime?.status)} onDownload={download} onCancel={cancelDownload} onVerify={verify} onBenchmark={benchmark} onCancelBenchmark={cancelBenchmark} onDelete={del} onSwitch={switchModel} />
          ))}

          <h2 className="font-semibold text-lg pt-4">Qwen3-ASR</h2>
          {models.filter((m) => m.kind === 'qwen').map((m) => (
            <ModelRow key={m.id} m={m} current={current} downloading={downloading} status={status[m.id]} benchmark={benchmarks[m.id]} runtimeReady={['ready', 'running'].includes(runtime?.status)} onDownload={download} onCancel={cancelDownload} onVerify={verify} onBenchmark={benchmark} onCancelBenchmark={cancelBenchmark} onDelete={del} onSwitch={switchModel} />
          ))}

          <h2 className="font-semibold text-lg pt-4">精确时间轴模型</h2>
          {models.filter((m) => m.role === 'aligner' || m.kind === 'qwen-forced-aligner').map((m) => (
            <ModelRow key={m.id} m={m} current={current} downloading={downloading} status={status[m.id]} runtimeReady={['ready', 'running'].includes(runtime?.status)} onDownload={download} onCancel={cancelDownload} onVerify={verify} onDelete={del} />
          ))}

          <h2 className="font-semibold text-lg pt-4">说话人分离模型</h2>
          {models.filter((m) => m.role === 'diarization').map((m) => (
            <ModelRow key={m.id} m={m} current={current} downloading={downloading} status={status[m.id]} runtimeReady={['ready', 'running'].includes(runtime?.status)} onDownload={download} onCancel={cancelDownload} onVerify={verify} onDelete={del} />
          ))}
        </div>
      )}
    </div>
  );
}

function RuntimePanel({ runtime: r, busy, onAction, onInstallFeature }) {
  const labels = { not_installed: '未安装', checking: '正在检查', installing: '安装中', repairing: '修复中', ready: '可用', starting: '启动中', running: '运行中', broken: '需要修复', error: '错误', creating_environment: '创建环境', upgrading_pip: '准备依赖', installing_dependencies: '安装依赖', verifying: '验证中' };
  const available = Object.entries(r.devices || {}).filter(([, d]) => d.available).map(([name]) => name).join(' / ');
  return (
    <div className="card p-5 mb-6">
      <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">本地 AI 运行环境</h2><p className="text-sm text-gray-400">{labels[r.status] || r.status}</p></div>
        <div className="flex gap-2">{r.status === 'not_installed' && <button className="btn-primary" disabled={busy} onClick={() => onAction('install')}>安装</button>}
          {['broken', 'error'].includes(r.status) && <button className="btn-primary" disabled={busy} onClick={() => onAction('repair')}>修复</button>}
          {['ready', 'running'].includes(r.status) && <button className="btn-secondary" disabled={busy} onClick={() => onAction('restart')}>重启</button>}</div></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm">
        <RuntimeItem label="Python" value={r.python || '未检测'} />
        <RuntimeItem label="PyTorch" value={r.torch || '未安装'} />
        <RuntimeItem label="Transformers" value={r.transformers || '未安装'} />
        <RuntimeItem label="设备" value={available || '无'} />
        <RuntimeItem label="依赖" value={r.dependencies?.ok ? '完整' : '未验证'} />
        <RuntimeItem label="FFmpeg" value={r.ffmpeg ? '可用' : '不可用'} />
      </div>
      {r.error?.message && <p className="text-xs text-red-500 mt-3">{r.error.message}</p>}
      {['ready', 'running'].includes(r.status) && r.optionalFeatures && <div className="mt-4 pt-3 border-t border-black/5 dark:border-white/10 flex flex-wrap gap-2 items-center">
        <span className="text-xs text-gray-400">可选功能</span>
        <button className="btn-secondary !py-1.5 text-xs" disabled={busy || r.optionalFeatures.diarization?.available} onClick={() => onInstallFeature('diarization')}>
          说话人分离 Runtime：{r.optionalFeatures.diarization?.available ? '已安装' : '安装'}
        </button>
        <button className="btn-secondary !py-1.5 text-xs" disabled={busy || r.optionalFeatures['alignment-ja']?.available} onClick={() => onInstallFeature('alignment-ja')}>
          日语对齐：{r.optionalFeatures['alignment-ja']?.available ? '已安装' : '安装依赖'}
        </button>
        <button className="btn-secondary !py-1.5 text-xs" disabled={busy || r.optionalFeatures['alignment-ko']?.available} onClick={() => onInstallFeature('alignment-ko')}>
          韩语对齐：{r.optionalFeatures['alignment-ko']?.available ? '已安装' : '安装依赖'}
        </button>
        <button className="btn-secondary !py-1.5 text-xs" disabled={busy || r.streaming?.available || !r.streaming?.supported} onClick={() => onInstallFeature('qwen-streaming-vllm')}>
          True Streaming Runtime：{r.streaming?.available ? '可用' : r.streaming?.supported ? '安装' : '当前平台不支持'}
        </button>
      </div>}
    </div>
  );
}

function RuntimeItem({ label, value }) {
  return <div><p className="text-xs text-gray-400">{label}</p><p className="truncate" title={String(value)}>{value}</p></div>;
}

function ModelRow({ m, current, downloading, status, benchmark, runtimeReady, onDownload, onCancel, onVerify, onBenchmark, onCancelBenchmark, onDelete, onSwitch }) {
  const isAsr = (m.role || 'asr') === 'asr';
  const isCurrent = current === m.id && m.installed;
  const isDownloading = downloading === m.id;
  const dlStatus = status?.status || m.status;
  const state = { not_installed: '未安装', checking: '检查中', queued: '等待下载', downloading: '下载中', verifying: '验证中', ready: '可用', cancelled: '已取消', broken: '文件损坏', deleting: '删除中', error: '下载失败' }[dlStatus] || dlStatus;
  const downloadedBytes = status?.downloadedBytes ?? m.downloadedBytes;
  const totalBytes = status?.totalBytes ?? m.totalBytes;
  const progress = status?.progress ?? m.progress;
  const speed = status?.speedBytesPerSecond ?? m.speedBytesPerSecond;
  const eta = status?.etaSeconds ?? m.etaSeconds;
  const sourceLabel = (status?.source || m.source) === 'modelscope' ? '国内模型仓库' : '备用模型仓库';

  return (
    <div className="card p-5 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium">{m.label}</p>
          {isCurrent && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400">当前使用</span>}
        </div>
        <p className="text-xs mt-1">状态：{state} · 设备：{(m.supportedDevices || []).join(' / ')}</p>
        <p className="text-xs text-gray-400 mt-0.5">
          {m.kind === 'whisper' ? 'faster-whisper' : 'transformers'} · {m.id}
          {' · '}
          <span className="text-gray-500 dark:text-gray-400">
            {m.installed
              ? (m.size_bytes > 0 ? formatBytes(m.size_bytes) : '占用计算中…')
              : (m.estimated_size_bytes ? `约 ${formatBytes(m.estimated_size_bytes)}` : '')}
          </span>
        </p>
        {['queued', 'downloading', 'verifying'].includes(dlStatus) && (
          <div className="mt-2">
            {typeof progress === 'number' && <div className="w-full h-1.5 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-apple-blue rounded-full transition-all" style={{
                width: `${progress}%`
              }} />
            </div>}
            <p className="text-xs text-gray-400 mt-1">
              {downloadedBytes ? `已下载 ${formatBytes(downloadedBytes)}` : `${status?.phase === 'connecting' ? '正在连接' : '准备访问'}${sourceLabel}…`}
              {totalBytes ? ` / ${formatBytes(totalBytes)}` : ''}{speed ? ` · ${formatBytes(speed)}/s` : ''}{eta ? ` · 约 ${formatDuration(eta)}` : ''}
            </p>
          </div>
        )}
        {m.error && <p className="text-xs text-red-500 mt-2">{m.error.message || String(m.error)}</p>}
        {benchmark && ['queued', 'running'].includes(benchmark.status) && (
          <div className="flex items-center gap-2 text-xs text-blue-500 mt-2">
            <p>性能测试：{benchmarkStageLabel(benchmark.stage)} · 已用 {formatDuration(((Date.now() - (benchmark.startedAt || benchmark.createdAt || Date.now())) / 1000))}</p>
            <button className="text-gray-500 hover:text-red-500" onClick={() => onCancelBenchmark?.(m.id)}>取消</button>
          </div>
        )}
        {benchmark?.status === 'completed' && <BenchmarkResult result={benchmark.result} />}
      </div>
      <div className="flex gap-2 shrink-0">
        {['queued', 'downloading', 'verifying'].includes(dlStatus) ? (
          <button className="btn-secondary !py-1.5 text-sm" onClick={() => onCancel(m.id)}>取消</button>
        ) : ['checking', 'deleting'].includes(dlStatus) ? (
          <button className="btn-secondary !py-1.5 text-sm" disabled>{state}</button>
        ) : m.installed ? (
          <>
            {isAsr && !isCurrent && <button className="btn-secondary !py-1.5 text-sm" disabled={!runtimeReady} onClick={() => onSwitch(m.id)}>切换</button>}
            {isAsr && <button className="btn-secondary !py-1.5 text-sm" disabled={!runtimeReady || ['queued', 'running'].includes(benchmark?.status)} onClick={() => onBenchmark(m.id)}>性能测试</button>}
            <button className="btn-secondary !py-1.5 text-sm text-red-500" onClick={() => onDelete(m.id)}>删除</button>
          </>
        ) : (
          <><button className="btn-primary !py-1.5 text-sm" disabled={!runtimeReady || isDownloading} onClick={() => onDownload(m.id)}>
            {['cancelled', 'broken', 'error'].includes(dlStatus) ? '继续/重试' : '下载'}
          </button>{dlStatus === 'broken' && <button className="btn-secondary !py-1.5 text-sm" disabled={!runtimeReady} onClick={() => onVerify(m.id)}>验证</button>}</>
        )}
      </div>
    </div>
  );
}

function BenchmarkResult({ result: r }) {
  if (!r) return null;
  return <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs mt-3 p-2 rounded bg-gray-50 dark:bg-white/5">
    <span>设备 {r.device}</span><span>音频 {r.audioDurationSeconds?.toFixed(1)}s</span>
    <span>模型加载 {(r.modelLoadMs / 1000).toFixed(2)}s</span><span>推理 {(r.inferenceMs / 1000).toFixed(2)}s</span>
    <span>RTF {r.rtf?.toFixed(2)}</span><span>速度 {r.realtimeFactor?.toFixed(2)}x realtime</span>
    <span>{r.coldStart ? '冷启动' : '热模型'}</span>
  </div>;
}

function benchmarkStageLabel(stage) {
  return { queued: '排队中', preparing: '准备音频（最长 15 秒）', loading_model: '加载模型', benchmarking: '推理测试' }[stage] || stage || '处理中';
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}
