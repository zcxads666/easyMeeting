import { Router } from 'express';
import { diagnosticsSnapshot } from '../services/diagnostics.js';
export function createDiagnosticsRoute(options = {}) {
  const router = Router();
  router.get('/', async (_req, res) => {
    try { res.json(await diagnosticsSnapshot(options)); }
    catch (error) { res.status(500).json({ error: '无法生成诊断信息', code: 'DIAGNOSTICS_FAILED' }); }
  });
  return router;
}
