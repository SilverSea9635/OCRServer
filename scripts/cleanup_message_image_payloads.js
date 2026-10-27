#!/usr/bin/env node
/**
 * 旧 MySQL 消息版本专用：清理历史图片 base64；005 切换后自动跳过。
 * ─────────────────────────────────────────────────────────────
 * 在 services/message_storage.js 生效之前写入的消息，content 里可能仍带着图片 base64。
 * 本脚本用同一份剥离逻辑把它们替换为元数据，回收空间。
 *
 * 用法（在 OCRServer 目录下执行）：
 *   node scripts/cleanup_message_image_payloads.js            # 预演：只统计，不写库
 *   node scripts/cleanup_message_image_payloads.js --apply    # 实际执行
 *
 * 安全约束：
 *   - 默认 dry-run，必须显式 --apply 才写库；
 *   - 只改 content 里确实含图片 base64 的行（其余行完全不碰）；
 *   - 幂等：重复执行不会产生额外变化；
 *   - 不改表结构（表结构见 migrations/001_messages_content_mediumtext.sql）。
 */
import path from 'node:path';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { toStorableContent } from '../services/message_storage.js';

const APPLY = process.argv.includes('--apply');
const BATCH_SIZE = 200;
const environment = process.env.NODE_ENV || 'development';

dotenv.config({
  path: path.join(process.cwd(), `.env.${environment}`),
  quiet: true,
});

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'OCRDB',
});

const [messageTables] = await connection.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='messages'");
if (!messageTables.length) {
  console.log('消息已切换到 PostgreSQL，无需执行旧版图片载荷修复。');
  await connection.end();
  process.exit(0);
}

console.log(`模式: ${APPLY ? '实际执行（写库）' : '预演（不写库）'}`);
console.log(`目标库: ${process.env.DB_NAME || 'OCRDB'}`);

let lastId = 0;
let scanned = 0;
let matched = 0;
let reclaimed = 0;

for (;;) {
  const [rows] = await connection.query(
    'SELECT id, content FROM messages WHERE id > ? AND content LIKE ? ORDER BY id ASC LIMIT ?',
    [lastId, '%base64%', BATCH_SIZE],
  );

  if (rows.length === 0) {
    break;
  }

  for (const row of rows) {
    lastId = row.id;
    scanned += 1;

    let parsed;
    try {
      parsed = JSON.parse(row.content);
    } catch {
      continue; // 非 JSON（纯文本消息）：跳过
    }

    const hasImagePayload =
      Array.isArray(parsed) &&
      parsed.some((block) => block && block.type === 'image' && block.source && block.source.data);

    if (!hasImagePayload) {
      continue; // 只是文本里出现了 base64 字样：不动它
    }

    const next = toStorableContent(parsed);
    const saved = Buffer.byteLength(row.content, 'utf8') - Buffer.byteLength(next, 'utf8');

    matched += 1;
    reclaimed += saved;

    if (APPLY) {
      await connection.execute('UPDATE messages SET content = ? WHERE id = ?', [next, row.id]);
    }
  }
}

console.log(`扫描带 base64 字样的消息: ${scanned} 条`);
console.log(`确实含图片像素、需处理: ${matched} 条`);
console.log(`可回收: ${(reclaimed / 1024 / 1024).toFixed(2)} MB`);

if (!APPLY && matched > 0) {
  console.log('以上为预演结果，未写入。确认无误后加 --apply 执行。');
}

await connection.end();
