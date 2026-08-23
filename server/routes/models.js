import { Router, json } from 'express';
import { getPythonUrl } from '../services/python.js';
import { ensureFreshPython } from '../services/python.js';
import { runtimeManager } from '../services/runtime-manager.js';
import { taskManager } from '../services/queue.js';
import { getMeeting, getSettings } from '../services/store/jsonstore.js';
import { resolveMeetingAudio } from '../services/audio/access.js';
import { transcodeToPcm } from '../services/audio/ffmpeg.js';
import fsp from 'node:fs/promises';
import { inspectModelsWithoutRuntime } from '../services/models/catalog.js';

const router = Router();
router.use(json());

async function proxy(path, req, res, { fresh = false } = {}) {
  const doFetch = () => fetch(`${getPythonUrl()}${path}`, {
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
    body: req.method !== 'GET' ? JSON.stringify(req.body || {}) : undefined,
    // 15s 超时：Python 卡死时不无限挂起模型请求
    signal: AbortSignal.timeout(15000)
  });

  // 仅列表/状态请求等待代码热重启（fresh=true，有短超时）；
  // 删除/切换/下载不等待，避免用户操作被重启阻塞
  if (fresh) {
    try { await ensureFreshPython(); } catch { /* 忽略，继续尝试请求 */ }
  }

  let r;
  try {
    r = await doFetch();
  } catch {
    // 首次失败：重新拉起服务并重试一次
    try {
      await ensureFreshPython();
      r = await doFetch();
    } catch (e) {
      return res.status(502).json({ error: `本地推理服务未启动: ${e.message}` });
    }
  }
  try {
    const jsonRes = await r.json();
    res.status(r.status).json(jsonRes);
  } catch {
    res.status(502).json({ error: `本地推理服务响应异常 (HTTP ${r.status})` });
  }
}

router.get('/', async (req, res) => {
  try {
    const runtime = await runtimeManager.inspect();
    if (!['ready', 'running'].includes(runtime.status)) throw Object.assign(new Error('runtime unavailable'), { code: 'RUNTIME_NOT_READY' });
    await ensureFreshPython();
    const response = await fetch(`${getPythonUrl()}/models`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return res.status(response.status).json(await response.json());
  } catch {
    const models = await inspectModelsWithoutRuntime();
    return res.json({ models, disk_usage: models.reduce((sum, model) => sum + (model.sizeBytes || 0), 0), runtimeUnavailable: true });
  }
});
router.get('/runtime/capabilities', (req, res) => proxy('/runtime/capabilities', req, res, { fresh: true }));
router.get('/runtime/health', (req, res) => proxy('/runtime/health', req, res, { fresh: true }));
router.get('/download/status', (req, res) => proxy('/models/download/status', req, res, { fresh: true }));
router.post('/download', (req, res) => proxy('/models/download', req, res));
router.post('/download/cancel', (req, res) => proxy('/models/download/cancel', req, res));
router.post('/verify', (req, res) => proxy('/models/verify', req, res));
router.post('/switch', (req, res) => proxy('/models/switch', req, res));
router.post(/^\/(.+)\/benchmark$/, async (req, res) => {
  const id = decodeURIComponent(req.params[0]); const { meetingId } = req.body || {};
  const meeting = await getMeeting(meetingId);
  if (!meeting) return res.status(404).json({ error: '会议不存在', code: 'MEETING_NOT_FOUND' });
  let audio;
  try { audio = await resolveMeetingAudio(meeting); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message, code: error.code }); }
  const runtime = await runtimeManager.inspect();
  if (!['ready', 'running'].includes(runtime.status)) return res.status(409).json({ error: '本地 AI Runtime 未就绪', code: 'RUNTIME_NOT_READY' });
  const settings = await getSettings();
  const task = taskManager.create({ type: 'model_benchmark', lane: 'local', metadata: { modelId: id, meetingId }, run: async (context) => {
    let pcmPath;
    try {
      context.update('preparing'); pcmPath = await transcodeToPcm(audio.path, `benchmark_${Date.now()}.pcm`);
      if (context.isCancellationRequested()) return null;
      context.update('loading_model');
      context.update('benchmarking');
      const response = await fetch(`${getPythonUrl()}/models/benchmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, file: pcmPath, device: settings.asr.local.device || 'auto',
          compute_type: settings.asr.local.computeType || null, warmup_runs: 1, measured_runs: 1 }),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(30 * 60 * 1000)]) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { const detail = result.detail || result; throw Object.assign(new Error(detail.message || JSON.stringify(detail)), { code: detail.code || 'BENCHMARK_FAILED' }); }
      return result;
    } finally { if (pcmPath) await fsp.unlink(pcmPath).catch(() => {}); }
  }});
  res.status(202).json({ taskId: task.id });
});
router.delete(/^\/(.+)$/, (req, res) => {
  const id = req.params[0];
  if (!id) return res.status(404).json({ error: 'not found' });
  return proxy(`/models/${encodeURIComponent(id)}`, req, res);
});

export default router;
