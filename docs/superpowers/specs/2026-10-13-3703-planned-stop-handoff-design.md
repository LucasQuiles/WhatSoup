# #3703 planned-stop handoff: probes, correction and scope

Status: partial correction on the branch, not released. Red probes landed at 50100084e (base a668b5cff); the
correction follows them. Fixed and promoted to plain assertions: T2, T3a, T4, T6a, T6b, T6c and the horizon
case. Still red (`it.fails`): T1, T1b, T3b, T5a and T5b.

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

- **T1, T1b, T3b, T5a, T5b (handoff).** These need a durable owner that dispatches a handed-off, never-dispatched
  turn exactly once on the next start. The #3295 deferred-obligation store has the state machine, but its drain
  consumer (slice S3: claim, dispatch, `dispatched_commit`) does not exist; nothing calls `claimHead`. Until it
  exists, a stop fails such turns and reports the loss (T3a/T4 behaviour).
  - The decision needed: build S3 as the owner, or hand these turns to another existing owner.
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

