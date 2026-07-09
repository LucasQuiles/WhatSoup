# EVIDENCE-E — per-turn STATUS-narration cap (PR-E v2)

Branch: `fix/outbound-status-narration-cap` (worktree `pr-e-statuscap-20260709`),
based on `origin/main` `63ee7c1c`. Node `24.15.0`. Tests: `npx vitest run --pool=forks`.

Spec: `~/.claude/plans/whatsoup-pr-slate-2026-07-08/{DESIGN-E,PLAN-E}.md` (v2 —
status-cap-only, content NEVER suppressed, reset on `endTurn()`+`abortTurn()` NOT
`flush()`).

## Files changed

- `src/runtimes/agent/outbound-queue.ts` — the cap (all of PR-E).
  - New exports: `MAX_STATUS_MESSAGES_PER_TURN=10`, `STATUS_CAP_NOTICE`,
    `HIGH_VOLUME_TURN_WATERMARK=40`; new setter `setMaxStatusMessagesPerTurn(n)`.
  - New per-turn state: `turnStatusCount`, `statusCapNoticeSent`, `turnTotalCount`,
    `maxStatusMessagesPerTurn` (init from config, override via setter).
  - `statusBudgetExhausted()` gate wired into `flushToolBuffer()` (after the redirect
    early-return, before `enqueueText(statusText)`) and `enqueueProgress()` (after the
    floor + text-dedupe checks, before the emit). Content paths untouched.
  - Telemetry `turnTotalCount++` in `enqueue()`; logs `high-volume turn` once at the
    watermark. Never gates.
  - Reset of all three counters in `endTurn()` and `abortTurn()` — NOT `flush()`.
- `src/config.ts` — added `operationTracker.maxStatusMessagesPerTurn` (interface +
  default literal `10`, kept literal to avoid a config↔queue import cycle). Required so
  the cap is config-overridable and the field init typechecks.
- `tests/runtimes/agent/outbound-queue.test.ts` — Tasks 1–5 tests.
- `tests/runtimes/agent/progress-coalescing.bench.test.ts` — bench harness neutralises
  the orthogonal cap layer (see "Pre-existing suite" below).

## Commits (TDD, unpushed)

```
6a00cdb8 test(progress-coalescing): neutralise the PR-E status cap in the bench harness
e7c2953f feat(outbound-queue): log high-volume turn telemetry (suppresses nothing)   [Task 5]
f03bd23c fix(outbound-queue): reset status-cap state on endTurn/abortTurn, not flush  [Task 4]
d88d1318 test(outbound-queue): guard that PR-E never suppresses content               [Task 3]
5fba48a1 feat(outbound-queue): send one STATUS_CAP_NOTICE when the status cap trips   [Task 2]
1b09353b feat(outbound-queue): cap status narration at MAX_STATUS_MESSAGES_PER_TURN   [Task 1]
```

## RED → GREEN transcripts

### Task 1 — status cap reproduces the 07-09 flood (30 status → ≤10)

RED (cap not enforced):
```
FAIL  > PR-E status-narration cap > caps status narration at MAX_STATUS_MESSAGES_PER_TURN per turn
AssertionError: expected 30 to be less than or equal to 10
```
GREEN (after cap in flushToolBuffer + enqueueProgress):
```
Test Files  1 passed (1)
      Tests  1 passed | 129 skipped (130)
```

### Task 2 — exactly one STATUS_CAP_NOTICE + liveness kept

RED (no notice sent):
```
FAIL  > sends exactly one STATUS_CAP_NOTICE and keeps the typing indicator alive when the cap trips
- 1
+ 0        (expected 1 notice, got 0)
```
GREEN (after the notice in statusBudgetExhausted; exact `=== STATUS_CAP_NOTICE`
match confirms the notice survives the enqueueText → preprocessText pipeline unchanged):
```
Test Files  1 passed (1)
      Tests  1 passed | 130 skipped (131)
```

### Task 3 — content is NEVER suppressed (deliverable gate)

Guard — passes with no source change (E has no content path). 60 content messages +
the result all delivered:
```
Test Files  1 passed (1)
      Tests  1 passed | 131 skipped (132)
```

