# WhatSoup

Consolidated WhatsApp platform — one process, one Baileys connection, one database, 161 MCP tools (160 always-registered + `knowledge_search` registered only when Pinecone config, credentials, and profiles are usable; see `docs/tools.md`).

## Quick Reference

- **Language:** TypeScript (Node >= 23.10, native strip-types, no build step)
- **Test:** `npm test` (vitest, 10s timeout)
- **Typecheck:** `npm run typecheck`
- **Lint:** None configured yet (follow existing code style)

## Architecture

- `src/core/` — shared infrastructure (DB, types, access control, messages)
- `src/transport/` — Baileys connection management
- `src/mcp/` — MCP tool registry, socket server, tool implementations
- `src/runtimes/agent/` — Claude Code agent subprocess management
- `src/runtimes/chat/` — Direct LLM API chat (Chat Bot)
- `deploy/` — systemd units, hooks, proxy scripts

## Key Concepts

- **conversation_key** — canonical chat identity, stable across JID aliasing (@s.whatsapp.net vs @lid). All reads query on this. Raw `chat_jid` is kept for sends only.
- **ToolRegistry** — in-process MCP tool declarations with scope enforcement (chat vs global)
- **SocketServer** — per-scope Unix sockets speaking MCP JSON-RPC. Chat-scoped sessions auto-inject deliveryJid; global sessions require explicit chatJid.
- **SessionContext** — per-socket state: tier (global/chat-scoped), conversationKey, deliveryJid

## Instance Model

Four independent processes via systemd template unit (`whatsoup@<name>.service`):
- `primary-line` — passive MCP-only line for manual oversight (tier: global, no auto-response)
- `operator-agent` — full-access autonomous agent (tier: global)
- `sandbox-agent` — sandboxed per-chat agent (tier: chat-scoped per workspace)
- `chat-bot` — chat API bot, no MCP, no agent

### Per-Instance Plugin Scoping

Each agent instance controls which Claude Code plugins it loads via `enabledPlugins` in `agentOptions` (config.json) and `.claude/settings.json` (project-level). Plugins disabled at the instance level are not loaded into the session, saving context.

Key files:
- `src/core/settings-template.ts` — default permissions and plugin templates
- `src/core/workspace.ts` — `writePermissionsSettings()`, `ensurePermissionsSettings()`
- `src/fleet/routes/ops.ts` — PATCH handler writes enabledPlugins to both config.json and .claude/settings.json

## Conventions

- ESM throughout, no CommonJS
- Zod for runtime validation
- Pino for structured logging
- Real SQLite in tests (`:memory:` or temp files), real Unix sockets where needed
- Tests mirror source structure under `tests/`
- Run tests with `--pool=forks` for stability: `npx vitest run --pool=forks`

## Documentation

- `docs/configuration.md` — environment variables, instance.json schema, XDG paths, **per-instance plugin scoping**
- `docs/tools.md` — complete MCP tool API reference (161 tools across 20 modules; 160 always-registered + 1 conditionally-registered)
- `docs/runbook.md` — operational runbook (service management, troubleshooting, recovery)
- `docs/durability.md` — durability engine design, state machines, recovery algorithms
- `docs/security-handoffs/` — open security handoffs that belong to the WhatSoup application lifecycle
