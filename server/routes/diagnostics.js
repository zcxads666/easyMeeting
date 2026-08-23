import { Router } from 'express';
import { diagnosticsSnapshot } from '../services/diagnostics.js';
import { diagnosticLogs } from '../services/logger.js';
export function createDiagnosticsRoute(options = {}) {
  const router = Router();
  router.get('/', async (_req, res) => {
    try { res.json(await diagnosticsSnapshot(options)); }
    catch (error) { res.status(500).json({ error: '无法生成诊断信息', code: 'DIAGNOSTICS_FAILED' }); }
  });
  router.get('/export', async (_req, res) => {
    try {
      const bundle = { schemaVersion: 1, exportedAt: new Date().toISOString(), diagnostics: await diagnosticsSnapshot(options), logs: await diagnosticLogs() };
      res.setHeader('Content-Disposition', `attachment; filename="easyMeeting-diagnostics-${Date.now()}.json"`);
      res.type('application/json').send(JSON.stringify(bundle, null, 2));
    } catch { res.status(500).json({ error: '无法导出诊断包', code: 'DIAGNOSTICS_EXPORT_FAILED' }); }
  });
  return router;
}
