# WhatSoup Configuration Reference

WhatSoup is configured through two complementary mechanisms: environment variables for
infrastructure-level settings, and per-instance `config.json` files for runtime behavior.
In multi-instance mode, `config.json` values take precedence over environment variables.
Both take precedence over built-in defaults.

**Resolution order:** canonical `memory.*` in `config.json` > legacy flat aliases in `config.json` > environment variable > built-in default

---

## Environment Variables

### API Keys (required for chat and audio transcription)

| Variable | Type | Description |
|----------|------|-------------|
| `ANTHROPIC_API_KEY` | string | Anthropic API key. Required for `chat` instances — the `whatsoup` launcher hard-fails on startup if missing (`deploy/whatsoup:101`). **Not set** for `agent`/`passive` instances — the wrapper script explicitly unsets it so the agent runtime uses its subscription billing path instead of the API. |
| `OPENAI_API_KEY` | string | OpenAI API key. **Required for `chat` instances** — the launcher hard-fails on startup if missing (`deploy/whatsoup:102`). Used for transcription fallbacks (`src/runtimes/chat/providers/openai-whisper.ts`) and the LLM retry path (`src/runtimes/chat/runtime.ts:318,362`). For `agent` instances it is soft-optional (used for Whisper voice-note transcription when present); `passive` instances do not call any LLM APIs. |
| `PINECONE_API_KEY` | string | Default Pinecone API key env var. Instances can point at a different BYOK env var with `memory.pinecone.apiKeyEnv`. **Required for `chat` instances** — the launcher hard-fails on startup if missing (`deploy/whatsoup:103`), and `loadContext` is invoked per inbound message (`src/runtimes/chat/runtime.ts:201`) so a missing key burns the 5s timeout on every message. Soft-optional for `agent` instances (needed only when the instance declares `pineconeAllowedIndexes` for the `knowledge_search` MCP tool). |

These three keys are loaded from GNOME Keyring by the `whatsoup` wrapper script and exported
before the process starts. They are never written to disk.

> **Instance-type summary:** `chat` instances require **all three** keys (Anthropic, OpenAI, Pinecone) — startup aborts otherwise. `agent` instances require none at the launcher level; OpenAI and Pinecone are loaded best-effort and used only when the corresponding feature is exercised. `passive` instances require none.

### Models

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CONVERSATION_MODEL` | string | `claude-opus-4-6` | Primary model for response generation. |
| `EXTRACTION_MODEL` | string | `claude-sonnet-4-6` | Model for memory extraction and enrichment. |
| `VALIDATION_MODEL` | string | `claude-haiku-4-5` | Model for validation and lightweight classification. |
| `FALLBACK_MODEL` | string | `gpt-5.4` | OpenAI fallback when the primary model is unavailable. |

All four can be overridden per-instance via `config.json` `models` object.

### Conversation

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MAX_TOKENS` | integer | `750` | Maximum tokens in a single LLM response. Parsed by `intEnv()` — invalid values fall back to the default. |
| `RATE_LIMIT_PER_HOUR` | integer | `45` | Maximum messages per user per hour (chat runtime). |

### Access Control

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ADMIN_PHONES` | string | (empty) | Comma-separated list of phone numbers with admin access. Used only in single-instance mode; `config.json` `adminPhones` takes over in multi-instance mode. Example: `15555550100,15555550101`. |

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
| `PINECONE_PROJECT_ID` | string | unset | Optional project guard. When set, readiness and knowledge search verify that the resolved index host belongs to this project ID. |
| `PINECONE_EXPECTED_HOST_SUFFIX` | string | unset | Optional stricter project guard, for example `-nf9hzvy.svc.aped-4627-b74a.pinecone.io`. |
| `MW_MIND_EMBED_URL` | string | `http://127.0.0.1:8799/embed` | Default local embed endpoint for vector knowledge profiles that do not override `embedUrl`. |
| `RECENCY_HALF_LIFE_DAYS` | integer | `14` | Positive day-count half-life for memory-search recency decay. Smaller values forget faster; zero/negative/malformed values fall back to `14`. |
| `MAX_AGE_DAYS` | integer | `90` | Positive day-count cutoff for memory search; records older than this are filtered out. Zero/negative/malformed values fall back to `90`. |

