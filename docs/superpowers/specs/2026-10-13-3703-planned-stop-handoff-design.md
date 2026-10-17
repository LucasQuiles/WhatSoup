# #3703 planned-stop handoff: probes, correction and scope

Status: correction on the branch, not released. Red probes landed at 50100084e (base a668b5cff); the
correction follows them. Fixed and promoted to plain assertions: T2, T3a, T4, T6a, T6b, T6c and the horizon
case; T1, T1b, T3b, T5a and T5b behind the #3295 `deferredTurnAdmission` flag (see Handoff). The release
custodian's S3 ruling (2026-10-14) is applied in the Handoff section; no probe remains red.

## Incident shape

mini2 ar-bot, 2026-10-13 15:09:08Z. A DM (3603) was dispatched to the provider, and SIGTERM from a release
activation arrived 14 s later. The old release (ad7b46ccf4d1) ran `AgentRuntime.shutdown()`, finalized 3603
`failed / session_crash`, logged `shutdown complete` and exited 0. No reply was sent and no recovery ran.

## Probes

| File | Cases | Subject |
|------|-------|---------|
| `tests/runtimes/agent/planned-stop-handoff.test.ts` | T1, T1b, T2, T3a, T3b, T4, T5a, T5b | NEW runtime shutdown: handoff of undispatched turns, bounded drain of dispatched turns, honest failure, no false `shutdown complete`, exactly-once across starts |
| `tests/scripts/release-activate-stop-gate.test.ts` | T6a, T6b, T6c | `release:activate --apply` calls the stop preflight before bootout, waits while blocked, fails closed past the bound |
| `tests/scripts/stop-safety-gate.test.ts` | horizon | the 15-minute preflight window must not silently allow a stop over an older open turn that may still be active |

All 12 were committed as `it.fails` at 50100084e. A passing `it.fails` means that the probe failed as expected. It
is never evidence of a repaired release. Each case the correction fixes is promoted to a plain `it` in the same
change.

## Correction

- **Bounded planned-stop drain** (`src/runtimes/agent/planned-stop-drain.ts`, `AgentRuntime.shutdown()`). Shutdown
  takes the undispatched turns off every runtime TurnQueue first, so none is dispatched during the drain. Then it
  waits up to `PLANNED_STOP_DRAIN_MS` (5 s, option `plannedStopDrainMs`) for dispatched turns to finish. The bound
  fits inside main.ts's 10 s forced exit and the service stop timeouts. It rescues only replies that are about to
  land; it is not a substitute for the stop gate. (T2)
- **No false clean stop.** `finalizeActiveRuntimeTurnsForShutdown()` returns how many journaled turns it finalized
  `failed_terminal`, meaning no delivered reply and no recovery owner. Any nonzero count makes shutdown reject
  with `PlannedStopTurnLossError`, so main.ts logs `shutdown incomplete` and exits 1. Turns finalized with a
  delivered reply (`finalized_replied`) or a recovery owner are not counted. (T3a, T4)
  - Side effect: the clean-exit mark is withheld on such a stop, so the restart-loop guard counts it.
- **Activation stop gate** (`scripts/lib/release-activation/apply.ts`). After backups and staging, and before the
  symlink, plists or any launchctl verb, the apply runs the new release's
  `restart-safety-preflight.ts --mode stop`.
  - It re-checks every 15 s for up to 900 s while the preflight exits 3.
  - Past that bound, or on any other exit, it refuses with nothing switched.
  - There is no override.
  - The plan output lists the step. (T6a-c)
