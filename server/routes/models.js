import { Router, json } from 'express';
import { PYTHON_SERVE_URL } from '../config.js';

const router = Router();
router.use(json());

async function proxy(path, req, res) {
  try {
    const r = await fetch(`${PYTHON_SERVE_URL}${path}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body || {})
    });
    const jsonRes = await r.json();
    res.status(r.status).json(jsonRes);
  } catch (e) {
    res.status(502).json({ error: `本地推理服务未启动: ${e.message}` });
  }
}

router.get('/models', (req, res) => proxy('/models', req, res));
router.post('/models/download', (req, res) => proxy('/models/download', req, res));
router.post('/models/switch', (req, res) => proxy('/models/switch', req, res));
router.delete('/models/:id', (req, res) => proxy('/models', { ...req, method: 'DELETE' }, res));

export default router;