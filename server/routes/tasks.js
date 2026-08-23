import { Router, json } from 'express';
import { taskManager } from '../services/queue.js';
import { updateMeeting } from '../services/store/jsonstore.js';
const router = Router();
router.use(json());
router.get('/:id', (req, res) => {
  const task = taskManager.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});
router.post('/:id/cancel', async (req, res) => {
  const current = taskManager.get(req.params.id);
  if (!current) return res.status(404).json({ error: 'task not found' });
  const accepted = taskManager.cancel(req.params.id);
  if (accepted && current.metadata?.meetingId) await updateMeeting(current.metadata.meetingId, { status: 'cancelled' });
  res.json({ accepted, task: taskManager.get(req.params.id) });
});
export default router;
