import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'node:url';

dotenv.config({
  path: fileURLToPath(new URL('./.env.development', import.meta.url)),
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
export const MIMO_SYSTEM =
  process.env.MIMO_SYSTEM ||
  'You are MiMo, an AI assistant developed by Xiaomi. Keep answers concise and useful.';
export const DEFAULT_MAX_TOKENS = parseInt(process.env.DEFAULT_MAX_TOKENS) || 4096;