### Task 4 — reset on endTurn(), E1 leak regression + E3 guard

RED (E1: `endTurn()` did not reset — turn 1 exhausted the budget and silenced turn 2;
turn 1 = 10 status + 1 notice = 11 calls, turn 2 suppressed → still 11):
```
FAIL  > resets the status counter on endTurn so a prior turn cannot silence the next (E1)
AssertionError: expected 11 to be greater than 11
```
GREEN (after adding the 3-line reset to `endTurn()` + `abortTurn()`; E3 guard —
mid-turn `flush()` does NOT refill the budget — passes with the endTurn-only reset):
```
Test Files  1 passed (1)
      Tests  2 passed | 132 skipped (134)     (E1 + E3)
```

### Task 5 — high-volume telemetry, suppresses nothing

RED (no counter/warn):
```
FAIL  > logs a high-volume turn once past the watermark without suppressing content
expect(hv).toHaveLength(1)   → got 0
```
GREEN (after `turnTotalCount++` + one-shot `high-volume turn` warn at the watermark;
all 45 content messages delivered, warn fired once with `{chatJid, count: 40}`):
```
Test Files  1 passed (1)
      Tests  135 passed (135)     (full changed file)
```

## Changed test file — full run

```
Test Files  1 passed (1)
      Tests  135 passed (135)
```

## Pre-existing suite (full agent-runtime + config)

The cap is a behavioral change to progress-placeholder volume, so two pre-existing
`progress-coalescing.bench.test.ts` stress tests failed (the advisor-flagged
"flush()-as-turn-boundary" shape):

```
FAIL  progress-coalescing.bench.test.ts > 6. stress > 50 distinct-elapsed placeholders are all delivered (no over-coalescing)   (expected 50, got 11)
FAIL  progress-coalescing.bench.test.ts > 6. stress > 100 sequential turns each emit exactly one placeholder                     (expected 100, got 11)
```

Root cause: that bench measures the per-TEXT dedupe/coalescing layer in isolation and
already zeroes the per-chat rate floor; it treats `flush()` as a turn boundary. The PR-E
cap is an orthogonal layer whose reset is intentionally on `endTurn()`/`abortTurn()` and
NOT `flush()` (adversarial E3), so those single-turn high-fan-out / flush-boundary
scenarios trip it. Resolved the RIGHT way — neutralise the cap in the bench harness
(`setMaxStatusMessagesPerTurn(Number.MAX_SAFE_INTEGER)`, mirroring the existing
`setProgressFloorMs(0)`), NOT by resetting in `flush()` (which would reintroduce E3).
The cap itself is covered by the new outbound-queue.test.ts › PR-E tests.

After the harness fix — full agent-runtime suite + config test:
```
Test Files  151 passed (151)
      Tests  3484 passed (3484)
```
Pre-existing MAX_CHUNKS, rate-floor, batching, idempotency, endTurn/abortTurn tests all green.

## Typecheck

```
> tsc --noEmit        (clean, no errors)
```

## Test Integrity

Repo baseline gate (authoritative — net-new findings fail):
```
TEST_INTEGRITY_BASELINE_CHECK status=pass exit_class=clean total_findings=6 baseline_findings=6 new_findings=0 drifted_findings=0
```
Direct scan on the changed test files (relative path, run from inside the repo per the
known absolute-path false-negative caveat):
```
tests/runtimes/agent/outbound-queue.test.ts            → No findings.
tests/runtimes/agent/progress-coalescing.bench.test.ts → No findings.
```

## Call-site verification — E1 fix works end-to-end (not just the unit)

The E1 reset only helps if `endTurn()` is actually invoked on the turn-end paths.
Verified against `src/runtimes/agent/runtime.ts` (the design claimed it but the unit
test only proves the reset *given* endTurn fires):

- Both `result`-event handlers call `queue.endTurn()` **unconditionally at the top**,
  before any early-break branch: per-chat `runtime.ts:4732`, global/shared
  `runtime.ts:9165`. The in-code comment states it is the choke "so no early-break
  branch below can leave 'composing' asserted."