### Health Server

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `HEALTH_PORT` | integer | `9090` | Port for the HTTP health server (`GET /health`, `POST /send`, `POST /agent/compact`). |
| `HEALTH_BIND_ADDRESS` | string | `127.0.0.1` | Bind address for the health server. Set to `0.0.0.0` in Docker to allow host-exposed health checks. |
| `WHATSOUP_HEALTH_TOKEN` | string | (empty) | Bearer token for health-server mutation endpoints such as `POST /send`, `POST /access`, `POST /mark-read`, `POST /heal`, and `POST /agent/compact`. Requests without a matching `Authorization: Bearer <token>` header receive `401`. If unset, mutation endpoints fail closed with `401`. |

#### Agent compact endpoint

Agent instances expose `POST /agent/compact` for control-plane compaction that does not pass through WhatsApp ingest. This avoids the group-chat failure mode where bare `/compact` is ignored because the bot was not mentioned, while tagged `/compact` reaches the agent as ordinary text.

```bash
curl -sS -X POST "http://127.0.0.1:<healthPort>/agent/compact" \
  -H "Authorization: Bearer $WHATSOUP_HEALTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chatJid":"GROUP_JID@g.us"}'
```

`chatJid` is required for per-chat and shared session agents so the runtime compacts the intended session and routes the completion event correctly. Agents using one session can omit it only when an active chat is already known. `silent` defaults to `true`, suppressing the normal user-facing compact notice and any command output. Set `"silent": false` only for operator diagnostics.

### Logging

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `LOG_LEVEL` | string | `info` | Pino log level. Valid values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `LOG_DIR` | path | `<dataRoot>/logs` | Set automatically by `config.ts` from the resolved data root. Set before `logger.ts` initializes. Enables pino-roll daily file rotation when present. |

