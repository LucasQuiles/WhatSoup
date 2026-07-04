# WhatSoup Durability Engine

Reference document for `src/core/durability.ts`.

---

## 1. Design Rationale

WhatsApp's transport layer (via Baileys) provides **at-most-once delivery** semantics. A message sent by the bot is handed to WhatsApp with no guarantee of delivery acknowledgement — if the process crashes between `sendMessage()` returning and the echo arriving on the WebSocket, it is impossible to know from transport state alone whether the message was delivered.

WhatSoup addresses this with a write-ahead journal approach: every outbound send is recorded in SQLite _before_ the network call, and the resulting WhatsApp message ID is recorded _after_. On reconnect, the journal is reconciled against incoming echoes and the messages table to determine what actually arrived. Inbound events are journaled symmetrically so that crash recovery can decide whether a message that was "processing" at shutdown was fully handled.

**Three concrete problems the engine solves:**

1. **Crash during send** — the process dies after `sendMessage()` is called but before the echo arrives. The `sending → maybe_sent` promotion in pre-connect recovery captures this.

2. **Echo never arrives** — the message was delivered but the WebSocket echo was lost (e.g., brief disconnect). The 30-second sweep (`sweepStaleSubmitted`) and post-connect reconciliation against the messages table handle this.

3. **Interrupted inbound processing** — an incoming message started a Claude agent turn but the process crashed before the agent replied. Pre-connect recovery marks such events `failed`. There is currently no re-queue consumer: a message that was mid-processing at crash time is recorded as `failed` but is not retried or re-notified. Closing this gap is tracked by the bot-errors reliability workstream.

---

## 2. Core Concepts

### 2.1 Inbound Events Journal (`inbound_events`)

Every message that enters the bot's processing pipeline is written to `inbound_events` as the _first_ action, before any routing or LLM call. The journal entry carries a monotonically increasing `seq` number that threads through the entire lifecycle.

The `routed_to` column records which runtime handled the message (`agent`, `chat`, `passive`, etc.). If a process crash occurs while a turn is in progress, pre-connect recovery can inspect `routed_to` to understand what context was lost.

An inbound event is considered "done" only when its associated terminal outbound op transitions to `echoed`. This closes the loop: the bot confirms delivery before it considers the conversation turn complete.

### 2.2 Outbound Operations Journal (`outbound_ops`)

Every message the bot sends is journaled in `outbound_ops` before the network call. The journal entry captures:

- `payload` — the message text (or media descriptor), with a `payload_hash` (SHA-256) for deduplication detection.
- `replay_policy` — governs what happens if the op is found undelivered after a crash (see §2.4).
- `source_inbound_seq` — links the outbound op back to the inbound event that caused it.
- `is_terminal` — marks the op as the "final reply" for a conversation turn. When a terminal op reaches `echoed`, the linked inbound event is automatically advanced to `complete`.

### 2.3 Echo Correlation

When Baileys delivers an outgoing message, WhatsApp echoes it back on the same WebSocket connection with the same `message_id` it assigned to the send. WhatSoup captures this echo via `matchEcho(waMessageId)`:

1. Look up `outbound_ops` for a row with `wa_message_id = ? AND status = 'submitted'`.
2. If found, call `markEchoed()`.
3. If the op has `is_terminal = 1`, `markEchoed()` automatically calls `completeInbound()` on the linked inbound event.

If no echo arrives within 30 seconds after submission, the op is promoted to `maybe_sent` by the periodic sweep (§4.3), which triggers reconciliation on the next post-connect recovery pass.

### 2.4 Replay Policies

Every outbound op declares one of three replay policies:

| Policy | Meaning | On unconfirmed delivery |
|---|---|---|
| `safe` | Re-sending is idempotent (same text produces same observable result) | Reset to `pending`, then re-sent by the pending drainer (§4.4) |
| `unsafe` | Re-sending would cause a duplicate visible to the recipient | Quarantine — require manual resolution |
| `read_only` | Op has no side effects visible to the recipient (e.g., presence, read receipt) | Reset to `pending`, then re-sent by the pending drainer (§4.4) |

