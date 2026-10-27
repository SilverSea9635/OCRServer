import { AttachmentError, messageWithAttachment, uploadAttachment, ownedAttachment, imageReference } from '../services/attachments.js';
import { ModelProfileError, resolveModelProfile } from '../services/modelProfiles.js';
import { Router } from 'express';
import {
  streamChatMessage,
  streamChatViaAgentService,
  clearConversation,
  assertConversationAccess,
  ConversationAccessError,
} from '../services/chat.js';
import { DEFAULT_MAX_TOKENS, AGENT_SERVICE_ENABLED } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { createWorkFromChat, getWorkById } from '../services/works.js';
import { ChatPromptError, validateChatInput } from '../services/chatPrompts.js';

const router = Router();

/** 本轮用户消息的纯文本（数组消息取 text block），截断后作为作品描述与引用流水 */
function extractPromptText(message) {
  if (typeof message === 'string') {
    return message.trim().slice(0, 500);
  }

  if (Array.isArray(message)) {
    return message
      .filter((block) => block?.type === 'text')
      .map((block) => block.text || '')
      .join('\n')
      .trim()
      .slice(0, 500);
  }

  return '';
}

/** 助手回复的纯文本：Agent 分支回传 text，MiMo 分支是 content block 数组 */
function extractReplyText(finalMessage) {
  if (typeof finalMessage?.text === 'string') return finalMessage.text;

  const content = finalMessage?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text || '')
      .join('');
  }

  return '';
}

// POST /api/chat — SSE streaming (requires auth)
router.post('/', authMiddleware, async (req, res) => {
  const {
    conversationId,
    message: incomingMessage,
    attachmentId,
    refreshImageDescription,
    mode,
    model,
    modelProfileId,
    referenceWorkId,
  } = req.body ?? {};
  const maxTokens = DEFAULT_MAX_TOKENS;
  let reference = null;
  let message;
  try {
    message = await messageWithAttachment(req.user.id, incomingMessage, attachmentId);
    if (Array.isArray(message)) {
      message = await Promise.all(message.map(async block => {
        if (block?.type !== 'image') return block;
        if (block.attachmentId) return imageReference(await ownedAttachment(req.user.id, block.attachmentId));
        if (block.source?.type === 'base64' && block.source?.data) {
          const uploaded = await uploadAttachment(req.user.id, { data: block.source.data, mimeType: block.source.media_type, fileName: '截图' });
          return imageReference(await ownedAttachment(req.user.id, uploaded.id));
        }
        return block;
      }));
    }
    if (Array.isArray(message) && message.filter(block => block?.type === 'image').length > 1) throw new AttachmentError('每轮只能使用一张截图');
    validateChatInput(message, mode);
    if (referenceWorkId !== undefined && referenceWorkId !== null) {
      if (!Number.isSafeInteger(referenceWorkId) || referenceWorkId <= 0) throw new ChatPromptError('引用作品 ID 不正确');
      reference = await getWorkById(referenceWorkId, req.user.id);
      if (!reference) throw new ChatPromptError('引用作品不存在或不可访问', 404);
    }
  } catch (error) {
    res.status(error instanceof ChatPromptError || error instanceof AttachmentError ? error.statusCode : 500).json({ error: error instanceof ChatPromptError || error instanceof AttachmentError ? error.message : '无法读取引用作品或截图' });
    return;
  }
  const normalizedReferenceWorkId = reference?.id ?? null;

  let modelConfig;
  try {
    if (req.body?.modelConfig) throw new ModelProfileError('请保存模型配置后使用 modelProfileId');
    if (modelProfileId) {
      if (!AGENT_SERVICE_ENABLED) throw new ModelProfileError('自定义模型需要启用 Agent 服务', 503);
      modelConfig = await resolveModelProfile(req.user.id, modelProfileId);
    }
  } catch (error) {
    res.status(error instanceof ModelProfileError ? error.status : 500).json({ error: error instanceof ModelProfileError ? error.message : '无法加载模型配置' });
    return;
  }

  try {
    await assertConversationAccess(conversationId, req.user.id);
  } catch (error) {
    if (error instanceof ConversationAccessError) {
      res.status(error.statusCode).json({ error: error.message, type: error.type });
      return;
    }

    throw error;
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
    const chatOptions = {
      conversationId,
      userId: req.user.id,
      message,
      mode: reference ? 'adjust' : mode || 'new',
      refreshImageDescription: refreshImageDescription === true,
      reference,
      model: modelConfig?.modelName || model,
      modelConfig,
      maxTokens,
    };

    // 共享 Agent 负责生成与消息持久化；兼容导出也使用同一链路。
    chatTurn = AGENT_SERVICE_ENABLED
      ? await streamChatViaAgentService(chatOptions)
      : await streamChatMessage(chatOptions);

    sendEvent('start', { conversationId: chatTurn.resolvedConversationId });

    for await (const event of chatTurn.stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        sendEvent('delta', { text: event.delta.text });

      }
    }

    const finalMessage = await chatTurn.finalizeMessage();

    // 引用流程：把这轮回复里的组件代码落库成当前用户的新作品（默认未公开，等用户手动确认发布）。
    // 整段包 try/catch —— 作品入库失败绝不能连累已经生成好的对话。
    let workId = null;
    try {
      if (normalizedReferenceWorkId !== null) {
        const createdWork = await createWorkFromChat({
          userId: req.user.id,
          conversationId: chatTurn.resolvedConversationId,
          sourceWorkId: normalizedReferenceWorkId,
          title: reference.title || '引用调整的作品',
          code: extractReplyText(finalMessage),
          prompt: extractPromptText(message),
        });
        workId = createdWork?.id ?? null;
      }
    } catch (error) {
      console.error('引用作品落库失败（已忽略，不影响对话）:', error);
    }

    sendEvent('done', {
      conversationId: chatTurn.resolvedConversationId,
      usage: finalMessage.usage,
      stopReason: finalMessage.stop_reason,
      model: finalMessage.model,
      mode: reference ? 'adjust' : mode || 'new',
      workId,
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
