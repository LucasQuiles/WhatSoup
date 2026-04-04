# WhatSoup Configuration Reference

WhatSoup is configured through two complementary mechanisms: environment variables for
infrastructure-level settings, and per-instance `instance.json` files for runtime behavior.
In multi-instance mode, `instance.json` values take precedence over environment variables.
Both take precedence over hardcoded defaults.

**Resolution order:** `instance.json` > environment variable > hardcoded default

---

## Environment Variables

### API Keys (required for chat and audio transcription)

| Variable | Type | Description |
|----------|------|-------------|
| `ANTHROPIC_API_KEY` | string | Anthropic API key. Required for `chat` instances. **Not set** for `agent`/`passive` instances — the wrapper script explicitly unsets it so Claude Code uses Max/Pro subscription billing instead. |
| `OPENAI_API_KEY` | string | OpenAI API key. Required for audio transcription (Whisper) in `agent` instances, and for LLM fallback in `chat` instances. |
| `PINECONE_API_KEY` | string | Pinecone API key. Required for `chat` instances that use the memory/entity search pipeline. |

These three keys are loaded from GNOME Keyring by the `whatsoup` wrapper script and exported
before the process starts. They are never written to disk.

### Models

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CONVERSATION_MODEL` | string | `claude-opus-4-6` | Primary model for response generation. |
| `EXTRACTION_MODEL` | string | `claude-sonnet-4-6` | Model for memory extraction and enrichment. |
| `VALIDATION_MODEL` | string | `claude-haiku-4-5` | Model for validation and lightweight classification. |
| `FALLBACK_MODEL` | string | `gpt-5.4` | OpenAI fallback when the primary model is unavailable. |

All four can be overridden per-instance via `instance.json` `models` object.

### Conversation

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MAX_TOKENS` | integer | `750` | Maximum tokens in a single LLM response. Parsed by `intEnv()` — invalid values fall back to the default. |
| `RATE_LIMIT_PER_HOUR` | integer | `45` | Maximum messages per user per hour (chat runtime). |

### Access Control

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ADMIN_PHONES` | string | (empty) | Comma-separated list of phone numbers with admin access. Used only in single-instance mode; `instance.json` `adminPhones` takes over in multi-instance mode. Example: `15555550100,15555550101`. |

### Storage Paths (single-instance / legacy mode only)

These have no effect when `INSTANCE_CONFIG` is set (multi-instance mode).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WHATSOUP_CONFIG_DIR` | path | `$XDG_CONFIG_HOME/whatsoup` | Override the config root directory. |
| `WHATSOUP_DATA_DIR` | path | `$XDG_DATA_HOME/whatsoup` | Override the data root directory. |
| `WHATSOUP_STATE_DIR` | path | `$XDG_STATE_HOME/whatsoup` | Override the state root directory. |
| `XDG_CONFIG_HOME` | path | `~/.config` | XDG config base. |
| `XDG_DATA_HOME` | path | `~/.local/share` | XDG data base. |
| `XDG_STATE_HOME` | path | `~/.local/state` | XDG state base. |

