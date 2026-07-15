# WhatSoup Durability Engine

Reference document for `src/core/durability.ts`.

---

## 1. Design Rationale

WhatsApp's transport layer (via Baileys) provides **at-most-once delivery** semantics. A message sent by the bot is handed to WhatsApp with no guarantee of delivery acknowledgement — if the process crashes between `sendMessage()` returning and the echo arriving on the WebSocket, it is impossible to know from transport state alone whether the message was delivered.

WhatSoup addresses this with a write-ahead journal approach: every outbound send is recorded in SQLite _before_ the network call, and the resulting WhatsApp message ID is recorded _after_. On reconnect, the journal is reconciled against incoming echoes and the messages table to determine what actually arrived. Inbound events are journaled symmetrically so that crash recovery can decide whether a message that was "processing" at shutdown was fully handled.

**Three concrete problems the engine solves:**

1. **Crash during send** — the process dies after `sendMessage()` is called but before the echo arrives. The `sending → maybe_sent` promotion in pre-connect recovery captures this.

2. **Echo never arrives** — the message was delivered but the WebSocket echo was lost (e.g., brief disconnect). The 30-second sweep (`sweepStaleSubmitted`) and post-connect reconciliation against the messages table handle this.

3. **Interrupted inbound processing** — an incoming message started an agent turn but the process crashed before the terminal transaction. Recovery never blindly replays that prompt. A turn with exact immutable identity and unresolved delivery evidence can transfer to a proof-linked recovery job; an arbitrary open inbound with no provable owner is marked `failed` and remains operator-visible instead of risking duplicate provider or tool side effects.

---

## 2. Core Concepts

### 2.1 Inbound Events Journal (`inbound_events`)

Every message that enters the bot's processing pipeline is written to `inbound_events` as the _first_ action, before any routing or LLM call. The journal entry carries a monotonically increasing `seq` number that threads through the entire lifecycle.

The `routed_to` column records which runtime handled the message (`agent`, `chat`, `passive`, etc.). If a process crash occurs while a turn is in progress, pre-connect recovery can inspect `routed_to` to understand what context was lost.

An inbound event becomes terminal from the outcome selected by the immutable turn finalizer, not from echo alone. An echoed answer produces `finalized_replied`; an explicit suppression policy can produce `finalized_no_reply_policy`; a terminal provider/runtime failure produces `failed_terminal`; and unresolved delivery transfers to an exact recovery owner. Legacy `is_terminal` outbound ops still complete their linked inbound when echoed, but that compatibility path is not the complete terminal model.

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
| `processing` / `turn_done` | `complete` | `finalizeTurnTerminal()` — one atomic `finalized_replied` (`response_echoed`) or `finalized_no_reply_policy` (`no_reply_policy`) winner |
| `processing` / `turn_done` | `failed` | `finalizeTurnTerminal()` — one atomic `failed_terminal` winner with its bounded failure class |
| `processing` / `turn_done` | unchanged (recovery-owned) | `finalizeTurnTerminal()` — no inbound mutation; the linked recovery job and selected unresolved delivery become the durable owner in the same transaction, and later proof settles the source |
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

Before any recovery phase mutates state, pre-connect recovery appends a `recovery_plans` row and an
open `recovery_runs` row with trigger `pre_connect`. Summary statistics and the current open-recovery
count are finalized only after every phase succeeds. If any phase, counter, alert-evidence write, or
receipt finalization fails, the run remains open (`completed_at IS NULL`), its bounded `notes` records
`status: "incomplete"` and the failed phase names, and the primary error is rethrown. Mutations made by
earlier successful phases remain durable and are owned by that incomplete receipt for the next
recovery attempt; partial recovery is never reported as complete.

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

**Step 3 — Finalize the recovery run**

Post-connect recovery starts its own plan and open run before corroboration or outbound mutation.
After reconciliation, it requires the open-recovery count and all BOT ERRORS quarantine evidence to
be durably queued. A quarantine clear is staged until the proof gate returns successfully. Only then
is the run finalized with its aggregate statistics. A failed phase, evidence write, gate, clear, count,
or finalization leaves `completed_at` null and aborts the remaining recovery callback, including the
pending drainer.

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