- Every provider-failure early-break the design names (context-overflow, policy-block,
  usage-limit, auth-required, rate-limit, model-unavailable) is downstream of that
  endTurn(): the inline branches call `cleanupUsageLimitTurn()`
  (`runtime.ts:4806-4932`, `9242-9369`), and the registry-dispatch path
  `dispatchProviderFailureResult` → `handleProviderFailureResult` (`runtime.ts:4766`,
  `9200` → `7661`) both dispatch *after* the top-of-handler endTurn(). So
  `cleanupUsageLimitTurn`'s `queue.flush()` (`runtime.ts:9638`) always runs with the
  counters already reset.
- The only turn-end `flush()` sites without a preceding endTurn are non-leaking:
  `runtime.ts:3644`/`4333` are the mid-turn poll-loop flushes the design cites for E3
  (turn still open — correctly NOT a reset point); crash paths reset via `abortTurn()`
  (`runtime.ts:8295/8420/8520/8554/8610`) with `handleCrashNotify` (`8772`) only
  delivering the notice; the dying-session buffer flush (`3530`) is followed by a
  respawn that builds a replacement queue (QR-069 → fresh counter). Normal-path flushes
  (`5121`, `9543`) follow endTurn.

Conclusion: `endTurn()`/`abortTurn()` covers every genuine turn-end that reuses the
queue, so `turnStatusCount` cannot leak across turns. No design↔code mismatch found.

## File-size ratchet (CLAUDE.md local-green/CI-red trap)

The ~150-line test-file growth stays within the fitness budget:
```
tests/scripts/fitness-file-size-warning-budget.test.ts → 3 passed (3)
```

## Adversarial sign-off corrections (R1 / R2 / R3)

- **R1 [folded in]** — `turnStatusCount` advances ONLY on an actual emit. Already true
  in code: in `enqueueProgress` the increment lives inside `statusBudgetExhausted()`
  (outbound-queue.ts:695/906), which is called AFTER the floor guard (:671) and the
  text-dedupe guard (:684), adjacent to `lastProgressEmittedAt = now` (:700). Added the
  requested regression guard: with the rate floor actively suppressing, `turnStatusCount`
  does not advance (a floored placeholder takes no budget) — test "does not advance the
  status count when the rate floor suppresses a placeholder (R1)".
- **R3 [folded in]** — `STATUS_CAP_NOTICE` never self-counts. It routes through
  `enqueueText` (content), which does not touch `turnStatusCount`. Added the assertion:
  drive exactly cap+1 status → exactly `cap` status messages + one notice — test "does
  not count STATUS_CAP_NOTICE as status narration (R3)".
- **R2 [declined, optional]** — the cap gate is deliberately placed AFTER the
  `toolUpdateRedirectJid` branch (outbound-queue.ts, `flushToolBuffer`), so operator
  status-log redirects stay uncapped. Hoisting it above the redirect would (a) cap
  operator observability and (b) misfire the user-facing notice (sent via `enqueueText`)
  into the operator JID. Matches DESIGN-E's literal "before `enqueueText(statusText)`"
  (the redirect returns before that line). Kept as-is.

## Design ↔ code notes

- DESIGN-E cites `flushToolBuffer()` at l.825, `enqueueProgress()` at l.626,
  `endTurn()` at l.820, `abortTurn()` at l.735. On `origin/main` `63ee7c1c` the real
  offsets differ slightly (e.g. `flushToolBuffer` ~l.825, `endTurn` ~l.820 in the
  pre-change file); the anchors are the correct methods and the gates landed exactly
  where the spec describes (flushToolBuffer before `enqueueText(statusText)`;
  enqueueProgress before the emit; reset in endTurn/abortTurn, not flush).
- Gate placed AFTER the `toolUpdateRedirectJid` early-return in `flushToolBuffer` so an
  operator status-log redirect stays uncapped and the user-facing notice never misfires
  into the redirect JID. Consistent with the spec's "before `enqueueText(statusText)`"
  (redirect returns before that line).
```
