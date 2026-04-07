import { addNumbers, createFileInDirectory } from './Utils.js';
import { audit } from './audit_server.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from 'zod/v4';

const HOST = process.env.MCP_HOST || '127.0.0.1';
const PORT = Number(process.env.MCP_PORT || 3000);
const app = createMcpExpressApp({ host: HOST });
const transports = new Map();

function createServer() {
  const server = new McpServer({
    name: 'minimal-http-sse-mcp',
    version: '0.0.1',
    title: '最小化 HTTP/SSE MCP 服务器',
  });

  server.registerTool('add_numbers', {
    description: '计算两个数字的和',
    inputSchema: {
      a: z.number().describe('第一个数字'),
      b: z.number().describe('第二个数字'),
    },
  }, async ({ a, b }) => {
    const sum = addNumbers(a, b);

    return {
      content: [
        {
          type: 'text',
          text: String(sum),
        },
      ],
    };
  });

  server.registerTool('create_file', {
    description: '在指定目录创建文件',
    inputSchema: {
      directoryPath: z.string().describe('目标目录'),
      fileName: z.string().describe('文件名'),
      content: z.string().default('').describe('文件内容，默认空字符串'),
    },
  }, async ({ directoryPath, fileName, content }) => {
    const result = await createFileInDirectory(directoryPath, fileName, content);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  server.registerTool('audit', {
    description: '审计项目依赖的安全漏洞',
    inputSchema: {
      projectRoot: z.string().describe('项目根目录或 GitHub 仓库地址'),
      savePath: z.string().describe('审计结果保存路径'),
    },
  }, async ({ projectRoot, savePath }) => {
    const resultPath = await audit(projectRoot, savePath);

    return {
      content: [
        {
          type: 'text',
          text: resultPath,
        },
      ],
    };
  });

  return server;
}

app.get('/', (_req, res) => {
  res.json({
    name: 'minimal-http-sse-mcp',
    transport: 'http+sse',
    sseEndpoint: '/sse',
    messageEndpoint: '/messages?sessionId=<sessionId>',
  });
});

app.get('/sse', async (_req, res) => {
  try {
    const transport = new SSEServerTransport('/messages', res);
    const server = createServer();

    transports.set(transport.sessionId, transport);
    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };

    await server.connect(transport);
    console.log(`SSE session established: ${transport.sessionId}`);
  } catch (error) {
    console.error('Failed to establish SSE session:', error);
    if (!res.headersSent) {
      res.status(500).send('Failed to establish SSE session');
    }
  }
});

app.post('/messages', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  if (!sessionId) {
    res.status(400).send('Missing sessionId parameter');
    return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).send('Session not found');
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error(`Failed to handle message for session ${sessionId}:`, error);
    if (!res.headersSent) {
      res.status(500).send('Failed to handle message');
    }
  }
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`MCP HTTP/SSE server listening on http://${HOST}:${PORT}`);
  console.log(`SSE endpoint: http://${HOST}:${PORT}/sse`);
  console.log(`Message endpoint: http://${HOST}:${PORT}/messages?sessionId=<sessionId>`);
});

httpServer.on('error', (error) => {
  console.error('Server error:', error);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);

  for (const [sessionId, transport] of transports.entries()) {
    try {
      await transport.close();
    } catch (error) {
      console.error(`Failed to close transport for session ${sessionId}:`, error);
    } finally {
      transports.delete(sessionId);
    }
  }

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
