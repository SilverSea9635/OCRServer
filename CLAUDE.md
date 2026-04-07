# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm start        # production
pnpm dev          # development with nodemon hot-reload
```

No test suite is configured.

## Environment

Copy `.env.development` and set:
- `MIMO_KEY` — API key (required)
- `MIMO_PREFIX` — base URL ending in `/anthropic/v1/messages` (required)
- `MIMO_MODEL` — model name (default: `mimo-v2-omni`)
- `DEFAULT_MAX_TOKENS` — (default: 4096)
- `MCP_HOST` / `MCP_PORT` — server bind address (default: `127.0.0.1:3000`)
- `MCP_BODY_LIMIT` — express body size limit (default: `20mb`)

## Architecture

Two-file ESM project (`"type": "module"`):

**`ocr.js`** — AI layer. Wraps `@anthropic-ai/sdk` pointed at the Xiaomi MiMo API (Anthropic-compatible). Maintains an in-memory `Map` of conversation histories keyed by `conversationId`. Exports:
- `streamChatMessage({ conversationId, message, system, model, maxTokens })` — returns `{ resolvedConversationId, stream }`. History is updated after `stream.finalMessage()` resolves.
- `clearConversation(conversationId)` — deletes history for a session.

**`server.js`** — Express HTTP server with SSE streaming. Key routes:
- `POST /api/chat` — accepts `{ conversationId?, message, content, system?, model?, maxTokens? }`. Streams SSE events: `start`, `delta`, `done`, `error`. `message` and `content` are interchangeable; both accept string or Anthropic content-block arrays (for multimodal/image input).
- `DELETE /api/chat/:conversationId` — clears conversation history.
- `POST /messages?sessionId=` — MCP transport message handler (SSE session relay).
- `GET /` — service discovery JSON.

The `transports` Map in `server.js` is reserved for MCP SSE sessions but the `/sse` endpoint is not yet implemented — only the `/messages` relay exists.

Localhost-only host header validation is applied automatically when `MCP_HOST` is a loopback address.
