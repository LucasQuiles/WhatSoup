# WhatSoup

A multi-instance WhatsApp platform that runs three fundamentally different runtimes — passive listener, conversational chatbot, and autonomous AI agent — behind one Baileys v7 connection per line. Ships with a fleet management console for provisioning, monitoring, and operating all instances from a single dashboard.

One process per instance. One SQLite database per instance. 127 MCP tools. No build step. Probably too many MCP tools.

## What It Does

Each WhatsApp number gets its own isolated process with its own runtime mode:

| Mode | What Happens | Use Case |
|------|-------------|----------|
| **passive** | Stores messages. Does nothing else. Manual read/reply via MCP tools. | Personal number — just want the data accessible |
| **chat** | Calls an LLM API (Anthropic/OpenAI) with optional RAG via Pinecone. Stateless request-response. | Customer support bot, Q&A assistant |
| **agent** | Spawns a Claude Code SDK subprocess with tool access, file I/O, and multi-turn sessions. | Autonomous task execution, research, project work |

These are not configuration flags on one bot. They are different codepaths with different message flows, different dependencies, and different failure modes. Treating them as settings on the same runtime was the mistake the previous two repos made.

## Fleet Console

A React 19 dashboard for managing the entire fleet from a browser. Built with TypeScript, Tailwind CSS v4, React Query, and Recharts. Runs on the same port as the fleet server (production) or via Vite dev proxy (development).

### Fleet Overview

KPI cards with sparklines, three fleet-wide charts (message volume, token usage by provider, session activity by provider), instance table with sorting/filtering, and live activity feed with provider badges.

![Fleet Overview](docs/screenshots/fleet-overview.png)

### Line Detail — Metrics

Per-instance metrics with stacked bar chart, active hours heatmap (7-day weekly pattern or 30-day per-date grid), and tabbed token/session detail views. Nine tabs: Summary, Mode, Pipeline, Access, History, Logs, Metrics, Scheduled, Groups.

![Line Detail Metrics](docs/screenshots/line-detail-metrics.png)

### Operations

Fleet status dashboard with health monitoring, restart/delete/re-link actions for unhealthy instances, and log viewer with level filtering.

![Operations](docs/screenshots/ops.png)

### Inbox

Unified message inbox with chat list, message bubbles, send/reply, contact management (save, allow, block), and mark-read support. Line picker for switching between instances.

![Inbox](docs/screenshots/inbox.png)

### Instance Lifecycle

| Action | Where | What It Does |
|--------|-------|--------------|
| **Add Line** | Wizard | 5-step flow: Identity → QR scan → Model → Config → Review |
| **Re-link** | LineDetail, Ops | Standalone QR modal for re-authenticating a disconnected instance |
| **Configure** | LineDetail | Edit model, access, prompt, and agent settings on stopped instances |
| **Mark Read** | Inbox | Mark conversations as read — zeroes unread count and syncs to WhatsApp |
| **Delete** | LineDetail, Ops | Full teardown with confirmation — stops process, disables unit, removes all data |

### Design System

60+ CSS custom properties in a Tailwind v4 `@theme` block. Type scale (`--text-xs` through `--text-2xl`) maps directly to `text-*` utility classes. 40+ ESLint rules enforce token usage — hardcoded colors, spacing, font sizes, and transitions are lint errors. Custom component classes (`c-card`, `c-btn`, `c-hover`, `c-border-*`) provide consistent surfaces with hover/transition behavior. Form resets and body styles are wrapped in `@layer base` so utility overrides work correctly.

### WebSocket Realtime

The fleet server broadcasts invalidation events over WebSocket. The console subscribes and automatically refetches stale data — no polling delay for messages, chat updates, log changes, access changes, or typing indicators. Falls back to polling when WebSocket is disconnected.

```bash
# Development
cd console && npm run dev          # Vite dev server with hot reload + API proxy

# Production build
cd console && npm run build        # Outputs to dist/, served by fleet server
```

## Requirements

### Host deployment (systemd / launchd)

