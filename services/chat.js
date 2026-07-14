import { Anthropic } from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { MIMO_KEY, MIMO_PREFIX, MIMO_MODEL, MIMO_SYSTEM, DEFAULT_MAX_TOKENS, pool } from '../config.js';

if (!MIMO_KEY) {
  throw new Error('Missing MIMO_KEY in .env.development');
}

if (!MIMO_PREFIX) {
  throw new Error('Missing MIMO_PREFIX in .env.development');
}

const baseURL = MIMO_PREFIX.replace(/\/v1\/messages\/?$/, '');
const conversations = new Map();
const conversationQueues = new Map();

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
    'SELECT id FROM conversations WHERE conversation_id = ?',
    [conversationId],
  );

  if (existing.length > 0) {
    // Update title if provided and different
    if (title) {
      await pool.execute(
        'UPDATE conversations SET title = ? WHERE conversation_id = ? AND (title IS NULL OR title = "")',
        [title, conversationId],
      );
    }
    return;
  }

  await pool.execute(
    'INSERT INTO conversations (conversation_id, user_id, title) VALUES (?, ?, ?)',
    [conversationId, userId, title || ''],
  );
}

async function saveMessage(conversationId, userId, role, content, model, tokensUsed) {
  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  await pool.execute(
    'INSERT INTO messages (conversation_id, user_id, role, content, model, tokens_used) VALUES (?, ?, ?, ?, ?, ?)',
    [conversationId, userId, role, contentStr, model || null, tokensUsed || null],
  );
}

export async function streamChatMessage({
  conversationId,
  userId,
  message,
  system = MIMO_SYSTEM,
  model = MIMO_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  const resolvedConversationId = resolveConversationId(conversationId);
  const releaseConversationTurn = await acquireConversationTurn(resolvedConversationId);

  // Load existing history from in-memory cache or DB
  let history = conversations.get(resolvedConversationId);
  if (!history) {
    const [rows] = await pool.execute(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC',
      [resolvedConversationId],
    );
    history = rows.map((row) => {
      try {
        return { role: row.role, content: JSON.parse(row.content) };
      } catch {
        return { role: row.role, content: row.content };
      }
    });
    conversations.set(resolvedConversationId, history);
  }

  const nextHistory = [...history, { role: 'user', content: message }];

  // Derive title from first user message text
  let title = '';
  if (typeof message === 'string') {
    title = message.slice(0, 50);
  } else if (Array.isArray(message)) {
    const textPart = message.find((b) => b.type === 'text');
    if (textPart?.text) title = textPart.text.slice(0, 50);
  }

  // Persist conversation and user message to DB
  await ensureConversation(resolvedConversationId, userId, title);
  await saveMessage(resolvedConversationId, userId, 'user', message);

  let stream;

  try {
    stream = anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      system,
      messages: nextHistory,
    });
  } catch (error) {
    releaseConversationTurn();
    throw error;
  }

  let closed = false;

  const closeTurn = () => {
    if (closed) {
      return;
    }

    closed = true;
    releaseConversationTurn();
  };

  const finalizeMessage = async () => {
    try {
      const response = await stream.finalMessage();
      const assistantMessage = { role: 'assistant', content: response.content };

      // Update in-memory cache
      conversations.set(resolvedConversationId, [...nextHistory, assistantMessage]);

      // Persist assistant message to DB
      await saveMessage(
        resolvedConversationId,
        userId,
        'assistant',
        response.content,
        response.model,
        response.usage?.output_tokens,
      );

      return response;
    } finally {
      closeTurn();
    }
  };

  const abort = () => {
    stream.abort();
    closeTurn();
  };

  return { resolvedConversationId, stream, finalizeMessage, abort };
}

export async function clearConversation(conversationId, userId) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) {
    return false;
  }

  const trimmed = conversationId.trim();

  // Clear from in-memory cache
  conversations.delete(trimmed);

  // Clear from DB (messages cascade via FK)
  const [result] = await pool.execute(
    'DELETE FROM conversations WHERE conversation_id = ? AND user_id = ?',
    [trimmed, userId],
  );

  return result.affectedRows > 0;
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

  const [msgRows] = await pool.execute(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC',
    [conversationId],
  );

  const messages = msgRows.map((row) => {
    let content;
    try {
      content = JSON.parse(row.content);
    } catch {
      content = row.content;
    }
    return {
      id: row.id,
      role: row.role,
      content,
      createdAt: row.created_at,
    };
  });

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