### Docker

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WHATSOUP_DOCKER` | string | (unset) | Set to `1` to enable Docker platform detection. The Dockerfile sets this automatically. |
| `WHATSOUP_MODE` | string | `supervisor` | Entrypoint mode: `supervisor` (fleet + instances), `fleet` (fleet only), `instance` (single instance), `auth` (QR code pairing). |
| `WHATSOUP_INSTANCES` | string | (empty) | Comma-separated instance names to start in supervisor mode. Example: `my-bot,chat-bot`. |
| `FLEET_BIND_ADDRESS` | string | `127.0.0.1` | Bind address for the fleet server. Set to `0.0.0.0` in Docker. |

### Docker Volume Layout

The container uses XDG base directories under `/home/whatsoup/`:

| Volume | Container path | Contents |
|--------|---------------|----------|
| `config` | `/home/whatsoup/.config/whatsoup` | Instance configs, auth credentials, fleet token |
| `data` | `/home/whatsoup/.local/share/whatsoup` | SQLite databases, logs, media cache |
| `state` | `/home/whatsoup/.local/state/whatsoup` | Lock files (ephemeral) |

The `config` volume is critical — losing it requires re-scanning the QR code for each instance.

### Internal / Bootstrap

| Variable | Type | Description |
|----------|------|-------------|
| `INSTANCE_CONFIG` | JSON string | Serialized instance config injected by `instance-loader.ts`. Contains the full parsed and validated `config.json` plus resolved `paths`. **Not set manually** — managed by the bootstrap process. |

---

## Instance Configuration (config.json)

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
| `enabled` | boolean | no | `true` | Fleet opt-out switch. Set to `false` to keep the config on disk while taking the instance out of fleet rotation — discovery skips it, ops routes ignore its `healthPort`, and no polling or proxying occurs. Any other value (including absent) leaves the instance enabled. See note below.[^enabled] |
| `name` | string | yes | — | Instance name. Must match the directory name. Validated by the loader. |
| `type` | string | yes | — | Instance type: `chat`, `agent`, or `passive`. |
| `adminPhones` | string[] | yes | — | Non-empty array of phone numbers with admin access. All elements must be non-empty strings. |
| `accessMode` | string | yes | — | Who can interact with the bot. See [Access Modes](#access-modes). |
| `systemPrompt` | string | see rules | — | LLM system prompt. **Required** for `chat`. **Forbidden** for `passive`. Optional for `agent` (falls back to `DEFAULT_SYSTEM_PROMPT` in `config.ts`). |
| `models` | object | no | env/default | Model overrides. Keys: `conversation`, `extraction`, `validation`, `fallback`. Each takes a model ID string. |
| `memory` | object | no | defaults | Canonical BYOK memory/search config. Use this for all new configs. See [`memory`](#memory). |
| `pineconeIndex` | string | no | `whatsapp-bot` | Legacy alias for `memory.pinecone.index`. Runtime still reads it; fleet writes and the migrator convert it to `memory.*`. |
| `pineconeSearchMode` | string | no | auto | Legacy alias for `memory.pinecone.searchMode`. |
| `pineconeRerank` | boolean | no | `false` | Legacy alias for `memory.pinecone.rerank`. |
| `pineconeTopK` | integer | no | `20` | Legacy alias for `memory.pinecone.topK`. |
| `pineconeRerankTopN` | integer | no | `6` | Legacy alias for `memory.pinecone.rerankTopN`. |
| `pineconeAllowedIndexes` | string[] | no | `[]` | Legacy alias for `memory.pinecone.allowedIndexes`. |
| `maxTokens` | integer | no | `750` | Max LLM response tokens. Overrides `MAX_TOKENS`. |
| `tokenBudget` | integer | no | `100000` | Total token budget (used by agent runtime). |
| `rateLimitPerHour` | integer | no | `45` | Per-user rate limit. Overrides `RATE_LIMIT_PER_HOUR`. |
| `healthPort` | integer | no | `9090` | Health server port. Overrides `HEALTH_PORT`. |
| `siblingPhones` | string[] | no | `[]` | Phone numbers of other WhatSoup instances that share groups with this instance. Messages from siblings are silently ignored in groups to prevent infinite echo loops between co-located bots. Normalized to E.164 on load. |
| `chatAliases` | object | no | `{}` | Per-instance alias map used by send surfaces. Keys are aliases such as `ops` or `support`; values are raw WhatsApp JIDs. Seeded into the instance's `chat_aliases` table at startup. |
| `profiles` | object | no | `{}` | Per-instance send decoration policies. Keys are profile names; values can define `prefix`, `tag`, and `linkPreview`. Loaded from private instance config at startup. |
| `toolUpdateMode` | string | no | `full` | Controls what the user sees during agent tool execution. `full`: elapsed time and technical details. `friendly`: plain-language status, one-time per tool. `minimal`: typing indicator only, brief text for warnings. |
| `operationTracker` | object | no | see defaults | Per-tool progress reporting and stall detection. All sub-fields optional; unset fields use platform defaults. See [operationTracker](#operationtracker). |
| `agentOptions` | object | agent only | — | Agent-specific settings. Required fields vary by `sessionScope`. See [agentOptions](#agentoptions). |

[^enabled]: Enforcement sites: [`src/fleet/discovery.ts:94`](../src/fleet/discovery.ts) (fleet scan skip), [`src/fleet/routes/ops.ts:767`](../src/fleet/routes/ops.ts) (port-in-use scan), [`src/fleet/routes/ops.ts:788`](../src/fleet/routes/ops.ts) (existing-port map for PATCH conflict checks).

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

Omit any key to inherit the env var or built-in default for that slot.

### `chatAliases`

`chatAliases` is the per-instance alias seed for outbound sends. It lets fleet HTTP callers and global MCP `send_message` callers use a stable alias with `to` instead of embedding raw WhatsApp JIDs in scripts.

```json
"chatAliases": {
  "ops": "GROUP_JID@g.us",
  "support": "USER_JID@s.whatsapp.net"
}
```

Each instance has its own SQLite database, so alias scope is the instance. The same alias name may intentionally point to different chats in different instance configs. On startup, WhatSoup upserts the configured aliases into the instance's `chat_aliases` table and only updates rows whose target JID changed.

Validation rules:

- `chatAliases` must be an object.
- Alias keys are trimmed and must be non-empty.
- Target values are trimmed and must be non-empty strings.
- Duplicate aliases after trimming are rejected.

These values often contain private phone or group JIDs. Keep instance `config.json` files private; repo-local `instances/*/config.json` is ignored by git.

### `profiles`

`profiles` is the per-instance send profile registry. Fleet HTTP callers and global MCP `send_message` callers can pass `profile` to apply a named text decoration policy at send time.

```json
"profiles": {
  "notify": {},
  "alert": {
    "prefix": "[ALERT] "
  },
  "monitor": {
    "tag": " #monitor"
  },
  "plain": {
    "linkPreview": "off"
  }
}
```

Profiles are scoped to one instance config. The same profile name may intentionally behave differently on different lines. They are loaded into memory at startup; there is no profile table or runtime mutation API.

Supported fields:

| Field | Type | Description |
|-------|------|-------------|
| `prefix` | string | Prepended exactly as configured before the request text. |
| `tag` | string | Appended exactly as configured after the request text. |
| `linkPreview` | `"auto"` or `"off"` | Default link-preview mode for requests using the profile. A request-level `link_preview` value overrides this. |

Validation rules:

- `profiles` must be an object of profile names to profile objects.
- Profile names are trimmed and must be non-empty.
- Each profile value must be an object.
- Unknown profile fields are rejected.
- `prefix` and `tag`, when present, must be strings.
- `linkPreview`, when present, must be `"auto"` or `"off"`.

Keep instance `config.json` files private. Profile names are safe to document, but profile text can contain operational labels or private routing conventions; repo-local `instances/*/config.json` is ignored by git.

### Outbound Send Audit

Outbound send auditing is automatic and has no `config.json` field. Migration 22 creates an `outbound_sends` table in each instance's SQLite database on startup.

The table is per instance. It records outbound send intent and outcome for MCP `send_message` and health `/send`, including the resolved raw chat JID, whether the request used a raw `chatJid` or alias `to`, the selected `profile` when present, SHA-256 hash of the final message text, text length, status, transport message id when available, and error text for failed sends.

Message bodies are not stored in `outbound_sends`. Retention is currently unbounded; prune manually after backup if local policy requires it.

### `memory`

`memory` is the canonical BYOK configuration block. It owns every memory/search setting that used to be spread across flat fields such as `pineconeIndex`, hardwired namespace literals, and code-level knowledge profiles.

Use `memory` for new installs and migrations. The runtime still accepts the old flat fields for compatibility, but the fleet API and `npm run migrate-memory-config` write the canonical shape.

```json
"memory": {
  "conversation": {
    "recent": 50,
    "extended": 100,
    "extendedWithinMs": 600000
  },
  "retention": {
    "days": 30
  },
  "enrichment": {
    "intervalMs": 60000,
    "batchSize": 200,
    "minConfidence": 0.7,
    "dedupThreshold": 0.95,
    "maxRetries": 3
  },
  "pinecone": {
    "apiKeyEnv": "PINECONE_API_KEY",
    "projectId": "nf9hzvy",
    "expectedHostSuffix": "-nf9hzvy.svc.aped-4627-b74a.pinecone.io",
    "index": "mw-mind",
    "namespaces": {
      "facts": "whatsapp-facts",
      "chunks": "whatsapp-chunks",
      "summaries": "whatsapp-summaries",
      "legacy": "whatsapp",
      "contacts": "whatsapp-contacts",
      "localDocs": "local-docs",
      "oneDrive": "onedrive"
    },
    "searchMode": "entity",
    "allowedIndexes": [],
    "knowledgeSearch": {
      "enabled": true,
      "allowGlobalAgentSessions": false
    }
  }
}
```

#### Pinecone BYOK Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory.pinecone.apiKeyEnv` | string | `PINECONE_API_KEY` | Name of the environment variable that holds this instance's Pinecone key. This is the BYOK boundary: the key is still injected by wrappers/keychains, but the instance decides which env var to read. |
| `memory.pinecone.projectId` | string | env/unset | Optional project ID guard. If the listed index host does not include this project ID, readiness returns `project_mismatch` and `knowledge_search` refuses to query. |
| `memory.pinecone.expectedHostSuffix` | string | env/unset | Optional exact host suffix guard. Use this when two projects have the same index name and you need fail-closed routing. |
| `memory.pinecone.index` | string | env/`whatsapp-bot` | Primary chat memory/entity index. |
| `memory.pinecone.namespaces` | object | WhatsApp defaults | Namespaces used by chat context, fact export, and `mw-mind` intent routing. Every namespace is configurable per instance. |
| `memory.pinecone.searchMode` | string | auto | `memory` for chat/sender/self-fact filters, `entity` for entity index search. Defaults from the index name. |
| `memory.pinecone.allowedIndexes` | string[] | `[]` | Indexes exposed through the agent `knowledge_search` MCP tool. Empty disables that tool. |
| `memory.pinecone.knowledgeSearch.enabled` | boolean | `true` | Global on/off switch for knowledge tool registration. Still requires `allowedIndexes`. |
| `memory.pinecone.knowledgeSearch.allowGlobalAgentSessions` | boolean | `false` | Allows `knowledge_search` in non-`sandboxPerChat` agent sessions. Default is fail-closed because global sessions can span callers. |
| `memory.pinecone.knowledgeProfiles` | object | built-in profiles | Per-index retrieval profile overrides. Configure namespace allowlists, rerank settings, vector/text/entity mode, and `embedUrl`. |

