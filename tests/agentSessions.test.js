import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { clearRemoteAgentSession, AgentSessionCleanupError } from '../services/agent_sessions.js';

const options = { conversationId: 'fixture-conversation', userId: 123, enabled: true, agentServiceUrl: 'http://agent:8000', secret: 'fixture-secret' };

test('清理请求携带用户身份和路径签名', async () => {
  let called = false;
  await clearRemoteAgentSession({ ...options, fetchImpl: async (url, request) => {
    called = true;
    assert.equal(request.method, 'DELETE');
    assert.equal(url.searchParams.get('userId'), '123');
    const timestamp = request.headers['X-Internal-Timestamp'];
    const signature = createHmac('sha256', options.secret).update(`123.${timestamp}.DELETE.${url.pathname}`).digest('hex');
    assert.equal(request.headers['X-Internal-Signature'], signature);
    return { ok: true, json: async () => ({ cleared: true, conversationId: options.conversationId }) };
  } });
  assert.equal(called, true);
});

test('未启用 Agent 时维持原有删除流程', async () => {
  await clearRemoteAgentSession({ ...options, enabled: false, fetchImpl: () => { throw new Error('不应请求远端'); } });
});

test('远端失败、超时或确认信息不符时不允许继续删除业务会话', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 503 }),
    async () => { throw new Error('fixture-private-upstream-error'); },
    async () => ({ ok: true, json: async () => ({ cleared: false }) }),
  ]) {
    await assert.rejects(() => clearRemoteAgentSession({ ...options, fetchImpl }), error => error instanceof AgentSessionCleanupError && !error.message.includes('fixture-private'));
  }
});

test('运行中的会话保留冲突状态', async () => {
  await assert.rejects(() => clearRemoteAgentSession({ ...options, fetchImpl: async () => ({ ok: false, status: 409 }) }), error => error.statusCode === 409);
});
