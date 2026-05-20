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

dueTriggers(db, now, batchSize)   ← runtime poller (not yet wired — see §6)
  │
  ├─ queries: status=active, next_fire_at <= now, not expired
  ├─ executes poll (kind-specific: SQL query, shell cmd, HTTP, etc.)
  └─ writes result to trigger_runs, fires notification to report_chat_jid
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
| `schedule.at_time` | `fire_at` (unix epoch) | One-shot at a specific time |
| `poll.email` | `source` (gmail/m365), `sender?`, `subject_regex?`, `label?`, `body_regex?` | Email polling |
| `poll.url` | `url`, `hash_mode` (text/selector/headers), `selector?` | URL change detection |
| `poll.file` | `path`, `watch` (exists/mtime/content_hash) | Local file monitoring |
| `poll.sqlite` | `sql`, `fire_when` (rows_returned/rowcount_changed), `binds?` | SQLite query polling — the workhorse for personal-line watches |
| `poll.pinecone` | `index`, `namespace`, `query`, `top_k?`, `threshold?` | Pinecone similarity search |
| `poll.shell` | `argv[]`, `fire_when` (exit_zero/stdout_nonempty/stdout_regex), `cwd?`, `regex?` | Shell command polling |
| `event.message` | `match` (sender_jid/regex/mention), `value`, `chat_jid?` | Inbound message matching (runtime not wired — see §6) |

## 4. Personal-line watch recipe

The personal-line shape — "did contact X post in chat Y in the last N
seconds?" — is expressed today with `poll.sqlite` against the instance's own
`bot.db`. Both `@s.whatsapp.net` JIDs and `@lid` aliases must be matched
because WhatSoup stores the sender as either format depending on message
source.

`create_watch` parameters:

| Param | Type | Required | Description |
|---|---|---|---|
| `source` | enum: one of `poll.email`, `poll.url`, `poll.file`, `poll.sqlite`, `poll.pinecone`, `poll.shell`, `event.message` | yes | Trigger kind. The `schedule.*` kinds in §3 are valid `bead_triggers.kind` values but are reachable via `create_agent_job`, not `create_watch`. |
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

## 6. Runtime gap: `dueTriggers()` not wired

`dueTriggers()` (`src/core/substrate/triggers.ts:183`) is exported and unit
tested but **never imported or called** anywhere in the WhatSoup runtime.
The consequence:

- Triggers are validated and stored correctly
- `bead_triggers` rows are well-formed with `next_fire_at` timestamps
- But no runtime loop picks them up — no polling, no execution, no
  `trigger_runs` entries

| Kind | Stored? | Fires? | Notes |
|---|---|---|---|
| `poll.sqlite` | yes | no | SQL never executed on interval |
| `poll.shell` | yes | no | Shell command never run |
| `poll.url` | yes | no | URL never fetched |
| `poll.email` | yes | no | Email never checked |
| `poll.file` | yes | no | File never stat'd |
| `poll.pinecone` | yes | no | Pinecone never queried |
| `event.message` | yes | no | No inbound message matching |

Until the poller lands, watches function as **durable intent records** —
useful for record-keeping, vault projection, and `list_beads`/`list_triggers`
audits, but they do not auto-fire.

### Required to activate

A poller loop (likely in `src/main.ts` or a new
`src/core/substrate/poller.ts`) that:

1. Calls `dueTriggers(db, now, batchSize)` on an interval (e.g. every 30s)
2. For each due trigger, executes the kind-specific check (run the SQL,
   exec the argv, fetch the URL, etc.)
3. Records the result in `trigger_runs`
4. If fired, sends the notification to `report_chat_jid`
5. Updates `next_fire_at` to `now + interval_seconds`
6. Handles `terminal_at` expiry — sets trigger status to `expired`, fires
   the `on_terminal` action

This is a tracked WhatSoup enhancement; see the substrate roadmap.

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
