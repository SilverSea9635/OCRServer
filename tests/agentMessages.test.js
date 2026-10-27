import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { getRemoteMessages, requestAgentJSON } from '../services/agent_sessions.js';
import { reserveMessageAttachments, confirmMessageAttachments } from '../services/attachments.js';

test('消息分页保留 UUID，游标与用户身份传给内部服务', async () => {
  const page = await getRemoteMessages({ conversationId: 'conversation', userId: 123, agentServiceUrl: 'http://agent', secret: 'test-secret', limit: 20, before: 41, fetchImpl: async (url, request) => {
    assert.equal(url.searchParams.get('before'), '41');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(request.headers['X-User-Id'], '123');
    return { ok: true, json: async () => ({ messages: [{ id: 'uuid-id', content: '正文' }], nextCursor: 21 }) };
  } });
  assert.equal(page.messages[0].id, 'uuid-id');
  assert.equal(page.nextCursor, 21);
});

test('中文记忆名称签名使用解码后的路径，和 FastAPI 一致', async () => {
  await requestAgentJSON({ method: 'PUT', path: '/api/agent/memories/%E8%AF%AD%E8%A8%80', userId: 123, agentServiceUrl: 'http://agent', secret: 'fixture', body: { value: '中文' }, fetchImpl: async (url, request) => {
    const timestamp = request.headers['X-Internal-Timestamp'];
    assert.equal(request.headers['X-Internal-Signature'], createHmac('sha256', 'fixture').update(`123.${timestamp}.PUT./api/agent/memories/语言`).digest('hex'));
    return { ok: true, json: async () => ({ saved: true }) };
  } });
});

test('附件在消息请求前获得引用；无权访问时回滚，不产生引用', async () => {
  const events = [];
  let owned = true;
  const connection = {
    beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'),
    rollback: async () => events.push('rollback'), release: () => events.push('release'),
    execute: async (query, params) => {
      if (query.includes('FROM conversations')) return [[owned ? { conversation_id: 'one' } : undefined].filter(Boolean)];
      if (query.includes('FROM image_attachments')) return [[{ id: 'image' }]];
      events.push(['pin', params]); return [{}];
    },
  };
  const db = { getConnection: async () => connection, execute: async () => events.push('confirm') };
  await reserveMessageAttachments(1, 'one', 'message-uuid', [{ type: 'image', attachmentId: 'image' }], db);
  assert.equal(events[1][0], 'pin');
  assert.deepEqual(events[1][1], ['message-uuid', 'image', 'one']);
  assert.deepEqual(events.slice(-2), ['commit', 'release']);
  await confirmMessageAttachments('message-uuid', db);
  assert.equal(events.at(-1), 'confirm');
  events.length = 0;
  owned = false;
  await assert.rejects(() => reserveMessageAttachments(2, 'one', 'message-uuid', [{ type: 'image', attachmentId: 'image' }], db));
  assert.deepEqual(events, ['begin', 'rollback', 'release']);
});