#### Legacy Migration

Dry-run all local instance configs:

```bash
npm run migrate-memory-config
```

Migrate one instance with a backup:

```bash
npm run migrate-memory-config -- --instance example-agent --write
```

The migrator only reads and writes `config.json`. It does not touch `tokens.env`, `auth/`, `bot.db`, provider keychains, or WhatsApp session credentials, so a successful config migration does not require a QR re-auth.

Field aliases migrated into `memory.*` include `pineconeIndex`, `pineconeAllowedIndexes`, `pineconeSearchMode`, `pineconeRerank`, `pineconeTopK`, `pineconeRerankTopN`, `pineconeNamespaces`, `pineconeFactsNamespace`, `pineconeChunksNamespace`, `pineconeSummariesNamespace`, `pineconeApiKeyEnv`, `pineconeProjectId`, `pineconeExpectedHostSuffix`, `conversationWindow`, `conversationWindowExtended`, `windowExtensionThresholdMs`, `retentionDays`, and enrichment tuning fields.

### `operationTracker`

Controls per-tool progress reporting, slow/stall detection, and automatic recovery for agent instances. When enabled (the default), the tracker monitors each tool invocation and thinking gap, sending progress updates to the user and triggering recovery actions when operations exceed their thresholds.

Set `"enabled": false` to disable the tracker entirely and fall back to the legacy watchdog-only behavior (30-minute hard timeout with no per-tool granularity).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable or disable the operation tracker. |
| `progressIntervalMs` | integer | `30000` | Interval (ms) between periodic progress updates sent to the user while a tool runs. |
| `thinkingLongMs` | integer | `45000` | Time (ms) without any event before a "still thinking" notification is sent. |
| `thinkingStallMs` | integer | `300000` | Time (ms) without any event before a liveness probe (newline to stdin) is triggered. |
| `toolThresholds` | object | see below | Per-tool-category timing thresholds. Keys are tool category names; values are `ToolThreshold` objects. |

