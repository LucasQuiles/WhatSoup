# Turn-recovery continuity: automatic catch-up reconciler

## Why

The turn-recovery subsystem does the **pend** half of *pend-and-release* correctly:
when the agent crashes mid-turn it detects the orphaned inbound, refuses an unsafe
replay, and records an open `recovery_pending_operator_catchup` disposition link.
It never did the **release** half automatically.

Ground-truth from the live `q` instance (2026-09-03, read-only):

- **27 open catch-up links** and **24 `blocked_unsafe` job tombstones** had
  accumulated over ~6 weeks. Every one of the 8
  `crash_reclaim_no_terminal_outbound` inbounds was checked against the message
  log: **all 8 saw the conversation resume** — the 8/16 crash-storm cluster got
  delivered replies within ~60–90s; the three older ones are followed by
  hundreds of later in-thread replies. **No third-party user was silently
  dropped; no live reply was lost.** The backlog is *stale ledger residue*, not
  live message loss.

The root cause of the residue: an open catch-up link could be closed **only** by
a human running `scripts/close-recovery-catchup.ts` with the exact
`--plan-id / --conversation-key / --source-seqs / --catchup-seq` tuple. There is
no automatic closer, so links pile up indefinitely even after the conversation
has demonstrably caught up.

## What this adds (PR1 — primitive only)

`reconcileOperatorCatchupRecoveries(raw, …)` in
`src/core/recovery-catchup-closure.ts` — a **pure selector** on top of the
existing, hardened closure primitive. It does **not** invent any new proof or
closure semantics.

For each open pending `(recovery_plan_id, conversation_key)` group it:

1. Reads the exact set of still-open source seqs (`superseded_by_seq IS NULL`,
   not already closed).
2. Finds the **earliest later inbound** in that conversation that carries a
   *unique* delivery proof — `MIN(target_seq)` from the fail-closed
   `operator_catchup_delivery_proofs` view (`HAVING COUNT(*) = 1`) with
   `target_seq > max(source seqs)`.
3. Calls `closeOperatorCatchupRecoveryRaw` **verbatim** with
   `actor = 'auto_reconciler'` and an `auto://catchup-delivery-proof:seq=<n>`
   evidence reference.

### Why this is safe

The closure is defended three ways, all of which still apply unchanged:

- The app-layer `inspectOperatorCatchupRecovery` re-validates the exact pending
  set, `catchupSeq > every source`, target completeness, and a unique delivery
  proof, under a single-writer `BEGIN IMMEDIATE` reservation.
- The DB trigger `inbound_disposition_closure_validate_insert` **independently**
  re-proves the closure at INSERT time (`RAISE(ABORT, 'invalid operator
  catch-up closure')` otherwise). This is the ultimate backstop: **a wrong
  selection fails closed and cannot corrupt state.**
- The durable closure witness must persist and match exactly, or the whole
  transaction rolls back.

Because of this, the reconciler is intentionally *best-effort*: it picks a
candidate, attempts the closure, and on any rejection records a bounded skip
reason and moves on. Groups that are not yet provably superseded (no delivered
catch-up reply) simply stay pending — which is correct.

Groups whose source inbounds span multiple `chat_jid`s cannot be covered by a
single catch-up (the trigger requires `target.chat_jid = source.chat_jid` for
every source); those fail closed as `closure_rejected` and remain pending.

### Test coverage of the fail-closed path

The safety claim above is exercised, not just asserted
(`tests/core/recovery-catchup-reconciler.test.ts`):

- **Trigger fail-close → `closure_rejected`:** a group whose two sources sit on
  different `chat_jid`s under one `conversation_key` attempts a closure (a
  candidate proof exists for the target's own chat), the DB trigger
  `RAISE(ABORT)`s the mismatched row, the whole transaction rolls back, and the
  reconciler records a bounded `closure_rejected` skip — **neither** source is
  closed (no partial close) and both stay pending.
- **Lock contention → `busy`:** with a competing writer holding
  `BEGIN IMMEDIATE` on a second connection and `busy_timeout = 0`, the per-group
  closure loses the write lock and is classified `busy`; a retry after the lock
  releases closes the group, proving the skip is transient, not terminal.

### Report shape

`{ attempted, closed, linksClosed, skipped, skips[] }` where each skip is
`{ planId, conversationKey, nSourceSeqs, reason }` and `reason` is one of
`no_catchup_candidate | closure_rejected | busy | error`. `error` is reserved
for genuinely unexpected failures (not proof-shape rejections) so the caller can
alert on it rather than treat it as benign.

## PR2 — supervisor wiring (deploy-gated)

`runScan()` now invokes the reconciler once per cycle, immediately after
`recoverStaleTurnRecoveryJobs` (so freshly-reclaimed rows are visible) and
before job enumeration (so the cycle's totals include its outcome):

- **Gate:** a new optional supervisor dep, `catchupReconcile: { groupLimit? }`.
  Absent/null — the default everywhere today, including
  `createTurnRecoverySupervisorForRuntime` — keeps exactly the pre-PR2
  behavior. Enabling it is a separately-gated cutover decision, forwarded
  verbatim through `turn-recovery-dispatch.ts`.
- **Surface:** `DurabilityEngine.reconcileOperatorCatchupRecoveries(params?)`
  delegates to the core selector on the engine's own raw handle; the
  supervisor's narrow `TurnRecoverySupervisorDurability` interface carries it
  as an optional method, so fakes/legacy surfaces simply never reconcile.
- **Observability:** three new scan-result counters
  (`catchupReconcileAttempted / Closed / Skipped`); a whole-call failure
  (storage/schema drift) records `catchup_reconcile_failed` as the scan
  failure reason and logs a warning **without aborting the rest of the scan**
  (same contract as the stale-claim sweep). Unexpected-error skips inside a
  successful report are logged at error level for alert wiring.
- **Tests:** `tests/runtimes/agent/turn-recovery-catchup-reconcile-wiring.test.ts`
  drives a REAL `Database` + `DurabilityEngine` + `TurnRecoverySupervisor`
  end-to-end (only the socket is absent): gate-on closes a caught-up group
  with `auto_reconciler` actors and is idempotent; gate-off (default) leaves
  everything pending; `groupLimit` bounds a cycle and the next cycle drains
  the remainder; a throwing reconciler resolves the scan, keeps everything
  pending, and lands `catchup_reconcile_failed` in health.

## Follow-ups (separate PRs)

- ~~**PR2 — wiring**~~: shipped — see "PR2 — supervisor wiring" above.
- **② synthetic exclusion + actionable gauge:** stop enrolling
  `create_agent_job` self-turns (`source_message_id LIKE 'agentjob-%'`) in
  user-facing recovery, and split the health gauge into
  `synthetic / superseded / genuinely_stranded` so the alert is actionable.
- **③ user-facing catch-up nudge** for genuinely-stranded real user turns that
  the conversation has *not* resumed within a window; plus a newer-activity
  fence on the automatic replay path (today only the operator CLI has one).

## Deploy note

This subsystem ships as a source-bytes release export and is cut over via the
two-pointer procedure; **nothing here changes the running service until a
separately-gated cutover.** Editing the repo has zero live impact.
