import { useEffect, useState, useRef } from 'react';
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

  const load = async () => {
    setLoading(true);
    try {
      const data = await api('/models');
      setModels(data.models || []);
      setDiskUsage(data.disk_usage || 0);
    } catch (e) { setError('本地推理服务未启动：' + e.message); }
    finally { setLoading(false); }
  };

  const pollStatus = async () => {
    try {
      const data = await api('/models/download/status');
      setStatus(data.downloads || {});
    } catch { /* 忽略 */ }
  };

  useEffect(() => { load(); }, []);

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
      load();
      if (st.status === 'failed') setError(`下载失败: ${st.error || ''}`);
    }
  }, [status, downloading]);

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
      await load();
    } catch (e) { setError(e.message); }
  };

  const switchModel = async (id) => {
    try {
      await api('/models/switch', { method: 'POST', body: { id } });
      await useStore.getState().saveSettings({ asr: { local: { engine: id.startsWith('whisper') ? 'whisper' : 'qwen', model: id } } });
      await load();
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
        <span className="text-sm text-gray-400 dark:text-gray-500">占用 {formatBytes(diskUsage)}</span>
      </div>

      {error && <div className="card p-4 mb-6 text-red-600 bg-red-50 border-red-100 dark:bg-red-950/30 dark:border-red-900">{error}</div>}

      {loading ? (
        <p className="text-center text-gray-400 py-16">加载模型列表…</p>
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
        <p className="text-xs text-gray-400 mt-0.5">{m.kind === 'whisper' ? 'faster-whisper' : 'transformers'} · {m.id}</p>
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