#### Tool Thresholds

Each tool category has three timing parameters:

| Parameter | Description |
|-----------|-------------|
| `expectedMs` | Baseline expected duration for the tool. |
| `slowMultiplier` | After `expectedMs * slowMultiplier`, a "slow" warning is sent to the user. |
| `stallMultiplier` | After `expectedMs * stallMultiplier`, the tool is considered stalled and recovery is triggered (Ctrl+C to stdin). |

**Platform defaults:**

| Category | `expectedMs` | `slowMultiplier` | `stallMultiplier` | Slow at | Stall at |
|----------|-------------|-------------------|--------------------| --------|----------|
| `agent` | 120000 | 1.5 | 3 | 3 min | 6 min |
| `bash` | 15000 | 2 | 5 | 30s | 75s |
| `read` | 3000 | 3 | 10 | 9s | 30s |
| `edit` | 2000 | 3 | 10 | 6s | 20s |
| `web` | 10000 | 2 | 4 | 20s | 40s |
| `mcp` | 15000 | 2 | 5 | 30s | 75s |
| `skill` | 3000 | 3 | 10 | 9s | 30s |
| `default` | 10000 | 2 | 5 | 20s | 50s |

Override individual categories by providing partial objects — unspecified fields inherit from the category default (or the `default` category for custom keys).

**Example — override bash and add a custom category:**