- **Node.js >= 23.10** — native `--experimental-strip-types`, no transpilation (`node -v` to check)
- **Linux with systemd** — user units for process management (`systemctl --user`); enable lingering for headless servers: `loginctl enable-linger $USER`
- **GNOME Keyring** (`libsecret-tools`) or environment variables for API keys — `npm run setup` checks both
- **ffmpeg** — video frame extraction in chat mode (optional)

### Docker deployment

- **Docker** with Compose V2 (`docker compose version`)
- No Node.js, systemd, or keyring required — the image bundles everything

> **Pinned dependencies:** Due to the increase in recent supply chain attacks, all dependency versions in `package.json` are pinned to exact versions known to be safe at time of release. This minimizes the risk of compromised packages being pulled in by WhatSoup. If you choose to unpin or update these, do so at your own risk and with due diligence. Pinned versions will be updated in future releases with known good sources.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/LucasQuiles/WhatSoup.git
cd WhatSoup
npm install

# 2. Run setup (installs systemd unit, wrapper scripts, builds console)
npm run setup

# 3. Start the fleet server
npm run fleet

# 4. Open http://localhost:9099 and create your first instance
#    Click "Add Line" → choose a type → scan the QR code with WhatsApp
```

The setup script installs the systemd template unit, symlinks the wrapper script to `~/.local/bin`, builds the console, and checks for API keys in your keyring. After setup, `npm run fleet` is the only command you need — everything else is managed from the browser.

### Docker Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/LucasQuiles/WhatSoup.git
cd WhatSoup
cp .env.example .env
# Edit .env — set API keys, WHATSOUP_INSTANCES, WHATSOUP_HEALTH_TOKEN

# 2. Build and start
docker compose up -d --build

# 3. Open http://localhost:9099 and create your first instance
#    Click "Add Line" → choose a type → scan the QR code with WhatsApp
```

The Docker image runs fleet + instances in a single supervisor container. Auth credentials, databases, and logs persist in named volumes (`config`, `data`, `state`). See [docs/configuration.md](docs/configuration.md) for environment variables and [docs/runbook.md](docs/runbook.md) for Docker operations.

For development:

```bash
npm run typecheck         # tsc --noEmit
npm test                  # ~3900 tests, ~23s, real SQLite, no mocks
cd console && npm run dev # Vite dev server with hot reload + API proxy
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
  fleet/          Fleet management server — discovery, health polling, API routes, WebSocket
    routes/       REST API handlers (lines, ops, data, feed, metrics)
    discovery.ts  Config-dir scanner, instance registry
    health-poller.ts  5-second health probe per instance
    realtime-event-poller.ts  2-second snapshot-diff for WebSocket invalidation
    websocket-server.ts  WS broadcast for realtime console updates
    static.ts     SPA serving with token injection
  lib/            Shared utilities — HTTP helpers, text utils, validation
  config.ts       Instance-aware config from JSON + env vars
  logger.ts       Pino structured logging with daily rotation
  main.ts         Bootstrap, lifecycle, health server

console/
  src/
    components/   30+ React components (modals, cards, badges, charts, forms, wizards)
    pages/        4 pages (SoupKitchen, Ops, Inbox, LineDetail)
    hooks/        React Query data hooks, WebSocket realtime, toast system
    lib/          API client with mock fallback, chart utils, formatting
    index.css     Design system — @theme tokens, @layer base/utilities, component classes

deploy/
  whatsoup@.service   systemd template unit (one per instance)
  hooks/              Agent sandbox enforcement
```

## Fleet API

