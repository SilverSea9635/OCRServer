import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../config.js';

// 默认只预览。应用时必须明确声明丢弃测试消息，并核对预期行数。
const apply = process.argv.includes('--apply');
const allowDiscard = process.argv.includes('--discard-test-messages') && process.argv.includes('--discard-test-conversations');
const expectedConversations = process.argv.find(value => value.startsWith('--expected-conversations='))?.split('=')[1];
const expected = process.argv.find(value => value.startsWith('--expected-messages='))?.split('=')[1];
const manifest = process.argv.find(value => value.startsWith('--manifest='))?.split('=')[1];
try {
  const [tables] = await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='messages'");
  if (!tables.length) {
    // messages 缺失也可能是 DDL 中断，必须核对新结构后才能报告已完成。
    const [columns] = await pool.query("SELECT COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='message_image_attachments'");
    const messageId = columns.find(row => row.COLUMN_NAME === 'message_id');
    const [temporary] = await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='message_image_attachments_v2'");
    if (messageId?.DATA_TYPE !== 'char' || messageId?.CHARACTER_MAXIMUM_LENGTH !== 36 || !columns.some(row => row.COLUMN_NAME === 'conversation_id') || !columns.some(row => row.COLUMN_NAME === 'state') || temporary.length) throw new Error('迁移结构不完整，请检查并恢复后再启动服务');
    console.log(JSON.stringify({ ok: true, alreadyApplied: true }));
  } else {
    const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM messages');
    const [conversations] = await pool.query('SELECT conversation_id AS conversationId, user_id AS userId FROM conversations');
    if (!apply) console.log(JSON.stringify({ ok: true, dryRun: true, testMessages: count, testConversations: conversations.length }));
    else {
      if (!allowDiscard || expected === undefined || Number(expected) !== count || Number(expectedConversations) !== conversations.length || !manifest) throw new Error('缺少测试数据清理声明、预期行数不符或未指定清理清单');
      // 清单不包含消息正文或连接凭据，用于同步清除旧的测试检查点。
      await writeFile(manifest, JSON.stringify(conversations), { mode: 0o600 });
      const [foreignKeys] = await pool.query("SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='conversations' AND TABLE_NAME<>'messages'");
      if (foreignKeys.length) throw new Error('会话仍存在其他业务外键，停止清理');
      const [messageForeignKeys] = await pool.query("SELECT TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='messages' AND TABLE_NAME<>'message_image_attachments'");
      if (messageForeignKeys.length) throw new Error('消息仍存在其他业务外键，停止清理');
      const [columnInfo] = await pool.query("SELECT TABLE_NAME,COLUMN_NAME,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='image_attachments' AND COLUMN_NAME='id') OR (TABLE_NAME='conversations' AND COLUMN_NAME='conversation_id'))");
      const imageCollation = columnInfo.find(row => row.TABLE_NAME === 'image_attachments')?.COLLATION_NAME;
      const conversationCollation = columnInfo.find(row => row.TABLE_NAME === 'conversations')?.COLLATION_NAME;
      if (![imageCollation,conversationCollation].every(value => typeof value === 'string' && /^[a-z0-9_]+$/.test(value))) throw new Error('无法确认跨表引用字符集');
      let source = await readFile(new URL('../migrations/005_postgres_messages.sql', import.meta.url), 'utf8');
      source = source.replace('attachment_id CHAR(36) NOT NULL', `attachment_id CHAR(36) COLLATE ${imageCollation} NOT NULL`).replace('conversation_id VARCHAR(64) COLLATE utf8mb4_unicode_ci', `conversation_id VARCHAR(64) COLLATE ${conversationCollation}`);
      for (const statement of source.split(';').map(value => value.trim()).filter(Boolean)) await pool.query(statement);
      console.log(JSON.stringify({ ok: true, discardedTestMessages: count, discardedTestConversations: conversations.length }));
    }
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, errorCode: error.code || error.name }));
  process.exitCode = 1;
} finally { await pool.end(); }
