# Personal-line watch — feature runbook

Protocol-level documentation for the substrate watch/trigger system, framed
around the most common operator use case: **a personal-line agent watching
for messages from a specific contact, in a specific group, on a specific
schedule.**

The primitives below are not new — `create_watch` and the `bead_triggers`
table have shipped with the substrate slice. This runbook normalises them
into a named feature, documents the working surface, and calls out the
runtime gap that operators need to know about before they rely on a watch.

## 1. Feature intent

The substrate's watch/trigger system gives an agent durable, scheduled
awareness of world-state changes without requiring a live Claude session to
stay open. A "personal-line watch" is the canonical shape:

> The personal-line operator-agent registers a watch saying "fire a
> notification into chat X if contact Y posts in group Z within the last N
> minutes." The watch persists in SQLite, survives instance restarts, and
> the agent can list, pause, and expire it through the substrate tools.

Other watch kinds (URL change detection, file mtime, Pinecone similarity,
shell command, cron schedule) share the same plumbing and the same
limitations described below.

## 2. Architecture

```
create_watch (MCP tool)
  │
  ├─ validates criteria via Zod (triggers.ts → SPEC_REGISTRY[kind].parse())
  ├─ creates bead (kind=watch) in `beads` table
  ├─ creates trigger in `bead_triggers` table
  └─ projects to Obsidian vault (if configured)

TriggerPoller (src/core/substrate/poller.ts)   ← wired in main.ts since PR #677
  │
  ├─ expiry sweep: status='active' AND terminal_at <= now → expireTrigger
  ├─ dueTriggers(db, now, batchSize) → process each
  ├─ per-kind executor (poll.sqlite + poll.pinecone + poll.file +
  │     poll.url[gated] + schedule.* implemented; poll.email no-op;
  │     poll.shell removed from creation, retained for legacy fail-closed;
  │     event.message = reserved scaffold, persisted with next_fire_at=NULL so
  │     the poller never selects it — not yet executed, pending ingest path)
  ├─ writes trigger_runs row (status: running → ok/noop/failed/terminal_fired)
  └─ on fire, sends notification to report_chat_jid via Messenger
```

Tables involved:

| Table | Purpose |
|---|---|
| `beads` | The watch bead — kind, title, owner, status, chat_jid |
| `bead_triggers` | The trigger — kind, spec_json, interval, next_fire_at, terminal_at, report_chat_jid |
| `bead_events` | Status change log (created, activated, expired) |
| `trigger_runs` | Execution log — each poll attempt and its result |

Schema is defined in `src/core/substrate/schema.ts`; the spec registry and
`dueTriggers` query live in `src/core/substrate/triggers.ts`.

## 3. Supported trigger kinds

Defined in `src/core/substrate/triggers.ts` (`SPEC_REGISTRY`):

