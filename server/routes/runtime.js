import { Router, json } from 'express';
import { runtimeManager } from '../services/runtime-manager.js';
import { taskManager } from '../services/queue.js';
import { checkFFmpeg } from '../services/audio/ffmpeg.js';
import { getRuntimeCapabilities, getRuntimeHealth } from '../services/python.js';

const router = Router(); router.use(json());
const publicState = (state) => ({ status: state.status, python: state.python || null,
  error: state.error ? { code: state.error.code, message: state.error.message } : null });
router.get('/', async (_req, res) => {
  const state = await runtimeManager.inspect();
  let capabilities = null; let health = null;
  if (state.status === 'running') [capabilities, health] = await Promise.all([getRuntimeCapabilities(), getRuntimeHealth()]);
  res.json({ ...publicState(state), torch: capabilities?.torch || null, transformers: capabilities?.transformers || null,
    devices: capabilities?.devices || null, dependencies: health?.dependencies || null, ffmpeg: await checkFFmpeg() });
});
function install(_req, res) {
  const task = taskManager.create({ type: 'runtime_install', lane: 'runtime', run: (context) =>
    runtimeManager.install({ signal: context.signal, onStage: context.update }).then(publicState) });
  res.status(202).json({ taskId: task.id });
}
router.post('/install', install); router.post('/repair', install);
router.post('/restart', async (_req, res) => {
  try { res.json(publicState(await runtimeManager.restart())); }
  catch (error) { res.status(500).json({ error: error.message, code: error.code || 'RUNTIME_RESTART_FAILED' }); }
});
export default router;
