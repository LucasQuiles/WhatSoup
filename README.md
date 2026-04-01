# WhatSoup

A multi-instance WhatsApp platform that runs three fundamentally different runtimes — passive listener, conversational chatbot, and autonomous AI agent — behind one Baileys v7 connection per line.

One process per instance. One SQLite database per instance. 127 MCP tools. No build step. Probably too many MCP tools.

## What It Does

Each WhatsApp number gets its own isolated process with its own runtime mode:

| Mode | What Happens | Use Case |
|------|-------------|----------|
| **passive** | Stores messages. Does nothing else. Manual read/reply via MCP tools. | Personal number — just want the data accessible |
| **chat** | Calls an LLM API (Anthropic/OpenAI) with optional RAG via Pinecone. Stateless request-response. | Customer support bot, Q&A assistant |
| **agent** | Spawns a Claude Code SDK subprocess with tool access, file I/O, and multi-turn sessions. | Autonomous task execution, research, project work |

These are not configuration flags on one bot. They are different codepaths with different message flows, different dependencies, and different failure modes. Treating them as settings on the same runtime was the mistake the previous two repos made.

## Requirements

- **Node.js >= 23.10** — uses native `--experimental-strip-types`, no transpilation
- **ffmpeg** — video frame extraction in chat runtime (optional)
- **SQLite** — via `node:sqlite`, bundled with Node 23+

## Quick Start

```bash
npm install
npm run typecheck
npm test                  # ~2000 tests, real SQLite, real Unix sockets, no mocks

# Single instance (needs WhatsApp auth)
npm start

# Multi-instance via systemd
systemctl --user start whatsoup@<name>
```

## Architecture

```
src/
  core/           DB, access control, messages, durability engine, JID handling
  transport/      Baileys v7 — auth, reconnection, parsing, event routing
  mcp/            Tool registry (127 tools), Unix socket server, 13 tool modules
  runtimes/
    passive/      Store-only. No auto-response. MCP socket for external access.
    chat/         LLM API — Anthropic/OpenAI, Pinecone RAG, enrichment, media
    agent/        Claude Code subprocess — sessions, sandbox, outbound queue
  config.ts       Instance-aware config from JSON + env vars
  logger.ts       Pino structured logging with daily rotation
  main.ts         Bootstrap, lifecycle, health server

deploy/
  whatsoup@.service   systemd template unit (one per instance)
  hooks/              Agent sandbox enforcement
```

## Instance Model

Each instance is an independent systemd service with isolated auth, database, logs, and config:

```
~/.config/whatsoup/instances/<name>/config.json    # what mode, what model, what access
~/.local/share/whatsoup/instances/<name>/bot.db     # messages, contacts, sessions
~/.local/state/whatsoup/instances/<name>/            # lock files, MCP socket
```

Config example (chat mode):

```json
{
  "name": "support",
  "type": "chat",
  "systemPrompt": "You are a helpful assistant.",
  "models": { "conversation": "claude-sonnet-4-6" },
  "accessMode": "open_dm",
  "maxTokens": 500,
  "rateLimitPerHour": 60,
  "healthPort": 9093
}
```

Access modes: `self_only` (just you), `allowlist` (approved contacts), `open_dm` (anyone can message), `groups_only` (WhatsApp groups only).

## Key Concepts

**conversation_key** — Canonical chat identity that stays stable when WhatsApp aliases JIDs between `@s.whatsapp.net` and `@lid`. Every query uses this instead of raw JIDs. Getting this wrong was responsible for roughly 40% of the bugs in the predecessor repos.

**ToolRegistry** — In-process MCP tool declarations with scope enforcement (`chat`-scoped vs `global`) and replay policy (`read_only`, `safe`, `unsafe`). Chat-scoped tools only see messages from the current conversation. Global tools see everything. The distinction matters when one instance serves multiple contacts.

**Durability engine** — Two-phase commit for message delivery. Inbound journal captures what arrived. Outbound ops track what was sent. Echo correlation confirms delivery. If the process crashes between receiving a message and sending the reply, the journal replays on restart.

**Media bridge** — Unix socket per workspace that lets Claude Code subprocesses send WhatsApp media (images, documents, audio) without direct Baileys access. The agent runtime owns the bridge; the subprocess just writes to a socket.

## Health & Monitoring

Each instance runs an HTTP health server:

```bash
curl http://127.0.0.1:9093/health
```

Returns connection status, uptime, message counts, enrichment state, durability stats, and model configuration. The health port is configurable per instance.

## Testing

```bash
npm test              # ~2000 tests, ~15s
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit
```

Tests use real SQLite (`:memory:` or temp files) and real Unix sockets. No infrastructure mocks. If the test passes, it works. If it doesn't, the mock was lying to you — which is why there aren't any.

## License

MIT
