-- 005：用户已确认旧 messages 仅为可丢弃测试数据，不执行内容搬迁。
-- 由 scripts/migrate_agent_messages.js 在检查表状态和行数后执行。
CREATE TABLE message_image_attachments_v2 (
  message_id CHAR(36) NOT NULL,
  attachment_id CHAR(36) NOT NULL,
  conversation_id VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(message_id, attachment_id),
  KEY idx_attachment_message(attachment_id),
  KEY idx_attachment_conversation(conversation_id),
  KEY idx_pending_attachment(state, created_at),
  CONSTRAINT fk_message_image_v2 FOREIGN KEY(attachment_id) REFERENCES image_attachments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 组件资产仍保留；来源消息改为 PostgreSQL 的稳定 UUID 弱引用。
UPDATE components SET source_message_id = NULL;
ALTER TABLE components MODIFY COLUMN source_message_id CHAR(36) NULL;

-- 新表及外键验证成功后，才切换并丢弃旧测试会话。
DROP TABLE IF EXISTS message_image_attachments;
DROP TABLE IF EXISTS messages;
RENAME TABLE message_image_attachments_v2 TO message_image_attachments;
DELETE FROM conversation_turns;
DELETE FROM conversations;
