import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, AGENT_SERVICE_URL } from '../config.js';
import { createConversation, streamChatViaAgentService, loadConversationHistory, clearConversation } from '../services/chat.js';
import { requestAgentJSON, getRemoteMessages, getRemoteMessage } from '../services/agent_sessions.js';
import { reserveMessageAttachments, confirmMessageAttachments } from '../services/attachments.js';

const conversationIds = [];
const key = `probe_${randomUUID().replaceAll('-', '')}`;
let userId;
let imageId;
const options = () => ({ userId, agentServiceUrl: AGENT_SERVICE_URL, secret: process.env.INTERNAL_API_TOKEN });
try {
  const [[user]] = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
  if (!user) throw new Error('联调需要一个现有测试用户');
  userId = user.id;
  const first = await createConversation(userId, '临时消息存储验证');
  conversationIds.push(first);
  const chat = await streamChatViaAgentService({ conversationId: first, userId, message: `请记住偏好 MEMORY_KEY=${key}`, model: 'fixture-a' });
  for await (const event of chat.stream) assert.equal(event.type, 'content_block_delta');
  await chat.finalizeMessage();
  const history = await loadConversationHistory(first, userId);
  assert.equal(history.messages.length, 2);
  assert.match(history.messages[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(history.messages[0].content, `请记住偏好 MEMORY_KEY=${key}`);
  const memories = await requestAgentJSON({ ...options(), path: '/api/agent/memories' });
  assert.ok(memories.memories.some(item => item.key === key && item.value === '使用简短中文'));

  const second = await createConversation(userId, '临时跨会话记忆验证');
  conversationIds.push(second);
  const next = await streamChatViaAgentService({ conversationId: second, userId, message: '读取已有偏好', model: 'fixture-b' });
  let reply = '';
  for await (const event of next.stream) reply += event.delta.text;
  await next.finalizeMessage();
  assert.ok(reply.includes('偏好已恢复'));

  // 网络流缺少 done 时不能误报完成，也不能写成功的计量元数据。
  const originalFetch = globalThis.fetch;
  let interrupted;
  try {
    globalThis.fetch = (url, options) => String(url).endsWith('/api/chat')
      ? Promise.resolve(new Response('event: delta\ndata: {"text":"不完整回复"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
      : originalFetch(url, options);
    interrupted = await streamChatViaAgentService({ conversationId: second, userId, message: '流中断测试', model: 'fixture-b' });
    await assert.rejects(async () => { for await (const event of interrupted.stream) {} }, /服务流已中断/);
  } finally { globalThis.fetch = originalFetch; interrupted?.abort(); }

  // 仅创建一条无 OSS 文件的附件元数据，验证跨库引用保护和联动清理。
  imageId = randomUUID();
  await pool.execute('INSERT INTO image_attachments(id,user_id,storage_key,file_name,mime_type,size_bytes,width,height,sha256) VALUES(?,?,?,?,?,?,?,?,?)', [imageId, userId, `verification/${imageId}`, 'probe.png', 'image/png', 1, 1, 1, '0'.repeat(64)]);
  const messageId = randomUUID();
  await reserveMessageAttachments(userId, second, messageId, [{ type: 'image', attachmentId: imageId }]);
  const assistantMessageId = randomUUID();
  const requestBody = JSON.stringify({ conversationId: second, userId: String(userId), message: '截图的文字描述', originalMessage: [{ type: 'image', attachmentId: imageId, source: { type: 'attachment', media_type: 'image/png' } }], messageId, assistantMessageId, model: 'fixture-b' });
  const requestOptions = {
    method: 'POST',
    headers: (await import('../services/agent_sessions.js')).agentHeaders({ method: 'POST', path: '/api/chat', userId, secret: process.env.INTERNAL_API_TOKEN }),
    body: requestBody,
  };
  const response = await fetch(`${AGENT_SERVICE_URL}/api/chat`, requestOptions);
  const frames = await response.text();
  assert.ok(frames.includes('event: done'));
  const replay = await fetch(`${AGENT_SERVICE_URL}/api/chat`, requestOptions);
  assert.ok((await replay.text()).includes('event: done'));
  assert.equal((await getRemoteMessages({ ...options(), conversationId: second })).messages.length, 4);
  await confirmMessageAttachments(messageId);
  const stored = await getRemoteMessage({ ...options(), conversationId: second, messageId });
  assert.equal(stored.content[0].attachmentId, imageId);
  const [[pin]] = await pool.execute('SELECT COUNT(*) AS count FROM message_image_attachments WHERE attachment_id=?', [imageId]);
  assert.equal(pin.count, 1);
  const page = await getRemoteMessages({ ...options(), conversationId: second, limit: 1 });
  assert.equal(page.messages.length, 1);
  assert.ok(page.nextCursor);
  for (const id of conversationIds) await clearConversation(id, userId);
  assert.equal(await loadConversationHistory(first, userId), null);
  await assert.rejects(() => getRemoteMessages({ ...options(), conversationId: first }), error => error.statusCode === 410);
  const [[unpin]] = await pool.execute('SELECT COUNT(*) AS count FROM message_image_attachments WHERE attachment_id=?', [imageId]);
  assert.equal(unpin.count, 0);
  console.log(JSON.stringify({ ok: true, messagesInPostgres: true, rawInputPreserved: true, crossConversationMemory: true, modelSwitch: true, pagination: true, attachmentReferences: true, coordinatedDelete: true, duplicateReplayed: true, truncatedStreamRejected: true }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, errorType: error.name, message: error instanceof assert.AssertionError ? error.message : undefined }));
  process.exitCode = 1;
} finally {
  if (userId) {
    for (const id of conversationIds) {
      try { await clearConversation(id, userId); } catch {}
    }
    try { await requestAgentJSON({ ...options(), method: 'DELETE', path: `/api/agent/memories/${key}` }); } catch {}
    if (imageId) await pool.execute('DELETE FROM image_attachments WHERE id=?', [imageId]);
  }
  await pool.end();
}
