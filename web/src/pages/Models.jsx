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
  const settings = useStore((s) => s.settings);
  const pollRef = useRef(null);
  const retryTimerRef = useRef(null);

  // 加载模型列表；失败或占用未计算完成时自动重试。
  // silent=true 时静默刷新（保留旧列表，避免闪烁/滚动跳动）
  const load = useCallback(async (retries = 3, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api('/models');
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

  // 有下载任务时轮询
  useEffect(() => {
    if (downloading) {
      pollStatus();
      pollRef.current = setInterval(async () => {
        await pollStatus();
        // 刷新模型列表以反映安装状态
        const data = await api('/models').catch(() => null);
        if (data) {
          setModels(data.models || []);
          setDiskUsage(data.disk_usage || 0);
        }
      }, 2000);
      return () => clearInterval(pollRef.current);
    }
  }, [downloading]);

  // 检测下载完成
  useEffect(() => {
    if (!downloading) return;
    const st = status[downloading];
    if (st && (st.status === 'completed' || st.status === 'failed')) {
      setDownloading(null);
      load(3, true);
      if (st.status === 'failed') setError(`下载失败: ${st.error || ''}`);
    }
  }, [status, downloading, load]);

  const download = async (id) => {
    setDownloading(id);
    setError('');
    try {
      await api('/models/download', { method: 'POST', body: { id } });
    } catch (e) {
      setError(e.message);
      setDownloading(null);
    }
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
      await useStore.getState().saveSettings({ asr: { local: { engine: id.startsWith('whisper') ? 'whisper' : 'qwen', model: id } } });
      await load(3, true);
    } catch (e) { setError(e.message); }
  };

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
            <ModelRow key={m.id} m={m} current={current} downloading={downloading} status={status[m.id]} onDownload={download} onDelete={del} onSwitch={switchModel} />
          ))}

          <h2 className="font-semibold text-lg pt-4">Qwen3-ASR</h2>
          {models.filter((m) => m.kind === 'qwen').map((m) => (
            <ModelRow key={m.id} m={m} current={current} downloading={downloading} status={status[m.id]} onDownload={download} onDelete={del} onSwitch={switchModel} />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelRow({ m, current, downloading, status, onDownload, onDelete, onSwitch }) {
  const isCurrent = current === m.id;
  const isDownloading = downloading === m.id;
  const dlStatus = status?.status;

  return (
    <div className="card p-5 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium">{m.label}</p>
          {isCurrent && <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400">当前使用</span>}
        </div>
        <p className="text-xs text-gray-400 mt-0.5">
          {m.kind === 'whisper' ? 'faster-whisper' : 'transformers'} · {m.id}
          {' · '}
          <span className="text-gray-500 dark:text-gray-400">
            {m.installed
              ? (m.size_bytes > 0 ? formatBytes(m.size_bytes) : '占用计算中…')
              : (m.estimated_size_bytes ? `约 ${formatBytes(m.estimated_size_bytes)}` : '')}
          </span>
        </p>
        {isDownloading && (
          <div className="mt-2">
            <div className="w-full h-1.5 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-apple-blue rounded-full transition-all" style={{
                width: dlStatus === 'completed' ? '100%' : '40%'
              }} />
            </div>
            <p className="text-xs text-gray-400 mt-1">
              {dlStatus === 'completed' ? '下载完成' : dlStatus === 'failed' ? '下载失败' : '下载中…'}
            </p>
          </div>
        )}
      </div>
      <div className="flex gap-2 shrink-0">
        {m.installed ? (
          <>
            {!isCurrent && <button className="btn-secondary !py-1.5 text-sm" onClick={() => onSwitch(m.id)}>切换</button>}
            <button className="btn-secondary !py-1.5 text-sm text-red-500" onClick={() => onDelete(m.id)}>删除</button>
          </>
        ) : (
          <button className="btn-primary !py-1.5 text-sm" disabled={isDownloading} onClick={() => onDownload(m.id)}>
            {isDownloading ? '下载中…' : '下载'}
          </button>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(1)} ${units[i]}`;
}