**Replay duplicate-delivery tradeoff.** Because only `safe`/`read_only` ops are ever
reset to `pending` (`unsafe` ops — including terminal user replies — are quarantined, never
replayed), a replay that re-sends an op which *was* actually delivered produces at most a
duplicate of an idempotent/side-effect-free message. That duplicate is the accepted tradeoff
for guaranteeing safe/read_only ops are not silently dropped; it is never incurred for
user-terminal replies.

The policy is set at creation time by the caller. Autonomous bot responses (via `sendTracked`) typically use `safe` because the text is deterministic for a given conversation state. MCP tool sends are excluded from the durability journal by design (gap-matrix item 92) — those use direct Baileys calls and do not go through `sendTracked`.

---

## 3. State Machines

### 3.1 Inbound Event Lifecycle

```
                        ┌─────────────────────────────────────────┐
                        │                                         │
  journalInbound()      │  processing_status progression          │
  ─────────────────     │                                         │
                        │                                         │
  INSERT → 'processing' ─┤                                        │
                         │                                        │
                         ├─ markTurnDone() ──────► turn_done      │
                         │                             │          │
                         │                             │ markInboundComplete()
                         │                             ▼          │
                         │                         complete ◄─────┘
                         │                             ▲
                         │  (also reachable directly   │
                         │   from processing via        │
                         │   markInboundComplete or     │
                         │   markInboundSkipped)        │
                         │                             │
                         ├─ markInboundFailed() ──► failed
                         │
                         │ (pre-connect recovery:
                         │  processing with no terminal
                         │  outbound op → failed)
```

**Transitions:**

| From | To | Trigger |
|---|---|---|
| `pending` | `processing` | Initial insert (journalInbound writes `processing` directly) |
| `processing` | `turn_done` | `markTurnDone()` — agent/chat runtime signals the LLM turn completed |
| `turn_done` | `complete` | `markInboundComplete()` — terminal outbound op echoed |
| `processing` | `complete` | `markInboundSkipped()` — message filtered/skipped without a turn (e.g. `local_command`, `empty_content`) |
| `processing` | `failed` | `markInboundFailed()` — error during processing, or pre-connect recovery |
| open | terminal | `sweepStuckInbound()` — live reconciler for stranded rows (see §4.5) |

Note: `completeInbound()` is a guarded helper — if the row is still `processing` when called, it applies `markTurnDone()` first before `markInboundComplete()`. This handles cases where the agent completes a turn without an explicit `markTurnDone()` call.

### 3.2 Outbound Op Lifecycle

```
  createOutboundOp()
  ──────────────────
  INSERT → pending

  pending ──── markSending() ──────────────► sending
                                                │
                                    markSubmitted(waMessageId)
                                                │
                                                ▼
                                           submitted
                                          /         \
                       echo arrives      /           \  no echo after 30s
                    matchEcho()         /             \  sweepStaleSubmitted()
                                       ▼               ▼
                                    echoed          maybe_sent
                                  (terminal)           │
                                                       ├─ wa_message_id found
                                                       │  in messages table
                                                       │  → echoed
                                                       │
                                                       ├─ not found + safe/read_only
                                                       │  → pending  (replay)
                                                       │
                                                       └─ not found + unsafe
                                                          → quarantined

  pending ─── drainPendingOutbound() ──► sending → submitted   (re-send, §4.4)
            (text {text} ops; non-reconstructable → quarantined)

  sending ─── process crash ──► maybe_sent  (pre-connect recovery)

  pending ─── send() throws ──► maybe_sent  (sendTracked error path)

                         failed_permanent  (hard failures, not retried)
```

**Terminal states:** `echoed`, `failed_permanent`, `quarantined`

**Recoverable state:** `maybe_sent` — always resolved in the next post-connect recovery pass.

**Replay-pending state:** `pending` reached via a `maybe_sent` reset is re-sent by the
pending drainer (§4.4) — both immediately after post-connect recovery and on the live
echo-timeout interval — so a reset op does not wait for a future restart to be re-delivered.

---

## 4. Recovery Algorithms

### 4.1 Pre-Connect Recovery (`preConnectRecovery`)

Runs **synchronously** at startup, after the database is opened but _before_ `connectionManager.connect()` is called. All operations are SQLite reads and writes — no network calls.

**Step 1 — Orphaned session detection**