- **Preflight horizon** (`classifyOlderOpenInbounds` in `scripts/restart-safety-preflight.ts`). An open inbound
  older than 900 s no longer counts as stale by age alone. The classification uses persisted ownership evidence
  only, from the same tables the #3560 ownership snapshot reads:
  - **live**, which blocks: an unexpired `claimed` recovery job or deferred obligation.
  - **stale**, which does not block, when any of these holds:
    - the row has its own terminal record;
    - a turn of a later inbound in the same conversation has a non-`admission_rejected` terminal record (turns
      of one conversation run in order);
    - a `pending` recovery job or deferred obligation owns the row durably.
  - **unverified**, which blocks with reason `older_turns_unverified`: none of the above.
  - A later `complete` row without a turn does not count; paused-chat and policy rows close at receipt while an
    earlier turn still runs.
  - The provider-execution capture is not used. It only covers the OpenCode lane, so "idle" cannot prove that a
    Claude turn is dead.
  - Read-only check against the live q database at 16:12Z: inbound 87177, open for 18 min while its turn was
    still running, classified as unverified and blocked. The old rule would have allowed the stop.
  - Contract change: weeks-old wedged rows stay restartable only when such evidence exists. A wedged chat with
    no later turn now blocks until an operator resolves the row.

## Handoff (#3295 S3)

Behind the default-OFF `deferredTurnAdmission` setting (`agentOptions.deferredTurnAdmission: { enabled }`, closed
shape validated at load). main.ts resolves it once and passes the same value to startup recovery and to the agent
runtime, which reads its option object live. With it OFF nothing below runs and T3a/T4 behaviour is unchanged,
except startup recovery (see Restart ownership).

- **Distinct cause.** The handoff has its own cause, `planned_stop`, used only by the shutdown sites while the
  runtime is stopping (`handOffUndispatchedTurnAtPlannedStop`). It never keys on a queue rejection reason:
  ordinary `queue_closed` (a closed TurnQueue outside the stop), `queue_halted`, `queue_full`, an unknown
  rejection and a processor failure stay terminal exactly as before (T1 cause cases). The other obligation
  causes are `recovery_blocked` (S2) and `fifo_behind_obligation` (below).
- **Handoff at stop** (`RuntimeTurnCoordinator.finalizeActiveRuntimeTurnsForShutdown`). A queued per_chat turn
  that never reached the provider and has a replay-safe text envelope becomes a `pending` row in
  `deferred_turn_obligations`, with the same predicate as the S2 admission defer. The row is written
  synchronously, before the stop counts its losses, so a clean stop is reported only with the owner on disk.
  Its inbound stays `processing` and gets no terminal record. If the write fails, the turn takes the old path:
  `failed_terminal`, and the stop rejects (T3b).
- **Admission boundary during the stop (T1b).** Ingest stores and journals a message (inboundSeq assigned)
  before `handleMessage` runs, so every message the runtime sees during the stop is already accepted.
  `handleMessage` keeps intake open until the stop closes it, just before the message-handler drain. In that
  window a journaled plain-text message (per_chat, not sandboxed, not a local or forwarded command, not a
  synthetic job) whose replay envelope meets the store's own contract (`deferredTurnEnvelopeRefusal`:
  replay-safe, text within the 256 KiB bound) runs the ordinary intake pipeline; its queue admission then hands
  it off with cause `planned_stop` instead of dispatching it. The handler is awaited through that admission, so
  the stop's handler drain covers the handoff. The same message with an envelope the store refuses (for example
  text over the bound) cannot be handed off. It is already accepted, so it is not refused: `handleMessage`
  returns without dispatching and the inbound stays `processing`. The stop rejects with
  `PlannedStopIntakeRetainedError` (`shutdown incomplete`, exit 1). On the next start, `preConnectRecovery`
  (step 4) gives the same seq the existing durable owner for an accepted inbound with no terminal outbound: an
  open `recovery_pending_operator_catchup` disposition link (counted in health `openRecoveries`), closed only
  through the supported operator catch-up. The message text stays whole in `messages`, and message retention
  (`deleteOldMessages`) keeps a message while its inbound has an open catch-up. It is never replayed.
  The bound is not raised and the text is never truncated. Any other message, and every message after closure, is
  refused with `RuntimeAdmissionClosedError`, which ingest records `failed / queue_closed`. There is no second
  intake pipeline and no new held state. Proof scope: the ingest-route cases drive the real ingest handler into
  the real runtime during a stop for one oversize plain-text message, then restart on the same database and
  follow that seq to its open catch-up link; they do not prove the whole route or any other ineligible shape.
