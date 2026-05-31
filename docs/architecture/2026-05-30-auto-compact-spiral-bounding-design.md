# Auto-Compact Spiral Bounding — Design

**Date:** 2026-05-30
**Status:** Design
**Target base:** origin/main `13d54a57`

## Problem

High-volume agent groups re-trigger auto-compaction in a tight loop, degrading
reply latency. Confirmed live on a canary host via journald: one hot group scope
fired `auto compact triggered` ~15× over two hours on 2026-05-30, with
`inputSinceCompact` climbing 339K → 3.8M → 4.8M against a 150K threshold. PRs
#704–#709 reduced but did not close this family.

### Root cause

`markSessionCompacted` (`src/runtimes/agent/session-db.ts:232`) advances the
baseline by setting `last_compact_input_tokens = total_input_tokens`. But
`total_input_tokens` is a **cumulative, monotonic** counter — it never decreases
after a `/compact`. The compact summarizes the live conversation, yet the
cumulative counter keeps climbing. For a high-volume group, the very next turn's
input can exceed the threshold, so
`inputSinceCompact = total - lastCompact` re-crosses 150K almost immediately.

The trigger gate (`maybeStartAutoCompact`, `runtime.ts:1301`) applies a cooldown
**only** in the timeout branch (`:1356`,
`autoCompactCooldownUntil.set(...AUTO_COMPACT_TIMEOUT_BACKOFF_MS)`). A
*successful-but-ineffective* compact — one that completed but left the scope
still over threshold — has **no cooldown**, so it re-arms on the next turn. The
success path (`runtime.ts:4324`) just calls `markSessionCompacted` and re-enables
auto-compact. That asymmetry is the spiral.

### Why the obvious signal does not work

A natural effectiveness check would be "did the context shrink?" — but
`total_input_tokens` is cumulative, so immediately after `markSessionCompacted`
the `inputSinceCompact` delta is always ~0 regardless of whether the real context
dropped. **Cumulative token counters cannot reveal post-compact context size.**
The guard must therefore key on *observable behavior around re-arming*, not on a
measured context delta.

> **Operational definition.** A compact is **ineffective** for a scope if that
> scope becomes eligible for auto-compact again within the rapid-re-arm window
> after a *successful* compact.

## Goals / Non-goals

**Goals**
- Bound the re-arm rate so a single scope cannot spin `/compact` every turn.
- Detect persistent offenders and back off harder, without ever fully disabling
  auto-compact (avoid trading the spiral for a prompt-too-long crash).
- Surface enough telemetry to prove the spiral is bounded in production.
- Preserve current correct behavior: timeout backoff, the anti-storm bootstrap
  path, the "failed compact must not reset baseline" invariant.

**Non-goals (deferred)**
- **Dynamic per-group thresholds.** Deferred unless this design proves
  insufficient. A scope whose steady-state floor exceeds the threshold is
  surfaced by telemetry (secondary signal below) but not auto-tuned here.
- Changing what `/compact` itself does, or how the SDK summarizes.
- Reducing cumulative-counter semantics (out of scope; many consumers).

## Approach

Hybrid, per the design pass: **post-success cooldown with escalating backoff**
(primary, behavioral) plus **next-turn input-delta telemetry** (secondary,
diagnostic). No dependency on any SDK post-compact context metric. (If the SDK is
later found to expose a reliable post-compact size, it can sharpen telemetry —
but the fix must not depend on it.)

### Primary signal — rapid re-arm interval / frequency

Per scope, track:
- `lastCompactCompletedAt` — timestamp of the last *successful* auto-compact.
- `consecutiveRapidRearms` — count of successive times the scope became
  auto-compact-eligible again within `RAPID_REARM_WINDOW_MS` of its last
  successful compact.
- current backoff tier (derived from `consecutiveRapidRearms`).

On a successful compact (the `hadCompactBoundary` branch at `runtime.ts:4324`),
record `lastCompactCompletedAt` and **always set a baseline cooldown**
(`AUTO_COMPACT_SUCCESS_COOLDOWN_MS`). This closes the asymmetry: success now
cools down like timeout already does.

When `maybeStartAutoCompact` next finds the scope eligible, it must classify the
eligibility **before** returning for an active cooldown. This is the important
ordering rule: the cooldown itself is the evidence window. If the code checks
`now < cooldownUntil` first and returns, it suppresses the re-arm without
recording that the compact was ineffective.

- If `now - lastCompactCompletedAt < RAPID_REARM_WINDOW_MS`, increment
  `consecutiveRapidRearms`, mark that this success has already recorded its
  rapid re-arm, and set the cooldown to the escalated tier.
