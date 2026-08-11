import { Router, json } from 'express';
import { getSettings, saveSettings } from '../services/store/jsonstore.js';
import { test } from '../services/llm/openai.js';

const router = Router();
router.use(json());

router.get('/', async (_req, res) => {
  res.json(await getSettings());
});

router.patch('/', async (req, res) => {
  res.json(await saveSettings(req.body));
});

// 测试 LLM 可达性
router.post('/llm/test', async (req, res) => {
  const settings = await saveSettings(req.body || {});
  try {
    await test(settings);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/logo', (_req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#0071e3"/><text x="32" y="42" font-size="30" text-anchor="middle" fill="#fff" font-family="-apple-system,sans-serif">会</text></svg>`;
  res.type('image/svg+xml').send(svg);
});

export default router;