### 4.6 Runtime Terminal Finalization Supervisor

Each admitted agent turn carries immutable scope, delivery, inbound, manager, and generation
identity. At turn end, the runtime flushes its ordered answer-operation evidence and asks
`finalizeTurnTerminal()` to commit the terminal winner, inbound disposition, optional recovery
job, and checkpoint bookkeeping in one transaction. The receipt distinguishes a newly applied
winner, an exact idempotent duplicate, and a conflicting duplicate; only the first two may run
terminal post-effects.

If delivery proof cannot be read or the terminal transaction fails, the runtime emits the
`agent_turn_finalization_failed` BOT ERRORS alert with bounded, hashed identity evidence and
retains the exact finalization request. A delivery-proof failure blocks the affected lane; a
terminal-write failure with already-frozen evidence may let the queue advance while retry
ownership remains retained. If both terminal persistence and durable alerting fail, the scope is
sticky-degraded and accepts no more turns until the same request recovers.

Retries are single-flight, run after **5 seconds**, process at most **16** retained records per
pass with a rotating cursor, and stop after **5** attempts per record. Exhausted work remains
retained and its scope remains blocked; it is never discarded. Admission stops at the
128-record high-watermark, while already-owned work is still retained. A successful retry must
return `winnerMatchesRequest=true` before post-effects run and the scope can unblock. The health
snapshot exposes retained/degraded gauges plus cumulative attempt, recovery, and exhaustion
counters; any retained finalization degrades runtime health. Shutdown cancels the retry timer.

Per-chat crash exhaustion follows the same proof boundary. The runtime first marks the current
manager owner `exhausted` and cancels auto-respawn. When an immutable crash context exists,
session, queue, and ownership cleanup is registered as an after-terminal action and cannot run
until the crash evidence has reached durable terminal state. If a journaled inbound has no
provable immutable context, destructive cleanup is withheld entirely. Crash history is
preserved after terminal cleanup, so health remains degraded and the exhausted episode stays
visible.

---

## 5. Operational Notes

### 5.1 Quarantined Ops

An op is quarantined when it is `unsafe` to replay — specifically, when its delivery status is ambiguous (`maybe_sent`) and re-sending it would create a visible duplicate for the recipient.

Quarantined ops require read-only inspection and evidence-backed resolution. A standalone
quarantined op does not globally stop the bot. A quarantined selected delivery in a `pending` or
`claimed` recovery job blocks its affected scope and degrades health. Terminal `blocked_unsafe`
and `exhausted` jobs no longer block admission. Both remain retained and health-visible for
operator action; `blocked_unsafe` is informational by itself, while exhausted retry work degrades
audit health until operator resolution.

**To inspect quarantined ops:**

```sql
-- All quarantined outbound ops with their source context
SELECT
  o.id,
  o.conversation_key,
  o.op_type,
  o.payload_hash,
  o.wa_message_id,
  o.submitted_at,
  o.error,
  o.source_inbound_seq,
  i.processing_status AS inbound_status,
  t.id AS terminal_record_id,
  j.id AS recovery_job_id,
  j.state AS recovery_state
FROM outbound_ops o
LEFT JOIN inbound_events i ON i.seq = o.source_inbound_seq
LEFT JOIN turn_terminal_records t ON t.delivery_op_id = o.id
LEFT JOIN turn_recovery_jobs j ON j.terminal_record_id = t.id
WHERE o.status = 'quarantined'
ORDER BY o.id DESC;
```

Do not resolve this by directly updating `outbound_ops` or deleting/updating linked terminal and
recovery rows. Such writes bypass terminal CAS, exact source settlement, completion proof,
reply-guarantee disarm, and late-echo conflict handling; a fabricated `echoed` status is not
transport evidence. Back up the database, preserve the query result, and use an audited
application recovery path. If the deployed build has no supported resolver for the required
operator decision, leave the chain intact for a reviewed repair.

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

