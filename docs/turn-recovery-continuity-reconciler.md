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
2. Finds the **earliest later inbound on the sources' own `chat_jid`** that
   carries a *unique* delivery proof — `MIN(target_seq)` from the fail-closed
   `operator_catchup_delivery_proofs` view (`HAVING COUNT(*) = 1`) with
   `target_seq > max(source seqs)`. The chat filter mirrors the closure trigger,
   which requires `target.chat_jid = source.chat_jid` for every source: a proof
   from another chat under the same `conversation_key` can never close the
   group, so picking one would wedge the group on every pass.
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
every source). Selection uses the earliest source's chat, so such a group is
still attempted whenever that chat has a candidate and then fails closed as
`closure_rejected`; with no candidate there it is reported as
`no_catchup_candidate`. Either way it remains pending.

### Bounding a pass

`groupLimit` (default `RECONCILE_DEFAULT_GROUP_LIMIT = 50`) caps closure
*attempts*, not groups looked at: a group with no candidate is skipped without
charging it. A second budget keeps the pass bounded — at most
`groupLimit × RECONCILE_EXAMINATION_MULTIPLIER` (20) groups are examined per
pass. Groups are enumerated in a stable `recovery_plan_id` order, so the budgets
raise the starvation threshold rather than removing it. Two classes of
unattemptable group sort ahead of a closable one, with different thresholds:

| Prefix class | Groups that hide the next one | Budget charged |
| --- | --- | --- |
| No catch-up candidate | `groupLimit × 20` (1000 by default) | examination |
| Candidate the closure always rejects | `groupLimit` (50 by default) | attempt |

The examination cap is tested before the counter is charged, so a prefix of
*exactly* `groupLimit × 20` candidate-less groups already hides the next group.
A group whose candidate is permanently rejected charges the attempt budget
before the closure is tried, so it starves a closable group twenty times sooner
than the candidate-less class. Neither case is reported: the report carries no
truncation signal for a pass that stopped on either budget. Both are properties
of the selection order, unchanged by this PR. The budgets bound the per-group
candidate probe and closure attempt; the enumeration query itself still reads
every open pending link.

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

## ② — blocked-unsafe actionability split (gauge)

`getTurnRecoverySupervisorCounts` now splits `blockedUnsafe` into three
buckets, mirrored into the health details surface
(`turnRecoveryBlockedUnsafe{Synthetic,Superseded,Stranded}`):

- **synthetic** — `agentjob-%` source IDs: internal scheduled self-turns
  that owe no user a reply. Parked synthetics are expected residue, never an
  incident.
- **superseded** — real sources whose conversation has ANY newer inbound
  (the same newer-activity signal the safe-replay fence uses): the thread
  moved on; the parked replay is correctly superseded.
- **stranded** — real sources with no newer activity: the only class that
  should page an operator.

`synthetic + superseded + stranded === blockedUnsafe` is asserted on real
rows (`tests/core/turn-recovery-counts-split.test.ts`). The enrollment-side
half of ② (stop enrolling synthetic self-turns into user-facing recovery at
all — live finalize + boot reclaim arms) is still open; the gauge split
makes the residue visible and non-paging in the meantime.

## Follow-ups (separate PRs)

- ~~**PR2 — wiring**~~: shipped — see "PR2 — supervisor wiring" above.
- **② synthetic exclusion + actionable gauge:** the gauge split shipped
  (see above); the enrollment-side synthetic exclusion is still open.
- **③ user-facing catch-up nudge** for genuinely-stranded real user turns that
  the conversation has *not* resumed within a window; plus a newer-activity
  fence on the automatic replay path (today only the operator CLI has one).

## Deploy note

This subsystem ships as a source-bytes release export and is cut over via the
two-pointer procedure; **nothing here changes the running service until a
separately-gated cutover.** Editing the repo has zero live impact.