- **Restart ownership** (`preConnectRecovery({ deferredTurnOwnerEnabled })`). main.ts derives the owner from the
  same setting it passes to the runtime: enabled exactly for an agent instance in per_chat scope with the setting
  on (`resolveDeferredTurnStartupSetting`). Enabled: crash recovery skips an inbound owned by a `claimed`
  obligation or by a `pending` one with attempts left; a committed or exhausted obligation does not protect its
  inbound, and no obligation is closed (the drain owns them). Disabled (the default): owned inbounds are failed
  like any interrupted turn and every open obligation is closed `terminal_quarantined`: pre-commit rows
  `owner_disabled`, `dispatched_commit` rows `owner_disabled_after_commit` (effects may have started: never
  labelled completed, and as terminal rows never replayed). Nothing is left non-terminal or holding a `processing`
  row. Retention never deletes a source or envelope while its obligation is non-terminal.
- **Drain** (`src/runtimes/agent/deferred-turn-drain.ts`). Started in `setDurability`, stopped at shutdown. It
  runs at start, after progress, on request and every 15 s. For the head obligation of each conversation it:
  - skips while a same-scope durable recovery blocks the conversation;
  - claims with a fence and checks that the source inbound is still open;
  - admits the turn to the chat's ordinary TurnQueue, so drained turns follow the same FIFO, fencing and
    planned-stop rules as live input;
  - writes `dispatched_commit` at the provider boundary, BEFORE the turn is published or sent. A stale fence
    throws there: nothing is published, the provider is not called, and the source stays open.
  - Each pass first renews the claim of every drained turn still waiting in a chat queue, then runs the expiry
    sweep. A turn that waits longer than the claim TTL (600 s) keeps its claim: it is not replayed, its last
    attempt does not become an exhausted head, and live input still queues behind it.
  - A turn that never reached the provider (stale fence, pre-boundary failure, queue rejection, planned stop) is
    released back to its obligation without any write to the source: a fenced requeue (up to the store's 5
    attempts, then `terminal_quarantined` / `attempts_exhausted` and the ordinary terminal path finalizes the
    source). If the claim lapsed and nobody re-claimed it (same epoch), the claim is restored to this claimant
    and the release decides as above; it is never swallowed into a replay. If another owner closed the
    obligation, the ordinary terminal path owns the still-open source; if another claimant holds it, that
    claimant owns it. Operator cancellation closes the pre-commit obligation without a fence
    (`operator_cancelled`): it wins over any claim, and a later commit by that claim fails its fence.
  - Closures the drain makes without a runtime turn settle the source themselves. `unsupported_envelope`, and
    `context_unavailable` / `enqueue_failed` on the last attempt (`attempts_exhausted`), fail a still-open source
    `failed / pre_dispatch_error`. `source_not_open` writes nothing: the source keeps the state its own owner
    wrote. No path labels a source completed.
  - An exhausted head (`pending` with no attempts left, e.g. a crashed process's last claim expired) can never be
    claimed: the drain closes it `terminal_quarantined` / `attempts_exhausted`, fails its source if still open,
    and the next obligation of the chat runs.
  - After the commit, nothing is requeued. The ordinary terminal path owns the turn, and the obligation closes
    once the source inbound is terminal: `terminal_completed` / `completed`, or `terminal_quarantined` /
    `source_failed`. A failed turn is never labelled completed.
- **FIFO against live input.** A live per_chat message whose conversation has ANY older runnable obligation
  (pending with attempts left, claimed, or committed and settling — not only the queue head) is itself deferred
  into an obligation (`fifo_behind_obligation`) and the drain is kicked, so both run in inbound order. An
  exhausted head does not hold live input by itself, but runnable work queued behind it does. A message that
  cannot be deferred (not a replay-safe text envelope) keeps the live path.
- **Stop during a drained turn.** A drained turn still queued, or active but not past the commit, is released
  back to its obligation (`planned_stop`); the stop stays clean and the next start dispatches it. A drained turn
  past the commit follows the dispatched-turn rules (bounded drain, then `failed_terminal`) and is never replayed.
- **Logs** of the drain carry error class names and bounded tags only: no raw error, obligation id, inbound
  sequence or envelope field.
- **Exactly once across starts** (T5a, T5b): the row is terminal or `dispatched_commit` after the first start,
  so a later start never claims it again. Concurrent drains on one database get one claim (atomic UPDATE).

## Scope limits

- **T6a proves ordering only.** It shows that the preflight call precedes the instance bootout. It does not show
  that no work enters between the check and the bootout. The running transport ingests asynchronously, without any
  activation-tool call, so tool-call order says nothing about admission in that gap.
- **First old-to-new cutover is a separate boundary.** On the first upgrade, the stop is executed by the OLD
  release's shutdown, which finalizes an in-flight turn failed (3603). Nothing in these probes, and no fix to the
  new runtime alone, qualifies that cutover or closes the 3603 race.
- **Before rollout:** the accepted admission/drain/ownership property must be shown through the actual supported
  activation route, not through the simulated launchd world.
- **No stop override.** A blocked apply is refused. An override must not stand in for the safe-stop contract. The
  earlier T6d override probe was removed.
- **Horizon (probe finding).** Before the correction, `inspectStopSafety` counted open inbounds older than 900 s as
  `staleIgnored` and allowed the stop. On the q instance on 2026-10-13, inbounds 87114, 87145 and 87146 stayed open
  for 16 to 22 min while their turns progressed, so a stop at minute 20 would have killed a live turn. The
  correction classifies such rows from persisted ownership evidence (see Correction). With no evidence, a row is
  unverified and blocks; it is never assumed dead.

## Remaining

- **Orphaned claim delays live input.** With FIFO, a live message waits behind an older obligation that a
  crashed process left `claimed`, until the claim TTL (600 s) expires and the drain reclaims it.
- **Each planned stop that releases a drained turn spends one of its 5 attempts** (the requeue counts).
- **An oversize message accepted during the stop is not replayed and gets no automatic reply.** No replay owner
  holds text over the 256 KiB bound. The stop fails instead of reporting clean, and the next start records an open
  operator catch-up for it. Recovery labels it with its generic reason (`crash_reclaim_no_terminal_outbound`,
  inbound `failed / crash_recovery`), not a planned-stop cause; the stop's own error carries that cause. Until the
  next start, the inbound stays `processing`.
- **A source the drain fails itself** (`pre_dispatch_error`, no runtime turn) gets an inbound failure but no
  `turn_terminal_records` row, as crash recovery's failures do.
- **First old-to-new cutover.** The supported operation is the new release's `release:activate --apply`. Its stop
  gate runs from the new release against the instance database before the old process is touched, so the old
  instance is stopped only after a quiet check.
  - Residual exposure: work the old transport admits between the last check and the bootout. That work is
    stopped by the old shutdown, which fails it and reports clean (the 3603 shape).
  - The new code cannot close that window on an old release.
  - The decision needed, per bot: accept that residual window for the first cutover, or require a separate
    quiet-window precondition.
- **Before rollout:** the admission/drain/ownership property must still be shown through the actual supported
  route.

## Native results at a668b5cff (probes run as plain `it`)

Recorded once at 50100084e and not rerun; the logs are retained outside the repository.

`npx vitest run` on the three files, as committed: 3 files passed, 14 passed, 12 expected fail.
With `it.fails` replaced by `it`, all 12 probes fail on an assertion, not a harness error:

| Case | First failing assertion |
|------|-------------------------|
| T6a | `expected 0 to be greater than or equal to 1` (no preflight call) |
| T6b | `expected [] to have a length of 3 but got +0` |
| T6c | `expected 0 to be greater than 1` |
| horizon | `expected 'allow' not to be 'allow'` |
| T1 | `expected 'failed' to be 'processing'` |
| T1b | `expected 'rejected' to be 'accepted'` |
| T2 | `expected 'failed' to be 'processing'` |
| T3a | `expected null not to be null` (shutdown resolved) |
| T3b | `expected "enqueueDeferredObligation" to be called at least once` |
| T4 | `expected [ 'shutdown complete' ] to not include 'shutdown complete'` |
| T5a | `expected +0 to be 1` |
| T5b | `expected +0 to be 1` |

