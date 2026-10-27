import { materializeImages, enrichImageHistory, ownedAttachment, reserveMessageAttachments, confirmMessageAttachments } from './attachments.js';
import { buildChatContext } from './chatPrompts.js';
import { createHmac, randomUUID } from 'node:crypto';
import { Anthropic } from '@anthropic-ai/sdk';
import {
  MIMO_KEY,
  MIMO_PREFIX,
  AGENT_SERVICE_URL,
  AGENT_SERVICE_ENABLED,
  AGENT_VISION_MODEL,
  pool,
} from '../config.js';
import { toStorableContent } from './message_storage.js';
import { clearRemoteAgentSession, getRemoteMessages } from './agent_sessions.js';

if (!MIMO_KEY) {
  throw new Error('Missing MIMO_KEY in .env.development');
}

if (!MIMO_PREFIX) {
  throw new Error('Missing MIMO_PREFIX in .env.development');
}

const baseURL = MIMO_PREFIX.replace(/\/v1\/messages\/?$/, '');
const conversationQueues = new Map();

export class ConversationAccessError extends Error {
  constructor() {
    super('对话不存在');
    this.name = 'ConversationAccessError';
    this.statusCode = 404;
    this.type = 'conversation_not_found';
  }
}

const anthropic = new Anthropic({
  apiKey: MIMO_KEY,
  baseURL,
});

function resolveConversationId(conversationId) {
  if (typeof conversationId === 'string' && conversationId.trim()) {
    return conversationId.trim();
  }

  return randomUUID();
}

export async function assertConversationAccess(conversationId, userId) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    return false;
  }

  const [rows] = await pool.execute(
    'SELECT user_id FROM conversations WHERE conversation_id = ?',
    [conversationId.trim()],
  );

  if (rows.length === 0) {
    return false;
  }

  if (String(rows[0].user_id) !== String(userId)) {
    throw new ConversationAccessError();
  }

  return true;
}

async function acquireConversationTurn(conversationId) {
  const previousTurn = conversationQueues.get(conversationId) || Promise.resolve();
  let releaseCurrentTurn;
  const currentTurn = new Promise((resolve) => {
    releaseCurrentTurn = resolve;
  });

  conversationQueues.set(conversationId, currentTurn);
  await previousTurn.catch(() => {});

  let released = false;

  return () => {
    if (released) {
      return;
    }

    released = true;

    if (conversationQueues.get(conversationId) === currentTurn) {
      conversationQueues.delete(conversationId);
    }

    releaseCurrentTurn();
  };
}

async function ensureConversation(conversationId, userId, title) {
  const [existing] = await pool.execute(
    'SELECT id, user_id FROM conversations WHERE conversation_id = ?',
    [conversationId],
  );

  if (existing.length > 0) {
    if (String(existing[0].user_id) !== String(userId)) {
      throw new ConversationAccessError();
    }

    // Update title if provided and different
    if (title) {
      await pool.execute(
        'UPDATE conversations SET title = ? WHERE conversation_id = ? AND user_id = ? AND (title IS NULL OR title = "")',
        [title, conversationId, userId],
      );
    }
    return;
  }

  await pool.execute(
    'INSERT INTO conversations (conversation_id, user_id, title) VALUES (?, ?, ?)',
    [conversationId, userId, title || ''],
  );
}

function agentOptions(userId, conversationId) {
  return { userId, conversationId, agentServiceUrl: AGENT_SERVICE_URL, secret: process.env.INTERNAL_API_TOKEN };
}

async function loadRecentHistory(conversationId, userId, limit = 20) {
  const result = await getRemoteMessages({ ...agentOptions(userId, conversationId), limit });
  return result.messages;
}

// C3：把 Python 回报的回合元数据落到 conversation_turns（表归本服务所有，见 migrations/002）。
// 写入失败只记日志——计量缺口不应该让用户这轮对话失败（与 Python 侧原实现同样的取舍）。
async function recordAgentTurn({ conversationId, userId, mode, model }) {
  try {
    await pool.execute(
      `INSERT INTO conversation_turns
         (conversation_id, turn_index, user_id, attachments, tool_trace, generation_mode, model)
       SELECT ?, COALESCE(MAX(turn_index), 0) + 1, ?, ?, ?, ?, ?
       FROM conversation_turns
       WHERE conversation_id = ?`,
      [conversationId, String(userId), '[]', '[]', mode || 'fresh', model || null, conversationId],
    );
  } catch (error) {
    console.error('Failed to record agent turn metadata (chat continues):', error.message);
  }
}

// 消息持久化已统一到 Python，保留旧导出名称以兼容调用方。
export async function streamChatMessage(options) {
  return streamChatViaAgentService(options);
}

// ─── 转发到 Python Agent 服务 ───

function deriveTitleFromMessage(message) {
  if (typeof message === 'string') {
    return message.slice(0, 50);
  }

  const textPart = message.find((b) => b?.type === 'text');
  return (textPart?.text || '图片消息').slice(0, 50);
}