Iterates `session_checkpoints` rows with `session_status = 'active'`. For each, calls `process.kill(claude_pid, 0)`. If the signal raises `ESRCH` (no such process), the session is marked `orphaned`. This prevents the checkpoint from blocking a new agent session from starting.

**Step 2 — Promote `sending` → `maybe_sent`**

Any outbound op in `sending` status at startup means the process crashed between `markSending()` and `markSubmitted()` — the network call may or may not have executed. All such ops are promoted to `maybe_sent` with `error = 'crash-in-flight'` so they are resolved by post-connect recovery.

**Step 3 — Recover tool calls**

Queries `tool_calls` with `status IN ('executing', 'pending')`. For each:

- If `outbound_op_id IS NOT NULL`: the tool call's send was already captured as an outbound op. No additional action — the outbound op handles it via Step 2. Logged only.
- If `outbound_op_id IS NULL AND replay_policy IN ('safe', 'read_only')`: mark as `replayed`. The runtime will re-issue the tool call when it replays the conversation turn.
- If `outbound_op_id IS NULL AND replay_policy = 'unsafe'`: mark as `quarantined`. Manual resolution required.

**Step 4 — Mark abandoned inbound events `failed`**

Queries `inbound_events` with `processing_status = 'processing'`. For each:

- Checks if a non-quarantined, non-permanently-failed **terminal** outbound op exists with `source_inbound_seq` matching this event.
- If no such op exists: mark the inbound event `failed`. The message was being processed when the crash occurred and never produced a reply.
- If a terminal op exists (e.g., in `maybe_sent`): leave in `processing` — post-connect recovery will resolve the outbound op and may complete the inbound event normally.

**Summary statistics** are returned in a `RecoveryStats` object. No `recovery_runs` record is written for pre-connect recovery (that table is written by post-connect recovery only).

### 4.2 Post-Connect Recovery (`postConnectRecovery`)

Runs after `connectionManager.connect()` resolves, plus a grace period to allow echoes to arrive:

```
  connect() resolves
       │
       ├── await historySyncComplete  (or 15s timeout)
       │
       └── await 10s grace period
               │
               └── postConnectRecovery()
```

The 10-second grace period is critical: it allows WhatsApp to deliver history sync and any echoes for messages that were `submitted` at the time of the previous crash.

**Step 1 — Promote stale `submitted` → `maybe_sent`**

