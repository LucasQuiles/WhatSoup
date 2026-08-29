# Provider 143/130 self-exit misclassification + NO_REPLY leak

**Status:** fix landed on `fix/provider-teardown-143-and-noreply-sentinel` (refs #3391, #1870).
**Audience:** anyone touching agent session lifecycle, crash/heal telemetry, or the egress reply gate.

## The defect class

WhatSoup's termination bookkeeping assumed a killed provider child **dies under the
signal** — i.e. `signal !== null` (`'SIGTERM'` / `'SIGINT'`), `code === null`. A provider
that **traps** the signal and shuts itself down self-exits with a **numeric `128 + signo`
code** instead: `signal === null`, `code === 143` (SIGTERM) or `code === 130` (SIGINT).
`claude-cli` does exactly this. Every classifier that switched only on the *signal value*
had a blind spot for the numeric shape.

Concretely, when the process group is SIGTERM'd — an idle-TTL suspend sweep, or a systemd
restart — each live chat's child self-exits `143` at (nearly) the same second. Because the
classifiers only recognized `signal === 'SIGTERM'`, those graceful teardowns were treated
as **provider crashes**.

### User-visible symptoms
1. **False "session ended" alarms:** `session ended (exited with code 143). Send any
   message to start a new session.` posted to every live chat on each teardown.
2. **False fleet-wide respawn exhaustion:** the `onCrash` sites recorded against
   `GLOBAL_CRASH_SCOPE_KEY`, so a 3-session idle-suspend cluster summed onto one global
   counter and pushed the whole instance toward `auto-respawn exhausted` — degrading every
   chat, not just the raced one.
3. **Dropped replies (re-ping "?"):** a false 143 crash triggered auto-respawn → a
   continuation turn → whose real answer was then suppressed by a stale `postTurnGate` as
   "phantom assistant_text." The user saw silence and had to re-send. (See *Residual gaps*.)

### NO_REPLY leak (same PR)
`NO_REPLY` is a **prompt-level** deliberate-silence sentinel (`scheduled-agent-job-isolation`
instructs background turns to "output only NO_REPLY"). No code consumer stripped it, so when
the reply guarantee forced a non-silent delivery, the literal token `NO_REPLY` posted to the
chat. It was a convention with **no matching code enforcement** — fail-open.

## The fix

### Single source of truth: `isSignalTeardownExit(code, signal)`
`failure-taxonomy.ts` now owns the "128 + signo graceful-exit" knowledge in one predicate,
recognizing **both** shapes:
- signal death: `signal === 'SIGTERM' | 'SIGINT'`
- numeric self-exit: `signal === null && (code === 143 | 130)`

**137 / SIGKILL is deliberately EXCLUDED.** SIGKILL is uncatchable, so a `137` self-exit is
impossible and a `signal === 'SIGKILL'` exit is a genuine force-kill (our own reap — tracked
separately via the intentional-kill marker — or OOM/external kill). Masking `137` would hide
real failures. This is the clean boundary: only catchable signals (143/130) are excused.

### Integration points routed through the predicate
| Site | Before | After |
|------|--------|-------|
| `failure-taxonomy.isExpectedProviderShutdown` | `signal==='SIGTERM'\|'SIGINT'` | `isSignalTeardownExit(code, signal)` |
| `session.ts` unexpected-exit notify | notified on 143 | suppresses spurious 143/130 crash line (signal-death still notifies — #1870 control) |
| `session.ts` turn-boundary `exitedWithError` | `code!==0 && code!==null` flagged 143 | delivered-result + clean-teardown 143 is not an error |
| `runtime.crashCountsTowardExhaustion` (3× onCrash + `recoverable_dead`) | always `recordCrash(GLOBAL_CRASH_SCOPE_KEY)` | expected teardown recovers the session but does **not** count toward respawn exhaustion |

### NO_REPLY consumer
`outbound-message-safety.classifyAssistantTextEgress` now matches a **whole-body** NO_REPLY
(optionally wrapped in the markdown fences/emphasis a model adds, trailing `.`/`!`) and
suppresses it as `no_reply_sentinel` with `satisfiesReplyGuarantee: true` — a genuine silent
turn the guarantee fallback will not re-deliver. Anchored to the full trimmed body, so prose
that merely *mentions* NO_REPLY is never suppressed.

## Verification
- 655 tests green (vitest, pinned node 24.15.0) across the 4 changed test files.
- Positive controls retained: a genuine signal-death mid-turn (no result) and non-zero error
  codes still classify as crashes and still notify.

## Residual gaps (tracked separately — NOT in this PR)
Removing the **false** 143 crash eliminates the dominant dropped-reply chain (there is no
respawn, so no phantom-suppressed continuation). Two latent gaps remain and warrant their own
issue:
1. **Post-turn gate vs. legit respawn continuation:** after a *real* crash, an auto-respawn
   continuation reply can still be suppressed by a stale `postTurnGate` entry
   (`runtime.ts:6172` / `:10178`). The gate should be cleared when a respawn continuation is
   issued.
2. **Minimal-mode buffered discard:** `outbound-queue.discardPreToolAssistantText` drops
   pre-tool assistant text in `toolUpdateMode==='minimal'` by design. It is data-loss only
   if the final result never enqueues (turn killed mid-flight) — which this PR prevents for
   the 143 case, but the general mid-turn-kill case remains.

## Deploy note
The running `q` prod tree (`WhatSoup-deploy-4fc1e7ff`) is ~108 commits behind main. No fix —
merged or not — reaches the live fleet until that tree is rolled forward. Landing this PR is
step 1; redeploying the fleet is step 2.
