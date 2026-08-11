import { Router, json } from 'express';
import { PYTHON_SERVE_URL } from '../config.js';

const router = Router();
router.use(json());

async function proxy(path, req, res) {
  try {
    const r = await fetch(`${PYTHON_SERVE_URL}${path}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method !== 'GET' ? JSON.stringify(req.body || {}) : undefined
    });
    const jsonRes = await r.json();
    res.status(r.status).json(jsonRes);
  } catch (e) {
    res.status(502).json({ error: `本地推理服务未启动: ${e.message}` });
  }
}

router.get('/', (req, res) => proxy('/models', req, res));
router.get('/download/status', (req, res) => proxy('/models/download/status', req, res));
router.post('/download', (req, res) => proxy('/models/download', req, res));
router.post('/switch', (req, res) => proxy('/models/switch', req, res));
router.delete('/:id', (req, res) => proxy(`/models/${encodeURIComponent(req.params.id)}`, req, res));

export default router;
