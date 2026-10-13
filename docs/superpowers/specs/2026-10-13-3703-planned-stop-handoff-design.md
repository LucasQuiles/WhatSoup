# #3703 planned-stop handoff: red probes and scope

Status: red probes only. No source change on this branch yet. Base: a668b5cff.

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

All 12 are committed as `it.fails`. A passing `it.fails` means that the probe failed as expected. It is never
evidence of a repaired release. When a fix makes a probe pass natively, that probe is promoted to a plain `it` in
the same change, and its native result is reported.

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
- **Horizon.** `inspectStopSafety` counts open inbounds older than 900 s as `staleIgnored` and allows the stop.
  On the q instance on 2026-10-13, inbounds 87114, 87145 and 87146 stayed open for 16 to 22 min while their turns
  progressed, so a stop at minute 20 would have killed a live turn. The database alone may not be able to tell
  such a turn from weeks-old wedged debt, which must stay restartable (the existing test). The fix needs a liveness
  source that can make that distinction. That source is an open design question.

## Native results at a668b5cff (probes run as plain `it`)

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

No case is fixed yet, so there is nothing to promote.
