import { Router } from 'express';
import { AGENT_SERVICE_URL } from '../config.js';

const router = Router();

// GET /api/models — 转发 Python Agent 服务的可用生成模型列表（前端下拉框数据源）
router.get('/', async (_req, res) => {
  try {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/models`);
    if (!resp.ok) {
      throw new Error(`agent service responded ${resp.status}`);
    }

    const data = await resp.json();
    res.json(data);
  } catch (error) {
    console.error('Failed to fetch models from agent service:', error);
    res.status(502).json({ error: '获取模型列表失败', models: [], default: '' });
  }
});

export default router;
