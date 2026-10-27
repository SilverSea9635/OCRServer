import { createHmac } from 'node:crypto';

export class AgentServiceError extends Error {
  constructor(statusCode = 503) {
    super(statusCode === 410 ? '该会话已经删除，请创建新会话' : '会话存储暂不可用，请稍后重试');
    this.name = 'AgentServiceError';
    this.statusCode = statusCode;
  }
}

export class AgentSessionCleanupError extends AgentServiceError {}

export function agentHeaders({ method, path, userId, secret }) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['X-User-Id'] = String(userId);
    headers['X-Internal-Timestamp'] = timestamp;
    headers['X-Internal-Signature'] = createHmac('sha256', secret)
      .update(`${userId}.${timestamp}.${method}.${decodeURIComponent(path)}`).digest('hex');
  }
  return headers;
}

export async function requestAgentJSON({ method = 'GET', path, body, query = {}, userId, agentServiceUrl, secret, fetchImpl = fetch }) {
  try {
    const url = new URL(`${agentServiceUrl.replace(/\/$/, '')}${path}`);
    url.searchParams.set('userId', String(userId));
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, {
      method, headers: agentHeaders({ method, path, userId, secret }),
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new AgentServiceError([400, 401, 403, 404, 409, 410].includes(response.status) ? response.status : 503);
    return await response.json();
  } catch (error) {
    if (error instanceof AgentServiceError) throw error;
    throw new AgentServiceError();
  }
}

export async function getRemoteMessages(options) {
  return requestAgentJSON({ ...options, path: `/api/agent/sessions/${encodeURIComponent(options.conversationId)}/messages`, query: { limit: options.limit || 100, before: options.before } });
}

export async function getRemoteMessage(options) {
  return requestAgentJSON({ ...options, path: `/api/agent/sessions/${encodeURIComponent(options.conversationId)}/messages/${encodeURIComponent(options.messageId)}` });
}

export async function clearRemoteAgentSession(options) {
  // 即使关闭模型生成，也要清理已迁移到 Python 的消息。
  if (options.enabled === false && !options.messageStorageEnabled) return;
  try {
    const result = await requestAgentJSON({ ...options, method: 'DELETE', path: `/api/agent/sessions/${encodeURIComponent(options.conversationId)}` });
    if (result.cleared !== true || result.conversationId !== options.conversationId) throw new AgentSessionCleanupError();
  } catch (error) {
    throw new AgentSessionCleanupError(error.statusCode || 503);
  }
}
