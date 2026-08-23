import { Router, json } from 'express';
import { getPythonUrl } from '../services/python.js';
import { ensureFreshPython } from '../services/python.js';

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

router.get('/', (req, res) => proxy('/models', req, res, { fresh: true }));
router.get('/runtime/capabilities', (req, res) => proxy('/runtime/capabilities', req, res, { fresh: true }));
router.get('/runtime/health', (req, res) => proxy('/runtime/health', req, res, { fresh: true }));
router.get('/download/status', (req, res) => proxy('/models/download/status', req, res, { fresh: true }));
router.post('/download', (req, res) => proxy('/models/download', req, res));
router.post('/switch', (req, res) => proxy('/models/switch', req, res));
router.delete(/^\/(.+)$/, (req, res) => {
  const id = req.params[0];
  if (!id) return res.status(404).json({ error: 'not found' });
  return proxy(`/models/${encodeURIComponent(id)}`, req, res);
});

export default router;
