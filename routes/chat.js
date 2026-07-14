import { Router } from 'express';
import { streamChatMessage, clearConversation } from '../services/chat.js';
import { DEFAULT_MAX_TOKENS } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// POST /api/chat — SSE streaming (requires auth)
router.post('/', authMiddleware, async (req, res) => {
  const {
    conversationId,
    message,
    system,
    model,
  } = req.body ?? {};
  const maxTokens = DEFAULT_MAX_TOKENS;
  const hasStructuredMessage = Array.isArray(message);
  const textInput = message;

  if (!hasStructuredMessage && (typeof textInput !== 'string' || !textInput.trim())) {
    res.status(400).json({
      error: 'message/content is required and must be a non-empty string or non-empty array when image is not provided',
    });
    return;
  }

  if (message !== undefined && typeof message !== 'string' && !Array.isArray(message)) {
    res.status(400).json({ error: 'message must be a string or an array of content blocks' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let chatTurn;
  let completed = false;
  let clientDisconnected = false;

  const handleDisconnect = () => {
    if (res.writableEnded) {
      return;
    }

    clientDisconnected = true;
    chatTurn?.abort();
  };

  req.on('close', handleDisconnect);
  res.on('close', handleDisconnect);

  try {
    chatTurn = await streamChatMessage({
      conversationId,
      userId: req.user.id,
      message,
      system,
      model,
      maxTokens,
    });

    sendEvent('start', { conversationId: chatTurn.resolvedConversationId });

    for await (const event of chatTurn.stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        sendEvent('delta', { text: event.delta.text });
      }
    }

    const finalMessage = await chatTurn.finalizeMessage();
    sendEvent('done', {
      conversationId: chatTurn.resolvedConversationId,
      usage: finalMessage.usage,
      stopReason: finalMessage.stop_reason,
      model: finalMessage.model,
    });
    completed = true;
  } catch (error) {
    if (!completed) {
      chatTurn?.abort();
    }

    if (!clientDisconnected) {
      console.error('Chat request failed:', error);

      if (!res.writableEnded) {
        sendEvent('error', {
          error: error?.message || 'Chat request failed',
          type: error?.type || 'internal_error',
        });
      }
    }
  } finally {
    req.off('close', handleDisconnect);
    res.off('close', handleDisconnect);

    if (!res.writableEnded) {
      res.end();
    }
  }
});

// DELETE /api/chat/:conversationId (requires auth)
router.delete('/:conversationId', authMiddleware, async (req, res) => {
  const cleared = await clearConversation(req.params.conversationId, req.user.id);

  res.json({
    conversationId: req.params.conversationId,
    cleared,
  });
});

export default router;