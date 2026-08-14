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
- `created_at` records queue creation and `submitted_at` records a provider submission receipt. `ambiguity_at` records entry to the current `maybe_sent` episode; it is not a substitute for either of the other clocks.
- `error` — for failed, ambiguous, or deferred operations, a bounded
  `whatsoup-outbound-failure-v1` JSON envelope. It records a stable failure
  code, stage, mutation certainty, retry decision/owner/deadline, attempt
  counts, timestamps, and evidence coverage. It never stores thrown provider
  prose. Pre-envelope values decode as `legacy_unclassified`.

### 2.3 Echo Correlation

When Baileys delivers an outgoing message, WhatsApp echoes it back on the same WebSocket connection with the same `message_id` it assigned to the send. WhatSoup captures this echo via `matchEcho(waMessageId)`:

1. Look up `outbound_ops` for a row with `wa_message_id = ? AND status = 'submitted'`.
2. If found, call `markEchoed()`.
3. If the op has `is_terminal = 1`, `markEchoed()` automatically calls `completeInbound()` on the linked inbound event.

If no echo arrives within 30 seconds after submission, the periodic sweep (§4.3) promotes the op to `maybe_sent` and starts its current ambiguity episode. The recurring live reconciliation loop waits that episode's own late-echo grace before replaying or quarantining it.

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
            (text / status_ping {text} ops; non-reconstructable → quarantined)

  pending ─── status_ping older than STATUS_OP_TTL_MS ──► quarantined  (drain TTL age-out, §4.4)

  *       ─── new status_ping enqueued for same chat ──► failed_permanent  (superseded, §4.4)

  sending ─── process crash ──► maybe_sent  (pre-connect recovery)

  pending ─── send() rejects before provider call ──► failed_permanent
  pending ─── send() returns a positive retry floor ──► pending
  pending ─── send() fails after provider call starts ──► maybe_sent

                         failed_permanent  (hard failures, not retried)
```

**Terminal states:** `echoed`, `failed_permanent`, `quarantined`

**Recoverable state:** `maybe_sent` — history debt is reconciled in the next post-connect recovery pass; debt created while a process remains live is reconciled only after its current ambiguity episode has the §4.3 late-echo grace.

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

Any outbound op in `sending` status at startup means the process crashed between
`markSending()` and `markSubmitted()` — the network call may or may not have
executed. All such ops are promoted to `maybe_sent` with structured
`outbound.crash_in_flight` evidence so they are resolved by post-connect recovery.

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

Any op in `submitted` with `submitted_at < now() - 30 seconds` is promoted
to `maybe_sent` with structured `outbound.echo_timeout` evidence. This handles
ops that were submitted in a previous session and whose echo arrived (or
didn't) during the grace period — if the echo arrived, it would have triggered
`matchEcho()` and the op would already be `echoed`. Remaining `submitted` ops
are definitively stale.

These newly promoted ops are immediately eligible for Step 2.

**Step 2 — Reconcile `maybe_sent` ops**

This one-time startup pass is an immediate history/corroboration reconciliation after the connection's history-sync and 10-second startup grace. It intentionally does not use the recurring live episode-dwell gate in §4.3.

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
setInterval(() => {
  durability.sweepStaleSubmitted();
  durability.reconcileLiveMaybeSent();
  drainPendingOutbound(...);
}, 10_000)
```

Promotes any `submitted` op with `submitted_at < now() - 30 seconds` to
`maybe_sent` with structured `outbound.echo_timeout` evidence. This catches ops
whose echo was permanently lost during a live session (not just crash
recovery). Each transition into `maybe_sent` records `ambiguity_at`; the same
interval reconciles live debt created after the one-time post-connect pass only
after 30 seconds from that current episode, never from queue creation. Legacy
rows fall back conservatively to a valid submission timestamp and then queue
creation; missing, malformed, or future chronology is treated as stale rather
than fresh. Each pass selects the oldest 200 eligible rows so a large backlog
cannot monopolize the maintenance tick: confirmed echoes settle,
`safe`/`read_only` ops reset to `pending`, and non-safe ops quarantine.
Corroborated selected-delivery proof is excluded before applying the page limit
so intentionally preserved rows neither create repeated recovery evidence nor
starve actionable debt. An empty scan creates no recovery plan or run. The
`pending` stage is then re-sent by the drainer (§4.4), which runs both on this
same interval and immediately after each recovery pass.

**Why 30 seconds?** WhatsApp echo latency is typically under 2 seconds on a healthy connection. 30 seconds provides a large margin for slow connections, QoS throttling, and brief disconnects while still being short enough that stuck ops don't silently accumulate for hours.

### 4.4 Pending Drainer (`drainPendingOutbound`)

`postConnectRecovery` resets unconfirmed `safe`/`read_only` ops to `pending`, but the reset
alone does not re-deliver them. `drainPendingOutbound(messenger, durability)` is the step
that re-sends them. It is wired in two places (`main.ts`):

1. **Post-connect recover callback** — immediately after each `postConnectRecovery()`.
2. **Echo-timeout interval** (every 10 s, alongside `sweepStaleSubmitted()`) — drains ops
   that land in `pending` between reconnects, without waiting for a restart,
   only when their structured retry deadline is absent or due. A future
   `retry_not_before` remains `pending`; the drainer never consumes producer
   retry floors early.

For each op in `status='pending'`:

- **Stale status ping past TTL** — an `op_type === 'status_ping'` op whose `created_at` is
  older than `STATUS_OP_TTL_MS` (30 min): `markQuarantined()` with disposition
  `stale_status_discarded` + an `outbound_status_discarded` info alert, never re-sent. A "back online" notice this old is
  stale misinformation, so dropping it is correct. Checked **before** `markSending`, and
  strictly gated on `op_type === 'status_ping'` — `text` ops have no age gate.
- **Reconstructable text op** — `op_type === 'text'` or `'status_ping'` and `payload` parses
  to `{ text: string }` (the exact shape `sendTracked` writes): `markSending()`, re-send via
  `messenger.sendMessage(chat_jid, text)`, then `markSubmitted(wa_message_id)`. The op then
  re-enters the normal `submitted → echoed` reconciliation path. Replays carry **no caller
  token** (#2813): `sendTracked` persists only `{ text }`, so a QR-086 infra caller (e.g.
  `'health'`) on the original send does not survive into the replay, which therefore takes
  the default — most restrictive — guard path with no cold-floor bypass. Fail-safe by
  design; persisting the caller in the payload envelope is the documented alternative if
  the bypass must survive replay. If the send throws, the
  shared classifier chooses the durable state: an ambiguous handoff becomes `maybe_sent`,
  a definitive rejection becomes `failed_permanent`, and a new positive producer floor
  returns to deferred `pending` (no inline retry / tight-loop).
- **Non-reconstructable op** — unknown `op_type`, or a `text`/`status_ping` op whose payload
  does not parse to `{ text }`: `markQuarantined()` with disposition
  `record_unreconstructable` + an `outbound_record_unreconstructable` warning. These are **not** left `pending` forever —
  doing so would reintroduce the original silent-drop bug for non-text ops.

One failing op never aborts the rest of the drain. The function returns
`{ resent, expired }`: `resent` = ops transitioned out of `pending` via `markSubmitted`;
`expired` = `status_ping` ops aged out past the TTL. **Duplicate-delivery tradeoff:** see
§2.4 — only `safe`/`read_only` ambiguity recovery is reset to `pending`, so a replay that
duplicates an already-delivered message is the accepted tradeoff for those policies.
An `unsafe` op may also be `pending` only after a deterministic non-send with a producer
deadline; retrying it cannot duplicate a prior provider submission. The drainer does not
widen replay eligibility for ambiguous unsafe replies.

**Status pings (`op_type === 'status_ping'`).** The agent "back online" / self-restart pings
(`main.ts`) are enqueued `replayPolicy: 'unsafe'` + `opType: 'status_ping'` so they are
structurally storm-proof (PR-C): (1) **unsafe** — `postConnectRecovery` quarantines a failed
ping instead of resetting it to `pending`, so the drain never re-sends it; (2)
**supersede-on-enqueue** — `createOutboundOp` marks a prior pending
`status_ping` failed-permanent with `outbound.superseded`; an already
sending/submitted/ambiguous ping is quarantined with its delivery certainty
preserved so a late echo can still settle it. Either terminal scheduling state
bounds the class to one outstanding ping per chat; (3) **TTL age-out** — the drain expires a stale ping
(above). All three are gated strictly on `op_type === 'status_ping'`; genuine `text` ops
(user replies, admin responses, the `isResume` continuity message) are untouched.

