import memoriesRouter from './routes/memories.js';
import { MCP_HOST, MCP_PORT, MCP_BODY_LIMIT } from './config.js';
import authRoutes from './routes/auth.js';
import creditsRoutes from './routes/credits.js';
import chatRoutes from './routes/chat.js';
import signinRoutes from './routes/signin.js';
import historyRoutes from './routes/history.js';
import modelsRoutes from './routes/models.js';
import modelProfilesRoutes from './routes/modelProfiles.js';
import worksRoutes from './routes/works.js';
import { cleanupUnusedAttachments } from './services/attachments.js';
import attachmentsRoutes from './routes/attachments.js';
import express from 'express';
import cors from 'cors';

const app = express();

app.use(express.json({ limit: MCP_BODY_LIMIT }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // PATCH 是作品广场「编辑作品」用的方法，缺了它浏览器预检会直接拦掉
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  next();
});

// 预检交给 cors 统一处理（上面的手写 204 短路已移除：它会先返回，
// 导致 PATCH 这类新增方法在浏览器端被拦下）
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Routes ───
app.use('/api/auth', authRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/signin', signinRoutes);
app.use('/api/memories', memoriesRouter);
app.use('/api/history', historyRoutes);
app.use('/api/models', modelsRoutes);
app.use('/api/model-profiles', modelProfilesRoutes);
app.use('/api/works', worksRoutes);
app.use('/api/attachments', attachmentsRoutes);

// ─── Health Check ───
app.get('/', (_req, res) => {
  res.json({
    name: 'ocr-server',
    chatEndpoint: '/api/chat',
    authEndpoints: {
      register: 'POST /api/auth/register',
      login: 'POST /api/auth/login',
      me: 'GET /api/auth/me',
      profile: 'PUT /api/auth/profile',
      refresh: 'POST /api/auth/refresh',
    },
    creditsEndpoints: {
      balance: 'GET /api/credits/balance',
      deduct: 'POST /api/credits/deduct',
      packages: 'GET /api/credits/packages',
      transactions: 'GET /api/credits/transactions',
    },
    signinEndpoints: {
      status: 'GET /api/signin/status',
      signin: 'POST /api/signin',
    },
    historyEndpoints: {
      list: 'GET /api/history',
      detail: 'GET /api/history/:conversationId',
      delete: 'DELETE /api/history/:conversationId',
    },
    modelsEndpoints: {
      list: 'GET /api/models',
    },
    worksEndpoints: {
      list: 'GET /api/works?scope=public|mine|favorites&sort=latest|hot&q=&page=&pageSize=',
      create: 'POST /api/works',
      mine: 'GET /api/works/mine',
      favorites: 'GET /api/works/favorites',
      detail: 'GET /api/works/:id',
      update: 'PATCH /api/works/:id',
      remove: 'DELETE /api/works/:id',
      favorite: 'POST|DELETE /api/works/:id/favorite',
      reference: 'POST /api/works/:id/reference',
    },
  });
});

// ─── Error Handler ───
app.use((error, _req, res, next) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({
      error: `request entity too large, current limit is ${MCP_BODY_LIMIT}`,
      type: 'payload_too_large',
    });
    return;
  }

  next(error);
});

// ─── Server ───
const httpServer = app.listen(MCP_PORT, MCP_HOST, () => {
  console.log(`Server listening on http://${MCP_HOST}:${MCP_PORT}`);
  console.log(`Chat endpoint: http://${MCP_HOST}:${MCP_PORT}/api/chat`);
  console.log(`Auth endpoints: http://${MCP_HOST}:${MCP_PORT}/api/auth/{register,login,me,refresh}`);
  console.log(`Credits endpoints: http://${MCP_HOST}:${MCP_PORT}/api/credits/{balance,deduct,packages,transactions}`);
  console.log(`Sign-in endpoints: http://${MCP_HOST}:${MCP_PORT}/api/signin/{status}`);
  console.log(`Works endpoints: http://${MCP_HOST}:${MCP_PORT}/api/works{/mine,/favorites,/:id,/favorite,/reference}`);
  console.log(`JSON body limit: ${MCP_BODY_LIMIT}`);
});

httpServer.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

// 未引用图片保留 24 小时；每小时清理，删除失败保留记录供下次重试。
let cleaningAttachments = false;
const attachmentCleanupTimer = setInterval(async () => {
  if (cleaningAttachments) return;
  cleaningAttachments = true;
  try { await cleanupUnusedAttachments(); }
  catch { console.error('附件清理暂未完成，将在下一轮重试'); }
  finally { cleaningAttachments = false; }
}, 60 * 60 * 1000);
attachmentCleanupTimer.unref();

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  clearInterval(attachmentCleanupTimer);

  httpServer.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});