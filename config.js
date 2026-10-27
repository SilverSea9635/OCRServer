import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

const environment = process.env.NODE_ENV || 'development';

dotenv.config({
  path: fileURLToPath(new URL(`./.env.${environment}`, import.meta.url)),
  quiet: true,
});

// ─── Server ───
export const MCP_HOST = process.env.MCP_HOST || '127.0.0.1';
export const MCP_PORT = Number(process.env.MCP_PORT || 3000);
export const MCP_BODY_LIMIT = process.env.MCP_BODY_LIMIT || '20mb';

// ─── MySQL ───
export const DB_HOST = process.env.DB_HOST || '127.0.0.1';
export const DB_PORT = Number(process.env.DB_PORT || 3306);
export const DB_USER = process.env.DB_USER || 'root';
export const DB_PASSWORD = process.env.DB_PASSWORD || '';
export const DB_NAME = process.env.DB_NAME || 'OCRDB';

export const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
});

// ─── Auth ───
export const JWT_SECRET = process.env.JWT_SECRET || 'snapui-default-secret-change-me';
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';
export const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'snapui-refresh-secret-change-me';
export const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '30d';
export const INITIAL_CREDITS = parseInt(process.env.INITIAL_CREDITS) || 100;

// ─── AI / Chat ───
export const MIMO_KEY = process.env.MIMO_KEY;
export const MIMO_PREFIX = process.env.MIMO_PREFIX;
export const MIMO_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5';
export const DEFAULT_MAX_TOKENS = parseInt(process.env.DEFAULT_MAX_TOKENS) || 4096;

// ─── Agent Service (Python 工程) ───
// /api/chat 由 Python 执行共享图并持久化 PostgreSQL 消息，本服务转发 SSE。
// 默认开启；关闭时停止聊天，不再使用缺少新消息存储的 MiMo 直连生成。
export const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || 'http://127.0.0.1:8001';
export const AGENT_SERVICE_ENABLED = (process.env.AGENT_SERVICE_ENABLED || 'true') === 'true';
// 图片视觉理解模型（截图 → 文本描述），复用 MiMo 的多模态能力
export const AGENT_VISION_MODEL = process.env.AGENT_VISION_MODEL || MIMO_MODEL;
