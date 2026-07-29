# WhatSoup Configuration Reference

WhatSoup is configured through two complementary mechanisms: environment variables for
infrastructure-level settings, and per-instance `config.json` files for runtime behavior.
In multi-instance mode, `config.json` values take precedence over environment variables.
Both take precedence over built-in defaults.

**Resolution order:** canonical `memory.*` in `config.json` > legacy flat aliases in `config.json` > environment variable > built-in default

---

## Environment Variables

### API Keys

| Variable | Type | Description |
|----------|------|-------------|
| `ANTHROPIC_API_KEY` | string | Anthropic API key. Required for `chat` instances — the `whatsoup` launcher hard-fails on startup if missing (`deploy/whatsoup:101`). **Not set** for `agent`/`passive` instances — the wrapper script explicitly unsets it so the agent runtime uses its subscription billing path instead of the API. |
| `OPENAI_API_KEY` | string | OpenAI API key. **Required for `chat` instances** — the launcher hard-fails on startup if missing (`deploy/whatsoup:102`). Used as the fallback key for OpenAI chat completions and Whisper transcription when the instance does not configure an `apiKeyService`; a configured `chatOptions.openaiProviderConfig.apiKeyService` or `transcriptionOptions.openaiProviderConfig.apiKeyService` resolves through `resolveApiKey()` first. For `agent` instances it is soft-optional (used for Whisper voice-note transcription when present); `passive` instances do not call any LLM APIs directly. |
| `OPENAI_BASE_URL` | string | **Legacy/fallback** process-wide override for the OpenAI SDK's endpoint — it governs bare `new OpenAI()` clients. Superseded for `chat` instances' chat completions by per-instance [`chatOptions.openaiProviderConfig.baseUrl`](#custom-endpoint-for-chat-instances-chatoptionsopenaiproviderconfig) and for Whisper transcription by per-instance [`transcriptionOptions.openaiProviderConfig.baseUrl`](#custom-endpoint-for-whisper-transcription-transcriptionoptionsopenaiproviderconfig). Instances that configure neither field still get the legacy bare SDK behavior. |
| `PINECONE_API_KEY` | string | Default Pinecone API key env var. Instances can point at a different BYOK env var with `memory.pinecone.apiKeyEnv`. **Required for `chat` instances** — the launcher hard-fails on startup if missing (`deploy/whatsoup:103`), and `loadContext` is invoked per inbound message (`src/runtimes/chat/runtime.ts:201`) so a missing key burns the 5s timeout on every message. Soft-optional for `agent` instances (needed only when the instance declares `pineconeAllowedIndexes` for the `knowledge_search` MCP tool). |
| `GEMINI_API_KEY` | string | Google Gemini API key. Forwarded into the agent subprocess environment only when `agentOptions.provider` is `gemini-cli` (`src/runtimes/agent/session.ts:193`); `GOOGLE_API_KEY` is forwarded alongside it when present. Not consulted by `claude-cli`/`codex-cli`/`opencode-cli` agents, or by `chat`/`passive` instances. An operator running a `gemini-cli` agent line must set it — without it the Gemini CLI has no credential. |

These three keys are loaded from GNOME Keyring by the `whatsoup` wrapper script and exported
before the process starts. They are never written to disk.

> **Instance-type summary:** `chat` instances require **all three** keys (Anthropic, OpenAI, Pinecone) — startup aborts otherwise. `agent` instances require none at the launcher level; OpenAI and Pinecone are loaded best-effort and used only when the corresponding feature is exercised. `passive` instances require none.

### Audio Transcription (local providers)

These tune the optional on-device voice-note transcription backends. They are read once at module load. The OpenAI Whisper path can use per-instance `transcriptionOptions.openaiProviderConfig`; when unset, it falls back to `OPENAI_API_KEY` / `OPENAI_BASE_URL` through the OpenAI SDK.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WHATSOUP_FASTER_WHISPER_MODEL` | string | `large-v3-turbo` | faster-whisper model name passed to the Python wrapper (`src/runtimes/chat/providers/transcription/faster-whisper.ts:13`). Models are loaded from `~/.local/share/whatsoup/models/faster-whisper`. |
| `WHATSOUP_FASTER_WHISPER_PYTHON` | path | (unset) | Explicit path to the faster-whisper Python interpreter (`src/runtimes/chat/providers/transcription/faster-whisper.ts:17`). When unset, the resolver probes the managed venv at `~/.local/share/whatsoup/transcription-venv/bin/{python3.12,python3,python}` and falls back to "runtime not installed" if none exists. |
| `WHATSOUP_WHISPER_CPP_MODEL` | path | `~/.local/share/whatsoup/models/whisper.cpp/ggml-small.bin` | Path to the whisper.cpp GGML model file (`src/runtimes/chat/providers/transcription/whisper-cpp.ts:9`). Transcription throws if the file is missing. |
| `WHATSOUP_WHISPER_CPP_BIN` | string | `whisper-cli` | whisper.cpp CLI binary to invoke (`src/runtimes/chat/providers/transcription/whisper-cpp.ts:12`). When unset, the resolver looks up `whisper-cli` on `PATH`; when set, the configured value is resolved via `resolveBinaryPath`. |

### Models

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CONVERSATION_MODEL` | string | `claude-opus-4-8` | Primary model for response generation. Literal ID or [symbolic form](#dynamic-model-resolution). |
| `EXTRACTION_MODEL` | string | `claude-sonnet-4-6` | Model for memory extraction and enrichment. Literal ID or [symbolic form](#dynamic-model-resolution). |
| `VALIDATION_MODEL` | string | `claude-haiku-4-5` | Model for validation and lightweight classification. Literal ID or [symbolic form](#dynamic-model-resolution). |
| `FALLBACK_MODEL` | string | `gpt-5.4` | OpenAI fallback when the primary model is unavailable. Literal ID (pinned, the default) or a [symbolic form](#dynamic-model-resolution) such as `openai:gpt:latest-stable` to track the newest stable release automatically. |

All four can be overridden per-instance via `config.json` `models` object.

#### Dynamic model resolution

Each model-role value accepts one of three modes:

1. **Literal ID** (default, fully backward compatible) — `gpt-5.4`,
   `claude-opus-4-8`, `claude-opus-4-6[1m]`. Pinned; passed to the provider
   exactly as written.
2. **`<vendor>[:<family>]:latest-stable`** (recommended dynamic mode) —
   resolves to the newest **stable** model in the vendor+family line:
   current/legacy catalog entries plus live-served IDs, excluding pre-release
   markers (`-preview`, `-beta`, …), dated snapshots (normalized to their base
   ID), and variant product lines (`-codex`, `-mini`). Example:
   `openai:gpt:latest-stable`, `anthropic:sonnet:latest-stable`.
3. **`<vendor>[:<family>]:latest`** — newest served ID in the line with no
   stability filter (tracks previews/snapshots too). Variant product lines
   stay excluded — `-codex`/`-mini` are different products, not newer builds.

Vendors: `openai`, `anthropic`. The family may be omitted
(`openai:latest-stable`) and defaults to the vendor's flagship chat line
(openai→`gpt`, anthropic→`opus`). Valid families are the ones present in the
static catalog (`src/lib/model-catalog.ts`) — currently `gpt`/`gpt-o` for
openai and `opus`/`sonnet`/`haiku`/`fable` for anthropic.

Semantics and failure behavior:

- **Validation is at config load.** An unknown vendor or family (or malformed
  mode) in a symbolic value fails startup with a clear error — it is never
  silently passed through as a literal, so typos cannot masquerade as model
  IDs. Note this claims any value ending in `:latest`/`:latest-stable`
  (e.g. an Ollama-style `llama3:latest` tag is rejected); other colon-tagged
  literals (`llama3:70b`) still pass through untouched.
- **Resolution is async, at point of use.** The raw symbolic string stays on
  the config; the chat runtime, enrichment extractor/validator, and memory
  consolidation resolve it to a concrete ID just before each provider call via
  a shared in-process cache of the live vendor `/v1/models` lists
  (`src/lib/model-advisor.ts`). The model-currency monitor refreshes that
  cache on startup and on its daily tick, re-resolving symbolic values and
  advising on the **resolved** target. Literal IDs never touch the network.
- **Degraded/offline live scan** (missing API key, network failure, non-OK
  response) resolves to the static catalog `current` entry for the family —
  warn-logged, never thrown; a live turn is never blocked on resolution.

#### Model currency advisories

Model IDs are passed through to providers opaquely — any string is accepted, so
new vendor releases work without a WhatSoup change. On startup (and daily
thereafter) the bot checks every configured model against the catalog in
`src/lib/model-catalog.ts`, plus the live Anthropic/OpenAI Models APIs when the
matching API key is present, and notifies operators through the BOT_ERRORS alert
pipeline (source `model-currency`) when a configured model:

- has a newer sibling in the same family (`info` severity, e.g. `claude-opus-4-6` → `claude-opus-4-8`), or
- is deprecated or retired upstream (`warning` severity, with the retirement date and replacement).

The check is advisory and fail-open: unknown providers/IDs, missing API keys,
and network failures all degrade to silence. Note the dependency this implies:
detecting a brand-new release the static catalog has never heard of requires
the live Models API (matching API key present); without keys, advisories come
from the static catalog alone, so an upstream retirement that postdates the
catalog produces no warning. The latest result is exposed on
the `/health` endpoint under `model_advisories`. Future model IDs that follow
vendor naming conventions (`claude-<family>-<major>-<minor>`,
`gpt-<major>.<minor>`) are recognized and ordered automatically; only
lifecycle metadata (deprecations/retirements) needs occasional catalog updates.

### Conversation

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MAX_TOKENS` | integer | `750` | Maximum tokens in a single LLM response. Parsed by `intEnv()` — invalid values fall back to the default. |
| `RATE_LIMIT_PER_HOUR` | integer | `45` | Maximum messages per user per hour (chat runtime). |
| `WHATSOUP_API_TIMEOUT_MS` | integer (ms) | `30000` | Timeout for outbound LLM API requests (`config.ts` `apiTimeoutMs`, `src/config.ts:928`). Lets operators raise the request timeout at runtime without a code edit (the documented recovery step for repeated API timeouts). Non-numeric (`intEnv` fallback) and non-positive (`0`/negative) values fall back to the `30000` default. |

### Agent session lifecycle (per_chat / shared agent runtimes)

Bounds resident per-chat agent sessions so a long-running instance does not accumulate one `claude` subprocess (plus its MCP and browser children) per distinct chat until the host exhausts memory. A periodic sweep suspends idle sessions via the session's graceful `shutdown(true)` (resumable — the next message rehydrates via `--resume`); sessions mid-turn, awaiting a poll vote, mid-dispatch, or younger than the residency floor are never evicted. In-turn watchdogs (`TURN_WATCHDOG_MS` etc.) handle hangs; these knobs handle idle accumulation. All parsed as positive integers (invalid/≤0 → default).

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WHATSOUP_SESSION_IDLE_MS` | integer (ms) | `3600000` (1h) | Idle threshold: a resident session with no message for longer than this is suspended on the next sweep. Setting this below ~35 min can suspend a session shortly after a long (multi-minute) turn completes, since idle is measured from the turn's last message. |
| `WHATSOUP_SESSION_SWEEP_MS` | integer (ms) | `600000` (10m) | How often the idle-session sweep runs. |
| `WHATSOUP_MAX_SESSIONS` | integer | `12` | LRU ceiling on concurrent resident sessions. When exceeded, the longest-idle evictable sessions are suspended down toward the cap even if still within `WHATSOUP_SESSION_IDLE_MS`, bounding memory under a burst of many active chats. |
| `WHATSOUP_LONG_OP_CEILING_MS` | integer (ms) | `7200000` (2h) | Hard bound on liveness-gated kill deferrals (`src/runtimes/agent/session.ts` `LONG_OP_CEILING_MS`). When the stalled-operation kill or the hard turn watchdog fires but the provider's process tree shows CPU progress (a long browser-automation / bash / MCP step, not a hang — see `tree-liveness.ts`), the kill is deferred and the timer re-arms; this ceiling, measured from the first fire of the quiet stretch, is the point past which the kill proceeds regardless. Raise it on instances that legitimately run very long automation jobs. Parsed as a positive integer (invalid/≤0 → default). |
| `WHATSOUP_SESSION_MIN_RESIDENCY_MS` | integer (ms) | `300000` (5m) | Anti-thrash floor: a freshly-spawned session is never suspended until it has lived at least this long, preventing evict→respawn churn under a burst. |

`per_chat`/sandboxed-per-chat instances also run a DB-level zombie-session sweep, cross-referencing `agent_sessions` rows against `session_checkpoints` and PID ownership (`classifyActiveSessions`). Sessions the classifier cannot confidently place land in its 'ambiguous' bucket and are left running; the two knobs below give that bucket an escape hatch so an init-failure session that never checkpointed does not stay `active` forever (#1756).

Before each classifier pass, a current-process resident manager may repair its exact
`agent_sessions` row only when the row is `orphaned` and an active checkpoint still
matches its workspace, provider session, and (for persistent providers) process ID.
Suspended rows, rows in `ended`, `completed`, `crashed`, or `resume_failed`, and
rows with any checkpoint mismatch are never reactivated.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WHATSOUP_ZOMBIE_SWEEP_MS` | integer (ms) | `1800000` (30m) | How often the zombie-session classifier re-runs after startup. |
| `WHATSOUP_AMBIGUOUS_SESSION_MAX_AGE_MS` | integer (ms) | `86400000` (24h) | Age (with zero processed messages) past which an 'ambiguous' row is independently re-verified for PID liveness/ownership and, if still not alive+owned, marked terminal (`orphaned`). A session with any processed messages, or a PID confirmed alive and owned by this service, is left alone regardless of age. |

Persisted resume is supported only by `claude-cli`, `codex-cli`, and `opencode-cli`.
If a persisted resume is attempted with `gemini-cli`, `openai-api`, or
`anthropic-api`, the exact agent lifecycle and its checkpoints are atomically retired to
`ended` before the attempt is rejected. Cleanup cannot repaint that lifecycle `suspended`; a
fresh session or later inbound must take a new lifecycle instead.

Graceful runtime shutdown attempts every resident session and continues queue/auxiliary cleanup
after an individual termination failure. Successfully closed managers release ownership;
failed singleton or per-chat managers retain their session and ownership for a later shutdown
retry. The runtime then propagates the original single failure or an aggregate of multiple
failures, so service supervision cannot mistake partial cleanup for success. Shutdown closes
user-turn admission before detaching queued work, cancels and terminalizes a singleton turn that
is still waiting to publish its evidence epoch, and waits for already-running message handlers to
reach that fence. If an active terminal or recovery handoff lacks exact durable release proof, its
session, outbound queue, FIFO identity, and reply-guarantee ownership remain attached and shutdown
fails visibly instead of clearing the evidence needed for diagnosis or retry.

### Access Control

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `ADMIN_PHONES` | string | (empty) | Comma-separated list of phone numbers with admin access. Used only in single-instance mode; `config.json` `adminPhones` takes over in multi-instance mode. Example: `15555550100,15555550101`. |
| `WHATSOUP_OUTBOUND_IDENTITY_MODE` | string | `log-only` | Mode for the outbound identity guard, which floors sends to cold (unknown) recipients at every `Messenger` egress. `log-only` (default) audits but never blocks — zero behavior change. `enforce` throws `OutboundIdentityError` and stops the send for cold targets. Any value other than `enforce` resolves to `log-only`. Resolved per-instance in `src/config.ts` (`outboundIdentityMode`). |

#### Enabling enforce mode

Default is `log-only` (audit only). After an instance's logs show the warm-set
covers legitimate traffic (only genuine cold/unknown would-blocks remain), flip:

    WHATSOUP_OUTBOUND_IDENTITY_MODE=enforce

in that instance's environment, then restart the instance. Audit events are
structured logs from the `outbound-identity` child logger (`code`, `reason`,
`verdict`, `caller`). Infra callers (`health`, `scheduler`, `reply-guarantee`,
`report-channel`) are never floored regardless of mode.

#### Guarded egresses and out-of-scope direct callers

The guard runs at every free-recipient egress. The five `Messenger` methods
(`ConnectionManager` `sendMessage`/`sendRaw`/`sendPollMessage`/`sendMedia` and
`TwilioConnection.sendMessage`) are guarded inline. Two MCP tools that reach the
raw socket directly — `forward_message` and `relay_message` — are **also** routed
through the guard. `relay_message` is disabled by default
(`advanced.enableRelayMessage`) and is guarded before it can be enabled.

The following direct callers are intentionally **out of scope**: they are
fixed-destination, self-profile, or catalog sends with no free recipient, so the
identity floor does not apply:

- **status broadcast** — posts to the WhatsApp status JID, not a chosen recipient.
- **send_product / send_product_message** — catalog content to a fixed target.
- **share_phone_number / request_phone_number** — self-profile exchange, no message body to a cold target.
- **group invite (send_group_invite)** — invite link delivery, fixed-destination.

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
| `TMPDIR` | path | `<dataRoot>/tmp` or `$XDG_DATA_HOME/whatsoup/tmp/<name>` | Runtime process temp directory. The wrapper, launchd plist generation, and bootstrap pin this to a WhatSoup-owned per-instance path. |

### Pinecone

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PINECONE_INDEX` | string | `whatsapp-bot` | Pinecone index name for the memory pipeline. When this equals `whatsapp-bot` (the default), `pineconeSearchMode` defaults to `memory`; any other index defaults to `entity`. |
| `PINECONE_PROJECT_ID` | string | unset | Optional project guard. When set, readiness and knowledge search verify that the resolved index host belongs to this project ID. |
| `PINECONE_EXPECTED_HOST_SUFFIX` | string | unset | Optional stricter project guard, for example `-nf9hzvy.svc.aped-4627-b74a.pinecone.io`. |
| `KNOWLEDGE_EMBED_URL` | string | `http://127.0.0.1:8799/embed` | Canonical local embed endpoint for vector knowledge profiles. Resolution order is `memory.pinecone.embedUrl` (per-instance) → `KNOWLEDGE_EMBED_URL` → `MW_MIND_EMBED_URL` (deprecated) → this default (`src/config.ts:691`). |
| `MW_MIND_EMBED_URL` | string | `http://127.0.0.1:8799/embed` | **Deprecated alias** of `KNOWLEDGE_EMBED_URL` (expires 2026-10-26). Honored only when neither `memory.pinecone.embedUrl` nor `KNOWLEDGE_EMBED_URL` is set; using it emits a startup deprecation warning. Prefer `KNOWLEDGE_EMBED_URL`. |
| `RECENCY_HALF_LIFE_DAYS` | integer | `14` | Positive day-count half-life for memory-search recency decay. Smaller values forget faster; zero/negative/malformed values fall back to `14`. |
| `MAX_AGE_DAYS` | integer | `90` | Positive day-count cutoff for memory search; records older than this are filtered out. Zero/negative/malformed values fall back to `90`. |

### Transport (Baileys connection)

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `WHATSOUP_BAILEYS_VERSION` | string | (unset → fetch latest) | Pin the Baileys WhatsApp Web protocol version as a dotted three-part tuple, e.g. `2.3000.1021` (`src/transport/baileys-version.ts:15`). When unset/empty the version is resolved live via `fetchLatestBaileysVersion()`. The value is strictly validated: it must be exactly three numeric, safe, non-negative integer parts or startup throws. |
| `WHATSOUP_AUTH_BOND_AUTO_RESTORE` | boolean (`0` disables) | enabled | Controls the auth-bond guard's automatic restore of WhatsApp credentials from the most recent backup (`src/transport/auth-bond.ts:432`). Auto-restore is on unless the value is exactly `0`; any other value (including unset) leaves it enabled. An explicit `autoRestore` option in code overrides this env var. |

### Credential Storage

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `REQUIRE_OS_KEYRING` | string (presence) | (unset) | When set to any non-empty value, an **errored** OS keyring backend probe (e.g. `secret-tool` timeout/EACCES, not a genuinely-absent keyring) becomes fatal instead of silently downgrading to plaintext file credential storage (`src/lib/keyring.ts:66`). A genuinely-absent keyring (ENOENT) is still allowed to fall back to env-only lookup. macOS always uses the Keychain backend, so this guard applies to the Linux/WSL `secret-tool` probe path. |

Unscoped credential lookups use the mapped environment variable first, then
the owner-private file
`$XDG_CONFIG_HOME/whatsoup/credentials/<service>.key`, then the bounded OS
Keychain or `secret-tool` backend, and finally the existing OpenCode fallback.
The credentials directory must be owned by the current user with mode `0700`;
each regular, non-symlinked `.key` file must be owned by that user with mode
`0600` and is read through a bounded descriptor. Account-scoped lookups never
consult this unscoped file store: they use the account-specific Keychain or
`secret-tool` entry before any allowed environment or OpenCode fallback.

The health-token launch path is intentionally separate. Its transitional,
account-specific file is
`$XDG_CONFIG_HOME/whatsoup/instances/<instance>/tokens.env`, not a
`credentials/<service>.key` file. `deploy/whatsoup` preserves an already-loaded
`WHATSOUP_HEALTH_TOKEN`, then reads this per-instance file, then checks the
scoped `whatsoup-health-token` Keychain/`secret-tool` entry, and finally the
legacy shared entry. A present unsafe file fails startup; only an absent file
falls back. The file is exactly one
`WHATSOUP_HEALTH_TOKEN=<64-lowercase-hex>` assignment, owned by the current UID
with mode `0600`, under a real owner-controlled directory that is not group- or
world-writable.

### Health Server

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `HEALTH_PORT` | integer | `9090` | Port for the HTTP health server (`GET /health`, `POST /send`, `POST /agent/compact`). |
| `HEALTH_BIND_ADDRESS` | string | `127.0.0.1` | Bind address for the health server. Set to `0.0.0.0` in Docker to allow host-exposed health checks. |
| `WHATSOUP_HEALTH_TOKEN` | string | (empty) | Bearer token for health-server mutation endpoints such as `POST /send`, `POST /access`, `POST /mark-read`, `POST /heal`, and `POST /agent/compact`. Requests without a matching `Authorization: Bearer <token>` header receive `401`. If unset, mutation endpoints fail closed with `401`. On managed instances, use the per-instance `tokens.env` contract described under Credential Storage instead of duplicating this secret in launchd `EnvironmentVariables`. |
| `WHATSOUP_SCHEDULE_ROOT` | string | (unset) | Filesystem root that `POST /schedule` bounds media file paths to. When unset the route fails closed with `409`; when set, a `filePath` must resolve (fd-pinned, symlink-safe per QR-090) inside this directory or the request is rejected. |
| `WHATSOUP_REPO_ROOT` | path | source-anchored reviewed checkout | Repository root scanned for the ARC binding file reported under the `arc` key of `GET /health`. A trimmed, non-empty explicit value is accepted only when its filesystem realpath matches the checkout containing the running source; a missing, invalid, or different checkout reports `{loaded:false,reason}` without falling back to cwd. Generated launchd jobs also pin `WorkingDirectory` to their reviewed checkout, so the variable is normally unnecessary there. |
| `WHATSOUP_GIT_SHA` | string | `null` in `/health` | Full 40-character git commit SHA for the running checkout. Normally exported by `deploy/whatsoup` after restart preflight and consumed by `src/core/health.ts` for `/health.instance.commit`; `src/transport/connection.ts` reuses the same helper for lifecycle audit `codeSha`. Invalid or short values are ignored. |
| `WHATSOUP_GIT_BRANCH` | string | `null` in `/health` | Git branch for the running checkout, normally exported by `deploy/whatsoup` after restart preflight and surfaced as `/health.instance.branch`. Detached checkouts are reported as `HEAD-detached`; non-git/content-streamed hosts leave the field `null` with a wrapper warning. |
| `WHATSOUP_INSTANCE_UNREACHABLE_ALERT_DWELL_MS` | integer (ms) | `30000` | Fleet health-poller (`src/fleet/health-poller.ts:23`): minimum time an instance must stay continuously unreachable before an `instance_unreachable` alert fires — debounces transient probe failures. |
| `WHATSOUP_HEALTH_BODY_DEGRADED_ALERT_POLLS` | integer | `2` | Fleet health-poller (`src/fleet/health-poller.ts:27`): consecutive degraded `GET /health` body polls required before a `health_body_degraded` alert fires. Floored to a minimum of `1`. |
| `WHATSOUP_HEALTH_BODY_DEGRADED_ALERT_DWELL_MS` | integer (ms) | `10000` | Fleet health-poller (`src/fleet/health-poller.ts:31`): minimum dwell time in the degraded state (applied alongside `WHATSOUP_HEALTH_BODY_DEGRADED_ALERT_POLLS`) before a health-body alert fires. A sole, proven-working usage/rate/session-limit fallback is emitted as non-paging `provider_fallback_capacity`; mixed, exhausted, empty, crashed, or otherwise unproven degradation remains fail-closed as `health_body_degraded`. |

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
| `WHATSOUP_PROVIDER_FALLBACK_PRIMARY_RECHECK_MS` | number (ms) | `300000` (5 min) | For agent instances with a provider fallback configured: how often the background probe re-checks whether the primary provider has recovered, while an `auth-required` fallback is active. Clamped to `[30000, 1800000]` (30 s–30 min); non-positive/invalid values use the default. |
| `WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD` | number | `12` | Consecutive failed primary recovery probes (on the window-extension path) before the first `fallback_recovery_stalled` operator alert is emitted; re-alerts fire at every subsequent multiple of the threshold (T, 2T, 3T …) within the same stall episode, up to the escalation ceiling (see `WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE`). The window keeps extending regardless — the threshold surfaces the stall, it never reverts to a dead primary. The counter resets when the window deactivates. Clamped to `[3, 100]`; non-positive/invalid values use the default. |
| `WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE` | number | `10` | Bounded escalation (DUR-02): beyond `threshold × this value` consecutive failed extension probes, re-alerts stop — the alert AT the ceiling multiple carries `ceiling=true` in its evidence (a state change, not a repeat) and no further `fallback_recovery_stalled` alerts fire for the rest of the episode. Repeating an indistinguishable alert forever past a known, indefinite stall is pure noise; the window still extends and the instance is never stranded. A successful primary probe resets the episode (and the ceiling) exactly once, same as the attempt counter. Clamped to `[1, 1000]`; non-positive/invalid values use the default. |
| `WHATSOUP_PROVIDER_FALLBACK_NOTICE_DEDUP_MS` | number (ms) | `1800000` (30 min) | Dedup window for the user-facing "switched to fallback provider" notice, so repeated fallbacks within the window don't re-notify the chat. Also used as the per-chat dedup window for `fallback_empty_turn` operator alerts. Non-positive/invalid values use the default. |
| `WHATSOUP_RESPONSE_REGISTRY_DISPATCH` | `1` to enable | off | Route terminal provider-failure results through the declarative response-workflow registry (`handleProviderFailureResult`) instead of the legacy per-chat / singleton branch ladders. Behaviour-preserving and equivalence-locked. Enable first, confirm green in production, then enable the diagnostics flag. See `docs/runbooks/error-response-workflows.md`. |
| `WHATSOUP_DIAGNOSTIC_BUNDLE` | `1` to enable | off | On an arming provider failure via the registry dispatcher, run the best-effort diagnostic bundle (health / usage-reset / model-usability / recovery / account-auth) and emit a redacted findings digest as a `provider_failure_diagnostics` alert. Requires `WHATSOUP_RESPONSE_REGISTRY_DISPATCH`. Fire-and-forget; throttled to one kick per primary per 60 s. |
| `WHATSOUP_ONE_MESSAGE_HANDOFF` | `1` to enable | off | Collapse the fallback notice and the stand-in's reply into one user message: when a replay is scheduled the notice is stashed in the crash-safe `standby_notice` latch and prepended to the stand-in's first visible reply (or flushed standalone if the turn produces none). Off → the notice is sent standalone as before. |
| `WHATSOUP_HANDOFF_DISTILLER` | `1` to enable | off | Arms the background production sweep that periodically distills each active conversation via `HandoffDistillRunner`. Inert (sweep not armed, one warn log) when set but `WHATSOUP_HANDOFF_DISTILL_MODEL` is unset or no API key resolves. Default-off; byte-identical when unset. See `docs/runbooks/error-response-workflows.md`. |
| `WHATSOUP_HANDOFF_CONTEXT` | `1` to enable | off | On each fresh or stand-in session spawn, injects the most recently distilled summary into the session system prompt (`system` seam for all providers). The callback yields `null` (omitted silently) when no fresh artifact exists. Default-off; byte-identical when unset. |
| `WHATSOUP_HANDOFF_DISTILL_MODEL` | string | (unset) | Cheap summarizer model id for the handoff distiller. Accepted values: `deepseek-chat`, `MiniMax-M2.7`, `glm-5.2`. When unset or unrecognised (no matching API key found) the distiller is inert and the sweep is not armed, even if `WHATSOUP_HANDOFF_DISTILLER=1`. |
| `WHATSOUP_HANDOFF_DISTILL_SWEEP_MS` | number (ms) | `60000` (60 s) | How often the background sweep consults the runner for each active conversation. Clamped to `[10000, 3600000]` (10 s – 1 h); non-positive/invalid values use the default. |
| `WHATSOUP_HANDOFF_DISTILL_GROWTH_THRESHOLD` | integer (tokens) | `4000` | Token growth since the last distill baseline that makes a conversation eligible for a fresh distill; below it the runner skips the conversation (no model call). Clamped to `[500, 1000000]`; non-positive/invalid values use the default. |
| `WHATSOUP_HANDOFF_DISTILL_VERBATIM_N` | integer | `40` | Trailing messages handed to the summarizer corpus. Clamped to `[1, 200]`; non-positive/invalid values use the default. |
| `WHATSOUP_HANDOFF_DISTILL_MAX_TOKENS` | integer (tokens) | `50000` | Per-conversation token budget per rolling window (`maxTokensPerWindow`). Clamped to `[1000, 5000000]`; non-positive/invalid values use the default. |
| `WHATSOUP_HANDOFF_DISTILL_MAX_CALLS` | integer | `6` | Per-conversation distill-call budget per rolling window (`maxCallsPerWindow`). Clamped to `[1, 1000]`; non-positive/invalid values use the default. |
| `WHATSOUP_HANDOFF_DISTILL_WINDOW_MS` | number (ms) | `3600000` (1 h) | Rolling-window length for the distiller token/call budgets (`windowMs`). Clamped to `[60000, 86400000]` (1 min – 24 h); non-positive/invalid values use the default. |
| `WHATSOUP_HANDOFF_DISTILL_FAILURE_THRESHOLD` | integer | `3` | Consecutive distill failures that trip the circuit breaker open (`failureThreshold`). Clamped to `[1, 100]`; non-positive/invalid values use the default. |
| `WHATSOUP_HANDOFF_DISTILL_BREAKER_COOLDOWN_MS` | number (ms) | `300000` (5 min) | Breaker open → half-open cooldown (`breakerCooldownMs`). Clamped to `[10000, 86400000]` (10 s – 24 h); non-positive/invalid values use the default. |
| `WHATSOUP_HANDOFF_DISTILL_GLOBAL_CONCURRENCY` | integer | `2` | Max concurrent distills across all conversations (`globalConcurrency`). Clamped to `[1, 32]`; non-positive/invalid values use the default. |
| `EMIT_ALERT_THROTTLE_MS` | number (ms) | `300000` (5 min) | In-process dedup window for the legacy alert helper (the spawn-based fallback path used when the durable outbox write fails). Alerts with the same `(instance, source, summary)` key within the window are suppressed. Set to `0` to disable. |
| `BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS` | `0` disables | enabled | Master switch for the agent runtime's per-tool-failure operator alerts. When set to exactly `0`, `maybeEmitToolFailureAlert` returns early and no `runtime_tool_failure` alert is emitted regardless of the failure (`src/runtimes/agent/runtime.ts:868`). Any other value (including unset) leaves the alerts enabled, still subject to the downstream noise gate that pages only on infra/provider-health signatures. |
| `BOT_ERRORS_EXPECTED_JID` | string | (unset) | Pinned expected destination group JID for the legacy alert helper (`src/lib/emit-alert.ts:101`). When set, the runtime-configured `BOT_ERRORS_JID` must equal it or the legacy helper is disabled (drift guard against misrouted alerts). When unset, the helper is disabled unless `BOT_ERRORS_REQUIRE_EXPECTED` is turned off — see below. |
| `BOT_ERRORS_REQUIRE_EXPECTED` | boolean (`0`/`false`/`no`/`off` disables) | enabled | Whether an unset `BOT_ERRORS_EXPECTED_JID` disables the legacy alert helper (`src/lib/emit-alert.ts:95`). Default (any value other than `0`/`false`/`no`/`off`, including unset) is fail-closed: without a pinned expected JID the legacy helper stays disabled. Set to one of the disabling tokens to allow the legacy helper to run against `BOT_ERRORS_JID` without the pin. |
| `FLEET_BIND_ADDRESS` | string | `127.0.0.1` | Bind address for the fleet server. Non-loopback values are refused at startup unless `WHATSOUP_FLEET_UNSAFE_REMOTE_CONSOLE=1` is set. The console HTML no longer carries the root fleet token (the console unlocks via `POST /api/console-session`, which sets an HttpOnly session cookie); the guard remains because a remote plain-HTTP bind would still transmit the operator-entered token and session cookie unencrypted. **The recommended way to reach the fleet from another host is to keep this loopback and front the port with `tailscale serve` (TLS), not to set the override** — see [Remote fleet access via tailscale serve](#remote-fleet-access-via-tailscale-serve). When a request arrives over TLS (a TLS-terminating front sets `X-Forwarded-Proto: https`, or the socket is directly encrypted) the console session cookie now carries `Secure`; a plain loopback-HTTP unlock omits it (localhost is a secure context, so the cookie still delivers). The root-token mint endpoints (`POST /api/console-session`, `/api/auth-ticket`, `/api/ws-ticket`) additionally refuse any non-loopback TCP source — behind `tailscale serve` the proxy connects from loopback, so legitimate remote mints still pass while a direct peer after a bind regression is rejected. |

### Docker Volume Layout

The container uses XDG base directories under `/home/whatsoup/`:

| Volume | Container path | Contents |
|--------|---------------|----------|
| `config` | `/home/whatsoup/.config/whatsoup` | Instance configs, auth credentials, fleet token |
| `data` | `/home/whatsoup/.local/share/whatsoup` | SQLite databases, logs, media cache |
| `state` | `/home/whatsoup/.local/state/whatsoup` | Lock files (ephemeral) |

The `config` volume is critical — losing it requires re-scanning the QR code for each instance.

### Remote fleet access via tailscale serve

The fleet server binds loopback (`FLEET_BIND_ADDRESS=127.0.0.1`). Co-located
callers (same host) reach it directly at `http://127.0.0.1:9099`. Remote hosts
reach it over TLS through `tailscale serve`, which is tailnet-private (unlike
Funnel, it is **not** exposed to the public internet), auto-provisions a
certificate, and reverse-proxies to the loopback port. This keeps the bind
guard satisfied with no `WHATSOUP_FLEET_UNSAFE_REMOTE_CONSOLE` override and
preserves cross-host delivery.

**Enable (run once on the fleet host):**

```bash
# Front the loopback fleet port with TLS on a tailnet-private 8443 listener.
# 8443 avoids any in-use 443/10000 Funnel listeners.
tailscale serve --bg --https=8443 http://127.0.0.1:9099

# Confirm it is `serve` (private), not `funnel` (public):
tailscale serve status
```

The endpoint is `https://<host>.<tailnet>.ts.net:8443`.

**Point a remote caller at it:**

```bash
# On the remote host:
printf 'https://<host>.<tailnet>.ts.net:8443\n' > ~/.config/whatsoup/fleet-api
```

Shell callers resolve the base URL through `~/.local/lib/whatsoup-fleet-api.sh`
(`~/.config/whatsoup/fleet-api`), so no code change is needed per host.

**Verify from a second tailnet host:**

```bash
# The console root is served unauthenticated (the HTML carries no token);
# a 200 proves the TLS front reaches the loopback fleet.
curl -fsS -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net:8443/
```

Because the unlock arrives over HTTPS, the console session cookie carries
`Secure`; because `tailscale serve` connects to the app from loopback, the
loopback-only mint gate still admits the request.

**Rollback:**

```bash
tailscale serve reset                      # tear down the TLS front
# restore the previous ~/.config/whatsoup/fleet-api on each remote host
```

`tailscale serve --bg` configuration persists across `tailscaled` restarts. If
the serve proxy fails, only *remote* delivery degrades — local loopback callers
are unaffected.

### Internal / Bootstrap

| Variable | Type | Description |
|----------|------|-------------|
| `INSTANCE_CONFIG` | JSON string | Serialized instance config injected by `instance-loader.ts`. Contains the full parsed and validated `config.json` plus resolved `paths`. **Not set manually** — managed by the bootstrap process. |
| `WHATSOUP_NODE` | path | Optional Node binary path propagated into the generated macOS launchd plist's `EnvironmentVariables` (`src/fleet/platform.ts:105`). When set in the generating process's environment, a `WHATSOUP_NODE` key with this value is emitted into the plist so the launched instance uses the chosen Node runtime; when unset the key is omitted entirely. |
| `WHATSOUP_SANDBOX_FAIL_OPEN` | string (`1` to enable) | Read by the agent sandbox `PreToolUse` hook (`deploy/hooks/agent-sandbox.sh`). Controls behaviour when `.claude/sandbox-policy.json` is **missing**. Default (unset/any value ≠ `1`): the hook **fails closed** — it denies the tool call and logs a structured `sandbox_deny` event, because WhatSoup only wires this hook in the same code path that writes the policy file (`src/core/workspace.ts` `writeSandboxArtifacts`), so a missing policy means the sandbox was tampered with or misconfigured. Set to exactly `1` to restore the legacy allow-all-on-missing-policy behaviour for out-of-band manual deployments that intentionally run the hook with no policy file. |
| `ENABLE_TOOL_SEARCH` | string (passthrough) | **Not a WhatSoup knob** — an agent-CLI harness "tokenomics pilot" control, forwarded verbatim into the agent subprocess only when set in the parent env (`src/runtimes/agent/providers/child-env.ts:115`). WhatSoup never reads it. |
| `TOKENOMICS_BOT` | string (passthrough) | **Not a WhatSoup knob** — same agent-CLI harness tokenomics-pilot passthrough into the agent subprocess (`child-env.ts:116`); WhatSoup never reads the value. |

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
| `internalPeerJids` | string[] | no | `[]` | Exact authenticated direct-chat JIDs whose outbound messages are internal operator coordination. Ordinary paths and operator vocabulary are preserved, while secrets and credential paths remain masked. This does not grant inbound admin access. Group JIDs, duplicate entries, whitespace, and spoofable transports such as `@sms` are rejected. |
| `accessMode` | string | yes | — | Who can interact with the bot. See [Access Modes](#access-modes). |
| `systemPrompt` | string | see rules | — | LLM system prompt. **Required** for `chat`. **Forbidden** for `passive`. Optional for `agent` (falls back to `DEFAULT_SYSTEM_PROMPT` in `config.ts`). |
| `models` | object | no | env/default | Model overrides. Keys: `conversation`, `extraction`, `validation`, `fallback`. Each takes a literal model ID or a symbolic `<vendor>[:<family>]:latest[-stable]` form (see [Dynamic model resolution](#dynamic-model-resolution)). |
| `memory` | object | no | defaults | Canonical BYOK memory/search config. Use this for all new configs. See [`memory`](#memory). |
| `pineconeIndex` | string | no | `whatsapp-bot` | Legacy alias for `memory.pinecone.index`. Runtime still reads it; fleet writes and the migrator convert it to `memory.*`. |
| `pineconeSearchMode` | string | no | auto | Legacy alias for `memory.pinecone.searchMode`. |
| `pineconeRerank` | boolean | no | `false` | Legacy alias for `memory.pinecone.rerank`. |
| `pineconeTopK` | integer | no | `20` | Legacy alias for `memory.pinecone.topK`. |
| `pineconeRerankTopN` | integer | no | `6` | Legacy alias for `memory.pinecone.rerankTopN`. |
| `pineconeAllowedIndexes` | string[] | no | `[]` | Legacy alias for `memory.pinecone.allowedIndexes`. |
| `maxTokens` | integer | no | `750` | Max LLM response tokens. Overrides `MAX_TOKENS`. |
| `tokenBudget` | integer | no | `100000` | Total token budget (used by agent runtime). |
| `workingMemorySummarization` | boolean | no | `true` | Chat runtime only (#1445 QR-010). When the working-memory window would exceed `tokenBudget`, the oldest overflow turns are summarized in one cheap LLM call (via the chat model's own provider, `models.validation` role) and prepended as a synthetic `[earlier conversation summary]` turn instead of being silently dropped. Set to `false` to restore drop-only behavior — even then, loss is never silent: a deterministic `[N earlier turns omitted]` marker turn is prepended instead. The same marker fallback is used if the summarization call itself fails or times out, so a summarization outage never fails the user's turn. |
| `rateLimitPerHour` | integer | no | `45` | Per-user rate limit. Overrides `RATE_LIMIT_PER_HOUR`. |
| `healthPort` | integer | no | `9090` | Health server port. Overrides `HEALTH_PORT`. |
| `siblingPhones` | string[] | no | `[]` | Phone numbers of other WhatSoup instances that share groups with this instance. Messages from siblings are silently ignored in groups to prevent infinite echo loops between co-located bots. Normalized to E.164 on load. |
| `chatAliases` | object | no | `{}` | Per-instance alias map used by send surfaces. Keys are aliases such as `ops` or `support`; values are raw WhatsApp JIDs. Seeded into the instance's `chat_aliases` table at startup. |
| `autoRespondGroups` | string[] | no | `[]` | Group JIDs (e.g. `120363...@g.us`) the bot auto-responds to without an `@mention`. At startup each JID is seeded into `access_list` as `allowed` (insert-only-when-absent: a group that already has any `allowed`/`blocked`/`pending` row is left untouched, so an explicit decision is never overridden). Non-string and blank entries are dropped. Skipped entirely when `accessMode` is `self_only`, which rejects all group messages at the policy layer. The durable, source-reproducible equivalent of a hand-inserted group access grant. |
| `profiles` | object | no | `{}` | Per-instance send decoration policies. Keys are profile names; values can define `prefix`, `tag`, and `linkPreview`. Loaded from private instance config at startup. |
| `toolUpdateMode` | string | no | `full` | Controls what the user sees during agent tool execution. `full`: elapsed time and technical details. `friendly`: plain-language status, one-time per tool. `minimal`: typing indicator only, brief text for warnings. |
| `echoGuard` | object | no | `{ enabled: true, groupCooldownMs: 1000 }` | Suppresses outbound echo loops in group chats. When enabled, group messages sent within `groupCooldownMs` of a prior send are suppressed. DMs are never affected. In-memory state, resets on restart. |
| `operationTracker` | object | no | see defaults | Per-tool progress reporting and stall detection. All sub-fields optional; unset fields use platform defaults. See [operationTracker](#operationtracker). |
| `agentOptions` | object | agent only | — | Agent-specific settings. Required fields vary by `sessionScope`. See [agentOptions](#agentoptions). |
| `chatOptions` | object | no | — | Chat-specific settings. Currently just `openaiProviderConfig` (chat OpenAI endpoint/key override). See [chatOptions](#chatoptions). |
| `transcriptionOptions` | object | no | — | Shared OpenAI Whisper transcription endpoint/key override. Valid for chat, agent, and passive instances. See [transcriptionOptions](#transcriptionoptions). |
| `transport` | string | no | `baileys` | Message transport: `baileys` (WhatsApp, default) or `twilio` (SMS). See [`twilioConfig`](#twilioconfig). |
| `twilioConfig` | object | iff `transport: "twilio"` | — | Twilio SMS transport settings. **Required** when `transport` is `twilio`; **rejected** when present with any other transport. See [`twilioConfig`](#twilioconfig). |
| `rateLimitWindowMs` | integer (ms) | `3600000` (1 h) | Measurement window for the per-user response rate limit — `checkRateLimit` counts responses sent within this window and compares against `rateLimitPerHour` (`src/runtimes/chat/rate-limiter.ts:15`). When unset it falls back to `rateLimitNoticeWindowMs` if that is set (with a startup deprecation warning), else the 1-hour default (`src/config.ts:448`). |
| `rateLimitNoticeWindowMs` | integer (ms) | `3600000` (1 h) | Dedup window for the "chill, I need a minute" rate-limit notice — once a user is told they are rate-limited, the notice is suppressed for this long before it can be sent again (`src/runtimes/chat/runtime.ts:174`). Distinct from `rateLimitWindowMs` (the counting window). |
| `recencyHalfLifeDays` | integer | `14` | Per-instance override of `RECENCY_HALF_LIFE_DAYS` — positive day-count half-life for memory-search recency decay (`src/config.ts:858`). Smaller values forget faster. Falls back to the `RECENCY_HALF_LIFE_DAYS` env var, then `14`; non-positive/non-integer values are ignored. |
| `maxAgeDays` | integer | `90` | Per-instance override of `MAX_AGE_DAYS` — positive day-count cutoff for memory search; records older than this are filtered out (`src/config.ts:859`). Falls back to the `MAX_AGE_DAYS` env var, then `90`; non-positive/non-integer values are ignored. |
| `toolUpdateRedirectJid` | string | `null` | Redirect target for the agent's batched tool-status updates. When set, the aggregated tool-status text is sent to this JID instead of the originating chat (`src/runtimes/agent/outbound-queue.ts:717`), keeping operational chatter out of the user-facing conversation. `null` (default) sends status inline as a typing indicator in the active chat. |
| `startupNotifications` | boolean | `true` | Gates the agent "back online" / resume startup notification (`src/main.ts:809`). `false` suppresses it. Only consulted for `agent` instances and only when `toolUpdateMode` is not `minimal`. |
| `proactiveResumeOnStartup` | boolean | `true` | For `per_chat` (non-sandboxed) agents, controls whether sessions that were active or gracefully suspended at last shutdown are proactively resumed instead of waiting for the next user message. Resume requires a complete, self-consistent persisted delivery identity; legacy or ambiguous checkpoints fail closed and wait for lazy recovery on the next inbound message. `false` disables proactive resume. Group conversations are never proactively resumed. |
| `restartLoopGuard` | object | `{ enabled: true, maxRestarts: 3, windowMs: 300000 }` | Resume-replay circuit breaker for proactive resume (`src/runtimes/agent/restart-loop-guard.ts`). Each boot marks a crash marker in `<stateRoot>/restart-loop-guard.json`; a graceful shutdown clears it. When a boot follows an unclean exit with resumable checkpoints pending, the guard counts it; at `maxRestarts` crashy boots inside `windowMs`, proactive resume is suppressed for that boot (sessions still lazy-resume on their next message) and one admin notice is sent via the startup-notification channel. Defaults trip strictly before systemd's `StartLimitBurst=10`/`StartLimitIntervalSec=300` wedge, so the instance self-heals instead of the whole unit going dark. The guard fails open on any persistence error and never blocks inbound service. `enabled: false` disables the trip consult entirely. Guard state is surfaced in the runtime health snapshot (`restartLoopGuard` field). |
| `textAggregateDelayMs` | integer (ms) | `2000` | Debounce window for aggregating an agent's streamed text chunks into one outbound WhatsApp message — the stream buffer flushes this long after the last chunk (`src/runtimes/agent/outbound-queue.ts:382`). Non-positive/non-integer values fall back to `2000`. |
| `pollResolution` | object | `{ defaultStrategy: "first-vote-wins", defaultTimeoutMs: 3600000 }` | Group poll behaviour for `AskUserQuestion`-bridged decisions. `defaultStrategy` (`first-vote-wins`, `admin-only`, or `admin-wins`) is applied to group polls (`src/runtimes/agent/runtime.ts:3416`); DMs always use `first-vote-wins`. `defaultTimeoutMs` is the default pending-poll timeout, clamped to the poll-resolution min/max before use (`src/runtimes/agent/poll-resolution.ts:401`). |
| `gui` | boolean | `false` | Per-instance flag indicating the instance exposes a GUI surface; surfaced through fleet discovery/line metadata. Read into `config.gui` (`src/config.ts:891`). |
| `guiPort` | integer | `9099` | Port advertised for this instance's GUI. Read into `config.guiPort` (`src/config.ts:892`) and surfaced by fleet discovery (`src/fleet/discovery.ts:177`) and the `GET /api/lines/:name` route (`src/fleet/routes/lines.ts:559`). Falls back to the `WHATSOUP_GUI_PORT` env var, then the fleet-port default `9099`. |
| `controlPeers` | object | `{}` | Map of trusted-peer name → phone number for the self-healing control plane. Messages from these phones carrying a control protocol are routed to `control_messages` instead of normal ingest (`src/core/ingest.ts:151`), and named peers (`q`, `loops`) gate degradation-monitor and runtime control behaviour (`src/main.ts:705`, `src/runtimes/agent/runtime.ts:2158`). Empty disables the control-peer paths. |
| `pausedChats` | string[] | `[]` | JIDs (chat JID or conversation key, e.g. `120363...@g.us`) whose inbound messages are stored but never dispatched to the runtime (`src/core/ingest.ts:250`). Lets an operator toggle a chat off without losing messages. Admin commands from a paused chat still process. Non-string/blank entries are dropped. |
| `pausedChatBypassPatterns` | string[] | `[]` | Case-insensitive regex source strings matched against inbound message content in a paused chat (`src/core/ingest.ts`). A match dispatches the message through the normal path as if the chat were not paused, so operator-directed traffic (e.g. escalations) survives pausing a busy group. Default empty keeps `pausedChats` behavior unchanged. Null content (media) never matches. Invalid regex entries are rejected by the instance-config validator; at runtime a bad entry is skipped with a single warn and never breaks ingest. |
| `voiceReply` | string | `never` | Agent voice-reply policy (`src/runtimes/agent/runtime.ts:4196`): `never` (text only), `when_received` (reply with TTS audio only when the inbound message was a voice note), or `always` (always reply with audio). Requires ElevenLabs configuration to produce audio. |
| `autoTyping` | string | `off` | Outbound typing-presence simulation while sending (`src/transport/connection.ts:754`): `off` (no presence), `composing` ("typing…"), or `recording` ("recording audio…"). The presence is set before the send and cleared (`paused`) after. |
| `elevenlabs` | object | see fields | ElevenLabs TTS settings used when a voice reply is produced (`src/runtimes/agent/runtime.ts:7214`). Fields: `defaultVoiceId` (default `pNInz6obpgDQGcFmaJgB`), `defaultModel` (default `eleven_multilingual_v2`), `stability` (default `0.5`), `similarityBoost` (default `0.75`). |
| `generateHighQualityLinkPreview` | boolean | `false` | When `true`, Baileys generates high-quality link-preview thumbnails for outbound messages (`src/transport/connection.ts:704`). Default `false` keeps the lighter-weight preview behaviour. |
| `mediaRetention` | object | `{ tempHours: 72, cacheHours: 168, intervalHours: 6 }` | Media-sweep retention policy (`src/main.ts:679`). `tempHours` is the max age for temp media, `cacheHours` for cached media (default 7 days), and `intervalHours` is how often the retention timer runs. |
| `ingest` | object | `{ maxConcurrent: 20, maxQueueDepth: 500 }` | Inbound ingest backpressure (`src/core/ingest.ts:60`). `maxConcurrent` caps simultaneous in-flight ingests; `maxQueueDepth` caps the waiting queue before new inbound work is shed. |
| `maxExhaustionCycles` | integer | `2` | Number of full reconnect-window exhaustion cycles the transport tolerates before writing an `exhausted.marker` and exiting so the service manager restarts the process (`src/transport/connection.ts:2645`). |
| `agentMaxQueueDepth` | integer | `25` | Maximum depth of the agent turn queue (`src/runtimes/agent/runtime.ts:1477`); inbound turns beyond this are shed rather than queued without bound. |
| `adminReplayMax` | integer | `5` | Cap on how many queued DMs are replayed to a user when an admin grants them access (`src/core/admin.ts:124`). Group messages are excluded from replay. |
| `adminReplayDelayMs` | integer (ms) | `2000` | Throttle delay inserted between each replayed DM during an admin allow-replay (`src/core/admin.ts:157`), to avoid flooding. `0` disables the delay. |
| `advanced` | object | `{ enableRelayMessage: false, enableResync: false, relayMaxPayloadBytes: 1048576, enableUrlWatch: false }` | Gates for low-level/privileged MCP capabilities (`src/mcp/tools/advanced.ts`, `src/mcp/tools/substrate.ts`). `enableResync` must be `true` for the `resync_app_state` tool; `enableRelayMessage` must be `true` for the `relay_message` tool; `relayMaxPayloadBytes` caps the raw protobuf payload size (default 1 MB). `enableUrlWatch` must be `true` for `create_watch` to accept `source:'poll.url'` watches — when `false` (default) creation is rejected and the poller fails any persisted `poll.url` row closed (`url_watch_disabled`). The `poll.url` executor reuses the link-preview SSRF stack and is https-only + default-port-only. All default off/conservative. |

[^enabled]: Enforcement sites: [`src/fleet/discovery.ts:94`](../src/fleet/discovery.ts) (fleet scan skip), [`src/fleet/routes/ops.ts:767`](../src/fleet/routes/ops.ts) (port-in-use scan), [`src/fleet/routes/ops.ts:788`](../src/fleet/routes/ops.ts) (existing-port map for PATCH conflict checks).

### Access Modes

| Value | Description |
|-------|-------------|
| `self_only` | Only `adminPhones` can interact. Required for `passive`. |
| `allowlist` | Only approved users (managed via MCP access-list tools) can interact. |
| `open_dm` | Any direct message is accepted, except unresolved WhatsApp LID senders are held closed until they map to a phone identity. |
| `groups_only` | Only group chats are accepted. |

All access modes keep phone blocklist checks authoritative. If a sender arrives only as an unresolved `@lid`, permissive DM/group paths fail closed because the real phone cannot yet be compared against blocked phone entries.

### `models` Object

```json
"models": {
  "conversation": "claude-sonnet-4-6",
  "extraction": "claude-haiku-4-5-20251001",
  "validation": "claude-haiku-4-5-20251001",
  "fallback": "openai:gpt:latest-stable"
}
```

Omit any key to inherit the env var or built-in default for that slot. Each
value is a literal model ID (pinned) or a symbolic
`<vendor>[:<family>]:latest[-stable]` form that tracks the vendor's newest
release — see [Dynamic model resolution](#dynamic-model-resolution) for the
grammar, stability semantics, and offline fallback behavior. Malformed
symbolic values (unknown vendor/family) fail config load.

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

The table is per instance. It records outbound send intent and outcome for MCP `send_message`, health `/send`, and Reply Guarantee Protocol fallbacks, including the resolved raw chat JID, whether the request used a raw `chatJid` or alias `to`, the selected `profile` when present, SHA-256 hash of the final message text, text length, status, transport message id when available, and error text for failed sends.

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
| `memory.pinecone.projectId` | string | env/unset | Optional short project slug guard (not the UUID-form project ID). If the listed index host does not include this slug, readiness returns `project_mismatch` and `knowledge_search` refuses to query. |
| `memory.pinecone.expectedHostSuffix` | string | env/unset | Optional exact host suffix guard. Use this when two projects have the same index name and you need fail-closed routing. |
| `memory.pinecone.index` | string | env/`whatsapp-bot` | Primary chat memory/entity index. |
| `memory.pinecone.namespaces` | object | WhatsApp defaults | Namespaces used by chat context, fact export, and `mw-mind` intent routing. Every namespace is configurable per instance. |
| `memory.pinecone.searchMode` | string | auto | `memory` for chat/sender/self-fact filters, `entity` for entity index search. Defaults from the index name. |
| `memory.pinecone.allowedIndexes` | string[] | `[]` | Indexes exposed through the agent `knowledge_search` MCP tool. Empty disables that tool. |
| `memory.pinecone.knowledgeSearch.enabled` | boolean | `true` | Global on/off switch for knowledge tool registration. Still requires `allowedIndexes`. |
| `memory.pinecone.knowledgeSearch.allowGlobalAgentSessions` | boolean | `false` | Allows `knowledge_search` in non-`sandboxPerChat` agent sessions. Default is fail-closed because global sessions can span callers. |
| `memory.pinecone.knowledgeProfiles` | object | built-in profiles | Per-index retrieval profile overrides. Configure namespace allowlists, rerank settings, vector/text/entity mode, optional `minScore`, and `embedUrl`. Hits scoring below `minScore` are returned as no result. |
| `memory.fileWatch.allowed_roots` | string[] | `[]` | Filesystem roots a `poll.file` substrate watch may resolve under. **Empty = deny-all (fail-closed)** — the trigger poller runs unsandboxed in the main process, so a confused-deputy watch spec must not probe arbitrary host paths. Tilde-expanded. The executor additionally rejects `/proc` `/dev` `/sys` and non-regular files, and realpath-rechecks symlink targets against this allowlist (symlink-escape defense). For a `watch:'content_hash'` spec, `trigger_runs.output_json` persists the raw SHA-256 digest of the watched file as the change-detection baseline — an opaque content fingerprint, never the file body (an accepted tradeoff: a content-change watch needs a stored baseline to diff). |

For non-`q` instances, any explicit Pinecone config must include
`memory.pinecone.projectId` or `memory.pinecone.expectedHostSuffix` in the
instance config. Create/PATCH validation rejects new config-only Pinecone setup
without one of those guards so same-name indexes cannot silently route to the
wrong project. Existing load/discovery configs are not hard-failed for this
guard; runtime Pinecone calls still fail closed when the guard is missing.

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
| `full` | Elapsed time every 30s | "taking longer than expected" (threshold notice, no live clock) | "still working — this is taking a while" (threshold notice, no live clock) |
| `friendly` | One-time "working on something" per tool | Plain-language "still working on it..." | "still working — this is taking a while" |
| `minimal` | Typing indicator only | Typing indicator only | Typing indicator only |

### `agentOptions`

Optional when `type` is `agent`. Fleet create/update APIs fill a default
`sessionScope` and `cwd` when they are omitted; hand-written configs may omit
`sessionScope` (the runtime defaults it to `single`) but should keep it
explicit for readability.

#### Agent runtime control-plane boundary

WhatSoup owns per-instance agent runtime configuration: `agentOptions`,
generated workspace files, plugin scoping, provider fallback behavior, sandbox
settings, and MCP tool scope. It does not own host-global agent doctrine or Q-host
runtime proof.

On operator workstations, WhatSoup should consume the tracked cross-runtime control
surface and local runtime standard as operator policy through compact instructions or
project pointers, not by copying the full doctrine into `config.json`.

ARC binding pointer: `bindings/whatsoup.arc.json` in the private ARC repository.

Claims about live WhatSoup behavior still require WhatSoup-specific source, tests,
health output, logs, or probes. Q-host current-state rows are not production-fleet
proof unless a WhatSoup-specific proof artifact says so.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `sessionScope` | string | no | `single` at runtime (`per_chat` via fleet API) | `single`, `shared`, or `per_chat`. See [Session Scopes](#session-scopes). Omitted = the runtime defaults to `single`; the fleet create/update APIs fill `per_chat` when the whole `agentOptions` block is omitted. Invalid values are rejected on every path (create, update, load, discovery). |
| `model` | string | no | provider default | Agent-scoped model override, passed to the provider CLI as `--model` at spawn. Highest-precedence agent-model source: wins over top-level `model` and `models.conversation` (`resolveAgentModel`, `src/core/agent-model.ts`). When set, the provider CLI runs this model regardless of the harness's own settings default. |
| `provider` | string | no | `claude-cli` | Agent provider ID. Must be one of `claude-cli`, `codex-cli`, `gemini-cli`, `opencode-cli`, `openai-api`, or `anthropic-api`. A primary `opencode-cli` route requires a non-empty top-level `model` or `models.conversation`; other CLI providers may use their own default model. |
| `providerConfig` | object | no | — | Provider-specific overrides. The selected provider owns the accepted keys; unknown provider IDs are rejected before runtime startup. For `opencode-cli`, `providerConfig.executionProfile` selects an explicit OpenCode agent. `providerConfig.baseUrl` selects a custom endpoint and `providerConfig.apiKeyService` names the keyring service that authenticates it — see [OpenCode headless execution profile](#opencode-headless-execution-profile) and [Custom endpoint](#custom-endpoint-providerconfigbaseurl) for routing, auth, and validation semantics. |
| `providerDataPolicy` | string | no | — | Classification attached to the primary provider route: `trusted` or `restricted`. It is required when `providerBoundaryMode` is `enforce`. `restricted` is currently supported only for `openai-api` and `anthropic-api`; CLI providers are rejected because this classification layer does not provide a mechanical CLI isolation boundary. Classification alone does not sanitize provider payloads. |
| `providerBoundaryMode` | string | no | `shadow` | `shadow` records route policy state without blocking a missing classification. `enforce` rejects startup or route admission when the primary or any fallback route lacks a supported explicit policy. This is a route-admission/checkpoint-integrity gate, not the restricted-provider payload boundary described in the open [provider data-policy security handoff](security-handoffs/2026-07-23-provider-data-policy.md). |
| `fallbackProvider` | string | no | — | Legacy single fallback provider. Prefer `fallbacks` when configuring more than one backup. Must be one of the same IDs as `provider` (`claude-cli`, `codex-cli`, `gemini-cli`, `opencode-cli`, `openai-api`, `anthropic-api`); unknown IDs are rejected before startup. When the primary returns a usage-limit, rate-limit, or auth-required terminal result and the selected fallback is usable, the runtime sends a short in-chat handoff notice and replays the interrupted turn on the fallback provider when no tool side effects have started. Usage-limit and rate-limit fallbacks automatically revert when the window ends; auth-required fallbacks stay armed until the primary passes a background recovery probe. Omitted = fallback disabled (unless `fallbacks` is set). See [Provider fallback behavior](#provider-fallback-behavior) for the full lifecycle: user notice, window persistence across restarts, turn telemetry, credential pre-flight, and admin override commands. |
| `fallbackModel` | string | no | — | Model string passed to `fallbackProvider` while fallback is active (e.g. `minimax/MiniMax-M2`). The id must match the provider's model catalog **exactly, including case** — `opencode` treats `minimax/minimax-m2` and `minimax/MiniMax-M2` as different ids, and a wrong-case id fails every session with an opaque provider error. Copy the id verbatim from `opencode models` — the runtime warns at arm time (`fallback_model_unknown`) when the configured model is not found in the provider catalog. Non-empty string when present. Omission is allowed only for `claude-cli`, `codex-cli`, and `gemini-cli`, which may use their own defaults; **required when `fallbackProvider` is `opencode-cli`, `openai-api`, or `anthropic-api`** (see [Cross-field validation rules](#cross-field-validation-rules)). |
| `fallbackDataPolicy` | string | no | — | Legacy single-fallback classification paired with `fallbackProvider`: `trusted` or `restricted`. It is required when `providerBoundaryMode` is `enforce`, and `restricted` has the same API-provider-only limitation as `providerDataPolicy`. |
| `fallbacks` | array | no | — | Ordered fallback chain. Each entry is `{ "provider": "<provider-id>", "model": "<model-id>", "dataPolicy": "trusted" | "restricted" }`; `model` may be omitted only for `claude-cli`, `codex-cli`, and `gemini-cli`, and `dataPolicy` may be omitted only in `shadow` mode. OpenCode and managed API entries require a model. Do not combine with `fallbackProvider` / `fallbackModel` / `fallbackDataPolicy`. At arm time the runtime selects the first entry whose required key is present, records per-entry eligibility in `/health` and provider-status (`unknown` until the first selection pass), and fails open to entry zero if no keyed entry is eligible so the operator still gets binary/model/key alerts for the first configured target. Auth-required failures skip same-provider entries because they share the failed auth surface and require an independent provider. Maximum 8 entries. Duplicate provider/model routes with conflicting policies are rejected. |
| `cwd` | string | no | `~/.local/share/whatsoup/instances/<name>/workspace` | Working directory for the agent subprocess. Tilde is expanded (`~` → `$HOME`). Empty values are replaced with the default. |
| `instructionsPath` | string | no | — | Path to a CLAUDE.md-style instructions file, relative to `cwd`. |
| `sandboxPerChat` | boolean | no | `false` | Provision a separate workspace per chat. Requires `sessionScope: per_chat`. |
| `perChatConversationBound` | boolean | no | `false` | Harden the per-chat actor socket (non-sandbox `per_chat`, `claude-cli`): the socket's MCP session carries a conversation binding, so global tools are default-denied outside the registry's reviewed conversation-safe allowlist (`transcribe_audio`), caller-supplied conversation keys are confined to the socket's own chat, and injected targets are filled from the binding (caller-supplied targets rejected). Also enables `memory_write` for the bound session. Default `false` = the existing behavior (injected-send confinement only). Requires `sessionScope: per_chat`; incompatible with `sandboxPerChat`. **Capability note:** enabling this removes cross-conversation reads and unreviewed global tools from the per-chat agent by design — opt in per instance only after confirming the instance does not rely on them. |
| `sandbox` | object | no | — | Sandbox constraints applied via agent enforcement hooks. See [sandbox](#agentoptionssandbox). |
| `mcp` | object | no | — | MCP feature flags for the agent subprocess (e.g., `{ "send_media": true }`). |
| `pluginDirs` | string[] | no | — | Additional plugin directories to pass via `--plugin-dir` to the `claude-cli` agent subprocess. Tilde is expanded (`~` → `$HOME`). **Version resilience:** when an entry pins a version directory (e.g. `~/.claude/plugins/superpowers/5.0.7`) that no longer exists — for example after `claude plugin update` bumps it to `5.1.0` — the highest existing semver sibling under the same parent is substituted automatically at startup. Non-version paths and still-present directories are passed through unchanged. |
| `enabledPlugins` | Record<string, boolean> | no | — | Per-instance plugin overrides. Keys are `plugin@marketplace` identifiers. `true` = enabled, `false` = disabled. Omitted keys inherit from global `~/.claude/settings.json`. Written to `<cwd>/.claude/settings.json` at startup. |
| `autoCompactInputTokens` | number | no | `150000` | For Claude CLI agent sessions, automatically send a silent `/compact` after this many input tokens since the last successful compact. Default: 150,000 tokens (prevents prompt-too-long errors while leaving headroom for tool results). Valid range: 50,000-100,000,000. **Bootstrap behavior:** the first time eligibility is checked on any session whose `last_compact_input_tokens=0` (a fresh enable, or a brand-new session whose first turn crosses the threshold), the baseline is initialised silently without firing `/compact`. This prevents a compact storm on rollout but means the first real compact is deferred by one full threshold's worth of tokens. **Cooldown behavior:** successful auto-compacts wait 5 minutes before re-arming; scopes that become eligible again inside the rapid re-arm window escalate to 15, 30, then 60 minute cooldowns. A compact still unfinished after 4 minutes releases the following dispatch and applies a 5-minute retry backoff, but retains its FIFO result-classification slot: a late compact result is still consumed as a system result and cannot steal the next user's inbound identity. `GET /health` exposes current aggregate state through `runtime.agent.autoCompactState`, `autoCompactActiveBackoffScopes`, and `autoCompactWorstCurrentBackoffTier`. It also preserves the process-lifetime diagnostics `autoCompactIneffective`, `autoCompactConsecutiveRapidRearmsMax`, and `autoCompactNextTurnOverThreshold`; those totals/maxima do not independently degrade current health. |
| `allowM365Mutations` | boolean | no | `false` | Per-instance opt-in for propagating `ALLOW_M365_MUTATIONS` to the agent subprocess. Only consulted when `WHATSOUP_CONNECTOR_FAILCLOSED=1` is set on the parent process (off by default). See [Connector mutation policy (#411)](#connector-mutation-policy-411). |
| `nlRouting` | boolean | no | `false` | Flag-gates the NL-first routing aliases (`/model`, `/why`, `/reset`) and the per-sender route-preference store. Off = byte-identical base behavior: the three commands keep forwarding to the agent session and no preference table is created. Routing preference and visibility only — never tool or authority changes (capability-preserved routing). |
| `nlRoutingTiers` | object | no | — | Intent→provider map for NL routing: `{ "strongest": "<provider-id>", "fastest": "<provider-id>" }`. Unset tiers resolve to the default route honestly (`/model strongest` records the preference and routing reports it as unmapped). |
| `nlRoutingEventsDir` | string | no | per-instance config dir | Sink directory for the fail-closed `route-events.ndjson` sidecar (route metadata only — no message bodies, no raw sender JIDs; emit failure degrades to a warning and never blocks a turn). |
| `commandSurface` | object | no | — | Per-instance command-surface policy overlay (disable commands, cosmetic defaults). See [agentOptions.commandSurface](#agentoptionscommandsurface). **Accepted but not yet enforced (enforcement lands with T9c)** — the validator warns at config-validation time. |

#### Primary model usability probe

Agent runtimes launch a non-blocking startup probe for the configured primary conversation model. CLI model probes have a 15-second deadline so cold Claude/OpenCode startup does not create false degraded health. The result is surfaced in the `/health` `instance.primaryModelUsability` block with `status`, `provider`, `model`, optional `reason` / `suggestion`, `checkedAt`, and `probeInFlight`. A configured primary that returns `model-unavailable`, `credential-unavailable`, `provider-unavailable`, `timeout`, or an inconclusive `unknown` probe emits the `primary_model_unusable` operator alert. The alert evidence includes only safe metadata (provider, model, status, reason/suggestion) and never includes raw provider output or credential values.

Probe mechanism is provider-specific and intentionally separate from fallback activation: `claude-cli` performs a cheap model-addressed CLI probe, `opencode-cli` performs a minimal model-addressed `opencode run` probe from the agent cwd using the same model routing and credential env as normal turns, and `openai-api` / `anthropic-api` POST a minimal generation-class probe (`/chat/completions` / `/messages`) to the configured endpoint — `providerConfig.baseUrl` when set, else the provider default — authenticated with the key resolved via `providerConfig.apiKeyService` when set (`src/runtimes/agent/providers/primary-model-usability-adapters.ts`). A custom-endpoint instance therefore probes the endpoint it will actually serve from, not the provider's public API. This probe makes the startup surface explicit about account/model access.

Agent `/health` also exposes a top-level `turn_capability` block derived from runtime state: `model_usable`, `model_usability_status`, `last_successful_turn_at`, `last_turn_error_class`, and `last_turn_error_at`. `model_usable` is `true` after a successful primary model probe, `false` after a configured primary model usability failure that requires operator attention, and `null` when no definitive probe result exists yet. A failed user turn records only the failure class (for example `model-unavailable` or `unknown-terminal`) and a timestamp; raw provider stderr/stdout is not surfaced. Top-level `/health.status` becomes `degraded` when the agent runtime reports degraded health, when `model_usable` is `false`, or when a user turn has a recorded error with no later successful user turn. A later successful user turn clears `last_turn_error_class` and `last_turn_error_at`.

The `durability.outboundFailureEvidence` health block is a bounded,
content-free projection of outbound failure envelopes: `sampledRows` covers at
most the 500 newest rows and `groups` contains at most 20 aggregates by
`failureCode`, `stage`, `mutationState`, `evidenceCoverage`, `terminalState`,
`retryDecision`, `retryOwner`, and `remainingDelayBucket`. Each group includes
the earliest `nextEligibleAt` and aggregate `providerSubmissionCount`. It never
includes a recipient, message body, or raw provider error. Older prose rows
appear only as `outbound.legacy_unclassified`.

#### Cross-field validation rules

Beyond the per-field shapes above, the shared validator
(`src/core/agent-config-validator.ts`) rejects these combinations at
create/update time and at load/discovery (where the fleet surfaces them as a
config error):

- **Credential-routed `fallbackProvider` without `fallbackModel`.**
  `openai-api` and `anthropic-api` take their fallback-window model from
  `fallbackModel`; `opencode-cli` also needs the model prefix to select its
  one route credential. Only `claude-cli`, `codex-cli`, and `gemini-cli` may
  omit it and use their own default.
- **Malformed `fallbacks`.** `agentOptions.fallbacks` must be an array of at
  most 8 entries, cannot be combined with the legacy `fallbackProvider` /
  `fallbackModel` pair, cannot contain duplicate provider/model pairs, and
  cannot point an entry at the primary provider/model pair.
- **Credential-routed `fallbacks[]` entry without `model`.** `openai-api`,
  `anthropic-api`, and `opencode-cli` entries require an explicit `model`;
  only `claude-cli`, `codex-cli`, and `gemini-cli` entries may omit it.
- **Primary `provider: opencode-cli` without a resolvable model.** A non-empty
  top-level `model` or `models.conversation` is required so OpenCode's exact
  route credential can be selected before any session is spawned. Model
  omission remains valid for `claude-cli`, `codex-cli`, and `gemini-cli`.
- **Primary `provider: opencode-cli` with a model whose provider prefix maps to
  no known credential service.** OpenCode selects the child's key from the model
  prefix (e.g. `xai/grok-4` -> `xai`), so a resolvable-but-unmapped model (e.g.
  `MiniMax-M2` with no prefix, or `whatsoup-cloud/some-model`) would be admitted
  yet hard-fail every turn when `buildChildEnv` cannot pick a credential. Unless
  `providerConfig.apiKeyService` (with `baseUrl`) names the route explicitly, the
  model must be a `<provider>/<model>` id whose prefix is a mapped inference
  service. `buildChildEnv` enforces the same rule at spawn as a backstop; this
  admission check surfaces it as a clear config error instead of a runtime crash.
- **`providerConfig.baseUrl` with a non-`http(s)` scheme.** The value must be
  an absolute `http://` or `https://` URL.
- **`provider: opencode-cli` with `providerConfig.baseUrl` but no resolvable
  model.** The custom endpoint block written into `opencode.json` is only
  exercised when the instance's resolved model (top-level `model`, else
  `models.conversation`) routes to it; without one the endpoint would never be
  used. API providers consume `baseUrl` directly as an endpoint override and
  are exempt from this rule.
- **`providerConfig.apiKeyService` naming a non-provider or unknown service.**
  The value must be one of the inference-provider services in
  `PROVIDER_API_KEY_SERVICES` (`src/lib/provider-key-service.ts`) — the
  provider-only subset of the service→env-var map. Non-provider secrets (the
  health token, Pinecone, ElevenLabs) are rejected so a config cannot point
  `apiKeyService` at one and exfiltrate it through a custom `baseUrl`.
- **`providerConfig.apiKeyService` without `providerConfig.baseUrl`.** The key
  service only authenticates a custom endpoint; without one it would be
  silently inert.
- **Unsupported `providerConfig.executionProfile`.** When present, the value
  must be exactly `whatsoup-headless`. Arbitrary safe-looking agent names are
  rejected so a config cannot silently select a user/default policy.

A missing `sessionScope` is **not** an error: the runtime defaults it to
`single`, so load and discovery accept the omission rather than flagging a
config that would boot fine.

#### OpenCode headless execution profile

For `opencode-cli`, set `providerConfig.executionProfile` to the reserved
agent name provisioned for the instance, `whatsoup-headless`:

```jsonc
"model": "glm/glm-5.2",
"agentOptions": {
  "provider": "opencode-cli",
  "providerConfig": {
    "executionProfile": "whatsoup-headless"
  }
}
```

Every fresh turn, resumed turn, and model-usability probe with that field
configured passes exactly one `--agent whatsoup-headless` selector. WhatSoup
does not read OpenCode's `default_agent` and never adds `--auto`. An absent
field remains a legacy, report-only state during the first source rollout;
later hardened fallback admission treats that state as not aligned. A present
value other than `whatsoup-headless` fails config validation and the runtime
resolver also rejects it before spawn.

WhatSoup owns only the reserved selector contract. The fleet-policy package is
the single source for the versioned `whatsoup-headless` agent artifact and its
deployment; this repository does not synthesize an `agent` entry in
`opencode.json` or carry a second permission-policy template. The fleet source
is deliberately non-deployable until it has an exact workspace binding and
supported-version proof. A fleet lane becomes eligible only after separate
static resolution and an edit-plus-shell canary prove the installed profile.
Its permission rules are dispatcher policy, not an operating-system sandbox.

OpenCode children use a fresh positive environment allowlist. The non-secret
base is `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `TERM`, `NODE_PATH`,
`XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `TMPDIR`, plus the
instance/socket context `WHATSOUP_INSTANCE` and `WHATSOUP_MCP_SOCKET` when
configured. Config-root isolation may rewrite `HOME` and the XDG config/data
roots, but its controlling flag is not forwarded. The child does not receive
`SUDO_ASKPASS`, `ALLOW_M365_MUTATIONS`, `CLAUDE_CONFIG_DIR`, unrelated
connector/provider mutation flags, non-selected provider credentials, or
unknown secret-shaped parent variables.

#### Custom endpoint (`providerConfig.baseUrl`)

For `provider: opencode-cli`, `providerConfig.baseUrl` merges a custom
OpenAI-compatible provider block into the `opencode.json` written at startup;
for the API providers (`openai-api`, `anthropic-api`) it overrides the HTTP
endpoint the managed loop calls directly.

**Routing (opencode-cli):** with a `baseUrl` configured, sessions omit the
`-m`/`--model` argument and `opencode` resolves the model from
`opencode.json`'s top-level `model` field, which the startup merge points at
the custom block (`whatsoup-cloud/<model>`). The instance's resolved model
(top-level `model`, else `models.conversation`) is therefore the model id on
the endpoint itself, spelled exactly as the endpoint's catalog spells it —
model ids are case-sensitive, so copy them verbatim. Without a `baseUrl`,
sessions keep the `-m <model>` argument unchanged.

**Auth (opencode-cli):** the generated provider block references the endpoint
key as `options.apiKey: "{env:<ENVVAR>}"` (opencode env interpolation) — the
key value itself is never written to disk. The env var comes from the
service→env-var map (`src/lib/provider-key-service.ts`) for the keyring
service named by `providerConfig.apiKeyService`; when `apiKeyService` is
omitted, the service is derived from the configured model's prefix (e.g.
`minimax/MiniMax-M2` → `minimax`). The child environment selects exactly one
credential service: a valid `apiKeyService` for a custom endpoint takes
precedence; otherwise the selected model prefix must map to an inference
provider. An absent model is rejected during configuration admission; an
unmapped prefix is an explicit configuration error at spawn/probe time rather
than a credential superset. The selected service is
the only keyring lookup and, when present, the only provider credential added
to the child environment. A missing credential leaves that selected env var
absent for the existing pre-flight/runtime auth diagnostics. `apiKeyService`
must name an inference-provider service (`PROVIDER_API_KEY_SERVICES`) and
requires `baseUrl` (see
[Cross-field validation rules](#cross-field-validation-rules)).

**Headless permissions (opencode-cli):** WhatSoup's startup merge owns only the
generated MCP and optional custom-endpoint blocks. It preserves every existing
unrelated `agent` entry, removes the obsolete inline `whatsoup-headless` entry,
and never creates or replaces that reserved profile; the fleet-policy package
owns the external artifact. A route with
`providerConfig.executionProfile: "whatsoup-headless"` selects the externally
provisioned profile explicitly for every fresh, resumed, and model-usability
turn. Any other configured profile name is rejected.

WhatSoup does not infer this selector from OpenCode's `default_agent`, and does
not pass `--auto`, `--yolo`, or a blanket permission-bypass flag. A legacy
route without `executionProfile` remains non-hardened and must not pass fleet
fallback admission.
OpenCode permissions are an approval policy, not an operating-system sandbox:
they do not establish filesystem confidentiality, process isolation, or network
containment. Use an OS-level boundary when those properties are required. If
OpenCode still requests a denied permission, the unattended rejection is
classified as `provider_permission_denied` without retaining its dynamic path.
If the provider process closes successfully without a terminal result, the turn
now fails through the normal crash/finalization path and asks the user to retry
instead of leaving the turn indefinitely processing. A symlink-protected
`opencode.json` causes config writing, workspace provisioning, and runtime
startup to fail with a bounded non-secret configuration error; it does not
continue with an unwritten MCP configuration or an implicit agent.

OpenCode processes in one WhatSoup runtime share OpenCode's local SQLite state.
WhatSoup therefore serializes OpenCode turn and model-usability `run` process
lifetimes across chats and probes in that runtime, including the post-result or
post-timeout cleanup interval through the child's `close` event. Waiting does
not publish provider-turn ownership or assert typing. A wait
that reaches 30 seconds emits the warning source
`provider_execution_queue_pressure`; the source clears only when both the active
lease and FIFO queue are empty. `GET /health` exposes the process-local snapshot
at `runtime.agent.providerExecution`: `active`, `pending`, `oldestWaitMs`,
`totalWaits`, `maxPending`, `lastWaitMs`, `abortedWaits`, and `pressureActive`.
Sustained pressure degrades runtime health. This gate is process-local: separately
launched OpenCode commands or another WhatSoup process using the same XDG data
directory are not serialized and remain an explicit operational limitation.
SQLite/LockTimeout crash text is classified as `provider_state_locked` in the
existing crash, heal, and respawn evidence; generic account or workspace "locked"
messages do not match.

**Routing and auth (API providers):** `openai-api` / `anthropic-api` consume
`baseUrl` directly as the endpoint of the managed HTTP loop (default
`https://api.openai.com/v1` for `openai-api`), so any OpenAI-compatible
endpoint can serve an instance. `providerConfig` is instance-scoped and
API-type fallback entries inherit it (`src/runtimes/agent/fallback-config.ts`):
every `openai-api` entry in a chain hits the same `baseUrl` — one custom
endpoint per instance. A Groq fallback rung, end to end (provision the key
under service `groq` per
[Enabling provider fallback on a new host](#enabling-provider-fallback-on-a-new-host)):

```jsonc
"agentOptions": {
  "provider": "claude-cli",
  "fallbacks": [
    { "provider": "openai-api", "model": "llama-3.3-70b-versatile" }  // model REQUIRED for API entries
  ],
  "providerConfig": {
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyService": "groq"
  }
}
```

An aggregator that routes per model id can still serve several models through
the one inherited `baseUrl` — e.g. OpenRouter:

```jsonc
"fallbacks": [
  { "provider": "openai-api", "model": "meta-llama/llama-3.3-70b-instruct" },
  { "provider": "openai-api", "model": "qwen/qwen-2.5-72b-instruct" }
],
"providerConfig": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKeyService": "openrouter"
}
```

What this does **not** enable: two different custom endpoints (e.g. Groq and
OpenRouter) in one chain — that needs per-entry `providerConfig`, which is
future code work. Endpoint parity is the operator's to prove: before relying
on a new endpoint, force a canary window (`FALLBACK ON 5m`, step 5 below) and
confirm one streaming turn and one MCP tool-call turn succeed there. On `429`,
`Retry-After` is honored only up to 10 seconds
(`src/runtimes/agent/providers/rate-limit-retry.ts`); a longer wait fails the
turn into the chain. Decision record and endpoint pilot evidence:
`docs/specs/2026-07-03-openai-compatible-byok-providers-design.md` (internal,
publication-excluded). Maintainers extending the service map itself (new
`apiKeyService` values, probe coverage): see
[docs/architecture/provider-credential-services.md](architecture/provider-credential-services.md).

**Key resolution and account isolation (QR-104):** with `apiKeyService` set,
the key resolves service-env-var-first (a process-wide `GROQ_API_KEY` beats a
keychain `groq` entry — `lookupCredential`, `src/lib/keyring.ts`), and when
the service yields nothing at all the API providers take one final hop to
their provider-family default — `OPENAI_API_KEY` for `openai-api`,
`ANTHROPIC_API_KEY` for `anthropic-api`
(`src/lib/api-key-resolver.ts`). That last hop can
silently run a custom-endpoint instance on the wrong account's key, so it is
logged: `apiKeyService configured but keyring lookup missed — falling back to
env var; verify account isolation` (QR-104). During a pilot, treat that line
as a failed isolation check, not noise. The fleet credentials routes
(`PUT`/`DELETE`/`POST …/verify` on `/api/credentials/:service`) return
`envShadowed: true` whenever a process-wide env var is masking the stored
keyring entry.

> **Rotate wizard-typed keys.** Console builds before 2026-07 wrote any API
> key typed into the Add Line wizard's Model step to the instance's
> `config.json` as an inert top-level `apiKey`/`openaiKey` field (never read
> by any auth path). These fields are now stripped automatically on the next
> config update. If an instance's config carried one, treat that key as
> having been at rest on disk: rotate it, and delete the field by hand if the
> config will not be written soon.

#### Custom endpoint as the primary provider

The same `providerConfig` powers a custom endpoint as the PRIMARY provider —
not only as a fallback rung. Groq as primary, end to end (provision the key
under service `groq` per [Enabling provider fallback on a new host](#enabling-provider-fallback-on-a-new-host)
— the same provisioning routes apply to primary keys):

```jsonc
"agentOptions": {
  "provider": "openai-api",
  "providerConfig": { "baseUrl": "https://api.groq.com/openai/v1", "apiKeyService": "groq" },
  "model": "llama-3.3-70b-versatile",
  "fallbacks": [
    { "provider": "anthropic-api", "model": "claude-sonnet-5" }
  ]
}
```

The Add Line wizard exposes the same knobs at creation time: choosing an
API-type provider on the Config step reveals **Base URL** and **Keyring
Service** fields for a custom (BYOK) endpoint. After creation these provider
fields are file-edit only (see [docs/console-guide.md](console-guide.md));
restart the instance after editing. Verification paths are peers: the
[`FALLBACK ON` canary](#enabling-provider-fallback-on-a-new-host) exercises a
live turn, while `POST /api/credentials/:service/verify` runs a single
list-models probe without touching a session.

#### Provider fallback behavior

When the primary provider returns a usage-limit, rate-limit, auth-required, or model-unavailable terminal `result` (`src/runtimes/agent/runtime-turn-result-handler.ts`), the runtime:

1. **Tears down, explains briefly, and continues when safe.** The in-flight session is killed and the user receives a one- or two-line notice naming the switch reason and backup model, for example: "_Primary model hit a token/quota limit; switching until about 3:00 PM. Backup: OpenCode / minimax/MiniMax-M2.7. I will continue here._" If fallback credentials are missing, the notice says an operator has been notified and does not promise continuation. Provider policy-block results deliberately do **not** activate fallback.
2. **Arms a fallback window** (only when `fallbackProvider` or `fallbacks` is set). The first arm of a window (never an extension, and never the post-restart restore of a persisted window — the alert belongs to the original arm, once per window across restarts) raises the `provider_fallback_activated` operator alert carrying the reason, the selected entry's provider/model, and the window end; a post-restart restore instead raises `provider_fallback_restored` (the same window resuming — repeated restores are the crash-loop signature) carrying the original reason, the selected entry, the window end, and the resumed probe-attempt count; every deactivation of an active window raises `provider_fallback_reverted` carrying the revert reason (`window-elapsed`, `admin-disabled`, `primary-probe-ok`, ...), the window's own turn counts (served/empty during that window — not the process-lifetime totals), and the window duration; a completed replay raises `provider_fallback_replayed` carrying the reason and target entry (a failed replay raises only `runtime_provider_fallback_replay_failed` — never both for the same turn). The interrupted turn is replayed once on a freshly created fallback session only when the selected fallback target is usable and no tool side effects have started; it is not a general crash-replay path. Later sessions also route to that fallback until the window ends. With `fallbacks`, selection is static at arm/restore time: entries are checked in order for required key presence, the first eligible entry wins, and if every keyed entry is missing a key the runtime fails open to entry zero while alerting per-entry missing-key evidence. Usage-limit windows end at the reset time parsed from the provider message when available, else 5 hours from now, clamped to [1 minute, 24 hours]. Rate-limit windows use the default rolling window. Auth-required windows stay armed until a background primary recovery probe succeeds: while the remaining window exceeds the recheck cadence a standing probe re-checks every `WHATSOUP_PROVIDER_FALLBACK_PRIMARY_RECHECK_MS` (early recovery), and once the window reaches its end each failed probe extends it by one recheck interval. After `WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD` consecutive failed extension probes (default 12) the first `fallback_recovery_stalled` operator alert fires, and then re-fires at every subsequent multiple of the threshold (2T, 3T, …) within the same stall episode, up to the `WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_CEILING_MULTIPLE` escalation ceiling — cadenced re-surfacing without per-probe noise. The window keeps extending so the instance is never stranded on a dead primary. A second usage-limit hit while a window is active extends it — never shortens. **Probe-confirmed recovery is a typed transaction (DUR-02, honest re-scope):** the same fresh primary-usability result that ends the window also drives the revert, in one pass — the reused evidence (provider, model, status, `checkedAt`) is appended to that `provider_fallback_reverted` alert's evidence as `from_provider=… from_model=… to_provider=… to_model=… evidence_status=… evidence_provider=… evidence_model=… checked_at=… probe_validated=true post_revert_canary=not_run probe_attempts=N`. `probe_validated=true` is a genuine claim — the probe passed all three validation axes — but it is a PRE-revert check, not a post-revert canary (a real turn actually served through the reverted route); `post_revert_canary` is honestly `not_run` at receipt time because no such turn has happened yet. The SAME transaction clears `fallback_recovery_stalled` immediately if that stall episode had raised it (that incident is honestly about probe cadence, and a validated probe genuinely resolves it) — the stall clear is gated on `fallbackProbeAttempts` reaching `WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD` at deactivation time, true for ANY deactivation reason (not only a probe-confirmed one), so an admin-disable mid-stall clears it too, with honest `reason=… recovery=unconfirmed episode=abandoned` evidence instead of a receipt. `provider_fallback_activated`, however, stays open after a probe-confirmed revert until the real post-revert canary: the FIRST successful user turn served after the revert (outside any fallback window) clears it with `reason=post-revert-turn-success` evidence; a failing first post-revert turn leaves it open — no false "recovery confirmed" claim. A manual or window-elapsed deactivation (no receipt) clears `provider_fallback_activated` immediately, as it always has — it makes no probe-confirmed claim to defer. The transaction is instance-scoped only: it never reads or writes per-chat model pins, so a chat holding its own strict provider pin (`/model keep`) is unaffected by an instance-default revert.
3. **Persists the window across restarts.** The window is written to the singleton `agent_fallback_state` SQLite table (`src/runtimes/agent/fallback-state-db.ts`) and re-armed on startup, so a restart mid-window resumes on the fallback provider. Restored windows are clamped to at most 24 hours from startup; expired, corrupt, or no-longer-applicable rows are cleared and startup proceeds on the primary. The original activation time is preserved across extensions and restores, and the recovery-probe attempt count is persisted in the same row (additive `probe_attempts` column; rows written by older builds read back as 0) so a restart mid-stall resumes the stall clock instead of resetting it — without this, frequent restarts could keep a dead primary below the stall threshold forever. Each restore raises the `provider_fallback_restored` operator alert.
4. **Pre-flights credentials and binary on every window arm — without ever blocking.** When the selected fallback target resolves to a keyring service (`opencode-cli` uses the model's provider prefix, e.g. `minimax/MiniMax-M2` -> `minimax`; `openai-api` -> `openai`; `anthropic-api` -> `anthropic`; same-provider API fallback honors `providerConfig.apiKeyService`), a missing key raises the `fallback_credential_missing` operator alert, and a present key is probed against the provider's models endpoint (`src/runtimes/agent/providers/credential-verify.ts`) — but only for services with a verified probe endpoint: `anthropic`, `deepseek`, `minimax`, and `openai`. All other keyring services (`kimi`, `xai`, `groq`, `mistral`, `openrouter`, `google`, `fireworks-ai`, `togetherai`, ...) have no validity probe: the pre-flight returns `unknown` for them and degrades to the presence-only check, so `fallback_credential_invalid` cannot fire for those providers. The probe is fail-open: only a definitive 401/403 raises `fallback_credential_invalid`; network errors, timeouts, and unexpected statuses are ignored. The key value is never logged. In addition, CLI-backed providers (`opencode-cli`, `claude-cli`, `codex-cli`, `gemini-cli`) have their binary probed via `binary --version` (`src/runtimes/agent/providers/binary-preflight.ts`): a definitive ENOENT raises `fallback_binary_missing`; anything else is fail-open. Managed-loop providers (`openai-api`, `anthropic-api`) have no binary to probe. For `opencode-cli` with a selected model configured, a present binary additionally has its model catalog probed via `opencode models`: a model id absent from the catalog raises `fallback_model_unknown`, carrying the catalog's exact casing as a suggestion when the id differs only by case (model ids are case-sensitive, and a wrong-case id fails sessions with an error indistinguishable from an unknown model). The catalog probe is fail-open too: spawn errors, timeouts, and empty output stay silent. The window arms in all cases — no pre-flight blocks or reverts activation.
5. **Counts fallback turns.** Every completed user turn during an active window (compact and system turns excluded) increments process-local counters — `fallbackTurnsServed`, `fallbackTurnsEmpty`, `lastFallbackTurnAt` — surfaced in the `GET /health` `instance` block along with `effectiveProvider`, `fallbackReason`, `fallbackModel`, `fallbackResetAt`, `fallbackRecoveryProbeRequired`, `primaryModelUsability`, and the recovery-probe telemetry `probeAttempts` (consecutive failed extension probes in the current stall episode) and `lastProbeAt` (epoch ms of the most recent recovery probe, `null` until one runs); counters are reset on restart. Transition totals are counted the same way — `fallbackActivations` (first arms only; extensions and post-restart restores excluded), `fallbackReverts`, and `fallbackReplays` are process-local lifetime totals in the same `instance` block, reset on restart like the turn counters. Provider-reported turn cost is counted too: when a result event carries a finite `costUsd` (opencode today) it is logged beside the token counts and, while a fallback window is active, accumulated into `fallbackWindowCostUsd` — a process-local lifetime total (same semantics as `fallbackTurnsServed`) in the same `instance` block answering "what has fallback serving cost this process". The fleet `GET /api/lines/:name/provider-status` route forwards the same fields under `fallback.probeAttempts` / `fallback.lastProbeAt` / `fallback.windowCostUsd` / `fallback.activations` / `fallback.reverts` / `fallback.replays` (`null` when the instance health predates them). A turn that completes with zero visible output raises the `fallback_empty_turn` operator alert (the silent-dead-bot signal); the alert is deduplicated per chat using the `WHATSOUP_PROVIDER_FALLBACK_NOTICE_DEDUP_MS` window so a sustained silent-bot episode does not flood the operator channel. Counters always increment regardless of the dedup. On `per_chat` sessions the user additionally gets "_The backup model returned no reply — please resend or rephrase your message._"; `single`/`shared` sessions surface their existing generic `_(no response)_` fallback instead.

If no fallback activates for a rate-limit or model-unavailable terminal, the raw provider
result is suppressed and a deterministic, credential-free user notice is queued before the
session shuts down and the turn finalizes. This is identical for per-chat and shared/single
paths and with the response-registry dispatcher on or off; provider stderr or model/account
details are never forwarded as the notice.

Admins can force, end, or inspect the window from WhatsApp with `FALLBACK ON [<n>m|<n>h]` / `FALLBACK OFF` / `FALLBACK STATUS` — see [docs/runbook.md §7.2](runbook.md#72-force-or-inspect-provider-fallback).

#### Enabling provider fallback on a new host

When deploying an instance config that uses `fallbackProvider` or `fallbacks` to a machine where the stack has not run before, complete these steps before starting the service. The runtime will alert on any gap at activation time (`fallback_binary_missing`, `fallback_credential_missing`, `fallback_credential_invalid`, `fallback_model_unknown`), but early provisioning avoids the first-activation surprise. These provisioning routes apply equally to a custom endpoint used as the primary provider — see [Custom endpoint as the primary provider](#custom-endpoint-as-the-primary-provider).

1. **Install the fallback provider CLI and confirm it is on the service user's PATH.** Skip this step for API-type fallback providers (`openai-api`, `anthropic-api` — e.g. the Groq/OpenRouter recipes in [Custom endpoint](#custom-endpoint-providerconfigbaseurl)): they are managed HTTP loops with no CLI binary to install or probe.

   For `opencode-cli`:
   ```sh
   # Install opencode per the upstream instructions, then confirm:
   opencode --version
   ```
   The runtime spawns `opencode --version` at window-arm time (`src/runtimes/agent/providers/binary-preflight.ts`) and raises `fallback_binary_missing` if the binary is absent. The check runs on the service user's PATH, so install under that user or ensure the binary is in a PATH entry that the service environment inherits.

2. **Provision the provider API key** via one of three portable routes. The lookup order is: environment variable first (when no per-user scoping is requested), then platform keyring (`src/lib/keyring.ts:82`).

   **Route A — environment variable (universal).**
   Set the variable named in `SERVICE_ENV_MAP` (`src/lib/provider-key-service.ts`, re-exported from `src/lib/keyring.ts`):

   | Provider service | Environment variable |
   |-----------------|---------------------|
   | `minimax`       | `MINIMAX_API_KEY`   |
   | `deepseek`      | `DEEPSEEK_API_KEY`  |
   | `kimi`          | `KIMI_API_KEY`      |
   | `openai`        | `OPENAI_API_KEY`    |
   | `xai`           | `XAI_API_KEY`       |
   | `groq`          | `GROQ_API_KEY`      |
   | `mistral`       | `MISTRAL_API_KEY`   |
   | `openrouter`    | `OPENROUTER_API_KEY` |
   | `google`        | `GOOGLE_API_KEY`    |
   | `fireworks-ai`  | `FIREWORKS_API_KEY` |
   | `togetherai`    | `TOGETHER_API_KEY`  |

   Service names are opencode's models.dev provider ids — the prefix of the
   configured fallback model (`xai/grok-4` → `xai`). Note the catalog spells
   them `fireworks-ai` and `togetherai` (not `fireworks` / `together`). The
   same service name is the keychain service for Routes B and C below.

   For **systemd** managed instances, add a drop-in or `EnvironmentFile`:
   ```ini
   # ~/.config/systemd/user/whatsoup@<name>.service.d/fallback-key.conf
   [Service]
   Environment="MINIMAX_API_KEY=sk-…"
   # or: EnvironmentFile=%h/.config/whatsoup/<name>.env
   ```
   For **launchd** managed instances, add an `EnvironmentVariables` key to the plist (plists are generated in-process by `buildPlist()` in `src/fleet/platform.ts`; to regenerate and redeploy, follow [macOS launchd deployment](runbooks/macos-launchd-deployment.md)):
   ```xml
   <key>EnvironmentVariables</key>
   <dict>
     <key>MINIMAX_API_KEY</key>
     <string>sk-…</string>
   </dict>
   ```

   **launchd caveat:** generated plists emit only `PATH`/`HOME`/`TMPDIR`
   (+`WHATSOUP_NODE`) in `EnvironmentVariables` (`buildPlist()`,
   `src/fleet/platform.ts`) — there is no `EnvironmentFile` equivalent to the
   systemd units' per-instance `tokens.env`, so a hand-added key in a
   generated plist is LOST on the next `deploy:launchd.generated`
   regeneration. On macOS prefer Route B: API-provider keys are read
   in-process at request time, so the keychain entry alone is sufficient —
   no plist edit needed. Grant the service user's launchd context access to
   the item (`security add-generic-password -U …` under that user); keychain
   reads from a non-GUI launchd session fail when the login keychain is
   locked, which surfaces as `fallback_credential_missing` / QR-104 env
   fallback rather than an explicit error.

   **Route B — macOS Keychain.**
   The keyring reads via `security find-generic-password -s <service> -a <username> -w` (`src/lib/keyring.ts:128–134`), where `<service>` is the service name (e.g. `minimax`) and `<username>` is the OS username (`os.userInfo().username`). Store with the matching attributes:
   ```sh
   security add-generic-password -s minimax -a "$USER" -w
   # (bare -w: the command prompts for the value interactively, keeping the
   # key off argv — out of shell history and momentary `ps` visibility)
   ```

   **Route C — Linux GNOME Keyring (`secret-tool`).**
   The keyring reads via `secret-tool lookup service <service>` (`src/lib/keyring.ts:99–103, 109`), where `service` is the attribute name and the service name (e.g. `minimax`) is its value. Store with the matching attribute:
   ```sh
   secret-tool store --label="WhatSoup minimax key" service minimax
   # enter the key at the password prompt
   ```

3. **Set either the legacy single fallback pair or an ordered chain** in the instance `config.json`:
   ```json
   "agentOptions": {
     "fallbackProvider": "opencode-cli",
     "fallbackModel": "minimax/MiniMax-M2"
   }
   ```
   For multiple backups:
   ```json
   "agentOptions": {
     "fallbacks": [
       { "provider": "claude-cli", "model": "claude-opus-4-8" },
       { "provider": "claude-cli", "model": "claude-sonnet-4-6" },
       { "provider": "opencode-cli", "model": "minimax/MiniMax-M2" },
       { "provider": "opencode-cli", "model": "deepseek/deepseek-chat" },
       { "provider": "openai-api", "model": "gpt-4o-mini" }
     ]
   }
   ```
   To point `openai-api` entries at a custom OpenAI-compatible endpoint
   (Groq, OpenRouter, …), add the instance-level `providerConfig` block — see
   [Custom endpoint](#custom-endpoint-providerconfigbaseurl) for the worked
   recipes and the one-endpoint-per-instance constraint.

4. **Restart the instance** so the runtime loads the new config and arms any previously-persisted fallback window with the new pre-flight checks active.

5. **Verify.** From an admin WhatsApp DM:
   - `FALLBACK STATUS` — confirms the current window state and configured provider/model.
   - `FALLBACK ON 5m` — forces a 5-minute canary window; expect a reply served by the fallback provider. Check the `/health` endpoint `instance` block for `effectiveProvider` (flips to the fallback while the window is active), `fallbackTurnsServed`, and related fields.
   - For a custom `baseUrl` endpoint, use the canary window to confirm one streaming reply **and** one MCP tool-call turn — remote-endpoint parity for both is unproven until exercised. Remember that `groq`/`openrouter` keys get a presence-only pre-flight (no validity probe), so an invalid key first surfaces here, and watch the logs for the QR-104 isolation warning (see [Custom endpoint](#custom-endpoint-providerconfigbaseurl)).
   - Watch for the four arm-time alert sources: `fallback_binary_missing` (binary absent), `fallback_credential_missing` (key absent from keyring/env), `fallback_credential_invalid` (key rejected by provider API), `fallback_model_unknown` (model id absent from the provider catalog — usually a casing mismatch; the alert suggests the catalog's exact casing when one matches case-insensitively). These pre-flight probes run when a window first arms and when a restart restores a persisted window — never on extensions of an already-active window, so per-turn usage-limit extensions cannot storm the probes or the alerts. Any of these surfaces via the BOT_ERRORS alert pipeline within seconds of window activation. Further runtime (not pre-flight) sources exist: the transition alerts `provider_fallback_activated` (once per window, on the first arm — not re-raised when a restart restores the persisted window), `provider_fallback_restored` (each time a restart restores a persisted window — never counted as an activation), `provider_fallback_reverted` (once per window, on deactivation, with that window's turn counts and duration), and `provider_fallback_replayed` (once per activation, after the replay completes — a failed replay raises only `runtime_provider_fallback_replay_failed`); and `fallback_recovery_stalled`, fired once per stall episode when an `auth-required` window has extended through `WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD` consecutive failed primary recovery probes (re-firing at each subsequent multiple up to the escalation ceiling) and cleared on ANY deactivation once the episode reached that threshold — a probe-confirmed revert clears it immediately with the transition receipt, and a manual/window-elapsed deactivation clears it too, with honest "unconfirmed/abandoned" evidence instead. `provider_fallback_activated` clears immediately on a manual/window-elapsed deactivation, but on a probe-confirmed revert it stays open until the first real post-revert user turn succeeds (`reason=post-revert-turn-success`) — the genuine post-revert canary this design can produce; a failing first post-revert turn leaves it open.

#### Session Scopes

| Value | Behavior | Access mode constraint |
|-------|----------|------------------------|
| `single` | One shared agent session for all chats. | Any valid access mode (anti-echo AE1-AE4 runtime protections cover group resume safety). |
| `shared` | One shared session, multiple users welcomed. | Any valid access mode. |
| `per_chat` | One isolated agent-provider session per chat. | Any valid access mode. |

`/new` on an idle scope replaces the current session in place. When the target scope has a
turn in flight — a journaled user inbound, a processing or queued runtime turn (including
synthetic jobs without an inbound sequence), or a shared/single turn — `/new` now **interrupts
it**: the in-flight turn is aborted and terminalized through the same teardown `/kill-session`
uses (turn abort → durable turn finalization → session shutdown), the session is discarded,
and the reply is `*Interrupted the running task — starting new session* ✓`. A fresh session
spawns on the chat's next message. This makes `/new` the user-facing cancel for runaway long
jobs; the admitted turn still reaches a terminal transaction, so durability evidence is never
orphaned by the interrupt.

#### `agentOptions.sandbox`

Passed directly to agent sandbox enforcement hooks (`deploy/hooks/agent-sandbox.sh`). Sandboxed agent workspaces also install `deploy/hooks/poll-interaction-lint.mjs` as a fail-open `PostToolUse` diagnostic hook for poll/AskUser friction; it writes session-local JSONL telemetry and does not block tool calls.

| Field | Type | Description |
|-------|------|-------------|
| `allowedPaths` | string[] | Filesystem paths the agent may read/write. |
| `allowedTools` | string[] | Claude Code tools the agent may use. Empty array blocks all non-essential tools. |
| `allowedMcpTools` | string[] | MCP tools permitted within the sandbox. |
| `bash` | object | Bash execution policy: `{ "enabled": boolean, "pathRestricted": boolean }`. |
| `allowedEgress` | string[] | Opt-in network egress allowlist for the filtering proxy (#1607 / QR-008). Entries are `host` (any port) or `host:port` (exact); host match is case-insensitive; no wildcards. **Absent or omitted ⇒ no proxy is started and no egress restriction applies (today's behaviour, unchanged).** A present array (including `[]`) starts a loopback filtering proxy for this instance's agent subprocesses — see **Agent egress allowlist** below. |

**Missing-policy behaviour.** When the hook runs but `.claude/sandbox-policy.json` is absent it **fails closed** (denies, logs `sandbox_deny`) by default. Override with `WHATSOUP_SANDBOX_FAIL_OPEN=1` (see [Environment Variables → Internal / Bootstrap](#internal--bootstrap)).

**Bash `pathRestricted` is best-effort, not a real sandbox.** When `bash.pathRestricted` is `true`, the hook scans the *raw* command string and denies obvious out-of-sandbox escapes: absolute paths outside `allowedPaths` (including quoted paths with spaces), `../` traversal, known credential paths (`.ssh/`, `.gnupg/`, `secret-tool`), tilde expansion (`~`, `~user`), `$HOME`/`$XDG_*` and their brace/quote/default-value split forms, and command substitution (`$(...)`, backticks). This raises the bar against low-effort escapes but **cannot fully contain bash** — a shell can still construct an out-of-sandbox path at runtime in ways a static string scan cannot see (e.g. values read from files, `eval`, `base64 -d`, `$IFS` tricks, env vars assigned earlier in the same command). For hard isolation, run the agent under an OS-level boundary (separate UID, container, or `sandbox-exec`/`bwrap`) in addition to this hook. The residual-bypass note in `deploy/hooks/agent-sandbox.sh` documents this scope.

**Network egress is NOT confined by this hook.** The sandbox hook inspects filesystem paths in the command string only — it applies no network restriction. By default, any subprocess an agent starts (`curl`, `node`, `python`, …) can open a connection to any host; **agent subprocess network egress is unbounded unless the opt-in egress allowlist below is configured.**

#### Agent egress allowlist (`agentOptions.sandbox.allowedEgress`)

Setting a **present** `allowedEgress` array (see the sandbox field table above) — including `[]`, which is deny-all — starts a **loopback filtering forward-proxy** with the instance. The agent child processes receive `HTTP_PROXY`/`HTTPS_PROXY` pointing at it (plus `NO_PROXY=localhost,127.0.0.1`), in both UPPER and lower case (curl reads lowercase `http_proxy` for plain HTTP), and the proxy permits only allowlisted destinations (HTTP forward + HTTPS `CONNECT`), refusing and logging everything else (`sandbox_egress_deny`). An empty `[]` allowlist therefore runs the proxy and denies every host; only an absent/undefined `allowedEgress` skips the proxy. The allowlist is read back off `.claude/sandbox-policy.json` per request, so a live edit takes effect without a restart.

- **Opt-in / opt-out:** absent `allowedEgress` ⇒ no proxy, no env vars, behaviour unchanged. A present array (including `[]` = deny-all) enables the proxy for that instance.
- **Fail-closed:** an empty/corrupt/unreadable policy denies all egress; a proxy that cannot start aborts instance start rather than running unconfined. `WHATSOUP_SANDBOX_FAIL_OPEN=1` is the single documented escape hatch (relaxes both not-on-allowlist and unreadable-policy denials, logged).
- **Scope — defense-in-depth, not a kernel-hard boundary.** The proxy confines only proxy-aware traffic (subprocesses that honour `*_PROXY`). A subprocess that dials a raw socket or unsets the proxy env vars is **not** confined by this layer; a host-firewall egress backstop consuming the same allowlist is the planned follow-up (see QR-008 / issue #1607). Do not treat this as OS-hard containment on its own.

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

#### `agentOptions.commandSurface`

Per-instance command-surface policy overlay (W1-T9b): `{ "disabled": ["<command>", …], "defaultVerbosity": "terse"|"normal", "optionDefaults": { "<command>": { "<option>": "<default>" } } }`. The block may disable commands and set cosmetic defaults only — it has no gate/venue/visibility fields by design (those flow exclusively from the command-registry catalog). Validated by `src/core/agent-config-validator.ts` on create/update/load/discovery.

> **Note:** `agentOptions.commandSurface` is accepted but not yet enforced (enforcement lands with T9c) — the block validates and persists, but no runtime path consumes it yet, and the validator emits a startup warning saying so.

### `chatOptions`

Chat-specific settings. Currently the only field is `openaiProviderConfig`,
covered below; more chat-runtime knobs may be added here over time.

#### Custom endpoint for chat instances (`chatOptions.openaiProviderConfig`)

`type: 'chat'` instances can override the OpenAI chat-completions endpoint and
credential per instance instead of relying on the process-wide `OPENAI_BASE_URL`
env var (QR-218 PR-2):

```jsonc
"chatOptions": {
  "openaiProviderConfig": {
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyService": "groq"
  }
}
```

**Routing and auth:** `src/runtimes/chat/providers/openai.ts` consumes
`baseUrl` directly as the OpenAI SDK's `baseURL` option (default
`https://api.openai.com/v1` when omitted); `apiKeyService` names the keyring
service that authenticates it, resolved via the same `resolveApiKey()`
precedence the agent HTTP providers use (`src/lib/api-key-resolver.ts`):
service-env-var-first, then platform keyring, then the conventional
`OPENAI_API_KEY` env var as a final fallback — logging the QR-104 isolation
warning when that last hop actually yields a key. An instance that sets
neither field constructs the OpenAI client exactly as before (bare
`new OpenAI()`), so `OPENAI_BASE_URL` remains fully backward-compatible for
chat instances that configure nothing.

**Console:** Chat instances expose these fields in the Add Line wizard's
Model step and in the line configuration edit dialog as **Custom OpenAI
endpoint** and **Keyring Service**. The console writes only the endpoint URL
and service name to `config.json`; the API key value must already be set on
the host keyring or in the matching service env var. Choose no keyring service
to keep the conventional `OPENAI_API_KEY` fallback.

**Validation:** same shape rules as `agentOptions.providerConfig` —
`baseUrl` must be a non-empty, parseable `http://`/`https://` URL;
`apiKeyService` must name an inference-provider service in
`PROVIDER_API_KEY_SERVICES` (`src/lib/provider-key-service.ts`) — the
provider-only subset of `SERVICE_ENV_MAP`, so a config cannot name a
non-provider secret (health token, Pinecone, ElevenLabs) and exfiltrate it
via a custom `baseUrl` — and requires `baseUrl` to be set (a key service with
no endpoint to authenticate would be silently inert). Unlike
`agentOptions.providerConfig`, there is no "custom endpoint needs a routed
model" rule — every chat `generate()` request already carries its own model,
so `baseUrl` alone is never inert. A malformed `chatOptions.openaiProviderConfig`
is rejected at CREATE/PATCH and at load — it does not silently boot.

**Scope:** OpenAI chat completions only. Anthropic chat
(`src/runtimes/chat/providers/anthropic.ts`) is separate, and Whisper
voice-note transcription uses the dedicated
[`transcriptionOptions.openaiProviderConfig`](#custom-endpoint-for-whisper-transcription-transcriptionoptionsopenaiproviderconfig)
field below.

### `transcriptionOptions`

Shared transcription settings for OpenAI Whisper. The field is valid for chat,
agent, and passive instances because chat voice notes, agent media-prep, and
the global MCP `transcribe_audio` tool all call the same transcription chain.

#### Custom endpoint for Whisper transcription (`transcriptionOptions.openaiProviderConfig`)

Any instance can override the OpenAI Whisper endpoint and credential for
voice-note/audio transcription:

```jsonc
"transcriptionOptions": {
  "openaiProviderConfig": {
    "baseUrl": "https://api.groq.com/openai/v1",
    "apiKeyService": "groq"
  }
}
```

**Routing and auth:** `src/runtimes/chat/providers/transcription/openai-whisper.ts`
consumes `baseUrl` as the OpenAI SDK's `baseURL` option and resolves
`apiKeyService` with `resolveApiKey({ envVar: "OPENAI_API_KEY" })`. A
keyring-only config is active: `isAvailable()` consults the resolved key, not
only `process.env.OPENAI_API_KEY`. When `transcriptionOptions` is unset, the
provider preserves the legacy bare `new OpenAI()` construction, so
`OPENAI_BASE_URL` and `OPENAI_API_KEY` remain backward-compatible fallbacks.

**Validation:** `transcriptionOptions.openaiProviderConfig` uses the same
shape rules as `chatOptions.openaiProviderConfig`: `baseUrl` must be a
non-empty `http://`/`https://` URL; `apiKeyService` must be in
`PROVIDER_API_KEY_SERVICES`; and `apiKeyService` requires `baseUrl` so the
selected key cannot be silently inert. A malformed value is rejected at
CREATE/PATCH and load.

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

### Agent config-root isolation

`WHATSOUP_AGENT_CONFIG_ROOT_ISOLATION` is an opt-in prototype for sandbox-per-chat
agent workers. It controls only the child process environment built by
`src/runtimes/agent/providers/child-env.ts`.

- **Unset (default):** spawned CLI workers keep the parent `HOME`,
  `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` behavior. This preserves current
  host-global Claude/Codex/OpenCode config reachability.
- **Set to `"1"` and sandbox-per-chat supplies a workspace `configRoot`:**
  spawned CLI workers receive `HOME=<workspace>/.agent-home`,
  `XDG_CONFIG_HOME=<workspace>/.agent-home/.config`, and
  `XDG_DATA_HOME=<workspace>/.agent-home/.local/share`.
- Any other value is treated as unset.

The runtime supplies the generated `configRoot` only for sandbox-per-chat
sessions. This flag should stay default-off until Claude/Codex/OpenCode behavior
has been validated with synthetic roots for the target CLI versions.

### `twilioConfig`

Selects the optional Twilio SMS transport for this instance. Stage 2 supports
outbound text, poll-mode inbound text, webhook-mode inbound with signature
validation, and recorded voicemail with transcription. Operational guidance,
identity model, limitations, and keyring provisioning live in the runbook:
[`docs/runbooks/twilio-transport.md`](runbooks/twilio-transport.md).

```json
"transport": "twilio",
"twilioConfig": {
  "account": "sms-agent",
  "accountSid": "AC00000000000000000000000000000000",
  "authTokenService": "twilio-sms-agent",
  "phoneNumber": "+15550001111",
  "inboundMode": "poll",
  "pollIntervalMs": 15000,
  "rateLimit": { "smsPerMinute": 30 }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `account` | string | yes | — | Channel account segment for the `sms:<account>` channel ID. Must match `^[a-z][a-z0-9-]{0,63}$`. Changing it changes the channel identity. |
| `accountSid` | string | yes | — | Twilio Account SID. Must match `^AC[0-9a-f]{32}$` (hex must be lowercase). |
| `authTokenService` | string | yes | — | OS keyring **service name** for the auth token — never the token itself. Non-empty, no whitespace, max 128 chars. Resolved via `src/lib/keyring.ts` `lookupCredential` at first use; no environment-variable fallback exists for Twilio. |
| `phoneNumber` | string | XOR | — | E.164 sender number (`^\+[1-9]\d{6,14}$`). Exactly one of `phoneNumber` or `messagingServiceSid` must be set. |
| `messagingServiceSid` | string | XOR | — | Messaging Service SID sender. Must match `^MG[0-9a-f]{32}$` (lowercase hex). Without `phoneNumber`, inbound polling uses a single unfiltered call listing all messages on the account in both directions (no targeted per-number filtering). |
| `inboundMode` | string | no | `poll` | `poll` (REST polling) or `webhook` (signature-validated HTTP listener). |
| `webhook.publicBaseUrl` | string | webhook-mode | — | Public HTTPS base URL for Twilio to call. Trailing slash is stripped by the loader. Signature validation depends on this matching exactly. |
| `webhook.listenPort` | integer | webhook-mode | — | Local listener port (`[1, 65535]`; must not equal `healthPort`). Bind address defaults to `127.0.0.1`; use an HTTPS proxy/tunnel. |
| `webhook.listenAddress` | string | no | `127.0.0.1` | Override local bind address. |
| `voice.enabled` | boolean | no | `false` | Enable voicemail + `placeCall`. Requires `inboundMode:'webhook'` and `phoneNumber`. |
| `voice.voicemailMaxLengthSec` | integer | no | `120` | Max recording length (`[5, 600]`). |
| `voice.voicemailGreeting` | string | no | built-in | Custom `<Say>` greeting text (≤ 500 chars). |
| `pollIntervalMs` | integer | no | `15000` | Inbound poll interval; also the lookback window at connect. Range `[5000, 86400000]`. |
| `rateLimit.smsPerMinute` | integer | no | `30` | Range `[1, 600]`. Enforced per destination as a sliding one-minute window at the send seam; over-cap sends are **delayed (queued FIFO), never rejected**. The cap is in-process, in-memory state only: a restart resets it, and it is **not** shared across multiple processes sending from the same Twilio number — each process enforces its own independent cap, so N processes together allow up to N× the configured rate. Surviving restarts or coordinating across processes would require a persistent store, which is not implemented. |

### Validation Rules Summary

The loader enforces these constraints before the process starts:

- `name` must match the directory name.
- `type` must be `chat`, `agent`, or `passive`.
- `accessMode` must be one of the four valid values.
- `adminPhones` must be a non-empty array of non-empty strings.
- `chat` instances must have a non-empty `systemPrompt`.
- `passive` instances must not have a `systemPrompt` and must use `accessMode: self_only`.
- Fleet create/update APIs default omitted `agentOptions` to `sessionScope: per_chat` with a per-instance workspace under the user's home directory.
- `agent` instances may omit `sessionScope` (the runtime defaults it to `single`); a present value must be `single`, `shared`, or `per_chat`. An empty or missing `cwd` is normalized by the fleet API before persistence.
- `agentOptions.sandboxPerChat: true` requires `sessionScope: per_chat`.
- `agentOptions.perChatConversationBound: true` requires `sessionScope: per_chat` and is rejected together with `sandboxPerChat: true`.
- The fallback/custom-endpoint combinations listed under [Cross-field validation rules](#cross-field-validation-rules) are rejected.
- `agentOptions.allowM365Mutations`, when present, must be a boolean.
- `chatAliases`, when present, must be an object of non-empty alias to JID strings.
- `profiles`, when present, must be an object of profile names to profile objects with only `prefix`, `tag`, and `linkPreview` fields.
- `transport`, when present, must be `baileys` or `twilio`.
- `twilioConfig` is required when `transport` is `twilio` and rejected otherwise; its field rules (SID shapes, sender XOR, inbound mode, webhook block, voice coherence, numeric ranges) are listed under [`twilioConfig`](#twilioconfig).

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

$XDG_DATA_HOME/whatsoup/tmp/<name>/           (default: ~/.local/share/...)
  process temp      — Runtime `TMPDIR`; old files are swept hourly after 3 hours

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
| 26 | Rebuilds pre-existing `outbound_sends` tables so the caller CHECK constraint allows Reply Guarantee Protocol fallback audit rows (`rgp`) |
| 27 | Message query performance indexes on timestamp/from-me, timestamp/content-type, and token counters when token columns exist (`runMigration27`) |
| 28 | `pending_polls` table — persists `AskUserQuestion`/`send_poll` state across runtime restarts. Columns: `map_key` (PK), `chat_jid`, `tool_id`, `source`, `resolution`, `payload` (JSON), `created_at`, `closes_at`, `hard_closes_at`. Indexes on `chat_jid` and `closes_at`. Rehydration runs at `AgentRuntime.start()`; rows with `hard_closes_at <= now` are dropped after a one-line "decision expired during downtime" notice. (`runMigration28`) |
| 29 | Normalizes any existing millisecond-scale `messages.timestamp` rows down to Unix epoch seconds so message ordering, retention, enrichment windows, and fleet displays use one timestamp unit (`runMigration29`) |
| 30 | Adds `scheduled_messages.timezone` (IANA zone) so recurring schedules evaluate their cron in the user's timezone (DST-aware); `NULL` preserves the legacy UTC interpretation (`runMigration30`) |
| 31 | Adds the `llm_attempts` table (`sender_jid`, `attempt_at`) — records every LLM invocation, separate from the `rate_limits` (successful-response) counter, so outage/retry LLM cost is observable without charging the user's response rate-limit (`runMigration31`) |
| 32 | Adds `scheduled_messages.send_started_at` so scheduler crash recovery can distinguish pre-send claims from uncertain in-flight sends and fail closed instead of blindly replaying accepted messages (`runMigration32`) |
| 33 | Adds `auth_loss_signal` with active-signal and classifier indexes so auth-loss evidence can be recorded once, resolved after stable authenticated-open dwell, and counted across later recurrences (`runMigration33`) |
| 34 | Adds nullable `inbound_events` continuity-candidate marker columns (`continuity_candidate_reason`, `continuity_candidate_source`, `continuity_candidate_marked_at`) so restart recovery and runtime fault/disarm branches can tag no-terminal-outbound inbounds before any queue/consumer exists (`runMigration34`) |
| 35 | Rebuilds `messages_fts_delete` and `messages_fts_update` triggers with an `OLD.deleted_at IS NULL` guard on the FTS `'delete'` command, so a hard-delete or content_text update of a since-soft-deleted row no longer double-deletes the FTS entry (which threw `database disk image is malformed`, crashing retention pruning and transcription updates) — QR-115 (`runMigration35`) |
| 36 | Adds nullable `inbound_events.failure_class` — a bounded, content-free failure driver stamped alongside `terminal_reason = 'error'` on failed rows; vocabulary is gated in code (`src/core/inbound-failure-class.ts`), no CHECK, no default, no backfill (`runMigration36`) |
| 37 | Adds `turn_terminal_records`, the unique durable terminal decision for each inbound/turn/generation tuple, with recovery-owner coherence and conservative reply-guarantee disarm constraints (`runMigration37`) |
| 38 | Adds linked `turn_recovery_jobs` with immutable replay envelopes, blocked-unsafe promotion, claim and assignment epoch fences, bounded retry lifecycle, supervisor indexes, and a delivery-op lookup index for terminal echo fencing (`runMigration38`) |
| 39 | Adds the nullable, seven-field all-or-none completed-delivery identity bundle to `session_checkpoints`, including its dedicated completed inbound sequence, with insert/update triggers that reject partial identity (`runMigration39`) |
| 40 | Requires every transferred recovery owner to reference one exact unresolved outbound op (`pending`/`submitted`/`maybe_sent`) with matching terminal, inbound, owner, and routing identity; rejects invalid pre-existing transfers/jobs and any legacy completed job without terminal source plus selected-delivery proof on upgrade; adds auditable worker/echo completion proof and late-echo conflict fields; makes linked proof immutable/retained so retention can prune only proof-complete old chains; and safely clears legacy six-field checkpoint bundles that cannot prove their completed sequence (`runMigration40`) |
| 41 | Adds append-only recovery plans, per-inbound operator catch-up dispositions, later-echo delivery corroboration, recovery-run linkage, proof indexes, and immutability/retention triggers. This source is byte-for-byte locked to the migration already applied on deployed Q databases (`src/core/database-migration-41.ts`). The migration runner attests its required parent schema, foreign key, and exact owned-object hashes before recording receipt 41; a partial or same-name/no-op schema is rejected. |
| 42 | Adds the historical operator catch-up delivery-proof views, closure validation, unique closure index, and proof-anchor retention contract. This source is byte-for-byte locked to the migration already applied on deployed Q databases and must never be rewritten in place (`src/core/database-migration-42.ts`). |
| 43 | Forward-repairs historical schema 42 by normalizing closure uniqueness, materializing immutable proof witnesses, hardening proof-anchor retention, and preserving exact idempotent closure receipts. It accepts the exact original deployed schema-42 shape and the attested hardened artifact while rejecting partial, drifted, ambiguous, unwitnessed, or orphaned state. A historical `selected_corroborated` closure is grandfathered only as an immutable witness and replay blocker; later corroboration cannot authorize a new irreversible closure. Operational tooling uses the exported read-only canonical-schema attestation before closure (`src/core/database-migration-43.ts`). |
| 44 | Adds `total_cache_read_tokens`/`last_compact_cache_read_tokens` to `agent_sessions` (idempotent ALTERs, no-op if `agent_sessions` is absent). Splits the token-accounting semantics: `total_input_tokens` now accumulates only genuinely-new input (base + cache_creation) per turn; `total_cache_read_tokens` accumulates the cache-read portion separately (a repeated re-read of prior context, not new consumption — previously conflated into `total_input_tokens`, inflating it ~O(turns²) on long conversations). No backfill: historical rows keep their old (inflated) `total_input_tokens` value with `total_cache_read_tokens = 0` for that history. |
| 45 | recovery_runs.status column — first-class terminal-failure status (DEFAULT 'started', terminal 'completed'/'failed') with backfill (completed_at IS NOT NULL → 'completed'); wires finalize→'completed' / recordIncomplete→'failed' (`src/core/database-migration-45.ts`, #1789) |
| 46 | Durable background work: `background_work` (the Work Ledger — registers an in-session worker against a `conversation_key` and a lease, so the work outlives its parent session) and `work_results` (the Results Outbox — durable summary/artifact rows drained by an independent delivery daemon). Worker registration replaces "results ride the parent's stdout", which is why a SIGKILLed parent previously stranded finished work. `recovered` and `produced_at` are first-class columns so a result produced after its parent died is delivered marked and age-stated rather than presented as current. `delivery_dedupe_key` is UNIQUE, making at-least-once delivery safe to retry. `worker_kind` is CHECK-constrained to `agent_subagent` in this stage; operator-side scripts join later via a CLI shim (`src/core/database-migration-46.ts`) |
| 47 | Adds independently attested update and replacement fences for a recovery-linked `inbound_events` receipt. Recovery replay derives trusted identity and chronology from that journal row, so direct `seq`/`received_at` changes and replacement conflicts from either `INSERT OR REPLACE` or `UPDATE OR REPLACE` by linked sequence or message ID fail closed even when SQLite recursive triggers are disabled. Unlinked receipt correction or replacement, linked no-op updates, and unrelated inbound lifecycle updates remain allowed. The migration validates parent tables and columns, rejects any drifted same-name trigger, and preserves the deployed migration-40 identity trigger unchanged (`src/core/database-migration-47.ts`). |
| 48 | Adds nullable `recovery_runs` failure-context columns — `error_kind` (the failing phase, e.g. `reconcile_maybe_sent_outbound`) and `error_message` (the primary error text) — so a failed recovery run carries a durable, queryable reason instead of burying it in the free-text `notes` JSON. Both are NULL for runs that did not fail (started/completed); no CHECK, no default, no backfill. Migration 45 (#2139) recorded THAT a run failed; this records WHY (`src/core/database-migration-48.ts`, #1786 salvage). |
| 49 | Adds `memory_consolidation_runs`, a content-free execution-receipt table for typed consolidation mode/status/stage/cause, retryability, evidence coverage, bounded aggregate counters, overlap skips, absolute leases, and attempt/completion/success timestamps. Strict CHECK constraints exclude partial terminal state and require `success_at` exactly for successful/no-work outcomes; retention keeps the newest 100 receipts, removes terminal rows older than 30 days, and enforces a 10,000-row terminal cap (`src/core/database-migration-49.ts`). |

Recovery plans, runs, disposition links, delivery corroboration, and closure witnesses are retained
as an indefinite audit ledger. There is currently no TTL or destructive pruning contract for these
rows. Capacity work must archive them with a provenance-preserving migration; operators must not
delete proof rows directly or bypass their retention triggers.


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
| `tokenUsage` | `{ input: number, output: number }` | Lifetime token totals summed from `messages.input_tokens`/`output_tokens` (chat runtime) and `agent_sessions.total_input_tokens`/`total_output_tokens` (agent runtime). Requires Migration 11. As of Migration 44, the agent-runtime `input` figure is genuinely-new input only (cache-read re-reads excluded, tracked separately in `agent_sessions.total_cache_read_tokens`, not included here) — smaller and more accurate than before, not a behavior regression. |
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