`recovery_runs` records every invocation of both `preConnectRecovery()` and
`postConnectRecovery()` (triggers `pre_connect` and `post_connect`). Each run is linked to its
append-only `recovery_plans` owner. A non-null `completed_at` is a success receipt; a null
`completed_at` with structured incomplete notes is durable recovery debt and must not be interpreted
as an in-progress process merely because the service is currently running.

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

Migration 2 creates the original durability tables. Migrations 37 and 38 add terminal-decision
and recovery-job ledgers, Migration 39 extends `session_checkpoints` with a seven-field
completed-turn identity, and Migration 40 binds every recovery transfer and job to exact
delivery proof while adding auditable completion and conflict evidence.

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
| `terminal_reason` | TEXT | Human-readable terminal cause: `response_sent`, `error`, `local_command` / `empty_content` (skipped without a turn), `recovered_turn_done` / `recovered_response_sent` (finalized by recovery or the stuck-inbound reconciler §4.5), etc. Every failed row keeps `terminal_reason = 'error'` exactly (an external matcher contract); the driver split lives in `failure_class`. |
| `failure_class` | TEXT | Bounded, content-free failure driver stamped alongside `terminal_reason = 'error'` on a failed row. Migration 36; nullable, no CHECK/default/backfill/index (the vocabulary is gated in code at `src/core/inbound-failure-class.ts`). One of: `provider_failure`, `transport_send_failed`, `transport_disconnected`, `timeout`, `db_error`, `session_crash`, `session_spawn_failed`, `crash_recovery`, `stale_reclaim`, `unknown`. **NULL** = a pre-taxonomy row (failed before migration 36); **`unknown`** = classified but unattributable. Crash reclaim in `preConnectRecovery` stamps `crash_recovery`; the stuck-inbound reconciler (§4.5) stamps `stale_reclaim`. |

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

### `turn_terminal_records` (Migration 37)

One immutable terminal winner per `(inbound_seq_key, logical_turn_id, generation)`. A repeated
CAS increments `duplicate_finalize_count`; the receipt separately proves whether the stored
winner exactly matches the request, so a conflicting duplicate cannot masquerade as recovery.

| Column group | Description |
|---|---|
| `id`, `created_at` | Terminal record identity and creation time. |
| `scope`, `conversation_key`, `delivery_jid`, `inbound_seq`, `inbound_seq_key` | Exact routing and inbound identity. Null inbound sequences use the collision-safe key `-1`. |
| `logical_turn_id`, `manager_id`, `generation` | Immutable turn-owner identity and CAS key. |
| `attempt_kind`, `attempt_failure_class` | Bounded terminal attempt outcome. |
| `inbound_disposition`, `delivery_kind`, `delivery_op_id` | Selected inbound and delivery evidence. `delivery_op_id` is indexed when present. |
| `recovery_owner_*` | Complete recovery owner tuple, allowed only for a transferred disposition. |
| `reply_guarantee_disarmed` | Conservative 0/1 decision; unknown delivery cannot disarm the guarantee. |
| `duplicate_finalize_count`, `last_duplicate_at` | Idempotent or conflicting duplicate observations for the same CAS key. |

### `turn_recovery_jobs` (Migration 38)

Exactly one recovery job may link to a terminal record. Its replay envelope and source owner are
immutable; assignment changes require a monotonically fenced assignment epoch.

Migration 40 makes this ledger delivery-reconciliation ownership, not a generic restart prompt
replay queue. A transfer is valid only for a selected `enqueued`, `flushed`, or
`delivery_unknown` op whose persisted status and inbound/routing identity match. Provider fallback
keeps the original live runtime turn and FIFO owner during its one same-process stand-in
continuation; it does not claim a recovery job or manufacture a restart replay. If that process
cannot prove completion, the unresolved delivery remains blocked and operator-visible.

An exact repeat of the complete terminal-and-recovery request returns the existing linked job
receipt and increments `duplicate_enqueue_count` transactionally. A conflicting duplicate may
increment the terminal record's separate `duplicate_finalize_count`, but it receives no recovery
receipt and never increments the job counter. This keeps retry telemetry distinct from attempted
payload substitution.