Any op in `submitted` with `submitted_at < now() - 30 seconds` is promoted to `maybe_sent` with `error = 'stale-submitted-no-echo'`. This handles ops that were submitted in a previous session and whose echo arrived (or didn't) during the grace period — if the echo arrived, it would have triggered `matchEcho()` and the op would already be `echoed`. Remaining `submitted` ops are definitively stale.

These newly promoted ops are immediately eligible for Step 2.

**Step 2 — Reconcile `maybe_sent` ops**

For each `maybe_sent` op (including those promoted in Step 1):

- **Has `wa_message_id`**: query `messages` table for a matching `message_id`.
  - Found: `markEchoed()` — the message was delivered and stored by normal ingest. This also completes the linked inbound event if the op is terminal.
  - Not found + `safe`/`read_only`: reset to `pending` for replay (re-sent by the drainer, §4.4).
  - Not found + `unsafe`: `markQuarantined()`.
- **No `wa_message_id`** (send never reached WhatsApp): the message was definitely not delivered.
  - `safe`/`read_only`: reset to `pending` for replay (re-sent by the drainer, §4.4).
  - `unsafe`: `markQuarantined()`.

> The `stale-submitted → maybe_sent` promotion in Step 1 is **not** counted in
> `outbound_reconciled`; Step 2 re-reads those ops as `maybe_sent` and is the single
> counting site for `outbound_reconciled` (one increment per op). (BEAD-060)

**Step 3 — Log recovery run**

A `recovery_runs` record is inserted with aggregated statistics from both steps.

**Step 4 — Drain `pending` (re-send reset ops)**

After `postConnectRecovery` returns, the recover callback in `main.ts` invokes
`drainPendingOutbound()` (§4.4), which actually re-sends the ops that Step 2 reset to
`pending`. Reset-to-`pending` and re-send are deliberately separate steps: reset is a pure
synchronous SQLite write (safe inside the recovery pass), while re-send performs network I/O
and so runs after the pass completes. The drain is failure-isolated — a drain error never
breaks startup.

### 4.3 Periodic Sweep (`sweepStaleSubmitted`)

Runs every **10 seconds** while the process is live (wired in `main.ts` via `setInterval`,
on the same interval that calls `drainPendingOutbound()` — see §4.4):

```
setInterval(() => { durability.sweepStaleSubmitted(); drainPendingOutbound(...); }, 10_000)
```

Promotes any `submitted` op with `submitted_at < now() - 30 seconds` to `maybe_sent` with `error = 'echo_timeout'`. This catches ops whose echo was permanently lost during a live session (not just crash recovery). These `maybe_sent` ops are reconciled by the next post-connect recovery pass (which resets `safe`/`read_only` ops to `pending`); the `pending` stage is then re-sent by the drainer (§4.4), which runs both on this same interval and immediately after each recovery pass.

**Why 30 seconds?** WhatsApp echo latency is typically under 2 seconds on a healthy connection. 30 seconds provides a large margin for slow connections, QoS throttling, and brief disconnects while still being short enough that stuck ops don't silently accumulate for hours.

### 4.4 Pending Drainer (`drainPendingOutbound`)

`postConnectRecovery` resets unconfirmed `safe`/`read_only` ops to `pending`, but the reset
alone does not re-deliver them. `drainPendingOutbound(messenger, durability)` is the step
that re-sends them. It is wired in two places (`main.ts`):

1. **Post-connect recover callback** — immediately after each `postConnectRecovery()`.
2. **Echo-timeout interval** (every 10 s, alongside `sweepStaleSubmitted()`) — drains any op
   that lands in `pending` between reconnects, without waiting for a restart.

For each op in `status='pending'`:

- **Reconstructable text op** — `op_type === 'text'` and `payload` parses to
  `{ text: string }` (the exact shape `sendTracked` writes): `markSending()`, re-send via
  `messenger.sendMessage(chat_jid, text)`, then `markSubmitted(wa_message_id)`. The op then
  re-enters the normal `submitted → echoed` reconciliation path. If the send throws, the op
  is set back to `maybe_sent` so it re-enters the reconnect-paced recovery loop (no inline
  retry / tight-loop).
- **Non-reconstructable op** — unknown `op_type`, or a `text` op whose payload does not parse
  to `{ text }`: `markQuarantined()` + an `outbound_quarantined` alert
  (`reason=pending_replay_unreconstructable`). These are **not** left `pending` forever —
  doing so would reintroduce the original silent-drop bug for non-text ops.

One failing op never aborts the rest of the drain. The function returns the count of ops
successfully re-sent. **Duplicate-delivery tradeoff:** see §2.4 — only `safe`/`read_only` ops
ever reach `pending`, so a replay that duplicates an already-delivered message is the
accepted tradeoff for those ops and is never incurred for user-terminal (`unsafe`) replies.
This is the same risk `sendTracked`-created ops already carry on a `maybe_sent → reset`
cycle; the drainer does not widen it.

### 4.5 Stuck-Inbound Reconciler (`sweepStuckInbound`)

`preConnectRecovery` (§4.1) only runs at process start. An inbound row can also become
stranded in a non-terminal `processing_status` **while the process is live** — for example a
reply that was echoed (delivery confirmed) but whose linked-inbound completion step was
missed (the QR-102 ordering strand), or a turn that finished with no reply and never
finalized. Such a row never reaches `complete`/`failed`, so retention (which deletes only
terminal rows) never reclaims it. `sweepStuckInbound()` is the live counterpart to
pre-connect recovery. It is wired in `main.ts` to run once at startup and then every
**15 minutes**, and reconciles three buckets in a single transaction:

| Bucket | Selection | Disposition |
|---|---|---|
| 1. Echoed but not finalized | open (`pending`/`processing`/`turn_done`) with an `is_terminal`, `echoed` outbound op, `received_at` older than **5 minutes** | `completeInbound(seq, 'recovered_response_sent')` |
| 2. Stranded `turn_done` | `turn_done` older than **24 hours** with no echoed terminal op | `markInboundComplete(seq, 'recovered_turn_done')` |
| 3. Stale open, no success | `pending`/`processing` older than **24 hours** with no echoed terminal op | `markInboundFailed(seq)` (terminal_reason `error`) |

The buckets are mutually exclusive (bucket 1 requires an echoed terminal op; buckets 2 and 3
require its absence), so no row is disposed twice. Each SELECT is bounded to 200 rows so a
large backlog drains over successive sweeps rather than in one long transaction. The
**5-minute** and **24-hour** grace windows keep the sweep from racing normal in-flight
delivery. It uses the same primitives as the echo/recovery paths (never `completeTurn`, which
opens its own `BEGIN IMMEDIATE`) and leaves `continuity_candidate_*` columns untouched. The
sweep is idempotent — once a row is terminal it falls out of every bucket's open-status
filter — and never re-touches rows already finalized by `preConnectRecovery`.

---

## 5. Operational Notes

### 5.1 Quarantined Ops

An op is quarantined when it is `unsafe` to replay — specifically, when its delivery status is ambiguous (`maybe_sent`) and re-sending it would create a visible duplicate for the recipient.

Quarantined ops require **manual inspection and resolution**. The bot continues operating normally; quarantined ops do not block new sends.

**To inspect quarantined ops:**

```sql
-- All quarantined outbound ops with their source context
SELECT
  o.id,
  o.conversation_key,
  o.op_type,
  o.payload,
  o.wa_message_id,
  o.submitted_at,
  o.error,
  o.source_inbound_seq,
  i.processing_status AS inbound_status
FROM outbound_ops o
LEFT JOIN inbound_events i ON i.seq = o.source_inbound_seq
WHERE o.status = 'quarantined'
ORDER BY o.id DESC;
```

**To resolve a quarantined op manually:**

If you have confirmed the message was delivered (e.g., visible in WhatsApp):
```sql
UPDATE outbound_ops SET status = 'echoed', echoed_at = datetime('now') WHERE id = <id>;
```

If you have confirmed the message was NOT delivered and it is safe to re-send:
```sql
UPDATE outbound_ops SET status = 'pending', error = NULL WHERE id = <id>;
```

If the op should be abandoned permanently:
```sql
UPDATE outbound_ops SET status = 'failed_permanent', error = 'manually_abandoned' WHERE id = <id>;
```

### 5.2 Quarantined Tool Calls

Tool calls become quarantined when they have `replay_policy = 'unsafe'` and no `outbound_op_id` at crash time. These represent tool invocations with irreversible side effects (e.g., API mutations) whose completion status is unknown.

```sql
-- All quarantined tool calls
SELECT
  t.id,
  t.conversation_key,
  t.tool_name,
  t.tool_input,
  t.created_at,
  t.completed_at
FROM tool_calls t
WHERE t.status = 'quarantined'
ORDER BY t.id DESC;
```

### 5.3 `recovery_runs` Table — Audit Trail

`recovery_runs` records every invocation of `postConnectRecovery()` (the trigger `'post_connect'`). It is the primary audit trail for understanding what happened across restarts.

**Useful queries:**

```sql
-- Recent recovery history
SELECT
  id,
  trigger,
  started_at,
  completed_at,
  outbound_reconciled,
  outbound_replayed,
  outbound_quarantined,
  tool_calls_recovered,
  tool_calls_quarantined
FROM recovery_runs
ORDER BY id DESC
LIMIT 20;

-- Any recovery run that quarantined something (warrants attention)
SELECT *
FROM recovery_runs
WHERE outbound_quarantined > 0 OR tool_calls_quarantined > 0
ORDER BY id DESC;

-- Total messages replayed vs quarantined across all recoveries
SELECT
  SUM(outbound_replayed) AS total_replayed,
  SUM(outbound_quarantined) AS total_quarantined
FROM recovery_runs;
```

### 5.4 The 30-Second Grace Period

Two distinct 30-second thresholds appear in the code:

1. **`postConnectRecovery` Step 1**: `submitted_at < datetime('now', '-30 seconds')` — identifies ops submitted in a _previous session_ that had the full grace period to receive an echo and did not.

2. **`sweepStaleSubmitted`**: same SQL threshold — identifies ops submitted in the _current live session_ that have been waiting for an echo for over 30 seconds without one arriving.

These are the same 30-second constant applied in two different contexts. The rationale is identical: healthy echo latency is well under 5 seconds, so 30 seconds is a definitive signal that the echo will not arrive.

### 5.5 MCP Tool Sends Exclusion (Gap-Matrix Item 92)

Sends executed via MCP tool calls (e.g., `send_message` tool called by an external MCP client) bypass the `sendTracked` helper and do not create outbound op journal entries. This is **by design**: MCP tool sends are user-initiated and synchronous from the caller's perspective; the caller receives success/failure directly and manages retries. Journaling these would create phantom ops that the recovery engine cannot safely replay. This applies whether the target is supplied as raw `chatJid` or resolved from alias `to`.

This means MCP tool sends are **not** tracked in the durability engine and will not appear in `outbound_ops`. They are still recorded in the separate `outbound_sends` audit table, which stores intent, outcome, hash, and length metadata without storing message bodies.

### 5.6 `sendTracked` — Shared Send Helper

All autonomous sends (bot responses, startup notifications, admin messages) go through `sendTracked()`:

```typescript
export async function sendTracked(
  messenger: Messenger,
  chatJid: string,
  text: string,
  durability: DurabilityEngine | undefined,
  opts: { replayPolicy: 'safe' | 'unsafe' | 'read_only'; isTerminal?: boolean; sourceInboundSeq?: number },
): Promise<void>
```

The function:

1. Creates an outbound op with `status = 'pending'`.
2. Transitions it to `sending`.
3. Calls `messenger.sendMessage()`.
4. On success: calls `markSubmitted(waMessageId)`.
5. On error: calls `markMaybeSent(error)` and re-throws. The exception propagates so the caller can handle it, but the op is safely journaled for recovery.

If `durability` is `undefined` (rare, test contexts only), the send proceeds without journaling.

---

## 6. Database Schema

All durability tables are created in Migration 2 of `src/core/database.ts`.

### `inbound_events`

| Column | Type | Description |
|---|---|---|
| `seq` | INTEGER PK | Auto-incrementing journal sequence number. Stable identifier throughout the event's lifecycle. |
| `message_id` | TEXT NOT NULL | WhatsApp message ID (unique). Prevents duplicate journaling on WebSocket reconnect. |
| `conversation_key` | TEXT NOT NULL | Canonical chat identity. Used for joins and filtering. |
| `chat_jid` | TEXT NOT NULL | Raw WhatsApp JID. Kept for diagnostic queries. |
| `received_at` | TEXT | Timestamp of journal insertion (datetime, defaults to `now`). |
| `routed_to` | TEXT | Runtime that handled the message (`agent`, `chat`, `passive`, etc.). |
| `processing_status` | TEXT NOT NULL | Lifecycle state: `pending`, `processing`, `turn_done`, `complete`, `failed`. Default `pending`. |
| `completed_at` | TEXT | Timestamp when status reached a terminal state. |
| `terminal_reason` | TEXT | Human-readable terminal cause: `response_sent`, `error`, `local_command` / `empty_content` (skipped without a turn), `recovered_turn_done` / `recovered_response_sent` (finalized by recovery or the stuck-inbound reconciler §4.5), etc. |

### `outbound_ops`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incrementing op identifier. |
| `conversation_key` | TEXT NOT NULL | Canonical chat identity. |
| `chat_jid` | TEXT NOT NULL | Raw JID used for the actual send call. |
| `op_type` | TEXT NOT NULL | Operation type, currently always `'text'`. Reserved for future media types. |
| `payload` | TEXT NOT NULL | JSON-encoded message content. |
| `payload_hash` | TEXT | SHA-256 of `payload`. Available for deduplication queries. |
| `status` | TEXT NOT NULL | Lifecycle state. Default `'pending'`. |
| `created_at` | TEXT | Timestamp of op creation. |
| `submitted_at` | TEXT | Timestamp when `markSubmitted()` was called (after `sendMessage()` returned). |
| `echoed_at` | TEXT | Timestamp when WhatsApp echo was matched. |
| `wa_message_id` | TEXT | WhatsApp-assigned message ID, populated by `markSubmitted()`. May be null if send failed before an ID was returned. |
| `error` | TEXT | Error string for `maybe_sent`, `failed_permanent` states. |
| `source_inbound_seq` | INTEGER | FK to `inbound_events.seq`. Links this outbound op to the message that caused it. Nullable for proactive sends. |
| `retry_count` | INTEGER | Reserved. Currently always 0. |
| `is_terminal` | INTEGER | Boolean (0/1). If 1, echoing this op completes the linked inbound event. |
| `replay_policy` | TEXT NOT NULL | `'safe'`, `'unsafe'`, or `'read_only'`. Default `'unsafe'`. |

Index: `idx_outbound_ops_status` on `(status)`, `idx_outbound_ops_source` on `(source_inbound_seq)`.

### `tool_calls`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incrementing tool call identifier. |
| `conversation_key` | TEXT NOT NULL | Chat context of the tool call. |
| `session_checkpoint_id` | INTEGER | FK to `session_checkpoints.id`. Links the tool call to the agent session. |
| `tool_name` | TEXT NOT NULL | Name of the MCP tool invoked. |
| `tool_input` | TEXT NOT NULL | JSON-serialized input arguments. |
| `status` | TEXT NOT NULL | `pending`, `executing`, `complete`, `replayed`, `quarantined`. Default `'pending'`. |
| `result` | TEXT | JSON-serialized tool result. Populated by `markToolComplete()`. |
| `replay_policy` | TEXT NOT NULL | Same semantics as `outbound_ops.replay_policy`. |
| `created_at` | TEXT | Timestamp of record creation. |
| `completed_at` | TEXT | Timestamp when status reached a terminal state. |
| `outbound_op_id` | INTEGER | FK to `outbound_ops.id`. If set, this tool call produced an outbound send; recovery delegates to the op. |

### `session_checkpoints`

One row per conversation (UNIQUE on `conversation_key`). Upserted on checkpoint events; read during orphan detection.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incrementing row ID. |
| `conversation_key` | TEXT NOT NULL UNIQUE | Canonical chat identity. |
| `session_id` | TEXT | Claude Code session identifier. |
| `transcript_path` | TEXT | Path to the agent's transcript file. |
| `active_turn_id` | TEXT | ID of the in-flight conversation turn, or null if idle. |
| `last_inbound_seq` | INTEGER | Most recently processed inbound event seq. |
| `last_flushed_outbound_id` | INTEGER | Last outbound op ID that was flushed to the runtime. |
| `watchdog_state` | TEXT | Serialized watchdog state (JSON). |
| `workspace_path` | TEXT | Agent's working directory. |
| `claude_pid` | INTEGER | PID of the Claude Code subprocess. Used for orphan detection via `kill -0`. |
| `checkpoint_version` | INTEGER | Monotonically incrementing counter, incremented on every upsert. |
| `session_status` | TEXT NOT NULL | `active`, `suspended`, `orphaned`, `ended`. Default `'active'`. |
| `created_at` | TEXT | Row creation timestamp. |
| `updated_at` | TEXT | Last upsert timestamp. |

### `recovery_runs`

Append-only audit log; one row per `postConnectRecovery()` invocation.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incrementing run ID. |
| `started_at` | TEXT | Row insertion timestamp (defaults to `now`). |
| `completed_at` | TEXT | Timestamp when `logRecoveryRun()` was called. |
| `trigger` | TEXT NOT NULL | `'post_connect'` (only value written today; reserved for other triggers). |
| `inbound_replayed` | INTEGER | Count of inbound events re-queued for replay. |
| `outbound_reconciled` | INTEGER | Count of `maybe_sent` and `submitted` ops processed (found + not-found combined). |
| `outbound_replayed` | INTEGER | Count of ops reset to `pending` for replay. |
| `outbound_quarantined` | INTEGER | Count of ops moved to `quarantined`. |
| `tool_calls_recovered` | INTEGER | Count of `executing`/`pending` tool calls processed in pre-connect recovery. |
| `tool_calls_replayed` | INTEGER | Count of tool calls marked `replayed`. |
| `tool_calls_quarantined` | INTEGER | Count of tool calls quarantined. |
| `sessions_restored` | INTEGER | Reserved. Currently always 0. |
| `notes` | TEXT | Free-form notes. Not populated by the engine today. |