- If the same successful compact produces more eligible turns during the
  cooldown, do not increment repeatedly; one success can contribute at most one
  rapid-rearm count.
- Otherwise, if no rapid re-arm was observed for that successful compact and the
  window has elapsed, reset `consecutiveRapidRearms = 0` (the scope recovered).

**State-transition invariant (must hold across deferred cooldowns).**
`consecutiveRapidRearms` is **persistent across the deferral itself** — it must NOT
be reset merely because a deferred cooldown elapsed. The window is always measured
from `lastCompactCompletedAt` (the last *successful* compact), never from when the
last cooldown was set, and the count is reset only by the *recovery* condition.
Concretely:

1. Successful compact at T0 → `lastCompactCompletedAt = T0`, baseline cooldown.
2. Scope eligible again at T1, `T1 − T0 < window` → classify this before any
   cooldown return, set `consecutiveRapidRearms = 1`, mark T0 as already
   counted, and defer with the tier-1 (15 min) cooldown. **The count stays at 1
   through that cooldown.**
3. Cooldown elapses, compact runs, succeeds at T2 → `lastCompactCompletedAt = T2`.
   The count is **carried forward**, not reset — a successful compact alone is not
   recovery.
4. Scope eligible again at T3, `T3 − T2 < window` → `consecutiveRapidRearms = 2`,
   tier-2 (30 min). Repeat → tier-3 (60 min cap).
5. **Recovery (the only reset):** after a successful compact, the scope does NOT
   become eligible again within `RAPID_REARM_WINDOW_MS` → reset
   `consecutiveRapidRearms = 0`.

This guarantees a persistent offender actually climbs 1→2→3 to the 60-min cap. An
implementation that reset the count when the tier-1 cooldown expired would loop
forever at tier 1 and never escalate — explicitly forbidden, and asserted by the
escalation regression test (Testing §2).

### Escalating backoff tiers

`consecutiveRapidRearms` → cooldown applied before the next compact may start:

| consecutiveRapidRearms | cooldown |
|------------------------|----------|
| 0 (normal) | `AUTO_COMPACT_SUCCESS_COOLDOWN_MS` (baseline, e.g. 5 min) |
| 1 | 15 min |
| 2 | 30 min |
| ≥3 | 60 min (cap) |

Auto-compact is **never fully disabled** — even a persistent offender retries
hourly. The existing prompt-too-long kill+respawn path remains the ultimate
recovery if a scope's floor truly exceeds the context window. Exact constants are
implementation parameters (tunable, table-driven), surfaced in the runbook.

### Secondary signal — next-turn input delta (telemetry + in-window escalation)

Record the input-token delta of the **first real user turn after a compact**.

**Definition of "first real user turn" (must exclude the compact result).** This
is the first **non-silent, non-system** turn result for the scope *after* a
successful `compact_boundary` — explicitly NOT the `/compact` result's own
`inputTokens`. The `/compact` operation itself produces a result whose input is
the full pre-compact context; counting that would always trip the
over-threshold check and make the signal useless. Concretely, skip any result
where `wasSilentCompact` is true or the scope's pending-system-result count
absorbed it (the same `hadCompactBoundary` / system-turn accounting used at
`runtime.ts:4318`); the first turn that consumes a real user seq is the one to
measure.

If that single qualifying turn's own input exceeds `autoCompactInputTokens`, the
scope's steady-state floor is already above the threshold — compaction
structurally cannot help. Log it (`nextTurnInputOverThreshold`). If that turn
also arrives inside `RAPID_REARM_WINDOW_MS`, route it through the same
rapid-rearm helper used by the primary signal and mark the last successful
compact as already counted. This avoids double-counting when
`maybeStartAutoCompact` runs later in the same result handler. If the first
large turn arrives after the rapid-rearm window, keep the telemetry but do not
escalate; delayed eligibility is not the latency spiral this guard is bounding.

### Health telemetry

Surface per-runtime counters in the health snapshot (alongside the existing
`pollPersistenceErrors` at `runtime.ts:4425/4440`):
- `autoCompactIneffective` — total ineffective (rapid re-arm) detections.
- `autoCompactConsecutiveRapidRearmsMax` — high-water mark across scopes.
- `autoCompactNextTurnOverThreshold` — count of next-turn-over-threshold events.

These make "is the spiral bounded?" answerable from `/health` without log diving.

## Components touched