| Kind | Required fields | Description |
|---|---|---|
| `schedule.cron` | `expr`, `tz?` | Cron-based scheduling |
| `schedule.at_time` | `fire_at` (unix epoch **seconds**) | One-shot at a specific time. A value above the epoch-seconds ceiling (`MAX_REASONABLE_FIRE_AT_SEC`, year 2100) is treated as epoch-**milliseconds** and normalized down (`normalizeFireAtSeconds`); a value implausible in either unit is rejected. Prevents a caller-supplied ms timestamp from being stored verbatim and compared against the poller's seconds clock, which would never fire (#1757). |
| `poll.email` | `source` (gmail/m365), `sender?`, `subject_regex?`, `label?`, `body_regex?` | Email polling |
| `poll.url` | `url`, `hash_mode` (text/selector/headers), `selector?` | URL change detection — **wired, GATED default-OFF**. Requires `advanced.enableUrlWatch: true`; otherwise `create_watch` rejects `source:'poll.url'` at creation (never persists) and the poller fails closed (`url_watch_disabled`) for any persisted row. Reuses the link-preview SSRF stack (`fetchUrlGuarded`: per-hop resolved-IP revalidation, body cap, timeout). Tighter than the preview path: **https-only**, **default-port-only** (443/bare), and a blocked private/loopback/metadata host → `failed` / `ssrf_blocked` (fail-CLOSED, not the soft fallback link-preview uses). Fires on a change in the body / selected subtree (`selector`) / header subset hash. `output_json` carries only `{hashChanged, urlHash, hashMode}` — never the fetched body. |
| `poll.file` | `path`, `watch` (exists/mtime/content_hash) | Local file monitoring — **wired**. Fail-closed path policy: the resolved path must be under `memory.fileWatch.allowed_roots` (empty allowlist = deny-all; the poller runs unsandboxed in the main process), `/proc` `/dev` `/sys` are rejected, symlink targets are realpath-rechecked against the allowlist (symlink-escape defense), and only regular files are accepted. Disallowed → `failed` / `path_not_allowed`. `content_hash` reads are size-bounded (16 MiB cap). **Fingerprint surface:** for `watch:'content_hash'`, `trigger_runs.output_json` stores the raw SHA-256 digest of the watched file (under `hash`) as the change-detection baseline — alongside the operator-facing `{exists, hashChanged}` booleans. The file *body* is never written, but the digest is a stable, opaque fingerprint of the watched content (an attacker who can both read `trigger_runs` and guess/brute-force a candidate file could confirm the file's content by matching the digest). This is an accepted tradeoff: a content-change watch is meaningless without a persisted baseline to diff against. `exists`/`mtime` watches store no digest. |
| `poll.sqlite` | `sql`, `fire_when` (rows_returned/rowcount_changed), `binds?` | SQLite query polling — the workhorse for personal-line watches |
| `poll.pinecone` | `index`, `namespace`, `query`, `top_k?`, `threshold?` | Pinecone similarity search — **wired**. Reuses the `knowledge_search` Pinecone client + `memory.pinecone.allowedIndexes` allowlist (fail-closed `index_not_allowed`; empty allowlist denies all). Fires when `topScore >= threshold` (or any result when no threshold). `output_json` carries only `{matchCount, topScore}` — no record bodies. |
| ~~`poll.shell`~~ | — | **Removed from creation, retained internally for legacy fail-closed handling** (F2 Slice B). No executor ever existed; dropped from the `create_watch` `source` enum, so creation fails loudly via Zod. The kind is retained in `TriggerKind` / `ShellSpec` / `SPEC_REGISTRY` only so a legacy persisted row still validates and fails closed in the poller (`failed` / `shell_watch_removed`) rather than crashing on an unknown kind. |
| `event.message` | `match` (sender_jid/regex/mention), `value`, `chat_jid?` | Inbound message matching — **RESERVED SCAFFOLD, not yet executed**. Validated and persisted, but a created row carries `next_fire_at = NULL` (`computeNextFireAt` returns NULL for this kind), so the interval poller's `dueTriggers` (which requires `next_fire_at IS NOT NULL`) never selects or churns it — no silent reschedule. It still TTL-expires via the kind-agnostic `terminal_at` sweep. A legacy row that somehow has a non-null `next_fire_at` fails CLOSED in the executor (`failed` / `event_message_not_polled`) and is not rescheduled. Pending a future ingest-path integration (event-driven, not interval-polled) — see §6. |

## 4. Personal-line watch recipe

The personal-line shape — "did contact X post in chat Y in the last N
seconds?" — is expressed today with `poll.sqlite` against the instance's own
`bot.db`. Both `@s.whatsapp.net` JIDs and `@lid` aliases must be matched
because WhatSoup stores the sender as either format depending on message
source.

`create_watch` parameters:

| Param | Type | Required | Description |
|---|---|---|---|
| `source` | enum: one of `poll.email`, `poll.url`, `poll.file`, `poll.sqlite`, `poll.pinecone`, `event.message` | yes | Trigger kind. `poll.shell` is removed from this enum (creation fails via Zod) but retained internally for legacy fail-closed handling. `poll.url` additionally requires `advanced.enableUrlWatch: true` or creation is rejected. The `schedule.*` kinds in §3 are valid `bead_triggers.kind` values but are reachable via `create_agent_job`, not `create_watch`. |
| `criteria` | object | yes | Kind-specific spec (must pass Zod validation) |
| `report_chat` | string | yes | Conversation key to send notifications to |
| `title` | string | no | Human-readable description |
| `interval_seconds` | number | no | Poll interval (default varies by kind) |
| `ttl_hours` | number | no | Time-to-live (clamped to `config.memory.watchTtl.maxHours`) |
| `on_terminal` | enum | no | What to do at expiry: `notify` (default), `silent`, `reopen_bead` |
| `dedupe_key` | string | no | Prevents duplicate triggers with same kind+key |

Generic `poll.sqlite` example (placeholders in `<>` brackets):

```json
{
  "source": "poll.sqlite",
  "criteria": {
    "sql": "SELECT message_id, sender_name, substr(content,1,200) AS preview, datetime(timestamp,'unixepoch') AS ts FROM messages WHERE chat_jid = '<GROUP_JID>' AND (sender_jid = '<CONTACT_JID>' OR sender_jid = '<CONTACT_LID>') AND timestamp > strftime('%s','now') - <WINDOW_SECONDS> ORDER BY timestamp DESC LIMIT 5",
    "fire_when": "rows_returned"
  },
  "report_chat": "<REPORT_CHAT_JID>",
  "title": "personal-line watch: <CONTACT_LABEL> in <GROUP_LABEL>",
  "interval_seconds": 1800,
  "ttl_hours": 24,
  "on_terminal": "notify"
}
```

`fire_when: "rows_returned"` notifies whenever the SQL returns ≥1 row.
`fire_when: "rowcount_changed"` only notifies on delta from the previous
poll's row count — useful when the watch wants to surface only new activity
rather than re-firing on every poll while a match remains in the window.

### 4.1 Placeholder substitution

The recipe's bracketed placeholders map to instance-specific values as
follows. Source values once from the running instance — values change after
re-pairing or after an admin rotates contact metadata.

| Placeholder | Type | Where to source | Example |
|---|---|---|---|
| `<GROUP_JID>` | string | The group's `chat_jid` column in the instance `chats` table, or the value returned by `list_chats`. Project convention treats `conversation_key` (also on the row) as the canonical chat identity for reads — `chat_jid` is fine for filtering on the historical `messages` table, but if you build longer-lived queries prefer `conversation_key = '<GROUP_CK>'` against `idx_messages_conversation_ts`. | `111111100000000@g.us` |
| `<CONTACT_JID>` | string | The contact's `@s.whatsapp.net` JID — `messages.sender_jid` for any message the contact has sent into the group. | `15555550100@s.whatsapp.net` |
| `<CONTACT_LID>` | string | The contact's `@lid` alias — also surfaces in `messages.sender_jid`, depending on which delivery channel the message arrived on. Both forms must be matched because WhatsApp interleaves them across messages from the same contact. | `1111111100000@lid` |
| `<WINDOW_SECONDS>` | integer | The look-back window in seconds. Match it to `interval_seconds` (or a small multiple) so each poll covers the window since the last poll without large overlap. | `1800` (30 minutes) |
| `<REPORT_CHAT_JID>` | string | The `conversation_key` of the chat that should receive the notification (typically the operator's admin DM). | `15555550100@s.whatsapp.net` |
| `<CONTACT_LABEL>` | string | Free-form display label for the watch title. | `Alice Example` |
| `<GROUP_LABEL>` | string | Free-form display label for the watch title. | `Eng Standup` |

For the §7 workaround, also:

| Placeholder | Type | Where to source | Example |
|---|---|---|---|
| `<INSTANCE_BOT_DB_PATH>` | path | Per the XDG layout — usually `~/.local/share/whatsoup/instances/<instance>/bot.db`. See `docs/configuration.md` for overrides. | `~/.local/share/whatsoup/instances/ml-bot/bot.db` |
| `<TITLE>` | string | Watch title (free-form). | `personal-line: Alice in Eng Standup` |
| `<OWNER_JID>` | string | The agent's own `botJid` — visible in `agent_runtime.connection` startup logs. | `15555550100@s.whatsapp.net` |
| `<SQL>` | string | The complete SQL string — **use the corrected query in §4 as-is** to avoid silently re-introducing the seconds-vs-milliseconds bug fixed in PR #670. | (full §4 query) |

## 5. ZodRecord serialisation fix (2026-05-19)

Operators on `main` prior to PR #666 will see `create_watch` reject
`criteria` over MCP with:

```
mcp_whatsoup_create_watch — Invalid parameters for tool "create_watch":
[{"code":"invalid_type","expected":"object","received":"string","path":["criteria"]}]
```

Root cause: `zodToJsonSchema()` in `src/mcp/registry.ts` did not handle
`ZodRecord`, so `criteria: z.record(z.unknown())` exported without a
`type:` annotation. Strict MCP clients (including the Claude CLI agent
client) then serialised the parameter as a string and the server-side
parse rejected it.

PR #666 emits `{ "type": "object" }` for ZodRecord. The fix lands once the
WhatSoup instance restarts; until then, the workaround in §7 below inserts
the watch directly into SQLite.

## 6. Runtime poller status

`TriggerPoller` (`src/core/substrate/poller.ts`) is wired into `main.ts`
as of PR #677. It drains `bead_triggers.next_fire_at` on a 30s interval
and runs per-kind executors. **Not every kind has an executor yet** —
the first cut shipped only the kinds needed for personal-line watches.

| Kind | Stored? | Fires? | Notes |
|---|---|---|---|
| `poll.sqlite` | yes | **yes** | SQL executed; `fire_when` (`rows_returned` / `rowcount_changed`) evaluated |
| `poll.pinecone` | yes | **yes** | Similarity search via the `knowledge_search` client; fail-closed `index_not_allowed` against `memory.pinecone.allowedIndexes`; fires on `topScore >= threshold` (or any result when no threshold); `output_json` = `{matchCount, topScore}` only |
| `poll.file` | yes | **yes** | exists/mtime/content_hash; fail-closed path policy against `memory.fileWatch.allowed_roots` (empty = deny-all), `/proc` `/dev` `/sys` and non-regular files rejected, symlink-escape realpath recheck, 16 MiB hash cap; disallowed → `failed` / `path_not_allowed`. For `content_hash`, `output_json` carries the raw SHA-256 digest (`hash`) as the change-detection baseline — an opaque content fingerprint (never the body); see §3 poll.file for the tradeoff |
| `schedule.cron` | yes | **yes** | Fires on cron expression; `next_fire_at` advanced via `nextCronRun` |
| `schedule.at_time` | yes | **yes** | One-shot at `fire_at`, then transitions to `status='expired'` |
| `poll.url` | yes (gated) | **yes** (gated) | **GATED default-OFF** behind `advanced.enableUrlWatch`. When OFF: `create_watch` rejects at creation; a persisted row fails closed (`failed` / `url_watch_disabled`). When ON: fetches via the link-preview SSRF stack (`fetchUrlGuarded`), **https-only + default-port-only**, blocked host → `failed` / `ssrf_blocked` (fail-CLOSED); fires on a body/selector/header hash change; `output_json` = `{hashChanged, urlHash, hashMode}` only (no body) |
| ~~`poll.shell`~~ | n/a | n/a | **Removed from creation, retained internally for legacy fail-closed handling** (F2 Slice B). Dropped from the `create_watch` enum (creation fails via Zod); retained in `TriggerKind`/`ShellSpec`/`SPEC_REGISTRY` only so a legacy persisted row fails closed: `failed` / `shell_watch_removed` (no executor, no crash) |
| `poll.email` | yes | no | Recognised; records a `not_implemented` noop row in `trigger_runs` (no log line), 1h cooldown (deferred — no credential substrate) |
| `event.message` | yes | **no (reserved scaffold)** | Validated + persisted but NOT executed by the interval poller. A created row has `next_fire_at = NULL` so `dueTriggers` never selects it (no churn, no `not_implemented` 1h reschedule); it still TTL-expires via the `terminal_at` sweep. A legacy row with a non-null `next_fire_at` fails CLOSED (`failed` / `event_message_not_polled`), not rescheduled. Event-driven; a future ingest-path integration (design exists) will own it |

**Terminal expiry is handled** by a separate sweep at the start of each
tick — the `dueTriggers` query filters out rows past `terminal_at`, so
without this sweep they would stay `status='active'` forever. The sweep
sets `status='expired'`, writes a `trigger_expired` bead_event, records
a `terminal_fired` row in `trigger_runs`, and (when `on_terminal='notify'`)
sends an expiry notification.

### Behaviour per kind (delivered)

For each *delivered* kind, the poller:

1. Calls `dueTriggers(db, now, batchSize)` on the 30s interval
2. Executes the kind-specific check (run the SQL, advance the schedule)
3. Records the result in `trigger_runs` with status `ok` / `noop` / `failed`
4. If fired, sends the notification to `report_chat_jid` via `Messenger`
5. Updates `next_fire_at` to `now + interval_seconds` (or the next cron tick)
6. Handles `terminal_at` expiry — sets trigger status to `expired`, fires
   the `on_terminal` action (notify / silent / reopen_bead)

### Safety behaviours

The poller enforces four defensive policies that bound the blast radius
of misconfigured or compromised triggers:

- **Circuit breaker (auto-pause).** After `MAX_CONSECUTIVE_FAILURES` (default 5) consecutive failed runs for the same trigger, the poller transitions it to `status='paused'`, clears `next_fire_at`, writes a `trigger_paused` bead_event with `{ reason: 'consecutive_failures', failure_count }`, and dispatches a pause notification to `report_chat_jid` (unless `on_terminal='silent'`). A successful or noop run breaks the streak. Common case it prevents: a `poll.sqlite` trigger against a table that got dropped by a migration, otherwise retrying every 60s forever. **Reachability caveat:** this breaker keys on `outcome.status='failed'` and is evaluated in `scheduleNextFire`'s `else if` chain *after* the `schedule.cron`/`schedule.at_time` branches — so a `schedule.cron` trigger (which always reschedules to its next tick) never reaches it. The forbidden-target retirement below is the bound that *does* apply to scheduled producers.
- **Read-only SQL guard.** `poll.sqlite` spec SQL runs inside a `PRAGMA query_only = ON` / `OFF` envelope. Write attempts (`DELETE`, `UPDATE`, `DROP`, `INSERT`) fail with a SQLite "attempt to write a readonly database" error which the existing `sql_error` path captures into `trigger_runs`. Restoration is in a `finally` block so the poller's own follow-up writes (`UPDATE bead_triggers`, `INSERT trigger_runs`) still succeed. Bounds the blast radius of a compromised bead or confused-deputy injection.
- **Notification throttle.** Per-trigger minimum interval between dispatches, default `NOTIFICATION_THROTTLE_MIN_INTERVAL_SEC = 300` (5 min). When the previous dispatch was within the window, the current run is still recorded `status='ok' fired=true` but with `{ throttled: true, throttleRemainingSec: N }` in `output_json` — `messenger.sendMessage` is not called. Prevents wire-speed spam when `fire_when='rows_returned'` SQL matches permanently. The throttle reference is the last NOTIFICATION timestamp — the most recent `status='ok'` run whose `trigger_runs.output_json` carries a non-null delivered receipt, queried via `json_extract(output_json, '$.deliveredWaMessageId') IS NOT NULL` (not a `LIKE '%deliveredWaMessageId%'` substring scan, which would false-match the key name appearing in serialised `$.sampleRow` row data or a literal-null value) — not `bead_triggers.last_fire_at` (which advances every tick, including noops).
- **Dispatch-failure observability.** When a trigger fires and dispatch is attempted but `messenger.sendMessage` throws a *transient* error (timeout, connection closed, session 401 — anything not classified as a permanent per-target reject), the (already-committed) run is post-commit marked `error_kind='notify_dispatch_failed'` with `status` left unchanged (`ok`) and `error_message` NULL. This makes a fired-but-undelivered run distinguishable in `trigger_runs` telemetry from a throttled one (which was never dispatched and carries no `error_kind`) and from an execute failure (`status='failed'` with its own `error_kind`). The delivery is at-most-once: no automatic retry, and the trigger keeps rescheduling (fail-loud, never silently retire — a daily job must survive a transport blip).
- **Forbidden-target retirement (#1745).** When the dispatch throws a *permanent per-target authz reject* — `isForbiddenTargetReject` matches a `forbidden`/`403` message or `output.statusCode === 403` (the WhatsApp server refusing because the bot was removed from / is not a member of `report_chat_jid`); `401`/`unauthorized` is deliberately excluded as a transient session condition — the run is marked `error_kind='notify_forbidden_target'` instead. After `MAX_CONSECUTIVE_FORBIDDEN_REJECTS` (default 3) consecutive such rejects the poller RETIRES the producer: `status='paused'`, `next_fire_at=NULL`, a `trigger_paused` bead_event with `{ reason: 'forbidden_target', report_chat_jid, reject_count }` (the producer signal), and a `trigger_forbidden_target` BOT ERRORS alert naming the bead/trigger/chat. The alert is the *out-of-band* channel precisely because the report chat is undeliverable — the gap that let the original incident loop for ~4 days feeding the quarantine. Re-arm only after the bot is re-added, or delete the producing bead.

All four can be overridden per-poller via `TriggerPollerOptions` for tests
and operator tuning (e.g. `maxConsecutiveFailures`,
`maxConsecutiveForbiddenRejects`, `notificationThrottleMinIntervalSec`).

### Remaining work

After F2 Slice A (`poll.pinecone`, `poll.file`) and Slice B (`poll.url`
gated, `poll.shell` removed), the only remaining not-implemented kind is
`poll.email` — deferred because no Gmail/M365 credential substrate exists
(see the F2 closure doc). `event.message` is a **reserved scaffold**: the
spec is validated and the row is persisted, but it is NOT yet executed and
is intentionally NOT a poller concern. A created `event.message` row carries
`next_fire_at = NULL` (`computeNextFireAt` returns NULL for this kind), so
the poller's `dueTriggers` never selects it — the row sits inert (no
`not_implemented` 1h reschedule) and only TTL-expires via the kind-agnostic
`terminal_at` sweep. A legacy row that somehow has a non-null `next_fire_at`
fails CLOSED in the executor (`failed` / `event_message_not_polled`) and is
not rescheduled. It is event-driven and belongs in a future ingest path
(design exists), tracked as a separate slice. Any new executor is wired in
`poller.ts:executeTrigger()`
with a per-kind branch in `scheduleNextFire` where appropriate.

## 7. Workaround: direct DB insertion

When `create_watch` over MCP is unavailable (pre-PR-#666 instance, or any
other tooling outage), watches can be inserted directly. Substitute the
bracketed placeholders with the target instance's values (see §4.1).

**What this workaround does NOT do**, vs `createTrigger` in
`src/core/substrate/triggers.ts`:

- **Skips Zod validation** of `spec_json` against `SPEC_REGISTRY[kind]`. A
  malformed spec is rejected by the runtime poller but persists in the
  database, polluting `list_triggers` output and `bead_triggers` audits.
  Run the spec through the running instance's `create_watch` MCP tool
  whenever it is available; reach for this workaround only when MCP is
  genuinely unreachable.
- **Skips the `trigger_created` `bead_event`.** This row writes a
  `status_change` event for the bead, but the trigger itself has no
  corresponding event row. Substrate audits that walk `bead_events` looking
  for trigger lifecycle will show a half-formed history.
- **Skips Obsidian projection.** Vault sync happens through `create_watch`,
  not through SQLite triggers; manually-inserted watches will not appear in
  the operator's vault until the next full reconciliation.

```python
import sqlite3, json, time

db = sqlite3.connect("<INSTANCE_BOT_DB_PATH>")
db.execute("PRAGMA foreign_keys = ON")  # bead_triggers.bead_id has ON DELETE CASCADE
now = int(time.time())

db.execute("BEGIN")
# 1. Create bead. Mirrors create_watch: kind, title, owner_jid, status only —
#    the MCP tool does not set chat_jid on watch beads, so omit it here too.
db.execute("""
    INSERT INTO beads (kind, title, owner_jid, status, created_at, updated_at)
    VALUES ('watch', '<TITLE>', '<OWNER_JID>', 'active', ?, ?)
""", (now, now))
bead_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]

# 2. Create trigger.
# IMPORTANT: <SQL> must be the corrected query from §4 — the column
# `messages.timestamp` is unix seconds, not milliseconds. PR #670 fixed a
# silent-failure bug where an `* 1000` form returned zero rows forever.
spec = {"sql": "<SQL>", "fire_when": "rows_returned"}
db.execute("""
    INSERT INTO bead_triggers (bead_id, kind, spec_json, spec_version, status,
        interval_seconds, next_fire_at, terminal_at, on_terminal,
        report_chat_jid, created_at, updated_at)
    VALUES (?, 'poll.sqlite', ?, 1, 'active', ?, ?, ?, 'notify', ?, ?, ?)
""", (bead_id, json.dumps(spec), 1800, now+1800, now+86400,
      '<REPORT_CHAT_JID>', now, now))

# 3. Log event
db.execute("""
    INSERT INTO bead_events (bead_id, event_type, payload_json, actor, created_at)
    VALUES (?, 'status_change', '{"from":null,"to":"active"}', 'user', ?)
""", (bead_id, now))
db.commit()
```

The bot.db location follows the standard XDG layout described in
`docs/configuration.md` — typically
`~/.local/share/whatsoup/instances/<instance>/bot.db`.

## 8. Operational gotcha: startup-message amplification

During rapid instance restarts (e.g. iterating on launchd plist changes,
testing wrapper updates, debugging MCP socket teardown), the admin DM can
receive a burst of identical startup notifications — typically the agent's
idle "back online / standing by" message — once per restarted process.

Contributing factors:

1. **Startup notification per process** — each new agent process posts a
   single startup message to the admin's DM. Rapid restarts compress these
   into a visible spam pattern.
2. **Reply-guarantee fallback** — when an agent session does not complete
   within `DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS` (10 min), the fallback
   fires. Rapid session cycling (spawn → suspend → spawn) compresses this
   into a loop.
3. **MCP socket churn** — restarting WhatSoup tears down and rebuilds the
   MCP socket; in-flight agent sessions reconnect, but a session may cycle
   (spawn idle response, then suspend) before stabilising.

Mitigations:

- Avoid restarting WhatSoup while an agent session depends on its MCP
  socket; let the session quiesce first.
- The reply-guarantee rate limit (`DEFAULT_REPLY_GUARANTEE_RATE_LIMIT_MS`
  ≈ 15 min) suppresses true spam between sessions, but rapid restarts
  bypass it because each restart is a fresh process with no in-memory rate
  state.
- A follow-up enhancement worth tracking: persist the reply-guarantee
  rate-limit timestamp to SQLite so it survives restarts.

## 9. See also

- `docs/tools.md#create_watch` — full parameter reference
- `docs/runbooks/substrate-slice-1.md` — substrate schema and rollback
- `src/core/substrate/triggers.ts` — `SPEC_REGISTRY` and `dueTriggers`
- `src/core/substrate/schema.ts` — table definitions (`MIGRATION_23`)
- `src/mcp/tools/substrate.ts` — `create_watch` MCP tool implementation
