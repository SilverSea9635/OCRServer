# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) learning repository with two main implementations:

1. **stdio/** - MCP server using stdio transport with tool registration
2. **SSE/** - Server-Sent Events (SSE) minimal implementation with Express

## Architecture

### stdio MCP Server

The stdio implementation (`stdio/server.js`) is an MCP server that communicates via standard input/output:

- **Transport**: Uses `StdioServerTransport` from `@modelcontextprotocol/sdk`
- **Tools**: Registers three tools using Zod schemas:
  - `add_numbers` - Basic arithmetic operation
  - `create_file` - File system operations
  - `audit` - Security audit for npm/pnpm projects (local or GitHub)
- **Utilities** (`stdio/Utils.js`): Contains helper functions for file operations, project parsing (local/remote GitHub), and security auditing using pnpm audit

### SSE Server

The SSE implementation (`SSE/server.js`) demonstrates real-time communication:

- **Framework**: Express 5.x
- **Pattern**: Maintains a Set of connected clients, broadcasts messages to all
- **Endpoints**:
  - `GET /sse` - Establishes SSE connection
  - `POST /send` - Receives messages and broadcasts to all clients
  - `GET /` - Serves HTML demo page with inline JavaScript

## Development Commands

### stdio MCP Server

```bash
cd stdio
pnpm install
pnpm start        # Run the MCP server
pnpm dev          # Run with nodemon (auto-reload)
```

### SSE Server

```bash
cd SSE
pnpm install
pnpm start        # Start server on port 3001
pnpm dev          # Start with nodemon
pnpm client       # Run test client
```

Access the web interface at `http://localhost:3001/`

## Key Implementation Details

### MCP Tool Registration

Tools are registered with Zod schemas for input validation. The pattern is:

```javascript
server.registerTool('tool_name', {
  description: 'Tool description',
  inputSchema: {
    param: z.type().describe('Parameter description'),
  },
}, async (params) => {
  return {
    content: [{ type: 'text', text: result }],
  };
});
```

### Security Audit Flow

The audit tool (`stdio/audit_server.js`) follows this workflow:

1. Create temporary work directory
2. Parse project (local path or GitHub URL via API)
3. Write package.json to work directory
4. Generate package-lock.json with `npm i --package-lock-only`
5. Run `pnpm audit --json` and parse results
6. Generate markdown report with vulnerability tables
7. Clean up temporary files

### SSE Communication

The SSE server uses raw `res.write()` with proper event-stream formatting:

```
event: eventName
data: {"json":"payload"}

```

Clients are tracked in a Set and removed on connection close.

## Module System

Both projects use ES modules (`"type": "module"` in package.json). All imports must use `.js` extensions.

## Error Handling

- stdio utilities throw descriptive errors for validation failures
- SSE server logs connections/disconnections to console
- Audit tool catches non-zero exit codes from pnpm audit (expected when vulnerabilities exist)