async function describeImageWithMiMo(message, userId, refreshImageDescription = false) {
  const imageId = message.find(block => block.type === 'image')?.attachmentId;
  const attachment = imageId ? await ownedAttachment(userId, imageId) : null;
  if (!refreshImageDescription && attachment?.vision_description && attachment.vision_model === AGENT_VISION_MODEL) return attachment.vision_description;
  const materialized = await materializeImages(message, userId);
  // 仅把图片块交给 MiMo 做视觉理解，得到截图的中文描述（DeepSeek 为纯文本模型，无法直接读图）
  const imageBlocks = materialized.filter((b) => b?.type === 'image').map(block => ({type:'image', source:block.source}));
  const response = await anthropic.messages.create({
    model: AGENT_VISION_MODEL,
    max_tokens: 1024,
    system:
      '你是一名资深 UI 设计师。请用简洁的中文描述这张截图的界面设计，' +
      '包括整体布局、包含的组件（按钮/输入框/卡片/导航等）、配色、字体层级、间距与交互细节，' +
      '供后续生成前端 React 组件使用。只输出描述，不要输出代码。',
    messages: [
      {
        role: 'user',
        content: [...imageBlocks, { type: 'text', text: '请描述这张截图的 UI 设计。' }],
      },
    ],
  });

  const parts = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text);
  const description = parts.join('\n');
  if (imageId && description) await pool.execute('UPDATE image_attachments SET vision_description=?,vision_model=? WHERE id=? AND user_id=?', [description, AGENT_VISION_MODEL, imageId, userId]);
  return description;
}

