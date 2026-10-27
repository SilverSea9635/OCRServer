import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { AGENT_SERVICE_URL } from '../config.js';
import { requestAgentJSON } from '../services/agent_sessions.js';

const router = Router();
router.use(authMiddleware);

async function forward(req, res, method, key) {
  try {
    const result = await requestAgentJSON({
      method,
      path: key === undefined ? '/api/agent/memories' : `/api/agent/memories/${encodeURIComponent(key)}`,
      body: method === 'PUT' ? { value: req.body?.value } : undefined,
      userId: req.user.id, agentServiceUrl: AGENT_SERVICE_URL, secret: process.env.INTERNAL_API_TOKEN,
    });
    res.json(result);
  } catch ( error ) {
    res.status(error.statusCode || 503).json({ error: error.message });
  }
}

router.get('/', (req, res) => forward(req, res, 'GET'));
router.put('/:key', (req, res) => forward(req, res, 'PUT', req.params.key));
router.delete('/:key', (req, res) => forward(req, res, 'DELETE', req.params.key));
export default router;
