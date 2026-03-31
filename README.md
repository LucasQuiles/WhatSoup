# WhatSoup

Consolidated WhatsApp platform. One process, one Baileys v7 connection, one SQLite database, 127 MCP tools.

Replaces two legacy repos (`whatsapp-bot` + `whatsapp-mcp`) into a single codebase with embedded tool registry, dual runtime modes, and a durability engine.

## Requirements

- **Node.js >= 23.10** (native `--experimental-strip-types`, no build step)
- **ffmpeg** (for video frame extraction in chat runtime)
- **SQLite** (via `node:sqlite`, bundled with Node 23+)

## Quick Start

```bash
npm install
npm run typecheck
npm test

# Single-instance mode (requires Baileys auth)
npm start

# Multi-instance mode (via systemd template)
npm run start:instance    # reads INSTANCE_NAME env var
```

## Architecture

```
src/
  core/         Shared infrastructure — DB, types, access control, messages,
                durability engine, JID constants, workspace provisioning
  transport/    Baileys v7 connection — auth, reconnection, message parsing,
                event routing, @mention resolution
  mcp/          MCP tool registry (117 tools), Unix socket server,
                tool implementations across 13 modules
  runtimes/
    agent/      Claude Code agent subprocess — session management, watchdog,
                outbound queue, media bridge, per-chat sandboxing
    chat/       Direct LLM API chat — Anthropic/OpenAI providers, Pinecone
                memory, enrichment pipeline, media processing
  config.ts     Instance-aware config with env var fallbacks
  logger.ts     Pino + pino-roll (stdout + daily rotating file)
  main.ts       Bootstrap, lifecycle, health server

deploy/
  whatsoup@.service   systemd template unit
  hooks/              Agent sandbox enforcement (PreToolUse)
  mcp/                send-media MCP server, whatsoup-proxy

tests/                Mirrors src/ structure — 82 files, 1972 tests
```

## Instance Model

Three independent processes via `systemctl start whatsoup@<name>`:

| Instance | Type | Access | Description |
|----------|------|--------|-------------|
| `personal` | agent | self_only | Full-access Claude Code agent |
| `loops` | agent | allowlist | Sandboxed per-chat agent for friends |
| `besbot` | chat | open_dm | Direct LLM API chat bot |

Each instance has isolated auth credentials, SQLite database, log directory, and config at `~/.config/whatsapp-instances/<name>/instance.json`.

## Key Concepts

- **conversation_key** — Canonical chat identity, stable across JID aliasing (`@s.whatsapp.net` vs `@lid`). All reads query on this.
- **ToolRegistry** — In-process MCP tool declarations with scope enforcement (`chat` vs `global`) and replay policy (`read_only`, `safe`, `unsafe`).
- **Durability engine** — Two-phase commit model for message delivery. Inbound journal + outbound ops + echo correlation.
- **Media bridge** — Unix domain socket server per workspace that lets Claude Code subprocesses send WhatsApp media files.

## Environment Variables

All have sensible defaults. Instance JSON config takes precedence when running in multi-instance mode.

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PHONES` | (empty) | Comma-separated phone numbers for admin access |
| `HEALTH_PORT` | `9090` | HTTP health endpoint port |
| `MAX_TOKENS` | `750` | Max LLM response tokens |
| `RATE_LIMIT_PER_HOUR` | `45` | Per-user rate limit |
| `LOG_LEVEL` | `info` | Pino log level |
| `LOG_DIR` | `~/.local/share/whatsoup/<name>/logs` | Log file directory (enables pino-roll) |
| `CONVERSATION_MODEL` | `claude-opus-4-6` | Primary LLM model |
| `FALLBACK_MODEL` | `gpt-5.4` | Fallback LLM model |
| `PINECONE_INDEX` | `whatsapp-bot` | Pinecone index name |

## Testing

```bash
npm test              # 1972 tests, ~7s
npm run test:watch    # Watch mode
npm run typecheck     # tsc --noEmit
```

Real SQLite (`:memory:` or temp files) and real Unix sockets in tests. No mocks for infrastructure.

## License

Private.