`markEchoed()` preserves the first echo timestamp and records the selected op as `echoed`. When
the exact linked job is unsettled and its source is `processing`/`turn_done` (or already completed
as `response_echoed`), the source inbound and job settle in the same SQLite transaction. Startup
also scans a bounded set of already-echoed exact links, closing the crash gap between transport
truth and job settlement. If a late echo contradicts a worker-completed outcome or a pending/
failed source, delivery truth is not rolled back: the completed job retains its original
completion proof and records a durable `echo_conflict_at`/reason for operator review.

Database triggers keep every linked source inbound and selected outbound proof immutable and
retained while its job exists, including completed jobs. Retention selects only an old
`completed` job whose exact source inbound is still terminal (`complete`/`failed`) and whose
selected delivery is still terminal (`echoed`/`failed_permanent`/`quarantined`). The job deletion
uses `RETURNING terminal_record_id`; only those returned records can drive terminal and then
unreferenced proof deletion in the same transaction. State or age alone is never sufficient.
Migration 40 also refuses an upgrade when a legacy completed job lacks terminal source or
delivery proof. Recent chains and every unresolved/retry/orphan/corrupt obligation remain.
Runtime health reports an admission-active `outstanding` count (`pending` plus `claimed` jobs and
orphan transfers), every job-state bucket (including live claims), unmatched operator catch-ups,
quarantined selected deliveries, orphan transfers, corrupt links, and echo conflicts.
Admission blocks only `pending` or `claimed` jobs plus orphan transfers, and only on the affected
per-chat or global scope. Terminal `blocked_unsafe` and `exhausted` jobs do not block admission;
an isolated blocked-unsafe receipt is retained but does not make health degraded. Exhausted work,
an unmatched `recovery_pending_operator_catchup` link, corrupt proof, or a recorded echo conflict
independently keeps health degraded until operator closure or retention resolution. Appending the
matching `superseded_by_operator_catchup` closure removes that catch-up from the live gauge without
rewriting either durable disposition.

| Column group | Description |
|---|---|
| `id`, `terminal_record_id` | Job identity and unique FK to the terminal winner (`ON DELETE RESTRICT`). |
| `scope`, `conversation_key`, `delivery_jid`, `source_inbound_seq*` | Exact recovery routing and source inbound identity. |
| `source_*`, `owner_*`, `assigned_owner_*`, `assignment_epoch` | Source, original recovery owner, and current fenced owner tuples. Source and owner must differ. |
| `replay_safe`, `replay_safety_proof_id`, `sender_*`, `replay_text`, `is_group`, `group_name` | Bounded immutable replay envelope. Unsafe work starts blocked and requires a one-way promotion proof. |
| `state` | `blocked_unsafe`, `pending`, `claimed`, `completed`, or `exhausted`; database constraints enforce coherent state fields. |
| `attempt_count`, `claim_epoch`, `claim_token`, `claimed_at`, `claim_expires_at` | Five-attempt claim lifecycle with epoch and lease fencing. |
| `last_requeue_*`, `next_attempt_at` | Idempotent requeue receipt and bounded backoff scheduling. |
| `completion_kind`, `completion_proof_id` | Required, bounded proof for completed work (`worker` or exact transport `echo`). |
| `echo_conflict_at`, `echo_conflict_reason` | Durable late-echo contradiction evidence; transport truth is retained instead of rolled back. |
| `duplicate_enqueue_count`, `created_at`, `updated_at`, `completed_at` | Exact duplicate-enqueue observations and lifecycle audit fields; conflicting envelopes do not increment this job counter. |