### Pinecone

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PINECONE_INDEX` | string | `whatsapp-bot` | Pinecone index name for the memory pipeline. When this equals `whatsapp-bot` (the default), `pineconeSearchMode` defaults to `memory`; any other index defaults to `entity`. |

### Health Server

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `HEALTH_PORT` | integer | `9090` | Port for the HTTP health server (`GET /health`, `POST /send`). Listens on `127.0.0.1` only. |
| `WHATSOUP_HEALTH_TOKEN` | string | (empty) | Bearer token for `POST /send`. Requests without a matching `Authorization: Bearer <token>` header receive `401`. If unset, `POST /send` always returns `401`. |

### Logging

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `LOG_LEVEL` | string | `info` | Pino log level. Valid values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `LOG_DIR` | path | `<dataRoot>/logs` | Set automatically by `config.ts` from the resolved data root. Set before `logger.ts` initializes. Enables pino-roll daily file rotation when present. |

### Internal / Bootstrap

| Variable | Type | Description |
|----------|------|-------------|
| `INSTANCE_CONFIG` | JSON string | Serialized instance config injected by `instance-loader.ts`. Contains the full parsed and validated `instance.json` plus resolved `paths`. **Not set manually** — managed by the bootstrap process. |

---

## Instance Configuration (instance.json)

Each instance is a JSON file at:

```
$XDG_CONFIG_HOME/whatsoup/instances/<name>/config.json
```

Default XDG path: `~/.config/whatsoup/instances/<name>/config.json`

The `instances/` directory in the repo contains working examples that are symlinked or copied
into place during deployment.

### Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Instance name. Must match the directory name. Validated by the loader. |
| `type` | string | yes | — | Instance type: `chat`, `agent`, or `passive`. |
| `adminPhones` | string[] | yes | — | Non-empty array of phone numbers with admin access. All elements must be non-empty strings. |
| `accessMode` | string | yes | — | Who can interact with the bot. See [Access Modes](#access-modes). |
| `systemPrompt` | string | see rules | — | LLM system prompt. **Required** for `chat`. **Forbidden** for `passive`. Optional for `agent` (falls back to `DEFAULT_SYSTEM_PROMPT` in `config.ts`). |
| `models` | object | no | env/default | Model overrides. Keys: `conversation`, `extraction`, `validation`, `fallback`. Each takes a model ID string. |
| `pineconeIndex` | string | no | `whatsapp-bot` | Pinecone index name. Overrides `PINECONE_INDEX`. |
| `pineconeSearchMode` | string | no | auto | `memory` or `entity`. Auto-detected from index name if omitted: `whatsapp-bot` → `memory`, anything else → `entity`. |
| `pineconeRerank` | boolean | no | `false` | Enable client-side reranking via `pinecone-rerank-v0` for entity search. |
| `pineconeTopK` | integer | no | `20` | Number of candidates to fetch before reranking (entity search). |
| `pineconeRerankTopN` | integer | no | `6` | Number of results to keep after reranking. |
| `maxTokens` | integer | no | `750` | Max LLM response tokens. Overrides `MAX_TOKENS`. |
| `tokenBudget` | integer | no | `100000` | Total token budget (used by agent runtime). |
| `rateLimitPerHour` | integer | no | `45` | Per-user rate limit. Overrides `RATE_LIMIT_PER_HOUR`. |
| `healthPort` | integer | no | `9090` | Health server port. Overrides `HEALTH_PORT`. |
| `agentOptions` | object | agent only | — | Agent-specific settings. Required fields vary by `sessionScope`. See [agentOptions](#agentoptions). |

### Access Modes

| Value | Description |
|-------|-------------|
| `self_only` | Only `adminPhones` can interact. Required for `passive`; required for `agent` with `sessionScope: single` or no `agentOptions`. |
| `allowlist` | Only approved users (managed via MCP access-list tools) can interact. |
| `open_dm` | Any direct message is accepted. |
| `groups_only` | Only group chats are accepted. |

### `models` Object

```json
"models": {
  "conversation": "claude-sonnet-4-6",
  "extraction": "claude-haiku-4-5-20251001",
  "validation": "claude-haiku-4-5-20251001",
  "fallback": "gpt-5.4"
}
```

Omit any key to inherit the env var or hardcoded default for that slot.

### `agentOptions`

Required when `type` is `agent`. All sub-fields are validated by `instance-loader.ts`.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sessionScope` | string | yes | — | `single`, `shared`, or `per_chat`. See [Session Scopes](#session-scopes). |
| `cwd` | string | yes | — | Working directory for the Claude Code subprocess. Tilde is expanded (`~` → `$HOME`). |
| `instructionsPath` | string | no | — | Path to a CLAUDE.md-style instructions file, relative to `cwd`. |
| `sandboxPerChat` | boolean | no | `false` | Provision a separate workspace per chat. Requires `sessionScope: per_chat`. |
| `sandbox` | object | no | — | Sandbox constraints applied via Claude Code hooks. See [sandbox](#agentoptions-sandbox). |
| `mcp` | object | no | — | MCP feature flags for the agent subprocess (e.g., `{ "send_media": true }`). |
| `pluginDirs` | string[] | no | — | Additional plugin directories to pass via `--plugin-dir` to the Claude Code subprocess. |
| `enabledPlugins` | Record<string, boolean> | no | — | Per-instance plugin overrides. Keys are `plugin@marketplace` identifiers. `true` = enabled, `false` = disabled. Omitted keys inherit from global `~/.claude/settings.json`. Written to `<cwd>/.claude/settings.json` at startup. |

#### Session Scopes

| Value | Behavior | Access mode constraint |
|-------|----------|------------------------|
| `single` | One shared Claude Code session for all chats. | Must be `self_only`. |
| `shared` | One shared session, multiple users welcomed. | Any valid access mode. |
| `per_chat` | One isolated Claude Code session per chat. | Any valid access mode. |

#### `agentOptions.sandbox`

Passed directly to agent sandbox enforcement hooks (`deploy/hooks/agent-sandbox.sh`).

| Field | Type | Description |
|-------|------|-------------|
| `allowedPaths` | string[] | Filesystem paths the agent may read/write. |
| `allowedTools` | string[] | Claude Code tools the agent may use. Empty array blocks all non-essential tools. |
| `allowedMcpTools` | string[] | MCP tools permitted within the sandbox. |
| `bash` | object | Bash execution policy: `{ "enabled": boolean, "pathRestricted": boolean }`. |

#### `agentOptions.enabledPlugins`

Controls which Claude Code plugins are loaded for this instance's sessions. Each key is a plugin identifier in `plugin@marketplace` format. Set to `false` to disable a plugin that would otherwise be inherited from the global `~/.claude/settings.json`.

```json
"enabledPlugins": {
  "sdlc-os@sdlc-os-dev": false,
  "tmup@tmup-dev": false,
  "superpowers@superpowers-marketplace": true,
  "episodic-memory@superpowers-marketplace": true
}
```

**Behavior:**
- Keys set to `false` override the global setting and disable the plugin for this instance.
- Keys set to `true` explicitly enable the plugin (redundant if already globally enabled, but documents intent).
- Keys omitted entirely inherit from the global `enabledPlugins` in `~/.claude/settings.json`.
- An empty object `{}` or `null` resets to full global inheritance.
- This value is written to `<cwd>/.claude/settings.json` during instance startup and via the PATCH API.

**Context impact:** Plugin agents are eagerly loaded into the system prompt. Disabling heavy plugins like `sdlc-os` (45 agents, ~66K tokens) significantly reduces per-session context overhead.

### Validation Rules Summary

The loader enforces these constraints before the process starts:

- `name` must match the directory name.
- `type` must be `chat`, `agent`, or `passive`.
- `accessMode` must be one of the four valid values.
- `adminPhones` must be a non-empty array of non-empty strings.
- `chat` instances must have a non-empty `systemPrompt`.
- `passive` instances must not have a `systemPrompt` and must use `accessMode: self_only`.
- `agent` instances without `agentOptions` must use `accessMode: self_only`.
- `agent` instances with `agentOptions` must have a valid `sessionScope` and non-empty `cwd`.
- `agentOptions.sandboxPerChat: true` requires `sessionScope: per_chat`.
- `agent` with `sessionScope: single` must use `accessMode: self_only`.

---

## XDG Directory Layout

In multi-instance mode, each instance gets isolated directories under the standard XDG tree.

```
$XDG_CONFIG_HOME/whatsoup/instances/<name>/   (default: ~/.config/...)
  config.json       — instance.json (the file you edit)
  auth/             — Baileys WhatsApp auth credentials

$XDG_DATA_HOME/whatsoup/instances/<name>/     (default: ~/.local/share/...)
  bot.db            — SQLite database (messages, contacts, access list, sessions)
  logs/             — Pino log files (daily rotation via pino-roll)
  media/tmp/        — Temporary media files for agent Read access

$XDG_STATE_HOME/whatsoup/instances/<name>/    (default: ~/.local/state/...)
  whatsoup.lock     — PID lock file (prevents double-start)
```

The loader creates all directories on startup with mode `0700`.

---

## Worked Examples

### Agent — per-chat, sandboxed (`sandbox-agent`)

A sandboxed agent available to an allowlist of friends. Each chat gets its own Claude Code
workspace under `~/workspace/sandbox-agent`. Bash is permitted but path-restricted.

```json
{
  "name": "sandbox-agent",
  "type": "agent",
  "accessMode": "allowlist",
  "adminPhones": ["15555550100"],
  "healthPort": 9091,
  "agentOptions": {
    "cwd": "~/workspace/sandbox-agent",
    "instructionsPath": "CLAUDE.md",
    "sessionScope": "per_chat",
    "sandboxPerChat": true,
    "sandbox": {
      "allowedPaths": ["~/workspace/sandbox-agent"],
      "allowedTools": [],
      "bash": { "enabled": true, "pathRestricted": true }
    },
    "mcp": {
      "send_media": true
    }
  }
}
```

### Agent — per-chat, open (`operator-agent`)

A full-access agent on an operator-managed line. No sandbox. Two admin phones. Each chat
gets its own session scoped to `~`.

```json
{
  "name": "operator-agent",
  "type": "agent",
  "adminPhones": ["15555550100", "15555550101"],
  "accessMode": "allowlist",
  "healthPort": 9092,
  "agentOptions": {
    "sessionScope": "per_chat",
    "cwd": "~"
  }
}
```

### Chat — entity search with Pinecone reranking (`chat-bot`)

A direct LLM API bot backed by an external Pinecone index. Uses `entity` search mode with
client-side reranking. Accepts DMs from anyone. Custom models reduce cost; `systemPrompt` is
required.

```json
{
  "name": "chat-bot",
  "type": "chat",
  "systemPrompt": "You are Chat Bot, a helpful assistant for your team...",
  "models": {
    "conversation": "claude-sonnet-4-6",
    "extraction": "claude-haiku-4-5-20251001",
    "validation": "claude-haiku-4-5-20251001"
  },
  "pineconeIndex": "team-search",
  "pineconeSearchMode": "entity",
  "pineconeRerank": true,
  "pineconeTopK": 20,
  "pineconeRerankTopN": 6,
  "maxTokens": 500,
  "tokenBudget": 50000,
  "rateLimitPerHour": 60,
  "adminPhones": ["15555550100", "15555550101"],
  "accessMode": "open_dm",
  "healthPort": 9093
}
```

### Passive — MCP-only

A passive instance exposes all 117 MCP tools over Unix sockets but never sends automatic
replies. Used to give external agents read/write access to a WhatsApp account without any
bot persona.

```json
{
  "name": "passive-example",
  "type": "passive",
  "adminPhones": ["15555550100"],
  "accessMode": "self_only",
  "healthPort": 9094
}
```

`passive` instances have no `systemPrompt` and are restricted to `self_only` access. No
`ANTHROPIC_API_KEY` or `PINECONE_API_KEY` is needed.

---

## Database Migration History

Migrations are applied automatically at startup by `src/core/database.ts`. Each migration is recorded in the `schema_migrations` table and is never re-applied.

| Version | Description |
|---------|-------------|
| 1 | Full schema DDL (messages, chats, contacts, access_list, rate_limits, etc.) |
| 2 | Durability tables (durability_queue, recovery_log) |
| 3 | Chat sync tables (Wave 2) |
| 4 | Labels tables (Wave 6) |
| 5 | `raw_message` column on messages for `forward_message` support |
| 6 | Blocklist and LID mapping persistence |
| 7 | `groups` table for group metadata persistence |
| 9 | `decryption_failures` table |
| 10 | Self-healing control plane tables |
| 11 | Token usage tracking: `input_tokens` + `output_tokens` on `messages`; `total_input_tokens` + `total_output_tokens` on `agent_sessions`. Uses `ALTER TABLE ... ADD COLUMN` with existence checks (idempotent). Chat runtime persists tokens per LLM response; agent runtime captures them from Claude Code stream result events. |

---

## Fleet API — Instance Fields from Config

The `GET /api/lines` and `GET /api/lines/:name` endpoints expose two config fields not present in the `/health` response:

| Field | Source | Description |
|-------|--------|-------------|
| `models` | `instance.json` → `models` object | Model overrides (conversation/extraction/validation/fallback), or `null` if not set in config. |
| `sandboxPerChat` | `instance.json` → `agentOptions.sandboxPerChat` | `true` when per-chat workspace provisioning is active; `false` otherwise. |

These are read-only in the API and used by the console (`LineTags` component) to display sandbox and fallback badges on fleet rows.

Additional fleet-only fields computed by the control-plane with a 60s cache:

| Field | Type | Description |
|-------|------|-------------|
| `chatCounts` | `{ chats: number, groups: number }` | Distinct DM and group conversation counts from the messages table. |
| `tokenUsage` | `{ input: number, output: number }` | Lifetime token totals summed from `messages.input_tokens`/`output_tokens` (chat runtime) and `agent_sessions.total_input_tokens`/`total_output_tokens` (agent runtime). Requires Migration 11. |
| `totalSessions` | `number` | Lifetime agent session count from `agent_sessions` table. Agent instances only; `0` for chat/passive. |

---

## API Key Setup (GNOME Keyring)

The `whatsoup` wrapper script loads API keys from GNOME Keyring at startup. Store them once:

```bash
# Chat and Pinecone keys (needed by chat instances)
secret-tool store --label='anthropic' service anthropic <<< 'sk-ant-...'
secret-tool store --label='openai'    service openai    <<< 'sk-...'
secret-tool store --label='pinecone'  service pinecone  <<< 'pcsk_...'
```

Agent and passive instances only need `openai` (for Whisper audio transcription). If the key
is absent, voice note transcription silently degrades — the agent receives the file path
instead of transcribed text.