export async function streamChatViaAgentService({
  refreshImageDescription = false,
  modelConfig,
  conversationId,
  userId,
  message,
  mode = 'new',
  reference = null,
  model,
  maxTokens,
}) {
  if (!AGENT_SERVICE_ENABLED) throw Object.assign(new Error('消息存储已迁移，请启用 Agent 服务'), { statusCode: 503 });
  const resolvedConversationId = resolveConversationId(conversationId);
  const messageId = randomUUID();
  const assistantMessageId = randomUUID();
  const releaseConversationTurn = await acquireConversationTurn(resolvedConversationId);

  let textForAgent;
  try {
    const title = deriveTitleFromMessage(message);
    await ensureConversation(resolvedConversationId, userId, title);
    const history = await loadRecentHistory(resolvedConversationId, userId);
    const context = buildChatContext({ message, mode, reference, history });

    await reserveMessageAttachments(userId, resolvedConversationId, messageId, message);

    // 图片视觉理解保持平台 MiMo；上下文仅用于本轮调用，原始用户输入独立落库。
    if (Array.isArray(context.message)) {
      const textParts = context.message.filter((block) => block.type === 'text').map((block) => block.text);
      if (context.message.some((block) => block.type === 'image')) {
        const description = await describeImageWithMiMo(context.message, userId, refreshImageDescription);
        textForAgent = [...textParts, description].join('\n\n');
      } else textForAgent = textParts.join('\n');
    } else textForAgent = context.message;



    // 3. 转发到 Python Agent 服务（maxTokens 由 Python 内部处理，此处透传保留兼容）
    const controller = new AbortController();
    const internalHeaders = { 'Content-Type': 'application/json' };
    const secret = process.env.INTERNAL_API_TOKEN;
    if (modelConfig && !secret) throw new Error('自定义模型需要配置内部调用签名');
    if (secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      internalHeaders['X-User-Id'] = String(userId);
      internalHeaders['X-Internal-Timestamp'] = timestamp;
      internalHeaders['X-Internal-Signature'] = createHmac('sha256', secret).update(`${userId}.${timestamp}.POST./api/chat`).digest('hex');
      if (modelConfig) internalHeaders['X-Model-Config-Signature'] = createHmac('sha256', secret).update([String(userId), timestamp, modelConfig.baseUrl, modelConfig.modelName, modelConfig.apiKey].join('\n')).digest('hex');
    }
    const response = await fetch(`${AGENT_SERVICE_URL}/api/chat`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({
        conversationId: resolvedConversationId,
        userId: String(userId),
        message: textForAgent,
        originalMessage: typeof message === 'string' ? message : JSON.parse(toStorableContent(message)),
        messageId, assistantMessageId,
        system: context.system,
        model: model || undefined,
        modelConfig: modelConfig || undefined,
        // 历史正文与检查点由 Python 恢复，不再往返传递整段历史。
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Agent service responded ${response.status}: ${detail}`);
    }

    // 4. 解析 Python 返回的 SSE 流，转成 Anthropic 事件形状，并累积完整文本
    let fullText = '';
    let closed = false;
    let finalStopReason = 'stop';
    let finalModel = model || 'deepseek-flash';
    let attachmentsConfirmed = false;
    let receivedDone = false;
    let finalUsage = null;
    let finalMode = context.mode === 'adjust' ? 'adjust' : 'fresh';

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const closeTurn = () => {
      if (closed) {
        return;
      }

      closed = true;
      try {
        controller.abort();
      } catch {
        // ignore
      }
      releaseConversationTurn();
    };

    const stream = (async function* () {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          let sepIndex;
          while ((sepIndex = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);

            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) {
              continue;
            }

            let payload;
            try {
              payload = JSON.parse(dataLine.slice(6));
            } catch {
              continue;
            }

            if (typeof payload?.text === 'string') {
              if (!attachmentsConfirmed) {
                await confirmMessageAttachments(messageId);
                attachmentsConfirmed = true;
              }
              fullText += payload.text;
              yield {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: payload.text },
              };
            } else if (typeof payload?.error === 'string') {
              throw new Error(payload.error);
            } else if (payload?.stopReason) {
              receivedDone = true;
              finalStopReason = payload.stopReason;
              finalModel = payload.model || finalModel;
              finalUsage = payload.usage || null;
              finalMode = context.mode === 'adjust' ? 'adjust' : payload.mode || finalMode;
            }
          }
        }
        if (!receivedDone) throw new Error('Agent 服务流已中断，请读取历史确认结果后重试');
      } finally {
        closeTurn();
      }
    })();

    const finalizeMessage = async () => {
      try {
        // Python 在 done 帧之前已提交用户消息和完整回复。
        if (!attachmentsConfirmed) await confirmMessageAttachments(messageId);
        // MySQL 仅保留计量等业务元数据，不再写消息正文。
        await recordAgentTurn({
          conversationId: resolvedConversationId,
          userId,
          mode: finalMode,
          model: finalModel,
        });

        return {
          // 助手回复全文：routes/chat.js 的「引用作品落库」从这里取组件代码
          text: fullText,
          usage: finalUsage || { output_tokens: null },
          stop_reason: finalStopReason,
          model: finalModel,
        };
      } finally {
        closeTurn();
      }
    };

    const abort = () => {
      closeTurn();
    };

    return { resolvedConversationId, stream, finalizeMessage, abort };
  } catch (error) {
    releaseConversationTurn();
    throw error;
  }
}

export async function clearConversation(conversationId, userId) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    return false;
  }

  const trimmed = conversationId.trim();

  // 与本进程的生成请求串行；Python 再通过数据库锁协调其他进程。
  const release = await acquireConversationTurn(trimmed);
  try {
    const [owned] = await pool.execute(
      'SELECT conversation_id FROM conversations WHERE conversation_id = ? AND user_id = ?',
      [trimmed, userId],
    );
    if (!owned.length) return false;

    // 消息、事件和检查点先清理成功，再删除业务记录；失败时保留会话供重试。
    await clearRemoteAgentSession({
      conversationId: trimmed, userId,
      enabled: AGENT_SERVICE_ENABLED, messageStorageEnabled: true, agentServiceUrl: AGENT_SERVICE_URL,
      secret: process.env.INTERNAL_API_TOKEN,
    });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM message_image_attachments WHERE conversation_id=?', [trimmed]);
      await connection.execute('DELETE FROM conversation_turns WHERE conversation_id=? AND user_id=?', [trimmed, String(userId)]);
      const [result] = await connection.execute(
        'DELETE FROM conversations WHERE conversation_id = ? AND user_id = ?', [trimmed, userId],
      );
      await connection.commit();
      return result.affectedRows > 0;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }

  } finally {
    release();
  }
}

export async function loadConversationHistory(conversationId, userId) {
  // Verify user owns this conversation
  const [convRows] = await pool.execute(
    'SELECT conversation_id, title, created_at FROM conversations WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId],
  );

  if (convRows.length === 0) {
    return null;
  }

  // 对旧前端保持完整 messages 数组；内部使用游标分页，避免数据库 OFFSET 扫描。
  const rows = [];
  let before;
  do {
    const page = await getRemoteMessages({ ...agentOptions(userId, conversationId), limit: 200, before });
    rows.unshift(...page.messages);
    before = page.nextCursor;
  } while (before);
  const messages = await enrichImageHistory(rows, userId);

  return {
    conversationId: convRows[0].conversation_id,
    title: convRows[0].title,
    createdAt: convRows[0].created_at,
    messages,
  };
}

export async function createConversation(userId, title = '') {
  const conversationId = randomUUID();
  await pool.execute(
    'INSERT INTO conversations (conversation_id, user_id, title) VALUES (?, ?, ?)',
    [conversationId, userId, title.slice(0, 50)],
  );
  return conversationId;
}

export async function getUserConversations(userId, page = 1, pageSize = 20) {
  const offset = (page - 1) * pageSize;

  const [countRows] = await pool.execute(
    'SELECT COUNT(*) AS total FROM conversations WHERE user_id = ?',
    [userId],
  );

  const [rows] = await pool.query(
    'SELECT conversation_id, title, created_at FROM conversations WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [userId, Number(pageSize), Number(offset)],
  );

  return {
    total: countRows[0].total,
    page,
    pageSize,
    conversations: rows.map((r) => ({
      id: r.conversation_id,
      title: r.title,
      createdAt: r.created_at,
    })),
  };
}
