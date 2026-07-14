import { MCP_HOST, MCP_PORT, MCP_BODY_LIMIT } from './config.js';
import authRoutes from './routes/auth.js';
import creditsRoutes from './routes/credits.js';
import chatRoutes from './routes/chat.js';
import signinRoutes from './routes/signin.js';
import historyRoutes from './routes/history.js';
import express from 'express';
import cors from 'cors';

const app = express();

app.use(express.json({ limit: MCP_BODY_LIMIT }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});
app.use(cors());

// ─── Routes ───
app.use('/api/auth', authRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/signin', signinRoutes);
app.use('/api/history', historyRoutes);

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
  console.log(`JSON body limit: ${MCP_BODY_LIMIT}`);
});

httpServer.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);

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