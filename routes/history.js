import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getUserConversations, loadConversationHistory, clearConversation, createConversation } from '../services/chat.js';

const router = Router();

// GET /api/history — list user's conversations (paginated)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));

    const result = await getUserConversations(req.user.id, page, pageSize);
    res.json(result);
  } catch (error) {
    console.error('Failed to fetch conversation history:', error);
    res.status(500).json({ error: '获取对话历史失败' });
  }
});

// POST /api/history — create a new conversation
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title } = req.body || {};
    const conversationId = await createConversation(req.user.id, title || '');
    res.json({ conversationId });
  } catch (error) {
    console.error('Failed to create conversation:', error);
    res.status(500).json({ error: '创建对话失败' });
  }
});

// GET /api/history/:conversationId — get conversation with messages
router.get('/:conversationId', authMiddleware, async (req, res) => {
  try {
    const result = await loadConversationHistory(req.params.conversationId, req.user.id);

    if (!result) {
      res.status(404).json({ error: '对话不存在' });
      return;
    }

    res.json(result);
  } catch (error) {
    console.error('Failed to fetch conversation:', error);
    res.status(500).json({ error: '获取对话详情失败' });
  }
});

// DELETE /api/history/:conversationId — delete a conversation
router.delete('/:conversationId', authMiddleware, async (req, res) => {
  try {
    const cleared = await clearConversation(req.params.conversationId, req.user.id);
    res.json({
      conversationId: req.params.conversationId,
      cleared,
    });
  } catch (error) {
    console.error('Failed to delete conversation:', error);
    res.status(500).json({ error: '删除对话失败' });
  }
});

export default router;