The fleet server exposes a REST API on `127.0.0.1:9099` with Bearer token auth.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/lines` | List all instances with health status |
| `GET` | `/api/lines/:name` | Detailed instance view with config |
| `POST` | `/api/lines` | Create a new instance |
| `DELETE` | `/api/lines/:name` | Delete an instance (stop + cleanup) |
| `PATCH` | `/api/lines/:name/config` | Update instance configuration |
| `GET` | `/api/lines/:name/auth` | SSE stream for QR code authentication |
| `POST` | `/api/lines/:name/restart` | Restart systemd unit |
| `POST` | `/api/lines/:name/stop` | Stop systemd unit |
| `POST` | `/api/lines/:name/send` | Send a message through the instance |
| `POST` | `/api/lines/:name/access` | Update access control |
| `POST` | `/api/lines/:name/mark-read` | Mark a conversation as read |
| `POST` | `/api/lines/:name/contacts` | Save a contact |
| `GET` | `/api/lines/:name/chats` | List chats for an instance |
| `GET` | `/api/lines/:name/messages` | Fetch messages for a chat |
| `GET` | `/api/lines/:name/metrics` | Per-instance metrics (24h, 7d, 30d) |
| `GET` | `/api/lines/:name/access` | View access control list |
| `GET` | `/api/lines/:name/logs` | View instance logs |
| `GET` | `/api/metrics` | Fleet-wide aggregated metrics |
| `GET` | `/api/feed` | Activity feed (all instances) |
| `GET` | `/api/typing` | Currently typing indicators |

The fleet token is stored at `~/.config/whatsoup/fleet-token` (auto-generated on first run).

`POST /api/lines/:name/send` accepts exactly one target: raw `chatJid` or alias `to`. Aliases resolve through that instance's private `chatAliases` config and `chat_aliases` table. Requests may also pass a named send `profile`.

## Instance Model

Each instance is an independent systemd service with isolated auth, database, logs, and config:

```
~/.config/whatsoup/instances/<name>/config.json    # what mode, what model, what access
~/.config/whatsoup/instances/<name>/auth/           # WhatsApp Baileys credentials
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
  "adminPhones": ["15555550100"],
  "chatAliases": { "ops": "GROUP_JID@g.us" },
  "profiles": { "notify": { "prefix": "[notify] " } },
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

**Realtime event poller** — Snapshot-diff engine running every 2 seconds. Tracks per-instance markers (latest message PK, access list changes, log file mtime) and emits WebSocket invalidation events only when something changes. Log file tracking uses a cached-path optimization — steady-state polls do a single `statSync` instead of scanning the log directory.

**linkedStatus** — Each instance in the fleet API includes `linkedStatus: 'linked' | 'unlinked'` based on whether Baileys auth credentials exist. Unlinked instances show a "Re-link" button instead of "Restart" since they need QR authentication before they can run.

## Health & Monitoring

Each instance runs an HTTP health server:

```bash
curl http://127.0.0.1:9093/health
```

Returns connection status, uptime, message counts, enrichment state, durability stats, and model configuration. The health port is configurable per instance.

The health server also exposes operational endpoints: `/send` (send messages), `/access` (allow/block contacts), `/mark-read` (mark chats as read), `/heal` (inject repair reports), `/agent/compact` (agent-only silent context compaction), and `/typing` (composing indicators).

The fleet server's health poller probes each instance every 5 seconds and tracks consecutive failures to determine status: `online` → `degraded` (1-2 failures) → `unreachable` (3+). The console displays this as a color-coded heartbeat strip.

## Testing

```bash
npm test              # ~3900 tests, ~23s
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit
```

Tests use real SQLite (`:memory:` or temp files) and real Unix sockets. No infrastructure mocks. If the test passes, it works. If it doesn't, the mock was lying to you — which is why there aren't any.

Coverage includes: ingest backpressure (semaphore + overflow queue), relay guardrails (config gate + payload size cap), mark-read API (health handler + fleet proxy), realtime event poller (log mtime tracking, snapshot-diff), and design system compliance (14 regression tests + 40+ ESLint rules).

## Documentation

| Document | Description |
|----------|-------------|
| [Console Guide](docs/console-guide.md) | Full walkthrough of every console page, tab, and feature |
| [Configuration Reference](docs/configuration.md) | Full config schema, env vars, worked examples, per-instance chat aliases, send profiles, and **per-instance plugin scoping** |
| [MCP Tool Reference](docs/tools.md) | All 140 tools with scopes, parameters, replay policies |
| [Runbook](docs/runbook.md) | Operational procedures and troubleshooting |
| [Durability Design](docs/durability.md) | Durability engine design, state machines, recovery algorithms |

## License

MIT