### 4.5 Stuck-Inbound Reconciler (`sweepStuckInbound`)

`preConnectRecovery` (§4.1) only runs at process start. An inbound row can also become
stranded in a non-terminal `processing_status` **while the process is live** — for example a
reply that was echoed (delivery confirmed) but whose linked-inbound completion step was
missed (the QR-102 ordering strand), or a turn that finished with no reply and never
finalized. Such a row never reaches `complete`/`failed`, so retention (which deletes only
terminal rows) never reclaims it. `sweepStuckInbound()` is the live counterpart to
pre-connect recovery. It is wired in `main.ts` to run once at startup and then every
**15 minutes**, and reconciles four buckets in a single transaction:

| Bucket | Selection | Disposition |
|---|---|---|
| 1. Echoed but not finalized | open (`pending`/`processing`/`turn_done`) with an `is_terminal`, `echoed` outbound op, `received_at` older than **5 minutes** | `completeInbound(seq, 'recovered_response_sent')` |
| 2. Stranded `turn_done` | `turn_done` older than **24 hours** with no echoed terminal op (and no `turn_terminal_records` row) | `markInboundComplete(seq, 'recovered_turn_done')` |
| 3. Stale open, no success | `pending`/`processing` older than **24 hours** with no echoed terminal op (and no `turn_terminal_records` row) | `markInboundFailed(seq)` (terminal_reason `error`, failure_class `stale_reclaim`) |
| 4. Recovery-owner reclaim (#1749) | open with a `transferred_to_recovery_owner` terminal record whose selected op is `failed_permanent`/`quarantined` **or** whose recovery job is `exhausted`, no echoed terminal op, and `received_at` older than **5 minutes** | `markInboundFailed(seq)` (failure_class `recovery_owner_reclaimed`); drive any `pending`/`claimed` owning job to `exhausted` |

Buckets 2 and 3 require `NOT EXISTS turn_terminal_records`, so a `transferred_to_recovery_owner`
record excludes its inbound from every one of buckets 1–3 — the recovery-owner trap (§4.7).
Bucket 4 is the exact inverse: it selects **only** inbound rows owning such a terminal record
whose delivery can never echo-settle, so the four buckets remain mutually exclusive and no row is
disposed twice (an echoed terminal op still routes to bucket 1). Each SELECT is bounded to 200 rows so a
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

### 4.7 Recovery-Owner Reclaim (#1749)

An unresolved delivery finalizes `transferred_to_recovery_owner`: the answer op is `maybe_sent`
(it may still echo late), so the turn transfers ownership and waits, writing a
`turn_terminal_records` row plus a recovery job. Late-echo settlement
(`completeEchoedTurnRecoveryInbound`) closes the source inbound only when that **same** selected
op reaches `echoed`. If the op instead reaches a terminal non-echoed state
(`failed_permanent`/`quarantined`) it can never echo-settle, and there is no live worker that
would otherwise exhaust the job. The terminal record simultaneously excludes the inbound from
buckets 1–3 of §4.5 and from `preConnectRecovery`, so without a reclaim the inbound stays
`processing` forever (retention only deletes terminal rows) and a still-`pending`/`claimed` job
pins admission on the scope indefinitely — the recovery-owner trap.

Remediation 1 (#1748) closed the trigger for future turns: a deterministic non-send now produces
the `not_sent` delivery evidence that finalizes `failed_terminal` (closing its inbound) instead
of transferring. Remediation 2/3 (this section) is the reclaim for rows already pinned. Sweep
bucket 4 (§4.5) fails such an inbound `recovery_owner_reclaimed` and drives any `pending`/
`claimed` owning job to the existing terminal `exhausted` state
(`reclaimDeadDeliveryRecoveryJobWithinCallerTransaction`). Because admission counts only
`pending`/`claimed` jobs plus orphan transfers (§ recovery jobs, below), the exhausted job stops
blocking the scope, while it and the `recovery_pending_operator_catchup` disposition keep the
lost message operator-visible (health stays degraded). The reclaim never touches an op that is
still `maybe_sent` with a live job — that message may yet have been delivered — nor an orphan
transfer (a `transferred_to_recovery_owner` record with no linked job), which is tracked
separately as a corrupt link. The reclaim also waits out the same **5-minute** min-age window
(measured from `received_at`) as bucket 1 before firing (#1833): a `failed_permanent`/`quarantined`
op is *not* terminal for echo — `selectOutboundForEchoMatch` still accepts it as a late-echo
candidate, and a genuine echo can flip it to `echoed` — so the grace window gives that echo a
chance to land and re-settle the turn before the reclaim would otherwise record a delivered turn as
a reclaim-failure. `unfinalized_retry_owned` incidents are owned by the finalization
supervisor's own exhaustion (§4.6), not by this recovery-owner reclaim.

### 4.8 Undispatched Admission Rejection

A journaled user turn can be rejected before provider dispatch when its runtime queue is closed,
halted, or full. The immutable replay envelope proves what was admitted, and the absence of an
answer operation proves that no provider response was sent. The current terminal contract still
records this as `attempt_kind='admission_rejected'`, `inbound_disposition='failed_terminal'`, and
`delivery_kind='none'`. It does **not** create a `turn_recovery_jobs` row and no runtime worker
automatically replays it after restart.

This boundary must stay visible. `turn_recovery_jobs` currently owns ambiguous answer-delivery
reconciliation and late-echo proof; its claim/reassignment APIs are not an active self-replay
worker. Treating those rows as proof that Q will retry its own prompt is incorrect.

Every journaled admission rejection emits `agent_turn_admission_rejected` with the inbound
sequence, scope, exact queue reason, and `automatic_replay=false`. Unjournaled system turns stay
silent. The safe current remediation is an owner-authorized new inbound that restates or continues
the lost intent after checking the target worktree and external state for already-applied effects.
The old inbound remains failed as an immutable audit record; do not relabel it delivered merely
because a later turn succeeds. A future automatic replay worker requires a separate proof contract
for undispatched input, restart-time owner reassignment, bounded claims/backoff, per-chat ordering,
and completion tied to the replay turn's echoed terminal output—not the selected-delivery
assumptions of the current recovery-job schema.

---

## 5. Operational Notes

### 5.1 Quarantined Ops

`quarantined` is a terminal containment state, not a universal claim that a message was lost.
Each transition stores a bounded `quarantine_disposition` and coverage value separately from the
versioned failure-evidence payload:

| Disposition | Provider-send conclusion | Alert source | Retention and clear policy |
|---|---|---|---|
| `delivery_ambiguous_unsafe` | A provider call may have happened; automatic replay remains disabled. | `outbound_delivery_ambiguous` (critical) | Retained until a reviewed retirement is recorded; its reviewed receipt then has an extended window (at least 90 days). Recovery clears only after proof and no unresolved contributor. |
| `delivery_not_attempted` | Evidence proves no provider submission. | `outbound_delivery_not_attempted` (warning) | Standard terminal window; recovery clears after proof and no contributor. |
| `record_unreconstructable` | Evidence proves no provider submission, but the original operation cannot be rebuilt. | `outbound_record_unreconstructable` (warning) | Retained until reviewed retirement; after its matching receipt, the standard terminal window applies. |
| `stale_status_discarded` | Evidence proves a stale status notice was discarded before send. | `outbound_status_discarded` (info) | Standard terminal window; this is an observation, not an incident source to clear. |
| `legacy_unclassified` | Historic or malformed evidence cannot prove a delivery outcome. | `outbound_quarantine_unclassified` (warning) | Retained for reviewed repair; it is never auto-expired as a resolved delivery outcome. |

The authenticated health response exposes exact, content-free counts at
`durability.outboundQuarantineDispositions`; `quarantinedOutbound` remains a coarse compatibility
count. Neither view contains payloads, destinations, message IDs, or raw provider errors.

A retirement receipt is accepted only when its bounded digest matches the immutable canonical
digest stored when that quarantine was created. This does not expose the evidence payload.

Quarantined ops require read-only inspection and evidence-backed resolution. A standalone
quarantined op does not globally stop the bot. A quarantined selected delivery in a `pending` or
`claimed` recovery job blocks its affected scope and degrades health. Terminal `blocked_unsafe`
and `exhausted` jobs no longer block admission. Both remain retained and health-visible for
operator action; `blocked_unsafe` is informational by itself, while exhausted retry work degrades
audit health until operator resolution.

**To inspect quarantined ops without exposing message content:**

```sql
-- Exact aggregate taxonomy; no payload, destination, identifier, or raw error.
SELECT
  CASE quarantine_disposition
    WHEN 'delivery_ambiguous_unsafe' THEN 'delivery_ambiguous_unsafe'
    WHEN 'delivery_not_attempted' THEN 'delivery_not_attempted'
    WHEN 'record_unreconstructable' THEN 'record_unreconstructable'
    WHEN 'stale_status_discarded' THEN 'stale_status_discarded'
    ELSE 'legacy_unclassified'
  END AS disposition,
  CASE quarantine_evidence_coverage
    WHEN 'complete' THEN 'complete'
    WHEN 'partial' THEN 'partial'
    ELSE 'legacy_unclassified'
  END AS evidence_coverage,
  COUNT(*) AS count
FROM outbound_ops
WHERE status = 'quarantined'
GROUP BY 1, 2
ORDER BY count DESC, disposition;
```

Do not resolve this by directly updating `outbound_ops` or deleting/updating linked terminal and
recovery rows. Such writes bypass terminal CAS, exact source settlement, completion proof,
reply-guarantee disarm, and late-echo conflict handling; a fabricated `echoed` status is not
transport evidence. The supported retirement command first returns only a bounded evidence digest;
an apply requires that exact digest, a matching disposition, and the disposition's fixed review
acknowledgement. It writes a bounded receipt in `outbound_quarantine_retirements`, keeps the
versioned evidence byte-for-byte, and creates an owner-only private backup without reporting its
path. It never replays an op or clears a BOT ERRORS source; the runtime recovery gate is the clear
authority after its own delivery proof and contributor checks.

### 5.2 Quarantined Tool Calls

Tool calls become quarantined when they have `replay_policy = 'unsafe'` and no `outbound_op_id` at crash time. These represent tool invocations with irreversible side effects (e.g., API mutations) whose completion status is unknown.

```sql
-- All quarantined tool calls
SELECT
  t.id,
  t.conversation_key,
  t.tool_name,
  t.tool_group,
  t.failure_code,
  t.failure_stage,
  t.operator_action,
  t.evidence_coverage,
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

Migration 45 adds a first-class `status` column (`'started'` | `'completed'` | `'failed'`,
`DEFAULT 'started'`) that disambiguates a null `completed_at` without inferring from absence: a
row is created `'started'`; `finalize()` sets `status='completed'` together with `completed_at`
(the success receipt above); `recordIncomplete()` sets `status='failed'` but deliberately does
**not** set `completed_at` — so `completed_at IS NULL` no longer means only "incomplete or
interrupted": `status='failed'` is an explicitly recorded incomplete run (structured notes
present, per the query below), while `status='started'` with a null `completed_at` is a run that
crashed before either `finalize()` or `recordIncomplete()` ran and is genuinely still open.
Historical rows backfilled by migration 45 follow the same rule: `completed_at IS NOT NULL`
became `'completed'`; rows with a null `completed_at` were left at the `'started'` default rather
than retro-labeled `'failed'`, because a historical incomplete is ambiguous (crash mid-run vs.
genuinely still in flight at backfill time).

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

Three distinct 30-second thresholds appear in the code:

1. **`postConnectRecovery` Step 1**: `submitted_at < datetime('now', '-30 seconds')` — identifies ops submitted in a _previous session_ that had the full grace period to receive an echo and did not.

2. **`sweepStaleSubmitted`**: same SQL threshold — identifies ops submitted in the _current live session_ that have been waiting for an echo for over 30 seconds without one arriving.

3. **`reconcileLiveMaybeSent`**: the active `ambiguity_at` episode (or the conservative legacy fallback) must be older than 30 seconds before the recurring live path replays or quarantines it. Repeated observations preserve the clock; a safe replay that later becomes ambiguous starts a new one.

The first two thresholds decide when a submission becomes ambiguous. The third protects the late-echo grace for that ambiguity episode. The post-connect history/corroboration pass remains immediate after its own startup grace. Healthy echo latency is well under 5 seconds, so 30 seconds provides a conservative margin without silently accumulating stuck work.

### 5.5 MCP Tool Sends Exclusion (Gap-Matrix Item 92)

Sends executed via MCP tool calls (e.g., `send_message` tool called by an external MCP client) bypass the `sendTracked` helper and do not create outbound op journal entries. This is **by design**: MCP tool sends are user-initiated and synchronous from the caller's perspective; the caller receives success/failure directly and manages retries. Journaling these would create phantom ops that the recovery engine cannot safely replay. This applies whether the target is supplied as raw `chatJid` or resolved from alias `to`.

This means MCP tool sends are **not** tracked in the durability engine and will not appear in `outbound_ops`. They are still recorded in the separate `outbound_sends` audit table. That table stores a random per-attempt receipt plus closed intent/outcome/failure/mutation evidence and bounded counters. It stores no destination, alias/profile, body fingerprint, exact length, provider identifier, or error prose.

The supported `maintain_outbound_audit` tool only selects preview (`dry_run:true`) or
apply (`dry_run:false`); it cannot override the automatic 30-day/10,000-terminal-row
policy. Retention health exposes a closed `not_run`/`succeeded`/`failed` state, a
saturating consecutive-failure count, and `retention_failed` without exception prose.
Unreadable audit/tool aggregates and failed retention degrade authenticated diagnostic
health with closed causes rather than reporting measured zeroes.

### 5.6 `sendTracked` — Shared Send Helper

All autonomous sends (bot responses, startup notifications, admin messages) go through `sendTracked()`:

```typescript
export async function sendTracked(
  messenger: Messenger,
  chatJid: string,
  text: string,
  durability: DurabilityEngine | undefined,
  opts: { replayPolicy: 'safe' | 'unsafe' | 'read_only'; isTerminal?: boolean; sourceInboundSeq?: number; caller?: GuardCaller; opType?: 'text' | 'status_ping' },
): Promise<void>
```

The function:

1. Creates an outbound op with `status = 'pending'`.
2. Transitions it to `sending`.
3. Calls `messenger.sendMessage()`.
4. On success: calls `markSubmitted(waMessageId)`.
5. On error: classifies the failure once and persists the resulting disposition.
   Definitive rejection becomes `failed_permanent`, ambiguous submission becomes
   `maybe_sent`, and a positive producer retry floor remains `pending` with
   `retry_not_before` owned by the pending drainer. The original exception is
   re-thrown after the durable write.

If `durability` is `undefined` (rare, test contexts only), the send proceeds without journaling.

---

### 5.7 Capability-Obligation Replay (Migration 58)

Off by default; activates only under `agentOptions.capabilityObligations.enabled === true`
(see `docs/configuration.md`) and only for `per_chat` scope. When a managed-loop provider
turn cannot fulfil a declared capability (e.g. a `/watch` YouTube or media download that
needs a child process), the C3 terminal transaction records a `capability_obligations` row
instead of silently dropping the request, and a supervisor replays it later.

**The dispatch contract (operators read this first).** The replayed turn re-enters the
*same* per-chat pipeline as a real inbound. Its prompt is NOT the bare original message: it
is a deterministic envelope (`composeCapabilityObligationReplayPrompt`) that names the
required capability and the EXACT source, and instructs the agent to call the
`execute_capability` MCP tool. **If the agent does not call `execute_capability`, no receipt
is written and the obligation quarantines (`blocked_ambiguous`) — fail-closed by design.**
So the serving line's skill/prompt guidance MUST lead the agent to call the tool; a stuck
obligation is most often a serving line whose harness never invokes it (wrong provider, or a
skill that answers from memory). The obligation never completes off a conversational
acknowledgement.

**Trusted execution (why a stuck obligation is safe).** Execution receipts are written ONLY
by the in-process `execute_capability` handler, which spawns the instance-declared resolver
argv itself (shell-lessly), derives the observed source digest from its own observations
(retained-media bytes hashed directly; the exact source string hashed for token sources),
validates a typed outcome (exit 0 + minimum output), and refuses any source beginning with
`-` (argv option-flag smuggling). No model-controlled text can forge a receipt or launder a
wrong source: a digest mismatch or a wrong/failed resolver records an *error* receipt that
can never complete the obligation.

**Settlement.** An obligation completes only when a bound `ok` receipt (obligation + claim
epoch + attempt + contract + input/source/media digests) coincides with the minted turn's
terminal record showing echoed delivery (`delivery_kind='echoed'`, non-null delivery op) and
a completion proof naming that exact terminal (`ttr:<id>`). A receipt without proven delivery
quarantines rather than completing.

**Group drains and backfill are gated.** Group-scoped obligations sit in `waiting_approval`
until a destination-specific, digest-bound `capability_drain_approvals` row is consumed (the
schema enforces the four live drain facts match). Historical backfill (`creation_reason LIKE
'reviewed_backfill:%'`) drains only reviewer-confirmed rows through the same machine, under a
separately approved manifest. Retained media is bounded (`retentionHorizonDays`, A-08):
expired media is no longer claimable and is GC-eligible.

**Operator tooling.** `scripts/capability-obligation-admin.ts` provides
`inspect`/`list`/`cancel`/`adjudicate`. It refuses unless the target database is at exactly
the current schema (it never migrates a live DB), previews by default (`cancel`/`adjudicate`
mutate only with `--confirm`), and routes cancel/requeue through the SAME guarded state
machine as the runtime (a `claimed` in-flight obligation is never operator-mutated). Every
action records an `operator` audit event carrying the `--run-id` actor and `--idempotency-key`.

**Readiness attestation producer (`scripts/capability-obligation-attest.ts`).** The supervisor
claims nothing without an admissible D5 attestation, and the recording core had no caller until
this front-door. It derives the live binding, runs a bounded NON-SENDING resolver canary, and
records ONE attestation iff the canary passes. Recording is fail-closed on three observations
(round-16..18): (a) the binding's media root must be a readable directory; (b) `--resolver-digest`
is REQUIRED and the resolver artifact is **declared EXPLICITLY** on `execution`
(`resolverArtifactPath` + `interpreted`) and verified by `verifyResolverArtifact` — NEVER inferred
from argv (round-18 finding 1). The declared artifact's realpath must BE the token that executes
(`command[0]` when not interpreted; EXACTLY `command[1]`, with no tokens between the interpreter
and the script and no flag at `command[1]`, when interpreted), and an `interpreted:false` MISLABEL of
an interpreter (a `watch-resolver`→node symlink declared "direct") is structurally REFUSED (round-19
finding 2). `--resolver-digest` must equal the **COMPOSITE** digest
`sha256([content_sha256, canonicalExecutionIdentity])` (round-19 findings 1+2) — the artifact CONTENT
folded with the canonical command SHAPE through ONE exported `canonicalExecutionIdentity()`, so the
attested value binds both. This refuses the two round-17 bypasses a reviewer proved (a `perl -eCODE`
that verified a decoy while inline code ran; a symlink `watch-resolver`→node hashed as node while
a script ran) — argv classification is unsound and was removed. (c) the probe evidence
(stdout/stderr digests + byte counts + exit/signal + observed-source digest) is written to a
`--receipt-out` file that is **fsynced, read-back-verified, and published NO-CLOBBER (`link()`, not
`rename()`) BEFORE the attestation row is admitted** — so an admissible row IMPLIES its receipt was
durably persisted first (round-17 finding 1) and a second run can never overwrite / destroy the
first's evidence (round-18 finding 2). The receipt records probe evidence only and does NOT assert
admission (admission = the row carrying the run's `nonce`). The **executor re-derives the COMPOSITE at the drain seam** and re-compares it to the admitted
`resolver_digest` (`options.attestation.resolverDigest`), fail-closed to an error receipt: a same-path
CONTENT swap (round-18 finding 1) OR a post-attest command-SHAPE change — injected `-e`, swapped
interpreter, changed template (round-18 finding 2) — changes the live composite and is refused before
any spawn. The executor then **content-addressed STAGES** the artifact (round-20 findings 1+3):
it copies the artifact's WHOLE DIRECTORY into a fresh private staging root (`mkdtemp`, 0700,
unpredictable, single-use), RE-HASHES the copy, compares the COPY's composite to the attested value,
and executes the COPY — so a rename OR an in-place write to the original AFTER verification cannot
substitute unverified bytes (the round-19 hardlink shared the inode AND re-resolved the path; a
reviewer defeated both vectors). Staging the whole directory (not just the file) preserves
sibling-module resolution (`require('./helper')`, a Python sibling import) that a single-file copy
would break. The composite now binds FOUR things via ONE canonicalizer: (1) the artifact CONTENT
digest; (2) the whole-DIRECTORY MANIFEST — a canonical `sha256` over the sorted `[relpath,
sha256(bytes)]` of every regular file PLUS a `[relpath + '/', '']` marker for every directory
(round-21 finding 3 — so an added or EMPTY directory also changes the manifest), so a post-attest
SIBLING swap (overwrite `helper.cjs` after attestation) or an added directory changes the manifest
and is refused; a SYMLINK or non-regular entry is refused fail-closed (a symlink survives the copy
and can point at post-attest-mutable bytes), and file MODE is deliberately excluded (its `cpSync`
preservation is not verified bit-identical, and a divergence would fail EVERY legitimate drain);
(3) the INTERPRETER content digest (`command[0]` hashed when `interpreted`, executed from its
verified realpath) — the interpreter must be an EXPLICIT path (a bare `node`/`python3` resolved via
`$PATH` is unpinnable and is refused at config LOAD), and (round-21 finding 1) the interpreter and
every ancestor directory must NOT be writable by a DIFFERENT untrusted actor (world-writable, or
group-writable to a group this process is in) — a non-sticky writable path is refused because the
interpreter is executed from its realpath (not staged) and a swap between hash and spawn would run
unverified bytes; a sticky dir like `/tmp` is exempt, and a EUID-owned interpreter is the same-UID
boundary (finding 4, below); (4) the canonical execution SHAPE + ENVELOPE (`command`, `interpreted`,
`timeoutMs`, `minOutputBytes`). In direct mode (`interpreted:false`) EVERY token after the artifact
must embed the bound `{source}` template AND must not be a flag (round-21 finding 2 — a renamed
interpreter reads a flag such as `-c`/`-e`/`--eval` as "run the following as code", which would
execute the inbound `{source}` as code; a bare non-`{source}` positional is also refused). RESIDUAL:
a renamed interpreter that treats a POSITIONAL data token as code with no flag (e.g. `awk`) still
executes `{source}` as code in direct mode — structural closure (source off argv, or the typed
config contract) is owner-gated. On a composite mismatch the executor logs the staged directory's file list
(`stagedManifestFiles`) so a stray file next to the resolver is diagnosable rather than opaque.

> **⚠ ROUND-21 CORRECTION (this section previously OVERSTATED closure).** An adversarial audit
> reopened THREE execution bypasses against `2bb3b74a`, disproving the prior "round-19 residuals
> are closed at RUNTIME" claim: (1) the interpreter was hashed then executed from its MUTABLE
> realpath — a user-writable interpreter swapped after staging executes unverified bytes with the
> composite unchanged (verify ≠ execute); (2) a renamed interpreter declared `interpreted:false`
> with `["-c","{source}"]` passed verification and ran the `{source}` DATA as shell code — the
> finding-2b guard refused only BARE positional tokens, not flag-driven code; (3) the
> whole-directory manifest entered only regular FILES, so an added/empty DIRECTORY did not change
> the composite. A fourth: the staged COPY is private (0700) but a same-UID concurrent writer can
> overwrite it between re-hash and spawn (POSIX has no portable `fexecve` in Node). Round-21
> narrows (1) by refusing a EUID-writable interpreter, (2) by requiring every direct-mode token to
> contain `{source}` and not start with `-` (residual: a renamed interpreter that treats a
> positional data token as code, e.g. awk — structural closure via stdin/file source or the typed
> config contract is owner-gated), and (3) by binding directory entries in the manifest. The
> same-UID staged-copy window (4) is an EXPLICIT owner-gated threat-model boundary, not a closure —
> see the capability-debt issue draft. Do not restore any blanket "residuals closed" wording here
> without a fresh adversarial pass.
>
> **OWNER RATIFICATION (2026-08-13, round 22):** the owner explicitly risk-accepted BOTH named
> residuals as documented threat-model boundaries: (a) the **F4 same-UID staged-copy window**
> (including the EUID-owned interpreter case — refusing EUID-writable interpreters would break
> nvm/homebrew node and the entire suite; the trust boundary is a single trusted UID, and POSIX
> Node has no portable `fexecve` to close it structurally), and (b) the **direct-mode
> positional-code residual** (a renamed interpreter such as `awk` treating a positional data token
> as code; structural closure via the typed config contract / source-off-argv stays a tracked
> debt, not a blocker). These are ACCEPTED boundaries, not open defects: a reviewer reproducing
> either shape is reproducing the documented threat model, not reopening a finding.

**OPERATOR CONSTRAINT (hard requirement):** the resolver artifact MUST live in an
ISOLATED directory containing ONLY the resolver and its intentional siblings — nothing else may be
written next to it (no `.DS_Store`, editor swap file, `__pycache__`, log, db, or media), it must be
symlink-free, and within the 64 MB staging bound; otherwise every subsequent drain fails closed as
`resolver_digest_mismatch`. The remaining graduation debt is the CONFIG-CONTRACT half of Option C
(a typed `{ interpreter, resolverArtifactPath, args }` execution struct replacing the `command`
array) — **owner-gated** because it touches every deployment resolver config. The runtime half is
NOT fully done: round-21 narrowed the reopened bypasses above, but the direct-mode positional-code
residual and the same-UID staged-copy window remain (structural closure is the typed contract +
source-off-argv, both owner-gated). NARROW CLAIM: a passing canary attests only that the verified resolver, run against
`sha256(probeSource)`, exited 0 within bound and produced ≥ `minOutputBytes` — it is NOT proof of
semantic processing; the fulfillment proof stays the D6 receipt + delivery chain. The attestation
ROW has **no probe-evidence columns**: adding them needs migration 58, which bumps
`CURRENT_SCHEMA_MIGRATION` *inside the attestation binding* — invalidating every computed digest and
reopening AS-01 — so the evidence lives in the receipt file, correlated by `nonce`, as a deliberate
deferral. (Design-spec deviation of record: the pinned Phase-2 spec §3.3 lists these as attestation
row fields; migration-58 realizes them as the correlated receipt instead. Not an oversight — the
spec's row-storage form is graduated with migration 58.)

**Group-drain approval is atomic.** `scripts/capability-obligation-approve-drain.ts` records the
AS-08 approval AND drives the sole `waiting_approval → waiting_capability` transition in ONE store
transaction (`recordAndConsumeGroupDrainApproval`, round-17 finding 3): a failure rolls back both
the approval row and the state flip, so there is no orphan-approval window. "Armed" is still not
"will drain" — the claim additionally requires a fresh admissible attestation.

**Cold-obligation activation (round 22 — owner-authorized 2026-08-13, WIRED).**
`src/runtimes/agent/capability-obligation-drain-now.ts` (`drainObligationNow`) is the gated
activation core — it activates ONE named `waiting_capability` obligation's per-chat session and runs
one tick, fail-closed, refusing a group without a live AS-08 approval and refusing ANY obligation
with no plausible attestation candidate (the round-22 pre-activation gate in
`hasAttestationCandidateIgnoringProvider`: every binding field except the pre-spawn-unknowable
provider/harness pair must match a live attestation, or no session is ever created; the claim's
exact-binding admission stays authoritative). The live adapter + operator trigger live in
`src/runtimes/agent/capability-obligation-drain-now-service.ts`: the OPERATOR TRIGGER is a same-UID
drop-file (`<db-dir>/capability-drain-now/<obligationId>.json`, written by the schema-guarded
dry-run-default CLI `scripts/capability-obligation-drain-now.ts`) serviced at the start of the
obligation runtime's single-flight scan tick — deliberately NOT a new network surface and NOT an
agent-reachable MCP tool, so no autonomous session can invoke it; its trust boundary is the single
trusted UID (the same owner-ratified F4 boundary as the staged-copy window). Requests are CONSUMED
(atomic rename) before servicing — a crash loses a request (operator re-issues), never services it
twice — expire after 15 minutes, are schema-validated (strict Zod, filename↔payload id match,
symlinks refused), and bounded per cycle. The ACTIVATION closure reuses the proven proactive-resume
recipe (capture ownership → fresh spawn → activate) with NONE of the resume side effects (no
checkpoint resume, no missed-message injection, no continuation turn — the only turn that can enter
is the minted obligation turn), and its reported post-condition is the SAME dispatch-target
predicate the supervisor uses, never the session flag alone. AE1 is intact: proactive resume still
excludes groups; with no request file the runtime never activates anything (executor-seam test).
Operator procedures: `docs/runbooks/capability-obligation-operator.md` §3.

**Verification-harness bound.** The full-suite battery runs under an externally bounded runner
(`scripts/full-suite-battery.ts`), which spawns vitest as a detached PROCESS GROUP with a hard
wall-clock bound and SIGKILLs the whole group on timeout AND on every close (so a grandchild cannot
survive a clean exit — round-18 finding 3). This exists because a synchronous fixture
`execFileSync('git', …)` (a starved `git hash-object` on `index.lock` under load) once wedged a
worker for ~72 minutes: vitest's async per-test timeout structurally cannot interrupt a blocking
synchronous call, so a hung fixture produced no truthful completion signal. Semantics
(round-18..19): a timeout is **inconclusive** (exit 124), never reportable as a pass OR a code failure;
a group kill that fails for a non-`ESRCH` reason (e.g. `EPERM`) is inconclusive (exit 125); a signalled
child maps to `128 + signal`. On a bound firing AND on a wrapper `SIGTERM`/`SIGINT`, a terminal grace is
armed **UNCONDITIONALLY** and is deliberately **NOT `.unref()`'d**, so a `close` that never arrives (an
escaped descendant holding a stdio pipe after a successful kill) resolves INCONCLUSIVE (125) rather than
letting the event loop drain to a FALSE exit 0 — the exact false-pass the battery exists to prevent
(round-19 finding 4). The runner is wired into the platform verification path (round-18 finding 4;
round-19 finding 5): the **canonical `npm test`** now runs THROUGH the bounded runner, so cutover
(`scripts/cutover.sh` PRE-01 `npm test`), the Node CI `npm test` jobs, and the release/CI full-suite
coverage gate (`scripts/run-coverage-check.sh`, invoked by `push-gate.ts`) are ALL bounded — not only an
ad-hoc entry.

**Backfill and AS-01 rehearsal (both owner-gated).**
`scripts/capability-obligation-backfill-manifest.ts` is READ-ONLY: from reviewer-confirmed
source identities it emits a digest-addressed manifest of the historical obligations that
WOULD be reprocessed (ineligible entries reported, never dropped), for owner approval. The
digest binds the DESTINATION (conversationKey/deliveryJid/isGroup), the SOURCE identity
(sourceDigest + token/media hash+size), the EXACT reviewer-classified recovery job id, the
reviewer's fulfilment classification, the replay-payload INPUT DIGEST (message text + prepared
media class), and the reviewer's EVIDENCE-MATRIX digest (transcript + tool/delivery receipts +
later-turn review) — so an approval cannot be reused for a different destination, a swapped
source, a different job, a changed classification, an EDITED instruction, or a different
evidence set. Only a reviewer
`confirmed_unfulfilled` whose persisted job agrees on inbound/message/conversation/destination,
is completed+`echo`, and has no sibling worker-fulfilment is eligible; echo-settlement is
corroboration with VETO power, never the affirmative proof (the executor does NOT re-derive
non-fulfilment from echo — that delivery/fulfilment conflation is the defect this feature
corrects). A reviewer capability override makes historical AUDIO eligible (audio is excluded
from the live contract by construction; incident-7795 shape). The human-readable manifest
prints exactly the digest-bound fields (destination, job, classification, source) so the
approver SEES what the approval commits to.
`scripts/capability-obligation-backfill-execute.ts` is the owner-gated EXECUTOR. It RECOMPUTES
the manifest digest over the descriptors it is about to run and REFUSES the whole run on
mismatch (a descriptor altered after approval cannot execute). For each entry it re-verifies
the reviewer classification + exact recovery job (selected BY ID, never latest-by-sequence),
RE-COMPUTES the input digest from the CURRENT message (a WhatsApp edit to the replayed
instruction after approval is skipped), retains+reverifies media, and is idempotent (a second
run creates nothing). Atomicity is ALL-OR-NOTHING over the approved set: if ANY approved entry
hard-fails (recovery/media/input reverify), the run commits NOTHING — there is no partial
backfill. It persists the real recovery job id as `origin_recovery_job_id` and leaves the
original recovery-job rows untouched. Concurrency is race-free: the executor holds ONE
`BEGIN IMMEDIATE` write lock spanning the ENTIRE critical section — the WAL-aware file-set
backup-verify, the authoritative re-run of the recovery + idempotency checks (the phase-1
reads are advisory), and the commit — so no concurrent writer can interleave. Media retention
(filesystem, content-addressed) runs BEFORE the lock, keeping the locked section fully
synchronous. Its CLI (`runBackfillExecuteCli`) is dry-run by default; applying requires a
schema guard, a fast-fail quiescence signal (a current writer is refused; NOTE this detects a
live writer but does NOT prove the bot process is stopped, which stays operator-attested), a
`--backup-path` that is a byte-exact SQLite FILE-SET (main||-wal) snapshot of THE TARGET at the
current schema — verified UNDER the write lock, so a concurrent WAL-only commit (main file
unchanged) is caught where a main-only check would miss it (a foreign or stale backup, or a
target that changed since the backup, is refused), an `--expect-existing` precondition on the
current backfill count, and a `--confirm <approvedDigest>` confirmation token equal to the
manifest digest (holding the flag is not enough — the operator must hold the artifact).
`scripts/capability-obligation-as01-rehearsal.ts` authors the old-binary/schema rehearsal: it
reads the startup/schema-guard command from the OLD release's OWN `package.json` (never
guessed); requires a real SQLite CLONE inside the designated sandbox using canonical realpath
(a symlink to a live DB, a non-regular, or a non-SQLite file are refused); takes a COHERENT
pre-migration snapshot via `VACUUM INTO` (SQLite reads its own snapshot and writes a fresh,
defragmented file, so ALL committed content — including frames still in the WAL — is captured
even under a concurrent reader; a `wal_checkpoint(TRUNCATE)`+main-copy would SILENTLY drop
committed WAL data whenever a pinned reader forces the checkpoint to return `{busy:1,
checkpointed:0}`); migrates it `startSchema→target` and HONORS the migration
verdict — it proceeds ONLY when the migration is ok (integrity + read-only smoke + non-decreasing
key-table row counts with the before→after delta reported + preserved trigger DEFINITIONS, name
AND SQL + target schema == current); an `ok:false` migration never reaches the old binary. It
then runs the DECISIVE old-binary check only under `--confirm --network-isolated`. That check
CLASSIFIES the observation — `rejected_no_write` / `accepted` / `wrote_dangerous` /
`inconclusive` — with a distinguishable exit code (0 pass, 1 inconclusive, 2 INCOMPLETE-when-
skipped, 3 accepted-owner-decision, 4 wrote-dangerous), so a skipped or unclassifiable step can
never read as a pass. The EXPECTED rejection has a STRICT contract: a non-zero exit (not a
126/127 tooling code) carrying the `DatabaseCompatibilityError` class AND the `future_schema`
reason together, with no write and no tooling-error signature (`npm ERR!` / missing script /
module-not-found) — a tooling error that merely mentions the reason string is `inconclusive`,
not a pass. The EXACT string/ceiling contract of the old binary is confirmable only at the
owner-gated real run against the pinned old release. Write detection is WAL-AWARE: the file-set
hash (main||-wal) makes a write the old binary lands in the write-ahead log visible, so a
WAL-only write is classified `wrote_dangerous`, not a clean rejection. On the expected rejection
it proves the coupled pre-migration RESTORE (candidate §5) — a CRASH-SAFE restore: write
temp ← backup, fsync temp, integrity_check temp, then delete the clone's `-wal`/`-shm` BEFORE
`rename()`ing the temp over the main file, then fsync the directory. The `-wal`/`-shm` are
discarded FIRST, never after the rename (the r12 defect): a crash at any boundary then leaves a
recoverable file-set — the un-restored migrated clone, or the restored backup — never a
restored-backup main paired with a stale WAL that would replay the old binary's frames on the
next open. The restored file-set must equal the backup and pass integrity_check. The old binary runs in a sandbox HOME + npm cache (never the operator's live
config); in tests an INJECTED runner spawns the fake directly (the default `npm run` transport
ships unit-untested by construction and is exercised only at the owner-gated real run). Network
isolation is a fail-closed egress probe (a reachable network REFUSES the run) — isolation can be
disproven, never proven, so `--network-isolated` stays an operator attestation the probe
fails-closed against; no-SEND is guaranteed by construction (it never opens a WhatsApp session).
Backfill EXECUTION,
the DM drain, both group drains, and the old-binary rehearsal are separately owner-gated.

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
| `failure_class` | TEXT | Bounded, content-free failure driver stamped alongside `terminal_reason = 'error'` on a failed row. Migration 36; nullable, no CHECK/default/backfill/index (the vocabulary is gated in code at `src/core/inbound-failure-class.ts`). One of: `provider_failure`, `transport_send_failed`, `transport_disconnected`, `timeout`, `db_error`, `session_crash`, `session_spawn_failed`, `crash_recovery`, `stale_reclaim`, the admission-rejection subclasses `queue_full` / `queue_halted` / `queue_closed` / `pre_dispatch_error` / `scope_blocked_recovery` (#1750), `recovery_owner_reclaimed` (#1749), `processor_throw`, or `unknown`. **NULL** = a pre-taxonomy row (failed before migration 36); **`unknown`** = classified but unattributable. Crash reclaim in `preConnectRecovery` stamps `crash_recovery`; the stuck-inbound reconciler (§4.5) stamps `stale_reclaim` (bucket 3) and `recovery_owner_reclaimed` (bucket 4, the recovery-owner reclaim of §4.7). An admitted-then-rejected turn stamps its distinct rejection driver (queue depth-cap shed, halt, closed admissions, pre-dispatch error, or recovery-scope block) instead of collapsing to `unknown`, so alerting can page on a queue halt without false-positiving on a benign capacity shed. Exact terminal-attempt classes remain independently preserved on `turn_terminal_records.attempt_failure_class`: for example, `provider_stream_corrupt` projects to the bounded inbound class `provider_failure` rather than expanding this column's vocabulary. |

### `outbound_ops`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incrementing op identifier. |
| `conversation_key` | TEXT NOT NULL | Canonical chat identity. |
| `chat_jid` | TEXT NOT NULL | Raw JID used for the actual send call. |
| `op_type` | TEXT NOT NULL | Operation type: `'text'` (default) or `'status_ping'` (back-online/self-restart notices — supersede + TTL scope key, §4.4). No DB CHECK; reserved for future media types. |
| `payload` | TEXT NOT NULL | JSON-encoded message content. |
| `payload_hash` | TEXT | SHA-256 of `payload`. Available for deduplication queries. |
| `status` | TEXT NOT NULL | Lifecycle state. Default `'pending'`. |
| `created_at` | TEXT | Timestamp of op creation. |
| `submitted_at` | TEXT | Timestamp when `markSubmitted()` was called (after `sendMessage()` returned). |
| `ambiguity_at` | TEXT | Nullable timestamp when the current `maybe_sent` episode began. Set atomically on entry, retained while the episode stays active, and replaced on a later re-entry. Legacy `maybe_sent` rows are backfilled from `submitted_at`, then `created_at`. |
| `echoed_at` | TEXT | Timestamp when WhatsApp echo was matched. |
| `wa_message_id` | TEXT | WhatsApp-assigned message ID, populated by `markSubmitted()`. May be null if send failed before an ID was returned. |
| `error` | TEXT | Nullable bounded `whatsoup-outbound-failure-v1` JSON for deferred or failed states. Stable fields: `failure_code`, `stage`, `mutation_state`, `retryable`, `retry_decision`, `retry_not_before`, `retry_owner`, `attempt_budget_disposition`, logical/provider attempt counts, first/last failure timestamps, and `evidence_coverage`. Legacy prose is read as `legacy_unclassified`; new writers never persist thrown prose. |
| `source_inbound_seq` | INTEGER | FK to `inbound_events.seq`. Links this outbound op to the message that caused it. Nullable for proactive sends. |
| `retry_count` | INTEGER | Number of completed logical send invocations recorded for the op, including a call rejected at admission. Waiting until a producer deadline does not add another attempt, and `provider_submission_count` separately records calls that crossed the provider boundary. |
| `is_terminal` | INTEGER | Boolean (0/1). If 1, echoing this op completes the linked inbound event. |
| `replay_policy` | TEXT NOT NULL | `'safe'`, `'unsafe'`, or `'read_only'`. Default `'unsafe'`. |

Index: `idx_outbound_ops_status` on `(status)`, `idx_outbound_ops_source` on `(source_inbound_seq)`.

`GET /health` exposes a privacy-safe `durability.outboundFailureEvidence`
projection. It samples the 500 newest non-null envelopes and returns at most 20
groups by failure code, stage, mutation state, evidence coverage, terminal
state, retry decision/owner, and remaining-delay bucket. Each group includes
its earliest next-eligible time and aggregate provider-submission count; it
does not expose destinations, message content, or provider prose.

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
Those receiver-local gauges cannot prove that the transport admitted every message sent during a
disconnect. The read-only `audit-continuity-manifest` operator command compares a bounded receipt
manifest from an independent participant history against exact local message, admission, and
delivery-proof state before any catch-up action. It separates already-admitted unanswered work from
work that requires provenance-labeled operator catch-up and emits no identifiers or content.
After that dry run, `record-continuity-manifest --confirm-record` can persist only the
`absent`, `observed_not_admitted`, and `ambiguous` classifications in the existing recovery
ledger. Durable identities and evidence are SHA-256 fingerprints; no raw receipt, destination,
manifest, or evidence value is written. Repeated recording is idempotent. `/health` exposes open/unresolved/ambiguous counts in a `continuity`
block and a `recovery_debt` field (status stays `"healthy"` when only continuity gaps are present —
see `docs/runbook.md` §7.6 or issue #2973); `degradation_causes` still includes `continuity_gap_open`
or `continuity_gap_unreadable` for diagnostic consumers. The recorder does not send,
replay, admit, or close work. A later proof-bound catch-up lane must close these rows only after an
exact provenance link and terminal delivery proof exist.
Admission blocks only `pending` or `claimed` jobs plus orphan transfers, and only on the affected
per-chat or global scope. When the selected delivery is provably dead (`failed_permanent`/
`quarantined`) the job can never echo-settle, so the stuck-inbound reclaim (§4.7) drives a
`pending`/`claimed` owning job to `exhausted` and fails its source inbound, releasing the scope.
Terminal `blocked_unsafe` and `exhausted` jobs do not block admission;
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
| `tool_group` | TEXT NOT NULL | Closed functional group used for aggregate diagnostics; unknown extension groups become `other`. |
| `tool_input` | TEXT NOT NULL | Fixed `[metadata-only]` marker. Arguments are never persisted. |
| `status` | TEXT NOT NULL | `pending`, `executing`, `complete`, `error`, `replayed`, `quarantined`. Default `'pending'`. `error` (added #1787) is the terminal state for a failed tool call — success-with-`isError` payload, a thrown handler, and a denied sensitive-tool attempt all mark `error` through the single `markToolComplete()` chokepoint. `complete`, `error`, `replayed`, and `quarantined` are the terminal statuses retention deletes (`database-retention.ts`); recovery only ever selects `executing`/`pending` (§4.1 Step 3), so `error` is never re-selected once written. |
| `result` | TEXT | Null while open; otherwise a fixed success, error, or recovery marker. Tool output and exception prose are never persisted. |
| `replay_policy` | TEXT NOT NULL | Same semantics as `outbound_ops.replay_policy`. |
| `created_at` | TEXT | Timestamp of record creation. |
| `completed_at` | TEXT | Timestamp when status reached a terminal state. |
| `outbound_op_id` | INTEGER | FK to `outbound_ops.id`. If set, this tool call produced an outbound send; recovery delegates to the op. |
| `outcome_code` | TEXT NOT NULL | Closed lifecycle outcome: open, success, failure, replayed recovery, or recovery quarantine. |
| `failure_code`, `failure_stage` | TEXT | Bounded typed failure evidence; null outside failed/quarantined outcomes. |
| `retry_disposition`, `operator_action` | TEXT NOT NULL | Closed recovery guidance derived from typed facts, never prose. |
| `evidence_coverage` | TEXT NOT NULL | `complete`, `partial`, or `legacy_unclassified`. |
| `duration_ms` | INTEGER | Optional bounded execution duration; null for open rows. |

Migration 50 replaces historical input/result/error content with these markers without interpreting legacy prose. This is a logical live-schema scrub, not proof of physical erasure: old bytes may remain in SQLite free pages, WAL files, backups, or snapshots until separately approved compaction and backup-retirement work occurs.

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

The periodic zombie-session sweep reconciles current-process residents before classifying
active rows. This is a narrow compare-and-set repair for an `orphaned` row whose active
checkpoint still proves the exact workspace and provider-session identity; persistent
providers must also match the resident process ID. It does not manufacture checkpoint
authority and refuses suspended, ended, completed, crashed, or resume-failed rows.

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
| `completed_at` | TEXT | Success timestamp, set only by `finalize()`. `NULL` means the run is incomplete or was interrupted — disambiguate with `status` (below) rather than treating `NULL` alone as proof the run is still active. |
| `status` | TEXT NOT NULL, `DEFAULT 'started'` | Added by migration 45. Terminal values `'completed'` (set by `finalize()`, alongside `completed_at`) and `'failed'` (set by `recordIncomplete()`, which leaves `completed_at` NULL). A row still at `'started'` with a null `completed_at` crashed before either writer ran. |
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

### `enrichment_runs` (#2565 typed cycle receipts)

Not part of the inbound/outbound durability journal above — `enrichment_runs` is written by
`EnrichmentPoller` (`src/runtimes/chat/enrichment/poller.ts`), one typed receipt per online
fact-extraction cycle, including no-work cycles. It is documented here because the #1789
durability-writer invariant guard
(`scripts/durability-writer-guard.ts`) treats it as one of the two tables the invariant was built
to fix, alongside `recovery_runs` above.

| Column | Type | Description |
|---|---|---|
| `run_id` | INTEGER PK | Auto-incrementing run ID. |
| `schema_version` | INTEGER | Receipt schema version. Current typed rows use `1`. |
| `source` | TEXT | `online` for the live poller; historical and backfill-shaped rows are `legacy` and are not interpreted as online health evidence. |
| `status` | TEXT | Closed outcome: `no_work`, `completed`, `partial`, `failed`, or `legacy_unclassified`. |
| `failure_code` | TEXT | Closed cause: `none`, `segment_failed`, `selection_failed`, `message_state_write_failed`, `ledger_write_failed`, or `legacy_unclassified`. |
| `stage` | TEXT | Closed execution stage: `none`, `selection`, `segment`, `message_state`, or `ledger`. |
| `retryable` | INTEGER | Boolean retry disposition (`0` or `1`). |
| `evidence_coverage` | TEXT | `typed` for a current receipt, `legacy_unclassified` for migrated historical evidence. |
| `started_at` | TEXT NOT NULL | Cycle start timestamp. |
| `completed_at` | TEXT | Completion timestamp for a terminal receipt. |
| `success_at` | TEXT | Set only for `no_work` and `completed` outcomes. |
| `messages_processed` | INTEGER | Compatibility count equal to typed `messages_succeeded + messages_terminal`. |
| `messages_selected` / `messages_succeeded` / `messages_deferred` / `messages_terminal` | INTEGER | Non-negative aggregate message accounting for the cycle. |
| `facts_extracted` | INTEGER | Aggregate facts extracted before queueing. |
| `facts_upserted` | INTEGER | Compatibility count; retained for existing metrics readers and mirrors `facts_queued`. It does not prove a remote Pinecone upsert. |
| `facts_queued` | INTEGER | Aggregate facts newly accepted by the local fact-export queue; remote export confirmation is owned separately. |
| `error` | TEXT | Historical compatibility field. Typed online receipts always write `NULL`; they never persist raw exception prose. |

Migration 55 adds the receipt fields and online-reader indexes without assigning stable meaning to
historical rows: those remain `legacy` / `legacy_unclassified`. On startup the runtime reads only
the newest typed `online` receipt, separately remembers the last proven success, and fails closed
for malformed or unreadable receipt evidence. Health projects only the bounded states `disabled`,
`not_started`, `no_work`, `current`, `partial`, `failed`, `stale`, `unreadable`, and `invalid`.
A fresh `partial` or `failed` receipt, or a stale previously successful cycle, therefore degrades
health even when an older success is still recent.

---

## 7. Durable Background Work (Work Ledger + Results Outbox)

Sections 1–6 make *turns* durable. This section covers the other loss class: **in-session
background workers** — agent-spawned subagents, background bash, CI babysitters — which live
inside the provider child's process tree.

### 7.1 The loss class

A background worker historically had no registration row, wrote its results to the parent's
stdout/memory, and depended on the parent's turn for delivery. So the parent's death was total:
the process tree died with it and finished work was stranded — pushed branches with no chat
notice, completed analyses never delivered, "the chat just stops".

That is not hypothetical. A production instance's heal reports show a 30-minute-cadence
`crash__signal_SIGKILL_exit_none` wave across the night of 07-22→23 (23:32, 00:02, 00:33, 01:03,
01:33, 02:03, 02:38, 03:08, 03:38, 04:09) plus 07-24 10:07Z — the hard watchdog serially
executing long agentic runs.

PR #2226's liveness gate stops the *false-positive* kills (a working tree is no longer mistaken
for a hung one). It does nothing for a genuine death. This is the durability half.

### 7.2 `background_work` — the Work Ledger

A sanctioned worker is REGISTERED at spawn, which binds it to a `conversation_key` (canonical,
alias-stable chat identity) instead of to its parent session's lifetime. A lease plus an optional
`parent_pid` turn "is the parent still alive?" into a deterministic query rather than an inference.

States: `registered → running → completed | failed`, with `orphaned` as the sweep's verdict on
running work whose lease expired. The sweep only **relabels** — it never kills or re-runs — so a
merely-slow worker that later renews or completes is not destroyed.

`worker_kind` is CHECK-constrained (currently `agent_subagent` only). An unsanctioned kind fails
loudly at write time instead of quietly creating an unmanaged class of worker.

### 7.3 `work_results` — the Results Outbox

Workers MUST write results here — a durable summary plus an optional artifact reference — never
only to parent stdout. An independent delivery daemon drains the outbox, so delivery no longer
depends on any session being alive.

`completeBackgroundWork()` writes the terminal state and the outbox row in **one transaction**.
That atomicity is the durability guarantee: there is no window where the ledger reads "completed"
with no result, nor one where a result exists for work still marked running. A process that dies
mid-call rolls back entirely and the row stays `running`, which the orphan sweep then collects —
rather than the work silently reading as done with nothing to show.

`delivery_dedupe_key` is UNIQUE, which is what makes at-least-once delivery safe to retry (the
bot-errors dispatcher discipline). Claiming a result flips `pending → delivering` and bumps the
attempt counter in one transaction, so two daemon ticks cannot deliver the same row twice.

### 7.4 Delivery honesty (`recovered`, `produced_at`)

A result produced by an orphaned worker and delivered later is, by construction, a statement about
the past. Section 5 and the alert-ordering findings record what happens when that goes unmarked:
reachability alerts not revalidated at delivery, digest retries not episode-fenced, a
clear-before-open leaving an incident falsely open — all cases where a stale delivery read as a
false claim about *now*.

So the schema records both facts and `describeResultStaleness()` renders them:

| Condition | Prefix |
|---|---|
| `recovered = 1` | `[recovered result · produced <age> ago]` — always, with age |
| age ≥ `STALE_DELIVERY_NOTICE_MS` (5 min) | `[delayed result · produced <age> ago]` |
| fresh, live parent | *(no qualifier)* |

`recovered` is **derived, never passed in**: it is true exactly when the work had already been
swept to `orphaned` before finishing. Letting a caller assert it would make it a claim rather than
an observation.

### 7.5 Re-adoption posture

Orphan detection is **notify-first** by owner ruling (2026-07-24): a detected orphan delivers its
results and notifies the originating chat, but does **not** auto-spawn an orchestrator to continue
the work. Fully autonomous re-adoption is a deliberate later decision, not a default.

### 7.6 Staging

- **PR1a (this change)** — migration 46 + `src/core/background-work-store.ts` + tests, including a
  real `kill -9` test that SIGKILLs a child which registered work, then asserts the registration
  survived, the sweep marks it orphaned, and a late result is marked `recovered`.
- **PR1b** (#2279) — registration write-path at the worker spawn sites + the delivery daemon.
  Until it lands, `src/core/background-work-store.ts` is intentionally unwired and is declared in
  `TRACKED_UNREACHABLE` (`tests/scripts/orphan-reachability-guard.test.ts`) so the gap stays
  visible rather than silent.
- **PR3** — CLI shim so operator-side scripts can register, plus the runbook.

## 8. Trigger Occurrence Lifecycle (#2566)

The trigger poller commits durable evidence of every execution BEFORE the executor runs, and
isolates hung executors from unrelated work. Slices 1–2 of #2566 implement the claim/lease,
concurrency, and liveness-observation layers documented here; delivery separation, replay policy,
and retention are later slices and are NOT yet implemented.

### 8.1 Fenced occurrence claim (migration 57)

`trigger_occurrences` gives every scheduled execution a stable identity —
`UNIQUE(trigger_id, scheduled_for, attempt)` — and a fenced lease (`lease_owner`,
`lease_generation`, `lease_expires_at`). `processTrigger` claims the occurrence (state
`running`) in its own committed transaction BEFORE invoking any executor: a crash or hang
always leaves committed evidence, and a second claim of the same occurrence is a UNIQUE
conflict that skips WITHOUT executing — restart cannot run the same occurrence twice. The
terminal finalize runs inside the existing run transaction and is fenced three ways: same
`lease_owner`, same `lease_generation`, AND current state in (`claimed`,`running`) — a stolen
lease or an abandoned execution can never rewrite a terminal state. On startup,
`reconcileStaleOccurrences` sweeps expired-lease claims to `stale` (`stale_cause=lease_expired`)
and never replays them: whether a side effect happened is unknowable at startup, so replay
policy belongs to a capability-aware later slice. `trigger_runs` is byte-unchanged alongside.

### 8.2 Bounded concurrency and hang isolation

Non-side-effecting probe kinds (`poll.sqlite`, `poll.pinecone`, `poll.file`, `poll.url`) run
through a bounded pool (`maxConcurrentExecutors`, default 4); every side-effecting kind
(`poll.shell`, `schedule.*`, `event.message`) stays strictly serial. Probes carry a
per-execution timeout (`executionTimeoutSeconds`, default 300s) finalized as the bounded class
`execution_timeout` — abandoning a read-only probe is always safe, and the finalize state
guard makes any late write from the abandoned execution a no-op. The run loop awaits each tick
under `tickBudgetSeconds` (default 600s) and re-arms the timer past stragglers, which keep
running detached and finalize under their lease.

### 8.3 Independent liveness observation

`TriggerLivenessObserver` runs the liveness gauges on its OWN timer (`observerIntervalMs`,
default 60s) so they still fire when a tick hangs — a watchdog inside `tickOnce` is starved by
the very hang it should report. It runs the #1765 past-due gauge (active, never-fired, stale
`next_fire_at`) via a poller-owned hook, and the recurring-overdue gauge
(`trigger_recurring_overdue`: active, fired before, `next_fire_at` more than
`recurringOverdueGraceSeconds` past — default 900s). Both are fire-once/clear-once latched
with restart-safe recovery markers.

### 8.4 Durable notification-delivery handoff

Notification dispatch is post-commit by design (a crash mid-send must not roll back the
committed run result), which used to make a crash between COMMIT and `sendMessage` a silent
at-most-once loss. The finalize transaction now stamps `notifyPending` on the run's
`output_json` whenever dispatch will follow; successful dispatch and both classified failure
paths (`notify_dispatch_failed`, `notify_forbidden_target`) clear it. Startup
`reconcileDeliveryIntents` marks any surviving intent with the bounded class
`notify_outcome_unknown` and NEVER re-sends: whether the message left the dead process is
unknowable, and a duplicate send is a worse failure than a surfaced unknown. Execution state
(`trigger_occurrences`) and delivery evidence (`deliveredWaMessageId` / notify error kinds)
are independently queryable.

### 8.5 Agent-job occurrence linkage

`AgentJobContext` carries the durable `occurrenceId` of the dispatching claim, and the agent
runtime embeds it in the journaled synthetic inbound's messageId
(`agentjob-<triggerId>-<unixSeconds>-occ<occurrenceId>`). The #2144 turn journal and
`trigger_occurrences` are therefore deterministically joinable — an accepted agent-job
occurrence without a matching journaled owner is auditable incoherence rather than an
unanswerable question.