```json
"operationTracker": {
  "enabled": true,
  "progressIntervalMs": 30000,
  "toolThresholds": {
    "bash": { "expectedMs": 30000, "stallMultiplier": 3 },
    "my_custom_tool": { "expectedMs": 60000, "slowMultiplier": 2, "stallMultiplier": 4 }
  }
}
```

#### Interaction with `toolUpdateMode`

The operation tracker detects and recovers from stuck operations regardless of the `toolUpdateMode` setting. The mode only controls what the user sees:

| Mode | Progress updates | Slow warning | Stall warning |
|------|-----------------|--------------|---------------|
| `full` | Elapsed time every 30s | Timing details and expected duration | Technical details with elapsed time |
| `friendly` | One-time "working on something" per tool | Plain-language "still working on it..." | "Got stuck — trying again..." |
| `minimal` | Typing indicator only | "Still working..." | "Something went wrong — retrying..." |

### `agentOptions`

Optional when `type` is `agent`. Fleet create/update APIs fill a default
`sessionScope` and `cwd` when they are omitted; hand-written configs that
include `agentOptions` should keep these fields explicit.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sessionScope` | string | no | `per_chat` via fleet API | `single`, `shared`, or `per_chat`. See [Session Scopes](#session-scopes). |
| `provider` | string | no | `claude-cli` | Agent provider ID. Must be one of `claude-cli`, `codex-cli`, `gemini-cli`, `opencode-cli`, `openai-api`, or `anthropic-api`. |
| `providerConfig` | object | no | — | Provider-specific overrides. The selected provider owns the accepted keys; unknown provider IDs are rejected before runtime startup. |
| `cwd` | string | no | `~/.local/share/whatsoup/instances/<name>/workspace` | Working directory for the agent subprocess. Tilde is expanded (`~` → `$HOME`). Empty values are replaced with the default. |
| `instructionsPath` | string | no | — | Path to a CLAUDE.md-style instructions file, relative to `cwd`. |
| `sandboxPerChat` | boolean | no | `false` | Provision a separate workspace per chat. Requires `sessionScope: per_chat`. |
| `sandbox` | object | no | — | Sandbox constraints applied via agent enforcement hooks. See [sandbox](#agentoptionssandbox). |
| `mcp` | object | no | — | MCP feature flags for the agent subprocess (e.g., `{ "send_media": true }`). |
| `pluginDirs` | string[] | no | — | Additional plugin directories to pass via `--plugin-dir` to the Claude Code subprocess. |
| `enabledPlugins` | Record<string, boolean> | no | — | Per-instance plugin overrides. Keys are `plugin@marketplace` identifiers. `true` = enabled, `false` = disabled. Omitted keys inherit from global `~/.claude/settings.json`. Written to `<cwd>/.claude/settings.json` at startup. |
| `allowM365Mutations` | boolean | no | `false` | Per-instance opt-in for propagating `ALLOW_M365_MUTATIONS` to the agent subprocess. Only consulted when `WHATSOUP_CONNECTOR_FAILCLOSED=1` is set on the parent process (off by default). See [Connector mutation policy (#411)](#connector-mutation-policy-411). |

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

### Connector mutation policy (#411)

Background: agent instances historically run with `permissions.defaultMode: bypassPermissions` and a wide tool allowlist (`mcp__google-workspace__*`, `mcp__plugin_*`, etc.). Mutation-capable tools (send mail, drive write, calendar mutations, M365 write tools) were gated only by out-of-tree hooks and by whether `ALLOW_M365_MUTATIONS=1` is set in the parent env. Either gate can be bypassed without the repo noticing, which is the root cause investigated in #411.

To give the repo a real say without rewriting existing on-disk settings, two mechanisms are active:

**1. `REQUIRED_DENY` floor (`src/core/settings-template.ts`).**
A repo-owned readonly list of deny patterns that `mergeSettingsJson` always unions into the resulting deny array, and that `isValidPermissionsSettings` requires as a subset. Custom `settingsJson` payloads cannot remove a floor entry.

The floor is populated with full permission strings for the mutation-capable connector tools approved in the #411 inventory. It covers Gmail and Google Calendar mutation tools exposed through the `mcp__claude_ai_*` namespace, Microsoft 365 mail, calendar, file, list, contact, group, task, chat, channel, Dataverse, Booking, OneNote, meeting, workbook, attachment, dynamic execution, batch, and subscription mutation tools. The read-only `mcp__google-workspace__*` namespace is intentionally not denied.

The source of truth is `REQUIRED_DENY`; this document describes categories only. New defaults, merged settings, and repaired settings receive the floor. Existing `.claude/settings.json` files that are not rewritten keep their current contents.

**2. `WHATSOUP_CONNECTOR_FAILCLOSED` env flag (`src/runtimes/agent/providers/child-env.ts`).**

- **Unset (default, today's behavior):** `buildBaseChildEnv` propagates `ALLOW_M365_MUTATIONS` to the agent subprocess whenever it is set in the parent env. This is exactly the pre-#411 child-env path; existing parent-process opt-ins keep working unchanged.
- **Set to `"1"` (opt-in):** `buildBaseChildEnv` drops `ALLOW_M365_MUTATIONS` from the child env *unless* the instance has `agentOptions.allowM365Mutations: true`. This converts the env-var gate into a per-instance allowlist that can be audited at config-write time.
- Any other value of the flag is treated as unset (back-compat).

WhatSoup forwards `agentOptions.allowM365Mutations` from the loaded instance config through runtime/session startup into each Claude CLI child-env builder; `buildBaseChildEnv` remains the single policy gate.

`WHATSOUP_CONNECTOR_FAILCLOSED` only controls child-env propagation of `ALLOW_M365_MUTATIONS`. It does not gate the `REQUIRED_DENY` floor.

**How operators enable fail-closed child-env propagation:**

```bash
# 1. In the launchd plist / systemd unit for the WhatSoup parent process:
export WHATSOUP_CONNECTOR_FAILCLOSED=1