| File | Change |
|------|--------|
| `src/runtimes/agent/runtime.ts` | New per-scope state maps (`lastCompactCompletedAt`, `consecutiveRapidRearms`, rapid-rearm dedupe marker); success-path cooldown at both `hadCompactBoundary` branches (per-chat ~`:4324`, single/global ~`:5916`); rapid-re-arm detection before the active-cooldown return in `maybeStartAutoCompact` (~`:1342`); next-turn-delta capture in both real-turn result paths; new health counters in both snapshot branches. |
| `src/runtimes/agent/runtime.ts` constants | `AUTO_COMPACT_SUCCESS_COOLDOWN_MS`, `RAPID_REARM_WINDOW_MS`, tier table (near the existing `AUTO_COMPACT_TIMEOUT_BACKOFF_MS` at `:136`). |
| `tests/runtimes/agent/runtime.test.ts` | Regression tests (below). |
| `tests/runtimes/agent/health-snapshot.test.ts` | New counters in the strict-shape assertions. |
| `docs/runbook.md` (auto-compact is documented there + `docs/configuration.md`) | Document the backoff tiers, counters, and the "floor above threshold" diagnosis. Co-update both if either describes the threshold/cooldown behavior. |

State is in-memory per `AgentRuntime` (like `autoCompactCooldownUntil` and
`pollPersistenceErrors` already are); it does not need to survive restart — a
respawn legitimately resets the backoff, and the bootstrap anti-storm path
(`runtime.ts:1328`) already handles re-entry.

## Invariants preserved

- **Failed compact must not reset baseline** (`runtime.ts:4318` comment): the
  success cooldown is set only in the `hadCompactBoundary` branch, never on a
  failed/silent-only turn.
- **Timeout backoff** (`:1356`) is unchanged; the new success cooldown is
  additive and uses the same `autoCompactCooldownUntil` map, so the two compose
  (whichever is later wins).
- **Anti-storm bootstrap** (`:1328`, `lastCompactInputTokens===0`) is untouched.
- **Shared-scope guard** (`sessionScope==='shared'` early return) unchanged.

## Testing (TDD)

Each test written to fail first, then pass:

1. **Spiral regression (the core fix):** simulate a scope that crosses threshold,
   compacts successfully, and immediately re-crosses. Assert the second compact
   does **not** start until the success cooldown elapses (fake timers). Cover
   both per-chat and single/global result branches; shared mode remains an
   auto-compact non-participant because `maybeStartAutoCompact` returns early.
   Reverting the cooldown must make this test fail (red-green).
2. **Escalation:** repeated rapid re-arms raise the cooldown tier (5→15→30→60),
   capped at 60. The test must prove tiers 1, 2, and 3; a test that only checks
   the first 15-minute tier is insufficient.
3. **Recovery:** after a prior rapid re-arm, a later successful compact followed
   by no eligibility inside the rapid-rearm window resets
   `consecutiveRapidRearms` to 0 and returns to baseline cooldown.
4. **Next-turn-over-threshold:** the compact result itself leaves the counter at
   0; the first real post-compact turn whose input exceeds the threshold
   increments it to 1, routes through the rapid-rearm helper, and does not
   double-count ordinary later results.
5. **Invariant guards:** failed/silent compact does NOT set the success cooldown
   or reset the baseline; timeout backoff still applies independently.
6. **Health shape:** new counters present and correctly typed in both per-chat
   and non-per-chat snapshot branches.
7. **State cleanup:** per-chat LID re-key preserves cooldown state; per-chat
   cleanup removes all new maps/sets; single/shared session resets clear global
   auto-compact state so a fresh session cannot inherit stale cooldown.
8. **Provider token shape:** `token_usage` events can satisfy next-turn
   measurement when a provider's final `result` event has no token counts, but
   pending system-turn token usage must not consume the first-real-user-turn
   latch.

Runtime behavior tests use the existing session-db mocks + vitest fake timers,
matching the surrounding compaction tests; DB mutation semantics stay covered by
the session-db tests. `typecheck:all` (tsconfig.test.json) must pass — test files
are type-checked there, not by bare `typecheck`.

## Rollout

- Land on a branch off `13d54a57`; CI on Node 24/25 is authoritative (local
  shell is v26, outside the engines range).
- After merge, **canary on one affected host first**, watch the new health
  counters + journal for bounded re-arm, then let it reach the rest of the
  fleet. (Per the `process.canary-before-fleet` fitness rule — the original
  auto-compact incident came from a no-canary fleet enable.)
- Verification = observe `autoCompactConsecutiveRapidRearmsMax` plateau and
  journal `auto compact triggered` frequency for the hot scope drop from
  per-minute to per-cooldown-tier.

## Out of scope (YAGNI)

- Dynamic/per-group thresholds (deferred; telemetry will say if needed).
- Persisting backoff state across restarts.
- SDK-reported post-compact context size (use if it appears; don't build on it).
- Refactoring the broader `AgentRuntime` sequencing (tracked separately as the
  god-class fitness finding).
