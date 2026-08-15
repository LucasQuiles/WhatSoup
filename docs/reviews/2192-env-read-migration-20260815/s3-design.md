# 2192 slice-3 design scout — the outbox/alert env family (BOT_ERRORS_*, EMIT_ALERT_*, WHATSOUP_ALERT_SINK)

**Survey tree:** `origin/main` = `22d0a95bb851db72786ac5783d436bf2febe89a3` (slice-2b landing commit, "config: absorb three boolean feature flags; keep the rollout dial env-late (#3238)"). Surveyed in a detached worktree at `/tmp/opencode/ws2192-s3` (HEAD == origin/main). **LOCAL-ONLY: no writes to the worktree, no pushes.**

**Scope (task #2192-s3):** map the outbox/alert env family across four files, evaluate three seams honestly, per-var recommend with confidence, list the toggling tests, and size one-PR cars.

## Ratchet context (read this first)

`tests/scripts/env-read-allowlist.test.ts` (#2192 slice 0) pins an exact per-file `process.env` count. The family lives in:

| File | Count | Ring | Allowlist annotation today |
|------|-------|------|----------------------------|
| `src/config.ts` | **34** | L4 composition | SSOT seam (instance-config → env → default) |
| `src/lib/bot-errors-outbox.ts` | **19** | L0 shared | "env-late by design: lib cannot import config, and config WRITES TMPDIR at load — the env var is the sanctioned lib-side channel" |
| `src/lib/emit-alert.ts` | **8** | L0 shared | "slice-3" |
| `src/lib/recovery-authority-store.ts` | **3** | L0 shared | "slice-3 typed outbox" |
| `src/runtimes/agent/tool-failure-alert.ts` | **1** | L3 runtime | "slice-3 outbox/alert field" |
| `src/core/outbound-message-safety.ts` | **2** | L1 domain | "BOT_ERRORS_JID safety config — slice-3 typed field" (co-reader, out of the 4-file scope) |

Two hard constraints govern every recommendation below:

1. **`src/lib` cannot import `src/config.ts`** (lib→lib only). So a "typed config field" can only reach lib via one of the three seams — it can never be a direct import.
2. **Ring-boundary ratchet** (`scripts/ring-boundary-guard.ts`, rule `eslint-rules/ring-boundaries.mjs`, baseline `arch.ring-boundaries` = 46 in `.claude/fitness/baseline.json`): no **new** config imports below L4. `runtimes`/`transport`/`mcp`/`core` may only touch config through **grandfathered importers** (already counted in the 46) or a param-DI seam.

The **TMPDIR precedent** is the in-repo proof of the sanctioned lib-side channel: `src/config.ts:526` writes `process.env.TMPDIR`, and `src/lib/bot-errors-outbox.ts:296` reads it back — that read is already allowed under the current annotation. Seam (b) below is "extend the TMPDIR pattern to the family."

---

## Verdict at a glance (ranked by confidence)

| Var | File(s) | Read-time | Seam | Confidence | Why |
|-----|---------|-----------|------|------------|-----|
| `BOT_ERRORS_JID` | emit-alert:91, outbound-message-safety:373 | call-time | **(b)** | HIGH | simple `?? null`, fixes cross-file coherence |
| `BOT_ERRORS_EXPECTED_JID` | emit-alert:92 | call-time | **(b)** | HIGH | simple, derived from JID |
| `BOT_ERRORS_REQUIRE_EXPECTED` | emit-alert:86 | call-time | **(b)** | HIGH | boolean default, no isolation chain |
| `BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS` | tool-failure-alert:66 | call-time | **(a) DI** | HIGH | single grandfathered caller + existing deps seam |
| `BOT_ERRORS_STATE_DIR` | outbox:288,350,548; recovery:32 | call-time | **(c)** | HIGH | vitest-isolation + provenance-policy entanglement (see §4) |
| `BOT_ERRORS_OUTBOX_DIR` | outbox:302,349,547 | call-time | **(c)** | HIGH | `outboxPolicy()` branch flips on absence |
| `INVOCATION_ID` / `SYSTEMD_EXEC_PID` | outbox:524,525 | call-time | **(c)** | HIGH | systemd per-invocation identity |
| `XDG_DATA_HOME` | recovery:34 | call-time | **(c)** | HIGH | OS ambient |
| `BOT_ERRORS_ALLOW_LIVE_IN_TESTS` | outbox:279 | call-time | **(c)** | HIGH | test escape hatch, inverts isolation |
| `BOT_ERRORS_TEST_ISOLATED` | outbox:549 | call-time | **(c)** | HIGH | test-harness marker |
| `WHATSOUP_ALERT_SINK` | emit-alert:178,183 | call + **module-eval** | **(c)** | HIGH | verifier dial (#2510), runtime-injectable |
| `VITEST`/`VITEST_POOL_ID`/`VITEST_WORKER_ID`/`NODE_ENV` | outbox:273-275,283,325,334; emit-alert:183 | call-time | **(c)** | HIGH | test-runner detection (non-family) |
| `TMPDIR` | outbox:296 | call-time | **(c)** [already] | HIGH | already config-published (config.ts:526) |
| `EMIT_ALERT_THROTTLE_MS` | emit-alert:40 (module-eval), 269, 292 | **module-eval + call** | **(b)** | MED-HIGH | needs IIFE→call-time refactor |
| `BOT_ERRORS_SAFE_SHAPE_CRED_PATH` | outbox:201 | call-time | **(b)** | MED-HIGH | boolean rollout flag, mid-run toggled in tests |
| `BOT_ERRORS_WRITEFAIL_DIR` | outbox:293 | call-time | **(c)** | MED | explicit-override only, low value, no policy branch |
| `WHATSOUP_INSTANCE` | recovery:35 | call-time | **(c)** | MED-HIGH | deploy-injected, never set in src |

---

## 1. Full site map

### 1a. `src/lib/bot-errors-outbox.ts` (19 process.env lines)

| Line | Var | Read-time | Family | Disposition |
|------|-----|-----------|--------|-------------|
| 201 | `BOT_ERRORS_SAFE_SHAPE_CRED_PATH` | call-time (redaction) | yes | **(b)** |
| 273/274/275 | `VITEST`, `VITEST_POOL_ID`, `VITEST_WORKER_ID` | call-time (`runningUnderVitest`) | no | (c) |
| 279 | `BOT_ERRORS_ALLOW_LIVE_IN_TESTS` | call-time (`vitestStateDir`) | yes | (c) |
| 283 | `VITEST_POOL_ID`/`VITEST_WORKER_ID` | call-time (`safeSegment`) | no | (c) |
| 288 | `BOT_ERRORS_STATE_DIR` | call-time (`stateDir`) | yes | (c) |
| 293 | `BOT_ERRORS_WRITEFAIL_DIR` | call-time (`writefailDirs`) | yes | (c) |
| 296 | `TMPDIR` | call-time (`writefailDirs`) | no | (c) already |
| 302 | `BOT_ERRORS_OUTBOX_DIR` | call-time (`botErrorsOutboxDir`) | yes | (c) |
| 325 | `process.env[key]` strong-signal scan | call-time | no | (c) |
| 334 | `NODE_ENV` | call-time (`provenanceSignals`) | no | (c) |
| 349/350 | `BOT_ERRORS_OUTBOX_DIR`/`STATE_DIR` | call-time (`outboxPolicy`) | yes | (c) |
| 524/525 | `INVOCATION_ID`, `SYSTEMD_EXEC_PID` | call-time (event build) | yes-ish | (c) |
| 547/548/549 | `BOT_ERRORS_OUTBOX_DIR`/`STATE_DIR`/`TEST_ISOLATED` | call-time (fail-closed write guard) | yes | (c) |

### 1b. `src/lib/emit-alert.ts` (8 lines)

| Line | Var | Read-time | Family | Disposition |
|------|-----|-----------|--------|-------------|
| 40 | `EMIT_ALERT_THROTTLE_MS` | **module-eval IIFE** | yes | **(b)** + refactor |
| 86 | `BOT_ERRORS_REQUIRE_EXPECTED` | call-time | yes | **(b)** |
| 91 | `BOT_ERRORS_JID` | call-time | yes | **(b)** |
| 92 | `BOT_ERRORS_EXPECTED_JID` | call-time | yes | **(b)** |
| 178 | `WHATSOUP_ALERT_SINK` | call-time (`alertSinkPath`) | yes | (c) |
| 183 | `WHATSOUP_ALERT_SINK` + `VITEST` | **module-eval warn guard** | yes | (c) |
| 269/292 | `EMIT_ALERT_THROTTLE_MS` | call-time (throttle prune/record) | yes | **(b)** |

### 1c. `src/lib/recovery-authority-store.ts` (3 lines)

| Line | Var | Read-time | Family | Disposition |
|------|-----|-----------|--------|-------------|
| 32 | `BOT_ERRORS_STATE_DIR` | call-time (`state_root`) | yes | (c) |
| 34 | `XDG_DATA_HOME` | call-time | no | (c) |
| 35 | `WHATSOUP_INSTANCE` | call-time | yes | (c) |

### 1d. `src/runtimes/agent/tool-failure-alert.ts` (1 line)

| Line | Var | Read-time | Family | Disposition |
|------|-----|-----------|--------|-------------|
| 66 | `BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS` | call-time | yes | **(a) DI** |

### 1e. Cross-file coherence (same var, two readers)

- `BOT_ERRORS_JID` → `emit-alert.ts:91` (lib) **and** `outbound-message-safety.ts:373` (core). Both resolve `process.env.BOT_ERRORS_JID ?? null`. They are already coherent *by construction* (same env var), but neither can import config, so any typed migration must keep them on a shared channel → seam (b).
- `BOT_ERRORS_STATE_DIR` → `bot-errors-outbox.ts:288,350,548` **and** `recovery-authority-store.ts:32`. Same override, **different fallbacks**: outbox defaults to `~/.local/state/bot-errors`; recovery store defaults to `~/.local/share/whatsapp/…/instances/<instance>` (via XDG + WHATSOUP_INSTANCE). Already inconsistent as a fallback; see §4.

---

## 2. Caller spread (drives seam (a) feasibility)

- **emit-alert** (`emitAlert` / `emitAlertChecked` / `clearAlertSource`): **~33 files** across *every* ring — lib, core, transport, mcp, runtimes, fleet, main.
- **bot-errors-outbox** (`writeBotErrorsEvent` etc.): 8 non-test files, including `emit-alert.ts` itself.
- **recovery-authority-store** (`loadRecoveryMarkers`/`setRecoveryMarker`/`clearRecoveryMarker`): 9 non-test files including `src/lib/model-advisor.ts` — a **lib module that cannot import config**.
- **tool-failure-alert** (`maybeEmitToolFailureAlert`): **1 caller** — `src/runtimes/agent/runtime.ts`, which is a **grandfathered config importer** (`import { config } from '../../config.ts'` at runtime.ts:251) and already has the `deps` DI seam.

---

## 3. The three seams, evaluated honestly

### (a) Typed `outboxConfig` DI threaded from entry points — **REJECT for lib, ACCEPT for one site**

- **tool-failure-alert.ts: ACCEPT.** Single caller (`runtime.ts`), existing `ToolFailureAlertDeps` seam, grandfathered config importer. Thread `config.toolFailureAlertsEnabled: boolean` through `maybeEmitToolFailureAlert`. This is the *exact* "param-DI from a grandfathered importer" pattern the slice-2b handoff redesign established (`handoff-distill-config.ts` pure resolver + `handoff-distill-coordinator.ts` call-boundary pass).
- **bot-errors-outbox / emit-alert / recovery-authority-store: REJECT.** Caller sprawl (8/33/9) means either a module-level `init()` (an implicit global — worse than the env var it replaces) or threading a params object through dozens of signatures. And it would **break ~9 mid-run-toggle test files** (see §6) — the exact ONE_MESSAGE_HANDOFF test-adaptation problem, at 10× scale. No semantic gain over (b).

### (b) config-publishes-env-vars bridge — **CORRECT for the simple scalars, UNSOUND for the DIR vars**

Config resolves the field (instance-config → env → default) and **writes it back to `process.env` at load**, exactly like `TMPDIR` (config.ts:526) and `LOG_DIR` (config.ts:518). Lib reads stay unchanged, annotated "config-published."

- **Sound for:** `BOT_ERRORS_JID`, `BOT_ERRORS_EXPECTED_JID`, `BOT_ERRORS_REQUIRE_EXPECTED`, `EMIT_ALERT_THROTTLE_MS` (after the module-eval refactor), `BOT_ERRORS_SAFE_SHAPE_CRED_PATH`. These are plain scalars: `env ?? default` with **no isolation tier and no policy branch on the absence of the var**.
- **UNSOUND for `BOT_ERRORS_STATE_DIR` / `BOT_ERRORS_OUTBOX_DIR`.** Their correctness depends on the var being *absent* when the operator didn't set it (see §4). Unconditionally publishing them would flip `outboxPolicy()` to `explicit-state`/`explicit-outbox` permanently and bypass the vitest isolation tier. This is a fail-closed regression, not a style issue.
- **Module-eval caveat (emit-alert.ts:40, 183).** The IIFE and the warn guard read env at module-eval. If config evals after emit-alert in *any* entry graph, they miss config's write. Mitigation: refactor the `EMIT_ALERT_THROTTLE_MS` IIFE into a call-time getter (the const is only a fallback in two places) and demote the :183 warn guard to lazy. Small, behavior-preserving.

### (c) keep env-late with per-var reasons — **CORRECT for identity / test / DIR / verifier-dial vars**

This is not "do nothing" — each survivor gets an explicit reason and an allowlist annotation upgrade. The DIR vars belong here (not (b)) for the isolation reason below.

---

## 4. The finding that re-ranks the DIR vars: isolation + provenance-policy entanglement

`src/lib/bot-errors-outbox.ts` routes the outbox dir through a three-tier chain whose *absence semantics* are load-bearing:

```ts
function stateDir(): string {
  return process.env['BOT_ERRORS_STATE_DIR'] ?? vitestStateDir() ?? join(homedir(), '.local', 'state', 'bot-errors');
}
function outboxPolicy(): 'explicit-outbox' | 'explicit-state' | 'test-default' | 'default' {
  if (process.env['BOT_ERRORS_OUTBOX_DIR'] !== undefined) return 'explicit-outbox';
  if (process.env['BOT_ERRORS_STATE_DIR'] !== undefined) return 'explicit-state';
  if (vitestStateDir() !== null) return 'test-default';
  return 'default';
}
```

`vitestStateDir()` isolates test traffic into `$TMPDIR/whatsoup-vitest-bot-errors/<worker>/<pid>/state` (unless `ALLOW_LIVE_IN_TESTS=1`), and `outboxPolicy()` feeds the **test-provenance stamp** that the Python dispatcher's `is_test_provenance_event` backstop screens on. If config *unconditionally* published `BOT_ERRORS_STATE_DIR`/`BOT_ERRORS_OUTBOX_DIR`:

1. `stateDir()` would always return config's value → vitest isolation never triggers → test bot-errors write to the **live homedir** in any test process that imports config (the #2658/#2887 CI-drift the fail-closed guard at outbox:547-557 exists to prevent).
2. `outboxPolicy()` would always return `explicit-state`/`explicit-outbox` → events lose the `test-default` provenance → the dispatcher stops routing test traffic as test traffic.

**Conclusion:** the DIR vars' "explicit override → vitest isolate → homedir default" resolution is genuinely lib-level logic (test-runner detection belongs in lib, same class as the VITEST reads already at (c)). Moving it into config would require config to replicate `runningUnderVitest`/`safeSegment` — bad layering — or publish conditionally, which defeats the point. **Keep the DIR vars env-late.** The deploy layer (systemd `Environment=`, launchd plists, Python installers) is already their cross-process SSOT; config.ts would be a *third* source that must agree with it.

---

## 5. Per-var migration recipes

### 5a. Seam (b) — simple scalars → typed config + env publish

`src/config.ts` gains a `botErrors` group (config count 34 → ~44, +2 per var: one read line + one write line):

```ts
// under Paths / near botName — instance-config → env → default, then published
botErrorsJid: optionalString(instance?.botErrorsJid, 'botErrorsJid') ?? process.env.BOT_ERRORS_JID ?? null,
botErrorsExpectedJid: optionalString(instance?.botErrorsExpectedJid, 'botErrorsExpectedJid')
  ?? process.env.BOT_ERRORS_EXPECTED_JID ?? /* resolve-from-jid at read */ null,
botErrorsRequireExpected: optionalBoolean(instance?.botErrorsRequireExpected, 'botErrorsRequireExpected')
  ?? process.env.BOT_ERRORS_REQUIRE_EXPECTED === '1',
emitAlertThrottleMs: optionalFiniteNumber(instance?.emitAlertThrottleMs, 'emitAlertThrottleMs')
  ?? positiveIntEnv('EMIT_ALERT_THROTTLE_MS', 300_000),
botErrorsSafeShapeCredPath: optionalBoolean(instance?.botErrorsSafeShapeCredPath, 'botErrorsSafeShapeCredPath')
  ?? process.env.BOT_ERRORS_SAFE_SHAPE_CRED_PATH === '1',
// publish (TMPDIR precedent — place beside the LOG_DIR/TMPDIR writes at config.ts:518-526)
process.env.BOT_ERRORS_JID = config.botErrorsJid ?? undefined;   // write only when non-null? see note
process.env.BOT_ERRORS_REQUIRE_EXPECTED = config.botErrorsRequireExpected ? '1' : '0';
process.env.EMIT_ALERT_THROTTLE_MS = String(config.emitAlertThrottleMs);
```

**Coherence note (JID).** Because `BOT_ERRORS_JID` must read identically in `emit-alert.ts:91` and `outbound-message-safety.ts:373`, the publish *must* be unconditional-or-null-consistent, and `BOT_ERRORS_EXPECTED_JID` must stay consistent with the resolved JID (today it defaults to the JID value — keep that derivation either in config or at read, not split).

**Throttle refactor (emit-alert.ts:40).** Replace the module-eval IIFE const with a call-time getter so the two call-time re-reads (269, 292) and the getter all agree, and the module-eval order no longer matters.

### 5b. Seam (a) DI — tool-failure-alert

`src/runtimes/agent/tool-failure-alert.ts:66` → add `toolFailureAlertsEnabled: boolean` to `ToolFailureAlertDeps`; `runtime.ts` passes `config.toolFailureAlertsEnabled`. Allowlist: `tool-failure-alert.ts` 1 → **0**.

### 5c. Seam (c) — annotate the survivors

Per-var reasons to land in the allowlist comment (and a one-line code comment at each site):

- `BOT_ERRORS_STATE_DIR` / `OUTBOX_DIR`: "explicit-override → vitest-isolate → homedir-default resolution is lib-level (test-runner detection); deploy layer is the cross-process SSOT; unconditional publish would break isolation + provenance-policy."
- `BOT_ERRORS_WRITEFAIL_DIR`: "explicit-override-only fallback candidate; no config value to add (default derives from stateDir)."
- `WHATSOUP_INSTANCE`: "deploy-injected instance identity (systemd/launchd); never set inside src; child-env forwards it."
- `INVOCATION_ID` / `SYSTEMD_EXEC_PID`: "systemd per-invocation identity — cannot be resolved at config load."
- `WHATSOUP_ALERT_SINK`: "verifier dial (#2510) — injected out-of-band at runtime to observe alert flow; must remain runtime-toggleable."
- `ALLOW_LIVE_IN_TESTS` / `TEST_ISOLATED`: "test escape hatches — deliberately test-only routing semantics."
- `XDG_DATA_HOME`, `VITEST*`, `NODE_ENV`, `TMPDIR`: ambient / test-detection (TMPDIR already config-published).

---

## 6. Toggling tests + adaptation cost per seam

Tests that set/delete family vars mid-run (all via `vi.stubEnv` / direct `process.env` mutation, restored in `afterEach`):

| Test file | Vars toggled |
|-----------|--------------|
| `tests/lib/bot-errors-outbox.test.ts` | STATE_DIR, OUTBOX_DIR, WRITEFAIL_DIR, ALLOW_LIVE_IN_TESTS, INVOCATION_ID, SYSTEMD_EXEC_PID, TMPDIR |
| `tests/lib/bot-errors-outbox-private-write.test.ts` | OUTBOX_DIR, WRITEFAIL_DIR, STATE_DIR, INVOCATION_ID, SYSTEMD_EXEC_PID, ALLOW_LIVE_IN_TESTS, XDG_CONFIG_HOME |
| `tests/lib/bot-errors-outbox-safe-shape.test.ts` | SAFE_SHAPE_CRED_PATH |
| `tests/lib/bot-errors-producer-provenance.test.ts` | ALLOW_LIVE_IN_TESTS, OUTBOX_DIR, STATE_DIR, NODE_ENV |
| `tests/lib/bot-errors-test-isolation.test.ts` | STATE_DIR, OUTBOX_DIR, WRITEFAIL_DIR, JID, EXPECTED_JID, TEST_ISOLATED |
| `tests/lib/emit-alert.test.ts` | OUTBOX_DIR, WRITEFAIL_DIR, STATE_DIR, ALERT_SINK, REQUIRE_EXPECTED, THROTTLE_MS, JID, EXPECTED_JID |
| `tests/lib/emit-alert-exit.test.ts` | OUTBOX_DIR, JID, EXPECTED_JID, REQUIRE_EXPECTED |
| `tests/lib/recovery-authority-store.test.ts` | STATE_DIR |
| `tests/runtimes/agent/tool-failure-alert.test.ts` | RUNTIME_TOOL_FAILURE_ALERTS |
| `tests/setup/bot-errors-vitest-isolation.ts` | (sets `BOT_ERRORS_TEST_ISOLATED`) |

**Adaptation cost:**
- **Seam (b) → ~ZERO.** These lib unit tests import `bot-errors-outbox.ts`/`emit-alert.ts` **directly**, so config is not in their graph; config's publish never fires, and the call-time env reads behave exactly as before. The one risk to verify in Car 2: an integration test that imports config **and** exercises the outbox write path (config's publish would pre-set the var). Grep-then-run the affected tests before merging.
- **Seam (a) full-form → ~9 files rewritten** (the ONE_MESSAGE_HANDOFF pattern), plus any caller-threading. This is the cost that rules out (a) for the lib modules.
- **Seam (c) → ZERO** (no code behavior change).

---

## 7. Slice plan (one-PR cars, easiest → hardest)

**Car 1 — seam (b), JID group + REQUIRE_EXPECTED.** `BOT_ERRORS_JID` (+ cross-file coherence with outbound-message-safety), `BOT_ERRORS_EXPECTED_JID`, `BOT_ERRORS_REQUIRE_EXPECTED`. config +~6 (read+write ×3); `emit-alert.ts` and `outbound-message-safety.ts` counts unchanged, annotations upgraded to "config-published." **HIGH confidence, no isolation risk.**

**Car 2 — seam (b), throttle + safe-shape.** `EMIT_ALERT_THROTTLE_MS` (with the IIFE→call-time refactor) + `BOT_ERRORS_SAFE_SHAPE_CRED_PATH`. config +~4. Verify the config-importing integration-test interaction explicitly. **MED-HIGH confidence.**

**Car 3 — seam (a) DI, tool-failure-alert.** Thread `config.toolFailureAlertsEnabled` through `runtime.ts`'s deps. Allowlist `tool-failure-alert.ts` 1 → 0. **HIGH confidence, trivial.**

**Car 4 — annotation-only (seam c).** Upgraded allowlist comments + per-site code comments for the DIR/identity/test/verifier survivors, with the §4 reasoning written down so the "why" is not re-litigated. No config change, no behavior change.

**Explicitly deferred (needs product/operator input, not this scout):**
- Whether the DIR vars should ever gain a *narrow* "publish explicit instance-JSON override only" config field (adds per-instance outbox dir without touching isolation). Low value today; the deploy layer already owns this.
- Whether `BOT_ERRORS_STATE_DIR`'s inconsistent fallback across outbox vs recovery-store (homedir `.local/state/bot-errors` vs XDG `.local/share/…/instances/<instance>`) is a latent bug to fix — flagged, out of slice scope.

---

## 8. Allowlist delta (net effect of the full slice)

| File | Before | After | Notes |
|------|--------|-------|-------|
| `src/config.ts` | 34 | ~44 | +read/write per migrated scalar |
| `src/runtimes/agent/tool-failure-alert.ts` | 1 | **0** | DI migration |
| `src/lib/bot-errors-outbox.ts` | 19 | 19 | annotation upgraded (config-published / env-late reasons) |
| `src/lib/emit-alert.ts` | 8 | 8 | annotation upgraded |
| `src/lib/recovery-authority-store.ts` | 3 | 3 | annotation upgraded |
| `src/core/outbound-message-safety.ts` | 2 | 2 | annotation upgraded (config-published) |

**Honest framing:** seam (b) does **not** shrink the total `process.env` surface — it *routes resolution through config* while keeping lib on the sanctioned env channel (TMPDIR pattern), enabling instance-JSON override and cross-file coherence. The only count reduction is tool-failure-alert via DI.

---

## 9. Risks / open questions

1. **Throttle module-eval refactor (Car 2)** changes `EMIT_ALERT_THROTTLE_MS` from "frozen at import" to "call-time getter." Behavior-preserving for single-process; flag if any test asserts the freeze.
2. **`BOT_ERRORS_EXPECTED_JID` default derives from `BOT_ERRORS_JID`** — the derivation must not split between config and lib (pick one owner).
3. **Integration tests importing config + outbox** (Car 2) — verify config's publish doesn't pre-set a var the test expects unset. Grep `config` imports in `tests/` that also touch `bot-errors-outbox`/`emit-alert`.
4. **The `BOT_ERRORS_STATE_DIR` fallback inconsistency** (§7 deferred) is the one latent-correctness issue found; recommend a follow-up ticket rather than folding into this slice.
