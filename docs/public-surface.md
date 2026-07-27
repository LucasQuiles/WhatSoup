# WhatSoup Public-Surface Registry

This file is the manifest of WhatSoup's external compatibility contract. It lives at the
location named by [docs/specs/2026-05-10-compatibility-deprecation-policy-design.md §9](specs/2026-05-10-compatibility-deprecation-policy-design.md#9-public-surface-registry)
and is what the deprecation policy enforces against. The policy's bootstrap caveat (§9.3)
is currently in effect: until the v1.0.0 baseline cut, surfaces documented in
`docs/configuration.md`, `docs/tools.md`, `docs/runbook.md`, the README, and the live specs
are presumed public. This file makes that presumption explicit.

**How to read this file**

- **Identifier** — stable dotted namespace; what release notes and migration domains refer to.
- **Type** — `http-api`, `mcp-tool`, `config-key`, `npm-script`, `deploy-artifact`,
  `runtime-mode`, `on-disk-artifact`, `env-var`.
- **Source of truth** — repository path (with line range when the source is monolithic).
  The registry does not duplicate schema; follow the link to the canonical definition.
- **Schema version** — current schema version for surfaces tied to a migration domain.
  Blank when not applicable (e.g., HTTP routes).
- **Stability** — `stable` (full deprecation policy), `beta` (public but reserves the right
  to break with one minor of notice), `experimental` (public for experimentation, may change
  without a deprecation window), `internal` (not in the contract — listed here only when an
  artifact path is publicly visible but the surface inside it is not).
- **Status** — `active`, `deprecated`, `removed-in:vN`. Deprecated entries link to the
  release-notes anchor where the deprecation was announced and name the removal-target
  version per §9.1.
- **Notes** — operator-facing context: scope, replay policy, deprecation removal date, etc.

**How to update this file**

Every promotion (internal → public) requires: registry entry here, documentation entry in
the relevant reference (`docs/configuration.md`, `docs/tools.md`, README API table, or
`docs/runbook.md`), and a release-notes entry under "Public surface additions" per §10.2.
Every deprecation requires: status change here, runtime/operator warning where feasible,
and a release-notes entry under "Deprecations" naming the removal-target version per §5.

**Maintainer:** WhatSoup core team. Registry drift is a hard gate in CI and release checks:
`npm run guard:public-surface-drift` fails when registry source paths, the required npm
script entry, documented MCP modules/tool counts, or required MCP identifiers drift. The
v1.0.0 baseline cut remains the point where the registry becomes the sole source of public
status; before that cut, documented surfaces still inherit the bootstrap caveat in §9.3.

---

## HTTP API — Fleet server

Canonical route table: [`src/fleet/index.ts:294-349`](../src/fleet/index.ts) (`ROUTES`
array). Operator-facing description: [README §Fleet API](../README.md#fleet-api). The fleet
server binds to `127.0.0.1:9099` by default and is gated by the root fleet token
(`Authorization: Bearer`), an audience-scoped ticket, or the legacy `?token=` query string
(deprecated — see entry below).

| Identifier | Method + Path | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `http:fleet.providers.list` | `GET /api/providers` | `src/fleet/index.ts:348` | beta | active | Provider catalog (id, displayName, type, needsApiKey, providerConfig fields) derived from `PROVIDER_IDS` |
| `http:fleet.credentials.set` | `PUT /api/credentials/:service` | `src/fleet/index.ts:349`, `src/fleet/routes/credentials.ts` | beta | active | Set or rotate a provider key (`{"value": string}`, single-line, ≤4096 bytes). Closed allowlist; never reads back. Returns `{ ok, service, backend, envShadowed }`. |
| `http:fleet.credentials.delete` | `DELETE /api/credentials/:service` | `src/fleet/index.ts:350`, `src/fleet/routes/credentials.ts` | beta | active | Remove a stored provider key. Returns `{ ok, service, envShadowed, inUse }`; 404 when no key was stored. |
| `http:fleet.credentials.verify` | `POST /api/credentials/:service/verify` | `src/fleet/index.ts:351`, `src/fleet/routes/credentials.ts` | beta | active | One live list-models probe using the stored key (never carried in the request). 10s per-service cooldown (429); returns `{ ok, service, status, envShadowed }`. |
| `http:fleet.credentials.read-rejected` | `GET /api/credentials/:service` | `src/fleet/index.ts:352`, `src/fleet/routes/credentials.ts` | beta | active | Always `405`: credentials are write-only and never read back. |
| `http:fleet.lines.list` | `GET /api/lines` | `src/fleet/index.ts:353` | stable | active | List instances + health |
| `http:fleet.lines.create` | `POST /api/lines` | `src/fleet/index.ts:354` | stable | active | Create instance |
| `http:fleet.lines.get` | `GET /api/lines/:name` | `src/fleet/index.ts:364` | stable | active | Instance detail + config |
| `http:fleet.lines.delete` | `DELETE /api/lines/:name` | `src/fleet/index.ts:363` | stable | active | Stop + cleanup |
| `http:fleet.lines.exists` | `GET /api/lines/:name/exists` | `src/fleet/index.ts:355` | stable | active | Registration probe |
| `http:fleet.lines.provider-status` | `GET /api/lines/:name/provider-status` | `src/fleet/index.ts:356` | beta | active | Per-instance primary/fallback provider, key presence (boolean), resolved primary model, custom-endpoint visibility (`endpointHost` — URL host only — and `apiKeyService` on BOTH `primary` and `fallback`, attributed to the role whose provider actually consumes `providerConfig`: `openai-api`/`anthropic-api` either role, `opencode-cli` as primary only; for the API providers `apiKeyService` is the explicit `providerConfig` override (`null` = no override), for `opencode-cli` it is the model-prefix-derived service `keyPresent` checks; `null` when not consumed by that role's provider or unparseable on disk; readable by any fleet-token or `api`-audience ticket holder — the key-service name identifies the OS-keyring entry, an accepted observability tradeoff), fallback reason/model/reset/probe state, fallback window/counter state, effective provider, active fallback-chain entry, chain eligibility, and line reachability |
| `http:fleet.lines.config-update` | `PATCH /api/lines/:name/config` | `src/fleet/index.ts:378` | stable | active | Update `config.json` |
| `http:fleet.lines.auth-sse` | `GET /api/lines/:name/auth` | `src/fleet/index.ts:379` | stable | active | QR-code SSE stream |
| `http:fleet.lines.restart` | `POST /api/lines/:name/restart` | `src/fleet/index.ts:376` | stable | active | Restart unit |
| `http:fleet.lines.stop` | `POST /api/lines/:name/stop` | `src/fleet/index.ts:377` | stable | active | Stop unit |
| `http:fleet.lines.send` | `POST /api/lines/:name/send` | `src/fleet/index.ts:372` | stable | active | Send message; accepts `chatJid` or alias `to` + optional `profile` |
| `http:fleet.lines.access-update` | `POST /api/lines/:name/access` | `src/fleet/index.ts:374` | stable | active | Update access control |
| `http:fleet.lines.access-view` | `GET /api/lines/:name/access` | `src/fleet/index.ts:370` | stable | active | View access list |
| `http:fleet.lines.mark-read` | `POST /api/lines/:name/mark-read` | `src/fleet/index.ts:375` | stable | active | Zero unread + chatModify |
| `http:fleet.lines.contacts-save` | `POST /api/lines/:name/contacts` | `src/fleet/index.ts:373` | stable | active | Save contact |
| `http:fleet.lines.contacts-search` | `GET /api/lines/:name/contacts/search` | `src/fleet/index.ts:401` | stable | active | Search saved contacts |
| `http:fleet.lines.chats` | `GET /api/lines/:name/chats` | `src/fleet/index.ts:365` | stable | active | List chats |
| `http:fleet.lines.messages` | `GET /api/lines/:name/messages` | `src/fleet/index.ts:366` | stable | active | Fetch messages |
| `http:fleet.lines.messages-search` | `GET /api/lines/:name/messages/search` | `src/fleet/index.ts:367` | stable | active | Full-text search |
| `http:fleet.lines.metrics` | `GET /api/lines/:name/metrics` | `src/fleet/index.ts:369` | stable | active | 24h / 7d / 30d |
| `http:fleet.lines.logs` | `GET /api/lines/:name/logs` | `src/fleet/index.ts:371` | stable | active | Instance logs |
| `http:fleet.lines.scheduled.list` | `GET /api/lines/:name/scheduled` | `src/fleet/index.ts:380` | stable | active | List scheduled; filter `?status=` |
| `http:fleet.lines.scheduled.create` | `POST /api/lines/:name/scheduled` | `src/fleet/index.ts:381` | stable | active | Schedule a new message |
| `http:fleet.lines.scheduled.cancel-query` | `DELETE /api/lines/:name/scheduled` | `src/fleet/index.ts:382` | stable | active | Cancel by `?id=` |
| `http:fleet.lines.scheduled.get` | `GET /api/lines/:name/scheduled/:id` | `src/fleet/index.ts:383` | stable | active | Single scheduled |
| `http:fleet.lines.scheduled.update` | `PUT /api/lines/:name/scheduled/:id` | `src/fleet/index.ts:384` | stable | active | Update scheduled |
| `http:fleet.lines.scheduled.cancel` | `DELETE /api/lines/:name/scheduled/:id` | `src/fleet/index.ts:385` | stable | active | Cancel scheduled |
| `http:fleet.lines.groups.list` | `GET /api/lines/:name/groups` | `src/fleet/index.ts:386` | stable | active | List groups |
| `http:fleet.lines.groups.create` | `POST /api/lines/:name/groups` | `src/fleet/index.ts:387` | stable | active | Create group |
| `http:fleet.lines.groups.detail` | `GET /api/lines/:name/groups/:jid` | `src/fleet/index.ts:399` | stable | active | Group detail |
| `http:fleet.lines.groups.leave` | `DELETE /api/lines/:name/groups/:jid` | `src/fleet/index.ts:400` | stable | active | Leave group |
| `http:fleet.lines.groups.subject` | `PUT /api/lines/:name/groups/:jid/subject` | `src/fleet/index.ts:388` | stable | active | Update subject |
| `http:fleet.lines.groups.description` | `PUT /api/lines/:name/groups/:jid/description` | `src/fleet/index.ts:389` | stable | active | Update description |
| `http:fleet.lines.groups.participants` | `POST /api/lines/:name/groups/:jid/participants` | `src/fleet/index.ts:390` | stable | active | Add/remove/promote/demote |
| `http:fleet.lines.groups.settings` | `PUT /api/lines/:name/groups/:jid/settings` | `src/fleet/index.ts:391` | stable | active | Announce / locked |
| `http:fleet.lines.groups.invite` | `GET /api/lines/:name/groups/:jid/invite` | `src/fleet/index.ts:392` | stable | active | Fetch invite code |
| `http:fleet.lines.groups.invite-revoke` | `POST /api/lines/:name/groups/:jid/invite/revoke` | `src/fleet/index.ts:393` | stable | active | Revoke + rotate |
| `http:fleet.lines.groups.ephemeral` | `PUT /api/lines/:name/groups/:jid/ephemeral` | `src/fleet/index.ts:394` | stable | active | Disappearing-message duration |
| `http:fleet.lines.groups.member-add-mode` | `PUT /api/lines/:name/groups/:jid/member-add-mode` | `src/fleet/index.ts:395` | stable | active | Toggle who can add members |
| `http:fleet.lines.groups.join-approval` | `PUT /api/lines/:name/groups/:jid/join-approval` | `src/fleet/index.ts:396` | stable | active | Toggle join-approval requirement |
| `http:fleet.lines.groups.requests.list` | `GET /api/lines/:name/groups/:jid/requests` | `src/fleet/index.ts:397` | stable | active | List pending join requests |
| `http:fleet.lines.groups.requests.update` | `POST /api/lines/:name/groups/:jid/requests` | `src/fleet/index.ts:398` | stable | active | Approve / reject |
| `http:fleet.feed` | `GET /api/feed` | `src/fleet/index.ts:346` | stable | active | Activity feed across instances |
| `http:fleet.typing` | `GET /api/typing` | `src/fleet/index.ts:345` | stable | active | Currently-typing indicators |
| `http:fleet.directories.check` | `GET /api/directories/check?path=...` | `src/fleet/index.ts:347` | stable | active | Path writable probe |
| `http:fleet.metrics` | `GET /api/metrics` | `src/fleet/index.ts:368` | stable | active | Fleet-wide metrics |
| `http:fleet.version` | `GET /api/version` | `src/fleet/index.ts:402` | stable | active | Build version |
| `http:fleet.update` | `POST /api/update` | `src/fleet/index.ts:403` | stable | active | Retired in-place update: performs no mutation in any mode; returns a typed `update-by-release-deploy-required` refusal over the SSE error channel. Update by deploying a new release; read availability via `GET /api/version`. |
| `http:fleet.lid-mappings.list` | `GET /api/lid-mappings` | `src/fleet/index.ts:404` | stable | active | List cross-instance LID mappings |
| `http:fleet.lid-mappings.sync` | `POST /api/lid-mappings/sync` | `src/fleet/index.ts:405` | stable | active | Sync mappings between instances |
| `http:fleet.silences.list` | `GET /api/fleet/silences` | `src/fleet/index.ts:342` | beta | active | List active fleet-wide alert silences |
| `http:fleet.silences.add` | `POST /api/fleet/silence` | `src/fleet/index.ts:343` | beta | active | Add a silence rule (instance, duration). Persisted under `~/.config/whatsoup/fleet-silences.json`. |
| `http:fleet.silences.remove` | `DELETE /api/fleet/silence/:name` | `src/fleet/index.ts:344` | beta | active | Remove a named silence rule |
| `http:fleet.auth-ticket.mint` | `POST /api/auth-ticket` | `src/fleet/index.ts:942`, `src/fleet/auth-ticket.ts` | stable | active | Mint short-lived API/SSE ticket (root Bearer, or console session cookie + same-origin proof). Loopback TCP source only (C2). |
| `http:fleet.console-session.create` | `POST /api/console-session` | `src/fleet/index.ts:905` | beta | active | Console unlock: loopback source only (C2), validates the root token + same-origin proof, sets an HttpOnly `SameSite=Strict` session cookie (24h TTL; `Secure` when the unlock arrives over TLS); the browser never holds the root token |
| `http:fleet.console-session.delete` | `DELETE /api/console-session` | `src/fleet/index.ts:929` | beta | active | Console lock/logout: revokes the presented session and clears the cookie |
| `http:fleet.ws-ticket.mint` | `POST /api/ws-ticket` | `src/fleet/index.ts:969`, `src/fleet/ws-ticket.ts` | stable | active | Mint short-lived WebSocket ticket (root Bearer, or console session cookie + same-origin proof). Loopback TCP source only (C2). |
| `http:fleet.legacy-query-token` | `?token=<root>` on `/api/*` and `/ws/*` | [README §Legacy authentication](../README.md#legacy-authentication-deprecated) | stable | deprecated | Deprecation notice: [2026-05-12 public-surface baseline](releases/2026-05-12-public-surface-baseline.md#deprecations). Removal target: v2.0.0 after 2026-06-30. Use `/api/auth-ticket` or Bearer. Emits one-shot `http_legacy_token_path` / `ws_legacy_token_path` warning. |

### Health server (per-instance)

Canonical implementations: [`src/core/health.ts`](../src/core/health.ts) for the normal
runtime and [`src/core/database-compatibility-early.ts`](../src/core/database-compatibility-early.ts)
for a startup database-compatibility drain. The normal runtime uses the configured
instance `healthPort` (falling back to `HEALTH_PORT`, then `9090`) and
`HEALTH_BIND_ADDRESS` (default `127.0.0.1`). Inspection-only startup binds to
`127.0.0.1` on the canonical instance `healthPort` from config, or `9090` when it is
absent. Normal-runtime mutation endpoints require
`Authorization: Bearer $WHATSOUP_HEALTH_TOKEN`; missing token fails closed `401`.
Inspection-only mode exposes no mutation endpoints or remote bind override.

| Identifier | Method + Path | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `http:health.status` | `GET /health` | `src/core/health.ts:1274`, `src/core/database-compatibility-early.ts:166` | stable | active | Normal-runtime liveness probe. During a startup database-compatibility drain, the inspection-only implementation returns `503` with `service_mode: "inspection_only"`, a content-free `startup_block`, database inspection metadata, and provider and synthetic admission blocked; it does not start WhatsApp, the agent runtime, or provider sessions. If a running Chat process detects compatibility loss inside its queue or a guarded background provider, it first returns normal-shape unhealthy health with bounded `runtime.chat.database_compatibility` fields (`reason`, `observed_migration`, `required_migration`), stops enrichment and memory consolidation, blocks later Chat admission, and exposes no paths, JIDs, or message content. The launchd health watchdog can perform one transition restart into startup classification. systemd `Restart=on-failure` does not react to HTTP `503`; that surface requires a controlled operator restart. A schema newer than the binary is never `schema_ready`. The normal-runtime `instance` block includes nullable checkout metadata (`commit`, full 40-character git SHA when known; `branch`, current branch or `HEAD-detached` when known) plus, on agent instances, provider-fallback telemetry (`effectiveProvider`, `fallbackActiveUntil`, `fallbackReason`, `fallbackModel`, `fallbackResetAt`, `fallbackRecoveryProbeRequired`, `fallbackTurnsServed`, `fallbackTurnsEmpty`, `lastFallbackTurnAt`; counters are process-local, reset on restart) and `primaryModelUsability` (`status`, `provider`, `model`, `reason`, `suggestion`, `checkedAt`, `probeInFlight`) from the startup primary model usability probe. The top-level `turn_capability` block exposes `model_usable`, `model_usability_status`, `model_usable_stale`, `model_usable_checked_at`, `last_successful_turn_at`, `last_turn_error_class`, and `last_turn_error_at` (`model_usable_stale` flags a usability verdict whose probe is past its freshness window — treated as unusable so a stale "usable" reading cannot keep health green; `model_usable_checked_at` is the probe timestamp); agent health degrades when runtime health is degraded, the configured primary model is unusable or its usability probe is stale, or a user-turn error has no later successful user turn (an `empty-output` error degrades only as a current, sustained stall — past a short debounce and within a staleness bound — so a transient empty turn or a stale idle one self-clears; #1433). `runtime.agent` also exposes process-local `proactiveResumeIdentityRejects`, provider-state execution telemetry (`providerExecution.active`, `pending`, `oldestWaitMs`, `totalWaits`, `maxPending`, `lastWaitMs`, `abortedWaits`, `pressureActive`), live `turnFinalizationRetainedRetries` / `turnFinalizationDegradedScopes` gauges, cumulative `turnFinalizationRetryAttempts` / `turnFinalizationRetryRecoveries` / `turnFinalizationRetryExhaustions`, and durable-recovery gauges `turnRecoveryOutstanding`, `turnRecoveryPending`, `turnRecoveryLiveClaimed`, `turnRecoveryExpiredClaimed`, `turnRecoveryBlockedUnsafe`, `turnRecoveryExhausted`, `turnRecoveryOpenRecoveries`, `turnRecoveryQuarantinedDelivery`, `turnRecoveryCorruptLinks`, `turnRecoveryOrphanTransfers`, and `turnRecoveryEchoConflicts`. `providerExecution.pressureActive` degrades runtime health after a 30-second wait. `turnRecoveryOutstanding` counts admission-active pending/claimed work plus orphan transfers; blocked-unsafe receipts remain visible but are informational by themselves. Retained finalization, outstanding or exhausted recovery, an open operator catch-up, corrupt proof, or an echo conflict degrades agent health. |
| `http:health.send` | `POST /send` | `src/core/health.ts:777` | stable | active | Send a text message |
| `http:health.schedule` | `POST /schedule` | `src/core/health.ts:838` | experimental | active | Enqueue a text/media message into `scheduled_messages` for durable delivery by the always-on MessageScheduler (≤~60 s). Media passed by file path bounded to `WHATSOUP_SCHEDULE_ROOT` (fail-closed `409` when unset); omitted `scheduledAt` lands on the next tick (`now + 2s`). Non-MCP enqueue path for the launchd loop-daily (5E-0). |
| `http:health.access` | `POST /access` | `src/core/health.ts:1097` | stable | active | Allow / block contact or group |
| `http:health.mark-read` | `POST /mark-read` | `src/core/health.ts:1189` | stable | active | Zero unread + chatModify |
| `http:health.typing` | `GET /typing` | `src/core/health.ts:1259` | stable | active | Currently-composing JIDs from presence cache |
| `http:health.heal` | `POST /heal` | `src/core/health.ts:1012` | stable | active | Inject Type-3 repair report |
| `http:health.agent-compact` | `POST /agent/compact` | `src/core/health.ts:923` | stable | active | Out-of-band compaction; requires `chatJid` for per-chat / shared scopes |

### WebSocket

| Identifier | Path | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `ws:fleet.realtime` | `wss://fleet/ws` | [`src/fleet/websocket-server.ts`](../src/fleet/websocket-server.ts) | stable | active | Realtime event stream. Auth via `/api/ws-ticket` ticket; legacy `?token=` deprecated (same window as the HTTP legacy entry). |

---

## MCP tools

Canonical tool index: [docs/tools.md](tools.md) — full schemas, scopes, replay policies for
all 163 tools (160 always-registered + 3 conditionally-registered: `knowledge_search` when
Pinecone is configured, `emit_heal_result` when the runtime has at least one configured
control-plane peer and is not in any sandbox mode, and `memory_write` when a Pinecone key and
index are configured; see
[docs/tools.md](tools.md#whatsoup-mcp-tool-api-reference) for the full gating conditions).
Tool definitions live under [`src/mcp/tools/*.ts`](../src/mcp/tools/) — each file exports a
factory that registers tools with the names listed below — except for `emit_heal_result`,
which is declared in
[`src/runtimes/agent/runtime-tool-registrations.ts`](../src/runtimes/agent/runtime-tool-registrations.ts)
and registered from `AgentRuntime.start()`.
Tool counts and module groupings come from the
[docs/tools.md table of contents](tools.md#table-of-contents).

The registry entries here are at the **module** level (a tool group is a public unit; the
individual tool inventory is `docs/tools.md`). Tool-level entries follow on promotion.

| Identifier | Tools | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `mcp:tools.messaging` | 9 | [`src/mcp/tools/messaging.ts`](../src/mcp/tools/messaging.ts) | stable | active | `send_message`, `reply_message`, `react_message`, `edit_message`, `delete_message`, `send_location`, `send_contact`, `send_poll`, `pin_message` |
| `mcp:tools.media` | 3 | [`src/mcp/tools/media.ts`](../src/mcp/tools/media.ts) | stable | active | `send_media`, `download_media`, `transcribe_audio` |
| `mcp:tools.chat-management` | 10 | [`src/mcp/tools/chat-management.ts`](../src/mcp/tools/chat-management.ts) | stable | active | `list_messages`, `get_message_context`, `list_chats`, `get_chat`, `forward_message`, `archive_chat`, `pin_chat`, `mute_chat`, `mark_messages_read`, `star_message` |
| `mcp:tools.chat-operations` | 11 | [`src/mcp/tools/chat-operations.ts`](../src/mcp/tools/chat-operations.ts) | stable | active | `clear_chat`, `delete_chat`, `delete_message_for_me`, `set_disappearing_messages`, `send_event_message`, `mark_chat_read`, `update_push_name`, `fetch_message_history`, `request_placeholder_resend`, `get_reactions`, `get_message_receipts` |
| `mcp:tools.search` | 4 | [`src/mcp/tools/search.ts`](../src/mcp/tools/search.ts) | stable | active | `search_messages`, `search_messages_advanced`, `search_chat_messages`, `search_contacts` |
| `mcp:tools.groups` | 19 | [`src/mcp/tools/groups.ts`](../src/mcp/tools/groups.ts) | stable | active | Group lifecycle, invites, participants, ephemeral, join-approval |
| `mcp:tools.community` | 12 | [`src/mcp/tools/community.ts`](../src/mcp/tools/community.ts) | stable | active | Community create / link / unlink / participants / metadata |
| `mcp:tools.newsletter` | 19 | [`src/mcp/tools/newsletter.ts`](../src/mcp/tools/newsletter.ts) | stable | active | Newsletter lifecycle + admin |
| `mcp:tools.business` | 13 | [`src/mcp/tools/business.ts`](../src/mcp/tools/business.ts) | stable | active | Catalog, product, orders, quick-reply, contact mgmt |
| `mcp:tools.profile` | 14 | [`src/mcp/tools/profile.ts`](../src/mcp/tools/profile.ts) | stable | active | Profile / privacy / blocklist / push-name |
| `mcp:tools.advanced` | 13 | [`src/mcp/tools/advanced.ts`](../src/mcp/tools/advanced.ts) | stable | active | Phone-number registration, pairing, app-state resync, placeholder resend, relay |
| `mcp:tools.calls` | 1 | [`src/mcp/tools/calls.ts`](../src/mcp/tools/calls.ts) | stable | active | `reject_call` |
| `mcp:tools.presence` | 3 | [`src/mcp/tools/presence.ts`](../src/mcp/tools/presence.ts) | stable | active | `get_presence`, `subscribe_presence`, `send_typing` |
| `mcp:tools.voice` | 1 | [`src/mcp/tools/voice.ts`](../src/mcp/tools/voice.ts) | stable | active | `send_voice_reply` |
| `mcp:tools.memory-write` | 1 | [`src/mcp/tools/memory-write.ts`](../src/mcp/tools/memory-write.ts) | stable | active | `memory_write` (agent episodic write to the configured per-person Pinecone index; Pinecone-gated, `core: false`). |
| `mcp:tools.knowledge` | 1 | [`src/mcp/tools/knowledge.ts`](../src/mcp/tools/knowledge.ts) | stable | active | `knowledge_search` (BYOK Pinecone). Pinecone-gated registration: conditionally-registered only when the instance's Pinecone allowed-indexes, credentials, and knowledge profiles are usable; see [docs/tools.md](tools.md#whatsoup-mcp-tool-api-reference) for full gating conditions. |
| `mcp:tools.retention` | 1 | [`src/mcp/tools/retention.ts`](../src/mcp/tools/retention.ts) | stable | active | `cleanup_media` retention controls |
| `mcp:tools.status` | 2 | [`src/mcp/tools/status.ts`](../src/mcp/tools/status.ts) | stable | active | `post_status`, `list_statuses` |
| `mcp:tools.scheduling` | 5 | [`src/mcp/tools/scheduling.ts`](../src/mcp/tools/scheduling.ts) | stable | active | `schedule_message`, `list_scheduled`, `get_scheduled`, `update_scheduled`, `cancel_scheduled` |
| `mcp:tools.audit` | 1 | [`src/mcp/tools/audit.ts`](../src/mcp/tools/audit.ts) | stable | active | `read_outbound_sends` |
| `mcp:tools.substrate` | 21 | [`src/mcp/tools/substrate.ts`](../src/mcp/tools/substrate.ts) | beta | active | Agent substrate: beads, watches, triggers, vault, observations, entities, aliases, activity timeline. Schema still settling. |

> The 162nd canonical tool (`emit_heal_result`) is registered inline from
> [`src/runtimes/agent/runtime.ts`](../src/runtimes/agent/runtime.ts) rather than under
> `src/mcp/tools/`, so it is intentionally absent from the per-module registry above.
> See the [`runtime.ts (inline)` section of docs/tools.md](tools.md#runtimets-inline) for
> the full schema and the conditional-registration gate.

Sock-tool factory infrastructure: [`src/mcp/tools/sock-tool-factory.ts`](../src/mcp/tools/sock-tool-factory.ts) — internal.

---

## Configuration

Canonical reference: [docs/configuration.md](configuration.md). The registry tracks
config-key groups at the section level; individual field shape lives in the reference.
Each instance config file is at `$XDG_CONFIG_HOME/whatsoup/instances/<name>/config.json`.

| Identifier | Type | Source | Schema | Stability | Status | Notes |
|---|---|---|---|---|---|---|
| `config:instance_config.top-level` | config-key | [docs/configuration.md §Top-Level Fields](configuration.md#top-level-fields) | v1 (bootstrap) | stable | active | `enabled`, `name`, `type`, `adminPhones`, `accessMode`, `systemPrompt`, `models`, `memory`, `maxTokens`, `tokenBudget`, `rateLimitPerHour`, `healthPort`, `siblingPhones`, `chatAliases`, `profiles`, `toolUpdateMode`, `operationTracker`, `agentOptions` |
| `config:instance_config.access-modes` | config-key | [docs/configuration.md §Access Modes](configuration.md#access-modes) | v1 (bootstrap) | stable | active | `self_only`, `allowlist`, `open_dm`, `groups_only` |
| `config:instance_config.models` | config-key | [docs/configuration.md §models Object](configuration.md#models-object) | v1 (bootstrap) | stable | active | `conversation`, `extraction`, `validation`, `fallback` |
| `config:instance_config.memory` | config-key | [docs/configuration.md §memory](configuration.md#memory) | v1 (bootstrap) | stable | active | Canonical BYOK memory/search config; supersedes legacy `pinecone*` flat fields |
| `config:instance_config.memory.pinecone` | config-key | [docs/configuration.md §Pinecone BYOK Fields](configuration.md#pinecone-byok-fields) | v1 (bootstrap) | stable | active | `index`, `searchMode`, `rerank`, `topK`, `rerankTopN`, `allowedIndexes`, `apiKeyEnv` |
| `config:instance_config.memory.legacy-aliases` | config-key | [docs/configuration.md §Legacy Migration](configuration.md#legacy-migration) | v1 (bootstrap) | stable | deprecated | Deprecation notice: [2026-05-12 public-surface baseline](releases/2026-05-12-public-surface-baseline.md#deprecations). Removal target: v2.0.0. Flat `pineconeIndex`, `pineconeSearchMode`, `pineconeRerank`, `pineconeTopK`, `pineconeRerankTopN`, `pineconeAllowedIndexes` are auto-migrated to `memory.pinecone.*`; new configs use canonical form. |
| `config:instance_config.chatAliases` | config-key | [docs/configuration.md §chatAliases](configuration.md#chataliases) | v1 (bootstrap) | stable | active | Per-instance alias map for outbound sends |
| `config:instance_config.profiles` | config-key | [docs/configuration.md §profiles](configuration.md#profiles) | v1 (bootstrap) | stable | active | Named send-decoration policies (`prefix`, `tag`, `linkPreview`) |
| `config:instance_config.operationTracker` | config-key | [docs/configuration.md §operationTracker](configuration.md#operationtracker) | v1 (bootstrap) | stable | active | Per-tool progress + stall detection |
| `config:instance_config.agentOptions` | config-key | [docs/configuration.md §agentOptions](configuration.md#agentoptions) | v1 (bootstrap) | stable | active | Agent runtime settings; required fields vary by `sessionScope`; provider IDs are `claude-cli`, `codex-cli`, `gemini-cli`, `opencode-cli`, `openai-api`, `anthropic-api` |
| `config:instance_config.agentOptions.sandbox` | config-key | [docs/configuration.md §agentOptions.sandbox](configuration.md#agentoptionssandbox) | v1 (bootstrap) | stable | active | Sandbox enforcement policy |
| `config:instance_config.agentOptions.enabledPlugins` | config-key | [docs/configuration.md §agentOptions.enabledPlugins](configuration.md#agentoptionsenabledplugins) | v1 (bootstrap) | stable | active | Plugin allowlist for agent instances |
| `config:instance_config.session-scopes` | config-key | [docs/configuration.md §Session Scopes](configuration.md#session-scopes) | v1 (bootstrap) | stable | active | `single`, `per_chat`, `shared` |
| `config:instance_config.outbound-send-audit` | config-key | [docs/configuration.md §Outbound Send Audit](configuration.md#outbound-send-audit) | v1 (bootstrap) | stable | active | Audit-log shape for fleet send pipeline |

Fleet, agent, and protection policy artifacts (`fleet.json`, `agent.json`,
`protection.policy.yaml`) are reserved by the migration framework and compatibility specs
but are not yet on disk; entries will be added once those artifacts land.

---

## Environment variables

Canonical reference: [docs/configuration.md §Environment Variables](configuration.md#environment-variables).
The registry tracks env-var groups at the section level.

| Identifier | Vars | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `env:api-keys` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PINECONE_API_KEY` | [docs/configuration.md §API Keys](configuration.md#api-keys-required-for-chat-and-audio-transcription) | stable | active | Loaded from GNOME Keyring by wrapper; required for `chat` instances, soft-optional for `agent`, unused for `passive` |
| `env:models` | `CONVERSATION_MODEL`, `EXTRACTION_MODEL`, `VALIDATION_MODEL`, `FALLBACK_MODEL` | [docs/configuration.md §Models](configuration.md#models) | stable | active | Overridable per instance via `models` |
| `env:conversation` | `MAX_TOKENS`, `RATE_LIMIT_PER_HOUR` | [docs/configuration.md §Conversation](configuration.md#conversation) | stable | active | Per-instance overrides available |
| `env:access-control` | `ADMIN_PHONES` | [docs/configuration.md §Access Control](configuration.md#access-control) | stable | deprecated | Deprecation notice: [2026-05-12 public-surface baseline](releases/2026-05-12-public-surface-baseline.md#deprecations). Removal target: v2.0.0. Single-instance only; `config.json:adminPhones` is the canonical form in multi-instance mode |
| `env:storage-paths` | `WHATSOUP_CONFIG_DIR`, `WHATSOUP_DATA_DIR`, `WHATSOUP_STATE_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | [docs/configuration.md §Storage Paths](configuration.md#storage-paths-single-instance-legacy-mode-only) | stable | active | Legacy / single-instance mode only |
| `env:pinecone` | `PINECONE_INDEX`, `PINECONE_PROJECT_ID`, `PINECONE_EXPECTED_HOST_SUFFIX`, `MW_MIND_EMBED_URL`, `RECENCY_HALF_LIFE_DAYS`, `MAX_AGE_DAYS` | [docs/configuration.md §Pinecone](configuration.md#pinecone) | stable | active | Defaults that per-instance `memory.pinecone.*` can override |
| `env:health-server` | `HEALTH_PORT`, `HEALTH_BIND_ADDRESS`, `WHATSOUP_HEALTH_TOKEN`, `WHATSOUP_SCHEDULE_ROOT` | [docs/configuration.md §Health Server](configuration.md#health-server) | stable | active | Mutation endpoints fail closed `401` without token; `POST /schedule` fail-closed `409` without `WHATSOUP_SCHEDULE_ROOT` |
| `env:logging` | `LOG_LEVEL`, `LOG_DIR` | [docs/configuration.md §Logging](configuration.md#logging) | stable | active | Pino log level + rotation directory |
| `env:docker` | `WHATSOUP_DOCKER`, `WHATSOUP_MODE`, `WHATSOUP_INSTANCES`, `FLEET_BIND_ADDRESS` | [docs/configuration.md §Docker](configuration.md#docker) | stable | active | Container entrypoint controls |
| `env:internal` | `INSTANCE_CONFIG` | [docs/configuration.md §Internal / Bootstrap](configuration.md#internal-bootstrap) | internal | active | Set by bootstrap process — operators must not set manually |

---

## NPM scripts (operator-facing)

Canonical source: [`package.json` `scripts`](../package.json). Only the operator-facing
scripts are public; build/test scripts are internal.

| Identifier | Script | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `cli:npm.start` | `npm run start` | `package.json` | stable | active | Start the supervisor (fleet + instances) |
| `cli:npm.start-instance` | `npm run start:instance` | `package.json` | stable | active | Start a single instance by name |
| `cli:npm.fleet` | `npm run fleet` | `package.json` | stable | active | Start the fleet server only |
| `cli:npm.setup` | `npm run setup` | `package.json` | stable | active | First-run setup wizard |
| `cli:npm.auth` | `npm run auth` | `package.json` | stable | active | QR-code authentication flow (supervisor) |
| `cli:npm.auth-instance` | `npm run auth:instance` | `package.json` | stable | active | QR-code authentication for a specific instance |
| `cli:npm.agent-lease` | `npm run agent:lease` | `package.json` | stable | active | Atomic writer/lineage lease for multi-agent git work — `acquire`/`status`/`heartbeat`/`release`/`takeover`/`check-path`; exit 0 OK, 1 BLOCK, 2 INCONCLUSIVE |
| `cli:npm.audit-instance-plugins` | `npm run audit:instance-plugins` | `package.json` | stable | active | Audit plugin allowlists across instances |
| `cli:npm.backfill-enrichment` | `npm run backfill-enrichment` | `package.json` | stable | active | One-shot enrichment backfill |
| `cli:npm.token-window` | `npm run token-window` | `package.json` | beta | active | Tokenomics pilot helper; reports rolling agent-token totals from an instance `bot.db` |
| `cli:npm.audit-continuity-manifest` | `npm run audit-continuity-manifest` | `package.json` | beta | active | Read-only comparison of a bounded independent-history receipt manifest against exact local message, admission, and echoed-reply proof; emits only ordinals, classifications, actions, and counts |
| `cli:npm.close-recovery-catchup` | `npm run close-recovery-catchup` | `package.json` | beta | active | Validate an exact schema-43 operator catch-up proof read-only; `--confirm` atomically persists the closure |
| `cli:npm.triage-issues` | `npm run triage:issues` | `package.json` | beta | active | Deterministic open-issue registry schema/check/render and bounded live snapshot/dry-run/re-read commands; apply requires a tracked clean plan plus explicit digest, issue-set, and idempotency confirmations |
| `cli:npm.migrate-memory-config` | `npm run migrate-memory-config` | `package.json` | stable | active | Migrate legacy flat `pinecone*` config to `memory.*` |
| `cli:npm.fleet-rotate-token` | `npm run fleet:rotate-token` | `package.json` | stable | active | Rotate the root fleet token; preserves accept-list |
| `cli:npm.arc-runtime-proof` | `npm run arc:runtime-proof` | `package.json` | beta | active | Emit the ARC runtime-enforcement `verification-record` from runtime health plus drift-free installed binding metadata; fails closed on missing emission contract, drift, or secret-like artifacts |
| `cli:npm.canary-artifact-proof` | `npm run canary:artifact-proof` | `package.json` | beta | active | Validate a local disposable-client canary proof artifact without browser login, send, or auth mutation; fails closed on unsafe or incomplete artifacts |
| `cli:npm.provider-parity` | `npm run provider:parity` | `package.json` | beta | active | Read-only redacted provider/fallback parity report from captured provider-status and provider-probe inputs; exits 0/1/2 for green, non-green, and parse/redaction failures |
| `cli:npm.release-snapshot` | `npm run release:snapshot` | `package.json` | beta | active | Read-only release snapshot planner and manifest-backed drift checker; live release mutation still requires separate approval |
| `cli:npm.qregistry-loop` | `npm run qregistry:loop` | `package.json` | internal | active | Durable qRegistry polling loop; validates `qregistry.ndjson` and dispatches OpenCode review/research workers on register/checker change (see `docs/audits/qregistry-loop.md`) |
| `cli:npm.leaks-anonymize` | `npm run leaks:anonymize` | `package.json` | stable | active | Report-first private literal anonymizer; pass `--write` to update files |
| `cli:npm.guard-publication` | `npm run guard:publication` | `package.json` | stable | active | Publication audit guard (default mode) |
| `cli:npm.guard-publication-all` | `npm run guard:publication:all` | `package.json` | stable | active | Verify tracked internal docs are represented in `docs/publication-audit.md` |
| `cli:npm.guard-publication-release` | `npm run guard:publication:release` | `package.json` | stable | active | Verify tracked internal docs are public-clean before publication |
| `cli:npm.guard-publication-staged` | `npm run guard:publication:staged` | `package.json` | stable | active | Publication audit guard for pre-commit use |
| `cli:npm.guard-git-estate` | `npm run guard:git-estate` | `package.json` | internal | active | Deterministic local Git-estate snapshot and hook gate: inventories linked worktrees twice with bounded Git subprocesses and a bounded status pool, branch/upstream state, stash object identity, and conflict instances; pre-commit warns while pre-push fails closed on malformed/incomplete/racing scans, invalid canonical v2 machine-local baselines, new conflicts, and new critical housekeeping debt; new worktree/branch identities are reported advisory-only and never block, in either phase — the ratchet is repo-global while several agents work the repo concurrently, so growth is routinely caused by an agent other than the pusher, who cannot clear it (growth is an ID set difference; retiring unrelated work does not offset it); `baseline write` explicitly and atomically accepts a complete non-racing local snapshot without cleaning repository state |
| `cli:npm.guard-pre-push` | `npm run guard:pre-push` | `package.json` | internal | active | Fail-closed pre-push hook and CI entrypoint; estate-gates every update including deletions, accepts only exact 40-character SHA-1 or 64-character SHA-256 object IDs, recognizes all-zero deletion IDs at either width, then binds one clean exact-HEAD candidate to the configured SSH push remote and live `main`; rechecks remote, candidate, cleanliness, and `main` after branch or release verification so a moving base is retryable INCONCLUSIVE rather than stale evidence |
| `cli:npm.drift-classify` | `npm run drift:classify` | `package.json` | stable | active | Classify how `main` has drifted from the base an evidence set was earned against, and which receipt sensitivity tags that invalidates. Exits 0 continue / 1 stop / 2 INCONCLUSIVE |
| `cli:npm.guard-drift-coverage` | `npm run guard:drift-coverage` | `package.json` | stable | active | CI gate: assert the drift classifier still recognises every tracked path. Exits 2 INCONCLUSIVE on an unclassified surface; never gates on the drift verdict itself |
| `cli:npm.guard-doc-drift` | `npm run guard:doc-drift` | `package.json` | stable | active | Verify cross-doc references resolve on disk |
| `cli:npm.guard-doc-tally` | `npm run guard:doc-tally` | `package.json` | stable | active | Verify hand-maintained tally docs declared header count matches actual body row count (doc-tally split-brain, #1524 class) |
| `cli:npm.guard-design-system-hygiene` | `npm run guard:design-system-hygiene` | `package.json` | internal | active | Staged/changed-range guard requiring tracked design-system SSOT docs for token, lint, and QA harness changes |
| `cli:npm.guard-public-surface-drift` | `npm run guard:public-surface-drift` | `package.json` | stable | active | Verify `docs/public-surface.md` and package.json scripts agree |
| `cli:npm.guard-source-runtime-drift` | `npm run guard:source-runtime-drift` | `package.json` | stable | active | Verify deployed runtime scripts match their checked-in sources against `deploy/source-runtime-manifest.json` |
| `cli:npm.guard-deployer-static` | `npm run guard:deployer-static` | `package.json` | internal | active | Local parity for the CI-only bot-errors deployer static guard — verifies the working-tree sources for `deploy/scripts/whatsoup-bot-errors-deploy.sh`'s managed files match the expected sha256 resolved from `deploy/bot-errors-runtime-manifest.json` (closes the local/CI gap that twice red-flagged PR #1397) |
| `cli:npm.guard-arc-binding-drift` | `npm run guard:arc-binding-drift` | `package.json` | stable | active | Verify tracked `.arc/` shim. Always-on vendored-pin check (`.arc/.canonical-sha` vs the payload sha in `arc.toml`/`ARC_BINDING.md`) HARD-BLOCKS a stale `.arc/` even in CI without the sibling repo. When the sibling agent-runtime-protocol is reachable (via `ARC_REPO_DIR`), it additionally runs the full byte-for-byte adopt-generator comparison and cross-checks the pin against the live sha |
| `cli:npm.guard-branch-protection-drift` | `npm run guard:branch-protection-drift` | `package.json` | stable | active | Compare live GitHub branch protection for `main` against the committed expectation in `docs/enforcement/branch-protection-expected.json` (R-02 approvals, required check contexts, force-push/deletion). On-demand only: reading protection needs an admin-scoped token CI does not have, so it is deliberately NOT in `verify:push:branch`. Exit 0 no drift, 1 drift, 2 INCONCLUSIVE — empty or non-protection input (e.g. `{"message":"Not Found"}` from a token without admin scope) is never reported as clean |
| `cli:npm.guard-branch-retirement` | `npm run guard:branch-retirement` | `package.json` | beta | active | Branch-retirement predicate (`retirementCandidates` in `scripts/branch-retirement.ts`) for the branch-deletion pass `mh-prune` deliberately never performs. No live git/`gh` collector is wired yet, so the CLI entrypoint fails closed (exit 2, stderr-only) rather than reporting a false-clean pass; the predicate itself is exercised only via its unit tests until the collector lands |
| `cli:npm.guard-fleet-bot-hardening-parity` | `npm run guard:fleet-bot-hardening-parity` | `package.json` | internal | active | Verify the redacted fleet bot-hardening parity manifest and source anchors stay aligned with the A-D provider-resilience standard |
| `cli:npm.guard-bot-errors-runtime-manifest` | `npm run guard:bot-errors-runtime-manifest` | `package.json` | stable | active | Verify BOT ERRORS runtime manifest hashes and capability markers match checked-in deploy scripts |
| `cli:npm.guard-bot-errors-critical-surface` | `npm run guard:bot-errors-critical-surface` | `package.json` | stable | active | Audit BOT ERRORS critical runtime surfaces: manifest hash/marker integrity, credential-path safety, and state-tree shape (local, or remote host via `--remote`/`--profile`) |
| `cli:npm.guard-work-index` | `npm run guard:work-index` | `package.json` | stable | active | Verify `docs/work-index.md` is up to date |
| `cli:npm.guard-repo` | `npm run guard:repo` | `package.json` | stable | active | Repo hygiene guard (default mode) |
| `cli:npm.guard-repo-release-hygiene` | `npm run guard:repo:release-hygiene` | `package.json` | stable | active | Repo hygiene guard over the release-hygiene file set |
| `cli:npm.guard-repo-staged` | `npm run guard:repo:staged` | `package.json` | stable | active | Repo hygiene guard over the staged diff |
| `cli:npm.guard-repo-branch-diff` | `npm run guard:repo:branch-diff` | `package.json` | stable | active | Repo hygiene guard over the branch/base diff |
| `cli:npm.guard-repo-commit-msg` | `npm run guard:repo:commit-msg` | `package.json` | stable | active | Repo hygiene guard over commit-msg input |
| `cli:npm.guard-repo-commit-authors` | `npm run guard:repo:commit-authors` | `package.json` | stable | active | Repo hygiene guard over branch-range commit authors |
| `cli:npm.guard-harness-maintenance` | `npm run guard:harness-maintenance` | `package.json` | internal | active | Validate harness-maintenance manifest and npm cooldown gates |
| `cli:npm.guard-agent-iteration-review` | `npm run guard:agent-iteration-review` | `package.json` | internal | active | Validate a self-review markdown artifact has required sections and a valid decision |
| `cli:npm.guard-worker-artifacts` | `npm run guard:worker-artifacts` | `package.json` | internal | active | Validate worker-delegation report artifacts (JSON validity, metadata, manifest completeness) |
| `cli:npm.guard-unit-drift` | `npm run guard:unit-drift` | `package.json` | internal | active | Compare checked-in systemd user units with installed units |
| `cli:npm.guard-node-pin-consistency` | `npm run guard:node-pin-consistency` | `package.json` | stable | active | Verify Node version pin is consistent across configs |
| `cli:npm.guard-service-units` | `npm run guard:service-units` | `package.json` | stable | active | Validate launchd plists / systemd units (label==stem, no bare/env node, no unexpanded ${VAR}, node-pin, absolute paths, plist structure) |
| `cli:npm.guard-insecure-tempfile` | `npm run guard:insecure-tempfile` | `package.json` | stable | active | Reject insecure temp-file creation in python + shell (tempfile.mktemp / mktemp import, /tmp write-target literals, shell redirect/tee to /tmp, unsafe mktemp templates) |
| `cli:npm.guard-no-destructive-git` | `npm run guard:no-destructive-git` | `package.json` | stable | active | Block destructive git cleanup commands (clean -fdx, reset --hard, checkout/switch --force, push --force, branch -D, update-ref -d, stash clear, reflog expire, gc --prune, filter-branch/-repo) in committed shell/hook automation; escape hatch `# no-destructive-git:allow` |
| `cli:npm.guard-baseline-growth` | `npm run guard:baseline-growth` | `package.json` | stable | active | Refuse any increase in the tolerated-debt weight of a committed baseline file (.claude/fitness/*, .claude/test-integrity/, console/*-baseline.json, eslint-rules/catch-ratchet-baseline.json, scripts/service-units-baseline.json); a baseline may only shrink, and an unreadable revision or unparseable document is INCONCLUSIVE (exit 2), never a pass |
| `cli:npm.guard-catch-ratchet` | `npm run guard:catch-ratchet` | `package.json` | stable | active | Compare the current src/ catch-swallow semantic multiset against its shrink-only baseline; new debt, stale debt, malformed state, or a zero-file scan blocks, and `--write` can only remove stale entries |
| `cli:npm.guard-import-cycle` | `npm run guard:import-cycle` | `package.json` | stable | active | Refuse runtime import cycles in src/ (Tarjan SCC over a TypeScript-resolved module graph); type-only imports are excluded because they are erased at runtime; an unresolvable specifier or an implausibly small graph is INCONCLUSIVE (exit 2), never a pass |
| `cli:npm.guard-phantom-deps` | `npm run guard:phantom-deps` | `package.json` | stable | active | Refuse an import of a package that no package.json from the importing file up to the repo root declares (phantom/hoisted dependency: resolves locally, breaks on a clean install); node builtins excluded in both spellings; an unreadable manifest chain or an implausibly small scan is INCONCLUSIVE (exit 2), never a pass |
| `cli:npm.guard-grant-resolver` | `npm run guard:grant-resolver` | `package.json` | internal | active | Fail the build on a new ungated inline isAdminPhone(resolvePhoneFromJid(...)) grant composition in src/ (QR-143/B4; use resolvePhoneFromJidForGrant or an allowlist row) |
| `cli:npm.guard-launchd-drift` | `npm run guard:launchd-drift` | `package.json` | internal | active | Compare installed macOS com.whatsoup.* LaunchAgents with checked-in templates (substitute-then-compare; secret-bearing plists structural-only) |
| `cli:npm.triage-required-suites` | `npm run triage:required-suites` | `package.json` | internal | active | Compute the minimum local suite set (functional ∪ all-fitness) to prevent #1507/#1514 CI-gap recurrence; WARN-tier triage aid (always exits 0, not a gate) |
| `cli:npm.guard-instance-config` | `npm run guard:instance-config` | `package.json` | stable | active | Verify instance config.json files for memory-config integrity and health-port map integrity |
| `cli:npm.guard-boundaries` | `npm run guard:boundaries` | `package.json` | stable | active | Deterministic ring import-boundary check with grandfathered baseline (new cross-ring violations block) |
| `cli:npm.guard-ring-boundaries` | `npm run guard:ring-boundaries` | `package.json` | stable | active | Alias for guard:boundaries |
| `cli:npm.guard-ring-boundary-ratchet` | `npm run guard:ring-boundary-ratchet` | `package.json` | stable | active | Guard-ring promotion of `arch.ring-boundaries`: counts `fitness/ring-boundaries` findings over src/ via the registry-derived ESLint config and ratchets against the baselined count (ratchet, not yet a pure block) |
| `cli:npm.guard-ssot-patterns` | `npm run guard:ssot-patterns` | `package.json` | stable | active | SSOT pattern-enforcement count ratchet (`arch.ssot-*` rules): ad-hoc reimplementations of the lid-resolver / jid-constants / chat-display-name / phone / presentation primitives fail above baseline; shrinking counts demand a same-commit baseline ratchet-down (see `docs/architecture/fitness-taxonomy.md`) |
| `cli:npm.guard-transport-patterns` | `npm run guard:transport-patterns` | `package.json` | stable | active | Transport-agnostic pattern check with grandfathered baseline (new WhatsApp-coupled literals/copy/health-key reads in generic UI + ops surfaces block) |
| `cli:npm.guard-fail-closed-gate` | `npm run guard:fail-closed-gate` | `package.json` | stable | active | Reject fail-open gate shapes (env-gated paths must fail closed when the gate variable is unset) |
| `cli:npm.guard-durability-writer` | `npm run guard:durability-writer` | `package.json` | stable | active | #1789 durability-writer invariant: every migrated table classifies into exactly one of status-bearing/non-status/reserved (`scripts/lib/durability-status-registry.ts`), reserved exemptions carry a reason+issue, non-status tables with a status-shaped column carry a justification, and every status-bearing table declares a non-empty terminal-failure vocabulary plus a resolvable production writer |
| `cli:npm.guard-restart-preflight` | `npm run guard:restart-preflight` | `package.json` | stable | active | Deploy-time import-closure probe: refuses service start when the on-disk import graph cannot link |
| `cli:npm.guard-repo-scan-history` | `npm run guard:repo:scan-history` | `package.json` | stable | active | Scan recent git history for secret-pattern leaks using the shared hygiene pattern set |
| `cli:npm.guard-bot-errors-simulation-matrix` | `npm run guard:bot-errors-simulation-matrix` | `package.json` | internal | active | Verify BOT ERRORS/Q-loop disaster scenarios are backed by executable fixture anchors |
| `cli:npm.guard-claude-settings` | `npm run guard:claude-settings` | `package.json` | stable | active | Verify tracked `.claude/settings.json` matches generated agent defaults |
| `cli:npm.guard-agent-decision-polls` | `npm run guard:agent-decision-polls` | `package.json` | stable | active | Verify AskUser poll protocol wiring across prompts, MCP schema, sandbox diagnostics, docs, and release gates |
| `cli:npm.guard-semantic-quality` | `npm run guard:semantic-quality` | `package.json` | beta | active | Exact-commit semantic production-reachability and export-ownership engine; local receipts default under Git metadata |
| `cli:npm.guard-safeguard-diagnostics` | `npm run guard:safeguard-diagnostics` | `package.json` | stable | active | Deterministic diagnostic map for guard-chain wiring, sensitive-publication anchors, runtime-boundary anchors, public-exposure guards, and portability blockers |
| `cli:npm.guard-guard-test-coverage` | `npm run guard:guard-test-coverage` | `package.json` | stable | active | Meta-guard: every guard-family script (`scripts/*guard*.ts`, `scripts/check-*.ts`) must ship a companion test wired into `verify:push:branch`, or carry a `// meta-guard:no-test <reason>` opt-out |
| `cli:npm.guard-test-integrity` | `npm run guard:test-integrity` | `package.json` | internal | active | CI wrapper for test-integrity baseline check (refs #511); skips when the plugin is absent only outside CI |
| `cli:npm.guard-test-integrity-required` | `npm run guard:test-integrity:required` | `package.json` | internal | active | Fail-closed test-integrity baseline check; requires the scanner to be installed and runnable |
| `cli:npm.guard-lint-src` | `npm run guard:lint:src` | `package.json` | stable | active | ESLint architectural-fitness ring over src/scripts/tests; warns (non-blocking), fails only on errors/config faults |
| `cli:npm.guard-coverage-headroom` | `npm run guard:coverage-headroom` | `package.json` | internal | active | Manual coverage threshold headroom diagnostic; run after `coverage:check` has generated `coverage/coverage-summary.json` |
| `cli:npm.work-index-regen` | `npm run work-index:regen` | `package.json` | stable | active | Regenerate `docs/work-index.md` |
| `cli:npm.verify-console-design-live` | `npm run verify:console-design:live` | `package.json` | stable | active | Live console design-system filesystem checks without fixture-test replay; used after full-suite coverage already ran the design tests |
| `cli:npm.verify-console-design` | `npm run verify:console-design` | `package.json` | stable | active | Full console design-system verification chain: live checks plus design guard fixture tests; retained for push and tag lanes without preceding full-suite coverage |
| `cli:npm.verify-console-browser` | `npm run verify:console-browser` | `package.json` | stable | active | Shared browser proof chain (`test:browser` + `test:browser:motion`) used by release/tag gates |
| `cli:npm.verify-semantic` | `npm run verify:semantic` | `package.json` | beta | active | Manual enforcement adapter for semantic quality; not composed into required gates until a separately approved promotion |
| `cli:npm.verify-semantic-shadow` | `npm run verify:semantic:shadow` | `package.json` | beta | active | Local/CI shadow adapter; emits findings and may retain a would-block receipt decision while exiting zero |
| `cli:npm.verify-push-branch` | `npm run verify:push:branch` | `package.json` | stable | active | Composite verifier run before pushing a branch |
| `cli:npm.verify-release` | `npm run verify:release` | `package.json` | beta | active | Release-readiness verifier; surface still settling |
| `cli:npm.verify-publish` | `npm run verify:publish` | `package.json` | beta | active | Strict public-publication prep gate; expected to fail until `PRIVATE-ARCHIVE` rows are removed, sanitized, or reclassified |

Test, typecheck, build, lint, format, and dev scripts are internal.

---

## Runtime modes

Canonical reference: [docs/specs/2026-05-09-fleet-topology-control-plane-design.md](specs/2026-05-09-fleet-topology-control-plane-design.md).

| Identifier | Mode | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `runtime:mode.supervisor` | `WHATSOUP_MODE=supervisor` | [`docker/entrypoint.sh`](../docker/entrypoint.sh) | stable | active | Docker default; runs fleet + instances listed in `WHATSOUP_INSTANCES` in one container |
| `runtime:mode.fleet` | `WHATSOUP_MODE=fleet` | [`docker/entrypoint.sh`](../docker/entrypoint.sh) | stable | active | Docker fleet-only entrypoint (`src/fleet/standalone.ts`) |
| `runtime:mode.instance` | `WHATSOUP_MODE=instance` | [`docker/entrypoint.sh`](../docker/entrypoint.sh) | stable | active | Docker single-instance entrypoint; requires `WHATSOUP_INSTANCE` |
| `runtime:mode.auth` | `WHATSOUP_MODE=auth` | [`docker/entrypoint.sh`](../docker/entrypoint.sh) | stable | active | Docker QR-pairing flow; requires `WHATSOUP_INSTANCE` |
| `runtime:type.chat` | instance `type: chat` | [docs/configuration.md §Top-Level Fields](configuration.md#top-level-fields) | stable | active | Chat-runtime instance |
| `runtime:type.agent` | instance `type: agent` | [docs/configuration.md §Top-Level Fields](configuration.md#top-level-fields) | stable | active | Agent-runtime instance |
| `runtime:type.passive` | instance `type: passive` | [docs/configuration.md §Top-Level Fields](configuration.md#top-level-fields) | stable | active | Read-only ingest |
| `runtime:role.admin` | fleet topology admin | [fleet-topology spec](specs/2026-05-09-fleet-topology-control-plane-design.md) | beta | active | Multi-machine admin role; spec live, runtime still landing |
| `runtime:role.client` | fleet topology client | [fleet-topology spec](specs/2026-05-09-fleet-topology-control-plane-design.md) | beta | active | Multi-machine client role |
| `runtime:role.standalone` | fleet topology standalone | [fleet-topology spec](specs/2026-05-09-fleet-topology-control-plane-design.md) | stable | active | Single-machine deployment (current production shape) |

---

## Deploy artifacts

Canonical source: [`deploy/`](../deploy). These are the install-time artifacts the
compatibility policy commits to. Behavior-preserving auto-regeneration by the migration
framework is non-breaking (§4); operator-edited changes plus post-regen behavior changes
are breaking.

| Identifier | Artifact | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `deploy:wrapper.whatsoup` | `whatsoup` launcher script | [`deploy/whatsoup`](../deploy/whatsoup) | stable | active | Takes `<instance-name>` argument; loads keychain secrets, exports env, execs `src/bootstrap.ts` for that instance |
| `deploy:wrapper.whatsoup-fleet` | `whatsoup-fleet` launcher | [`deploy/whatsoup-fleet`](../deploy/whatsoup-fleet) | stable | active | Fleet-only entrypoint |
| `deploy:wrapper.whatsoup-auth` | `whatsoup-auth` launcher | [`deploy/whatsoup-auth`](../deploy/whatsoup-auth) | stable | active | Auth-flow entrypoint |
| `deploy:wrapper.whatsoup-reply-guarantee-drain` | `whatsoup-reply-guarantee-drain` launcher | [`deploy/scripts/reply-guarantee-drain.sh`](../deploy/scripts/reply-guarantee-drain.sh) | stable | active | Repo-relative systemd entrypoint for draining queued stuck replies |
| `deploy:systemd.instance` | `whatsoup@.service` template | [`deploy/whatsoup@.service`](../deploy/whatsoup@.service) | stable | active | systemd template; per-instance unit |
| `deploy:systemd.fleet` | `whatsoup-fleet.service` | [`deploy/whatsoup-fleet.service`](../deploy/whatsoup-fleet.service) | stable | active | systemd fleet service |
| `deploy:systemd.heal-notify` | `whatsoup-heal-notify@.service` | [`deploy/whatsoup-heal-notify@.service`](../deploy/whatsoup-heal-notify@.service) | stable | active | systemd heal-notification template |
| `deploy:systemd.reply-guarantee` | `whatsoup-reply-guarantee.{service,timer}` | [`deploy/whatsoup-reply-guarantee.service`](../deploy/whatsoup-reply-guarantee.service), [`deploy/whatsoup-reply-guarantee.timer`](../deploy/whatsoup-reply-guarantee.timer) | stable | active | systemd timer for draining queued stuck replies |
| `deploy:systemd.harness-maintenance` | `harness-maintenance.{service,timer}` | [`deploy/harness-maintenance.service`](../deploy/harness-maintenance.service), [`deploy/harness-maintenance.timer`](../deploy/harness-maintenance.timer) | stable | active | systemd timer for harness and dependency maintenance |
| `deploy:setup.sh` | `setup.sh` | [`deploy/setup.sh`](../deploy/setup.sh) | stable | active | Operator setup script |
| `deploy:generate-health-tokens` | `generate-health-tokens.sh` | [`deploy/generate-health-tokens.sh`](../deploy/generate-health-tokens.sh) | stable | active | Generates per-instance health tokens |
| `deploy:tokens.env-template` | `whatsoup-tokens.env.example` | [`deploy/whatsoup-tokens.env.example`](../deploy/whatsoup-tokens.env.example) | stable | active | Template for `tokens.env` populated at deploy time |
| `deploy:mcp` | MCP wrapper templates | [`deploy/mcp/`](../deploy/mcp) | stable | active | MCP integration entrypoints |
| `deploy:hooks` | Agent sandbox hooks | [`deploy/hooks/`](../deploy/hooks) | beta | active | Sandbox enforcement plus fail-open diagnostics such as `poll-interaction-lint.mjs`; behavior contract still settling |
| `deploy:loops` | Background loop runners | [`deploy/loops/`](../deploy/loops) | beta | active | Long-running maintenance loops |
| `deploy:scripts` | Operator helper scripts | [`deploy/scripts/`](../deploy/scripts) | beta | active | Helpers that operators may reference from docs |
| `deploy:launchd.generated` | macOS plist generation behavior | [docs/runbooks/macos-launchd-deployment.md](runbooks/macos-launchd-deployment.md), [src/fleet/platform.ts](../src/fleet/platform.ts) | stable | active | Generated launchd plists; per §4, regen non-destructively is non-breaking |
| `deploy:launchd.timers` | `com.whatsoup.{harness-maintenance,reply-guarantee,release-drift-check}.plist` | [`deploy/com.whatsoup.harness-maintenance.plist`](../deploy/com.whatsoup.harness-maintenance.plist), [`deploy/com.whatsoup.reply-guarantee.plist`](../deploy/com.whatsoup.reply-guarantee.plist), [`deploy/com.whatsoup.release-drift-check.plist`](../deploy/com.whatsoup.release-drift-check.plist) | stable | active | launchd timer templates for maintenance, reply durability, and release drift alerting; rendered into `~/Library/LaunchAgents` by operator action on macOS, never auto-loaded (`RunAtLoad=false`; loading is a deployment step) |

---

## On-disk artifacts

These are paths and files the compatibility policy commits to. Operators rely on layout
stability for backup, migration, and disaster-recovery procedures.

| Identifier | Path | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `artifact:xdg.config-root` | `$XDG_CONFIG_HOME/whatsoup` | [docs/configuration.md §XDG Directory Layout](configuration.md#xdg-directory-layout) | stable | active | Config root; per-instance subdirs under `instances/` |
| `artifact:xdg.data-root` | `$XDG_DATA_HOME/whatsoup` | [docs/configuration.md §XDG Directory Layout](configuration.md#xdg-directory-layout) | stable | active | Data root: databases, logs, media cache |
| `artifact:xdg.state-root` | `$XDG_STATE_HOME/whatsoup` | [docs/configuration.md §XDG Directory Layout](configuration.md#xdg-directory-layout) | stable | active | Ephemeral state: lock files |
| `artifact:instance.config` | `<configRoot>/instances/<name>/config.json` | [docs/configuration.md §Instance Configuration](configuration.md#instance-configuration-configjson) | stable | active | Per-instance `config.json` |
| `artifact:instance.auth` | `<configRoot>/instances/<name>/auth/` | [docs/configuration.md](configuration.md) | stable | active | WhatsApp session credentials; never copy across machines |
| `artifact:instance.db` | `<dataRoot>/instances/<name>/bot.db` | [docs/configuration.md §Database Migration History](configuration.md#database-migration-history) | stable | active | Per-instance SQLite; migration chain canonical |
| `artifact:fleet.tokens` | `<configRoot>/fleet-tokens.json` | [README §Fleet API](../README.md#fleet-api) | stable | active | Active root token + rotated accept-list |
| `artifact:fleet.token-legacy` | `<configRoot>/fleet-token` | [README §Fleet API](../README.md#fleet-api) | stable | deprecated | Deprecation notice: [2026-05-12 public-surface baseline](releases/2026-05-12-public-surface-baseline.md#deprecations). Removal target: v2.0.0. Migrated on first read to `fleet-tokens.json`; retained for rollback |
| `artifact:fleet.silences` | `<configRoot>/fleet-silences.json` | [`src/fleet/silence-manager.ts`](../src/fleet/silence-manager.ts) | beta | active | Operator-managed alert silence rules; mode `0600`. Managed via `http:fleet.silences.*` routes. Safe to delete (re-bootstraps empty) |
| `artifact:fleet.alert-throttle` | `<configRoot>/fleet-alert-throttle.json` | [`src/fleet/alert-throttle-store.ts`](../src/fleet/alert-throttle-store.ts) | beta | active | Per-instance `lastAlertAt` cache used by `health-poller` to suppress duplicate alerts across restarts; mode `0600`; stale entries (>15min) auto-pruned at load. Safe to delete (re-bootstraps empty, worst case one batch of alerts re-fires) |
| `artifact:tokens.env` | `<configRoot>/instances/<name>/tokens.env` | [`deploy/whatsoup-tokens.env.example`](../deploy/whatsoup-tokens.env.example) | stable | active | Per-instance health tokens; shape stable |
| `artifact:lid-mappings.db` | `<dataRoot>/instances/<name>/bot.db` table `lid_mappings*` | [docs/configuration.md §Database Migration History](configuration.md#database-migration-history) | stable | active | Cross-instance LID-to-phone mapping; #251 freshness-gated history retained |
| `artifact:logs.dir` | `<dataRoot>/logs/` | [docs/configuration.md §Logging](configuration.md#logging) | stable | active | Pino daily-rotated logs |
| `artifact:process-tmp.dir` | `$XDG_DATA_HOME/whatsoup/tmp/<name>/` | [docs/configuration.md §XDG Directory Layout](configuration.md#xdg-directory-layout) | stable | active | Per-instance runtime `TMPDIR`; swept hourly after 3 hours |

---

## Console workflows

Per §2.1, console workflows are public at the **behavior** level — what an operator can
accomplish — not the internal component structure (which is private per §2.2). The
behavioral contract is documented at [docs/console-guide.md](console-guide.md) and the
[README Fleet Console section](../README.md#fleet-console).

| Identifier | Workflow | Source | Stability | Status | Notes |
|---|---|---|---|---|---|
| `console:fleet-overview` | Fleet overview + line list | [README §Fleet Overview](../README.md#fleet-overview), [docs/console-guide.md](console-guide.md) | stable | active | Behavior contract — internal React component layout is private |
| `console:line-detail.metrics` | Per-line metrics view | [README §Line Detail — Metrics](../README.md#line-detail-metrics) | stable | active | 24h / 7d / 30d windows |
| `console:operations` | Operations panel | [README §Operations](../README.md#operations) | stable | active | Restart / stop / access / send |
| `console:inbox` | Inbox / conversation list | [README §Inbox](../README.md#inbox) | stable | active | Operator inbox view |
| `console:instance-lifecycle` | Create / pair / delete instance | [README §Instance Lifecycle](../README.md#instance-lifecycle) | stable | active | Pair-via-QR flow |
| `console:websocket-realtime` | Realtime updates | [README §WebSocket Realtime](../README.md#websocket-realtime) | stable | active | Pushes feed / typing / metrics deltas |

---

## Cross-references

- [docs/specs/2026-05-10-compatibility-deprecation-policy-design.md](specs/2026-05-10-compatibility-deprecation-policy-design.md) — owning spec; defines §9.1 row shape, §9.3 bootstrap caveat, §9.4 CI linting, §10 promotion path
- [docs/specs/2026-05-09-settings-migration-framework-design.md](specs/2026-05-09-settings-migration-framework-design.md) — `public_surface_registry` is the eighth migration domain
- [docs/specs/2026-05-09-fleet-topology-control-plane-design.md](specs/2026-05-09-fleet-topology-control-plane-design.md) — admin / client / standalone modes
- [docs/specs/2026-05-08-whatsoup-protection-layer-design.md](specs/2026-05-08-whatsoup-protection-layer-design.md) — protection-policy surface
- [docs/releases/2026-05-12-public-surface-baseline.md](releases/2026-05-12-public-surface-baseline.md) — bootstrap release note for public-surface additions and deprecations
- [docs/releases/2026-07-14-database-compatibility-drain.md](releases/2026-07-14-database-compatibility-drain.md) — inspection-only health contract for startup database drains
- [docs/configuration.md](configuration.md) — canonical config / env-var reference
- [docs/tools.md](tools.md) — canonical MCP tool reference (per-tool schemas)
- [docs/runbook.md](runbook.md) — operator runbook
- [README.md](../README.md) — README API table mirrors the HTTP routes here