# 2. For each instance that legitimately needs mutation access:
#    config.json
{
  "name": "mutation-enabled-agent",
  "type": "agent",
  "agentOptions": {
    "sessionScope": "per_chat",
    "cwd": "...",
    "allowM365Mutations": true
  }
}
```

### Validation Rules Summary

The loader enforces these constraints before the process starts:

- `name` must match the directory name.
- `type` must be `chat`, `agent`, or `passive`.
- `accessMode` must be one of the four valid values.
- `adminPhones` must be a non-empty array of non-empty strings.
- `chat` instances must have a non-empty `systemPrompt`.
- `passive` instances must not have a `systemPrompt` and must use `accessMode: self_only`.
- Fleet create/update APIs default omitted `agentOptions` to `sessionScope: per_chat` with a per-instance workspace under the user's home directory.
- `agent` instances with hand-written `agentOptions` must have a valid `sessionScope`; an empty or missing `cwd` is normalized by the fleet API before persistence.
- `agentOptions.sandboxPerChat: true` requires `sessionScope: per_chat`.
- `agentOptions.allowM365Mutations`, when present, must be a boolean.
- `agent` with `sessionScope: single` must use `accessMode: self_only`.
- `chatAliases`, when present, must be an object of non-empty alias to JID strings.
- `profiles`, when present, must be an object of profile names to profile objects with only `prefix`, `tag`, and `linkPreview` fields.

---

## XDG Directory Layout

In multi-instance mode, each instance gets isolated directories under the standard XDG tree.

```
$XDG_CONFIG_HOME/whatsoup/instances/<name>/   (default: ~/.config/...)
  config.json       — per-instance configuration (the file you edit)
  auth/             — Baileys WhatsApp auth credentials