### `tool_calls`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incrementing tool call identifier. |
| `conversation_key` | TEXT NOT NULL | Chat context of the tool call. Global-tier sessions (no per-chat key) record under the reserved `__global__` sentinel; real keys derive from JIDs so it cannot collide. |
| `session_checkpoint_id` | INTEGER | FK to `session_checkpoints.id`. Links the tool call to the agent session. |
| `tool_name` | TEXT NOT NULL | Name of the MCP tool invoked. |
| `tool_input` | TEXT NOT NULL | JSON-serialized input arguments. |
| `status` | TEXT NOT NULL | `pending`, `executing`, `complete`, `error`, `replayed`, `quarantined`. Default `'pending'`. `error` (added #1787) is the terminal state for a failed tool call — success-with-`isError` payload, a thrown handler, and a denied sensitive-tool attempt all mark `error` through the single `markToolComplete()` chokepoint. `complete`, `error`, `replayed`, and `quarantined` are the terminal statuses retention deletes (`database-retention.ts`); recovery only ever selects `executing`/`pending` (§4.1 Step 3), so `error` is never re-selected once written. |
| `result` | TEXT | JSON-serialized tool result, or the `error: ...` message when `status = 'error'`. Populated by `markToolComplete()`. |
| `replay_policy` | TEXT NOT NULL | Same semantics as `outbound_ops.replay_policy`. |
| `created_at` | TEXT | Timestamp of record creation. |
| `completed_at` | TEXT | Timestamp when status reached a terminal state. |
| `outbound_op_id` | INTEGER | FK to `outbound_ops.id`. If set, this tool call produced an outbound send; recovery delegates to the op. |

### `session_checkpoints`

One row per conversation (UNIQUE on `conversation_key`). Upserted on checkpoint events; read during orphan detection.

Migration 39 adds the completed-turn identity bundle below. The seven fields are either
all null (legacy or not-yet-completed checkpoints) or all populated; database triggers
reject partial bundles. Terminal finalization derives the bundle from the same validated
terminal identity and writes it in the terminal transaction, rejecting caller-supplied
values that contradict that identity. `last_inbound_seq` remains independent progress state;
only `completed_inbound_seq` identifies the resumable completed turn.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incrementing row ID. |
| `conversation_key` | TEXT NOT NULL UNIQUE | Canonical chat identity. |
| `session_id` | TEXT | Provider session identifier. |
| `transcript_path` | TEXT | Path to the agent's transcript file. |
| `active_turn_id` | TEXT | ID of the in-flight conversation turn, or null if idle. |
| `last_inbound_seq` | INTEGER | Most recently processed inbound event seq. |
| `last_flushed_outbound_id` | INTEGER | Last outbound op ID that was flushed to the runtime. |
| `watchdog_state` | TEXT | Serialized watchdog state (JSON). |
| `workspace_path` | TEXT | Agent's working directory. |
| `claude_pid` | INTEGER | PID of the Claude Code subprocess. Used for orphan detection via `kill -0`. |
| `checkpoint_version` | INTEGER | Monotonically incrementing counter, incremented on every upsert. |
| `session_status` | TEXT NOT NULL | `active`, `suspended`, `orphaned`, `ended`. Default `'active'`. |
| `completed_inbound_seq` | INTEGER | Exact inbound sequence for the most recently completed resumable turn. Part of the all-or-none completed identity bundle. |
| `completed_delivery_jid` | TEXT | Exact raw delivery JID for the most recently completed inbound turn. Part of the all-or-none completed identity bundle. |
| `completed_delivery_namespace` | TEXT | Persisted JID domain (`s.whatsapp.net`, `lid`, or `g.us`); must match `completed_delivery_jid`. |
| `completed_scope` | TEXT | Completing turn scope: `per_chat`, `shared`, or `singleton`. |
| `completed_logical_turn_id` | TEXT | Logical turn ID that completed the checkpoint. |
| `completed_manager_id` | TEXT | Session manager ID that owned the completing turn. |
| `completed_generation` | INTEGER | Positive manager generation that owned the completing turn. |
| `created_at` | TEXT | Row creation timestamp. |
| `updated_at` | TEXT | Last upsert timestamp. |

Resume selection preserves the recorded identity rather than reconstructing one. For a
shared or single session, the latest eligible completed checkpoint for the exact
`session_id` is selected by `completed_inbound_seq DESC, id DESC`. The persisted JID must
round-trip to `conversation_key`, its stored namespace must equal its actual domain, and
the scope and turn-owner tuple must be complete and valid. Legacy, partial, malformed, or
contradictory identity fails closed; the runtime never appends a guessed namespace to a
conversation key. When the runtime knows an exact `session_id`, lifecycle status changes
update every checkpoint row for that ID so all conversations attached to a shared session
move together.

A fresh provider spawn creates its `agent_sessions` row and resets its checkpoint in one
transaction before provider initialization. The reset clears stale session, turn, watchdog,
delivery, and completed-turn identity while making the new lifecycle active. If persistence
fails after a persistent child was spawned, the manager kills and waits for that child before
fully resetting; managed and spawn-per-turn managers reset without becoming ready. A later
non-null `session_id` rotation replaces the completed identity with the all-or-none bundle
supplied by that same upsert; without replacement proof, the old proof is cleared.
Migration 40 also clears pre-existing six-field bundles whose completed inbound sequence was
never persisted; it deliberately does not infer that sequence from independent progress state.

Persisted resume is supported only by `claude-cli`, `codex-cli`, and `opencode-cli`.
Reactivation is an exact compare-and-set on the agent row ID (when supplied), provider session
ID, and a resumable status; it clears stale `ended_at` and activates every resumable checkpoint
for that provider session in the same transaction. `gemini-cli`, `openai-api`, and
`anthropic-api` do not support resume. An attempted resume on those providers first atomically
retires the exact lifecycle to `ended` (resolving exactly one resumable row when the caller has
no row ID) and then rejects, allowing the caller to choose a fresh/context recovery path. That
retirement is permanent for the failed manager: its durable failure-closed latch prevents a
later cleanup shutdown from repainting the lifecycle `suspended`. OpenCode uses the supplied
provider session ID on its first spawned turn.

Failure closure is also one transaction: an initialized lifecycle matches the exact agent row
and provider session ID and orphans every checkpoint for that session; a pre-init failure
matches the exact row plus its null-session conversation checkpoint. Graceful shutdown writes
`suspended` or `ended` only after child/provider termination succeeds. If termination fails,
the lifecycle becomes `crashed`/`orphaned`, the manager retains the live handle, and later
cleanup cannot repaint it resumable. Completed-turn proof lookup considers only `active` and
`suspended` checkpoints, so retired or failed proof cannot authorize a resume.

At runtime shutdown, every session is attempted even if an earlier one fails. Successfully
closed managers release their ownership; a failed singleton or per-chat manager remains attached
to its session/owner so a later shutdown call can retry it. Queue and auxiliary cleanup still
runs, then the original single error or an `AggregateError` is propagated. A partial shutdown is
therefore never reported as success and never drops the only handle capable of proving later
termination.

### `recovery_runs`

Durable, monotonically finalized audit log; one row per pre-connect or post-connect recovery
invocation. The row is created open, then updated exactly once with success or incomplete evidence.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incrementing run ID. |
| `started_at` | TEXT | Row insertion timestamp (defaults to `now`). |
| `completed_at` | TEXT | Success timestamp. `NULL` means the run is incomplete or was interrupted. |
| `trigger` | TEXT NOT NULL | `pre_connect` or `post_connect`. |
| `recovery_plan_id` | TEXT FK | Append-only plan that owns this run and its disposition/corroboration evidence. |
| `inbound_replayed` | INTEGER | Count of inbound events re-queued for replay. |
| `outbound_reconciled` | INTEGER | Count of `maybe_sent` and `submitted` ops processed (found + not-found combined). |
| `outbound_replayed` | INTEGER | Count of ops reset to `pending` for replay. |
| `outbound_quarantined` | INTEGER | Count of ops moved to `quarantined`. |
| `tool_calls_recovered` | INTEGER | Count of `executing`/`pending` tool calls processed in pre-connect recovery. |
| `tool_calls_replayed` | INTEGER | Count of tool calls marked `replayed`. |
| `tool_calls_quarantined` | INTEGER | Count of tool calls quarantined. |
| `sessions_restored` | INTEGER | Reserved. Currently always 0. |
| `notes` | TEXT | Bounded JSON summary. Successful runs record `openRecoveries`; failed runs record `status: "incomplete"`, failed phase names, and the last available open-recovery count. |

Recovery runs and their linked plans, dispositions, corroboration, and closure witnesses are retained
indefinitely as audit evidence. There is no supported direct-delete or TTL path. Archive/capacity work
must preserve identities and proof provenance through a dedicated forward migration.
