import { Router, json } from 'express';
import { getMeeting, saveMeeting, getSettings } from '../services/store/jsonstore.js';
import { chat, chatStream } from '../services/llm/openai.js';
import { CORRECT_SYSTEM, correctUser, SUMMARY_SYSTEM, summaryUser, SPEAKER_SYSTEM, speakerUser } from '../services/prompts/index.js';

const router = Router();
router.use(json());

router.post('/correct', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: '缺少 text' });
  const settings = await getSettings();
  try {
    const result = await chat(settings, [
      { role: 'system', content: CORRECT_SYSTEM },
      { role: 'user', content: correctUser(text) }
    ]);
    res.json({ corrected: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/summary', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: '缺少 text' });
  const settings = await getSettings();
  try {
    const result = await chat(settings, [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: summaryUser(text) }
    ]);
    let summary;
    try { summary = JSON.parse(result.replace(/```json|```|```json/g, '').trim()); }
    catch { summary = { summary: result }; }
    res.json({ summary });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 流式总结（SSE）
router.post('/summary/stream', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: '缺少 text' });
  const settings = await getSettings();
  // 在发送流式响应前校验 LLM 配置
  const { baseUrl, apiKey, model } = settings.llm;
  if (!baseUrl || !apiKey || !model) {
    return res.status(400).json({ error: '未配置 LLM（baseUrl / apiKey / model），请前往设置页配置' });
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  try {
    for await (const chunk of chatStream(settings, [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: summaryUser(text) }
    ])) {
      res.write(chunk);
    }
  } catch (e) {
    res.write(`\n[ERROR] ${e.message}`);
  }
  res.end();
});

router.post('/speaker', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: '缺少 text' });
  const settings = await getSettings();
  try {
    const result = await chat(settings, [
      { role: 'system', content: SPEAKER_SYSTEM },
      { role: 'user', content: speakerUser(text) }
    ]);
    res.json({ speaker: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;