$XDG_DATA_HOME/whatsoup/instances/<name>/     (default: ~/.local/share/...)
  bot.db            — SQLite database (messages, contacts, access list, sessions, outbound_sends audit)
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
  "memory": {
    "pinecone": {
      "apiKeyEnv": "PINECONE_TEAM_KEY",
      "projectId": "team-project-id",
      "expectedHostSuffix": "-team-project-id.svc.aped-4627-b74a.pinecone.io",
      "index": "team-search",
      "searchMode": "entity",
      "rerank": true,
      "topK": 20,
      "rerankTopN": 6
    }
  },
  "maxTokens": 500,
  "tokenBudget": 50000,
  "rateLimitPerHour": 60,
  "adminPhones": ["15555550100", "15555550101"],
  "accessMode": "open_dm",
  "healthPort": 9093
}
```

### Passive — MCP-only

A passive instance exposes the global MCP tools over Unix sockets but never sends automatic
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

All migration sources are in `src/core/database.ts` unless noted otherwise.

| Version | Description |
|---------|-------------|
| 1 | Full schema DDL — `messages`, `contacts`, `access_list`, `agent_sessions`, `rate_limits`, `enrichment_runs` (`MIGRATION_1`) |
| 2 | Durability tables: `inbound_events`, `outbound_ops`, `tool_calls`, `session_checkpoints`, `recovery_runs` (`MIGRATION_2`) |
| 3 | Chat sync tables, Wave 2 (`MIGRATION_3`) |
| 4 | Labels tables, Wave 6 (`MIGRATION_4`) |
| 5 | `messages.raw_message` column for `forward_message` support (idempotent ALTER) |
| 6 | Blocklist and LID mapping persistence (`MIGRATION_6`) |
| 7 | `groups` table for group metadata persistence (`MIGRATION_7`) |
| 8 | `messages.enrichment_retries` column — persist enrichment retry counters across restarts (previously in-memory only) |
| 9 | `decryption_failures` table + unresolved / conversation indexes (`MIGRATION_9`) |
| 10 | Self-healing control plane tables: `control_messages`, `heal_reports`, `pending_heal_reports` (`MIGRATION_10`) |
| 11 | Token usage tracking — `input_tokens`/`output_tokens`/`model_used` on `messages`; `total_input_tokens`/`total_output_tokens` on `agent_sessions`. Idempotent ALTERs. Chat runtime persists tokens per LLM response; agent runtime captures them from agent stream result events. |
| 12 | `messages.media_path` column + partial index `idx_messages_media_path` for media-bearing rows |
| 13 | `messages.content_text` column + rebuilt FTS triggers (insert / update / soft-delete / delete) to index `content_text` instead of `content` |
| 14 | `scheduled_messages` table + `idx_scheduled_pending` for the dispatcher |
| 15 | `metrics_hourly` rollup table + bucket index |
| 16 | `scheduled_messages.media_blob` column for inline media payloads |
| 17 | `scheduled_messages` recurrence columns (`chat_name`, `recurrence`, `next_run_at`, `run_count`) + `idx_scheduled_next_run` |
| 18 | `agent_token_events` table + `agent_sessions.ended_at` column + expression indexes for unixepoch queries + backfill of terminal sessions (`MIGRATION_18`) |
| 19 | `agent_sessions.provider` column — which LLM provider drove the session |
| 20 | `fact_export_queue` for the WhatsApp → mw-mind fact export pipeline (`MIGRATION_20`) |
| 21 | `chat_aliases` table — operator-friendly alias → `chat_jid` lookups (`MIGRATION_21`) |
| 22 | `outbound_sends` audit table + indexes (created_at, status, chat, alias) for the unified send pipeline (`MIGRATION_22`) |
| 23 | Substrate schema: `beads`, `bead_triggers`, `trigger_runs`, `bead_events`, `entities`, `entity_aliases`, `entity_observations`, `bead_entity_refs`, `sweep_runs` (`MIGRATION_23` in `src/core/substrate/schema.ts`) |
| 24 | `messages.updated_at` column + backfill + touch triggers on insert and content-changing updates |
| 25 | `lid_mappings_history` retained audit table + indexes — first-seen rows and LID → phone flips are recorded by the unified `writeLidMapping` seam (#251 LID conflict remediation) (`MIGRATION_25`) |

---

## Fleet API — Instance Fields from Config

The `GET /api/lines` and `GET /api/lines/:name` endpoints expose two config fields not present in the `/health` response:

| Field | Source | Description |
|-------|--------|-------------|
| `models` | `config.json` → `models` object | Model overrides (conversation/extraction/validation/fallback), or `null` if not set in config. |
| `sandboxPerChat` | `config.json` → `agentOptions.sandboxPerChat` | `true` when per-chat workspace provisioning is active; `false` otherwise. |

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

Agent and passive instances only need `openai` for the cloud transcription layer and other OpenAI-backed features. If the key
is absent, voice note transcription silently degrades — the agent receives the file path
instead of transcribed text.

For mwlab host-specific Pinecone/transcription setup, see `docs/runbooks/mwlab-transcription-pinecone.md`.
