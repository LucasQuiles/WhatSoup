# Fleet Runtime Sentinel — Operational Hardening Backlog

**Status:** living backlog. **Audit anchor:** merged sentinel at `f6dc5771` (3 read-only audits,
2026-06-15: observability, resilience/durability, taxonomy/recovery). **Re-verify each item against
current `origin/main` before fixing** — an active hardening stream has advanced main past the audit
anchor and may have already closed some items.

This is the refocused **O4 — Sentinel operational hardening** objective (runs alongside the gated O3
canary; the P0 cluster should land before live fan-out). Scope: `deploy/scripts/bot-errors-sentinel.py`,
`bot-errors-selfcheck.py`, `lib/sentinel_pin.py`, `bot-errors-heartbeat-watchdog.py`,
`whatsoup-bot-errors-deploy.sh`, installers.

---

## P0 — must-fix before live canary (safety: heal-storm / state-loss / fail-open)

> **✅ RECONCILED 2026-07-20 (main `61f388c61`): the entire P0 cluster is resolved on
> main — code-complete AND tested. Verified item-by-item against current source (the
> "re-verify before fixing" note above); 183 tests green
> (`test_bot_errors_sentinel.py` 83 + `test_bot_errors_selfcheck.py` 100). This section's
> table below is retained for historical context; each row's status is now:**
>
> | P0 | Status | Implementing evidence (code + test) |
> |---|---|---|
> | P0-1 | ✅ done | `run_once` persists `save_state` in a `finally` (`bot-errors-sentinel.py:1653-1655`) + `cycleSeq` generation counter (`:1631`) → `test_save_state_runs_even_if_central_heartbeat_write_raises` |
> | P0-2 | ✅ done | `acquire_instance_lock` non-blocking `fcntl.flock` (`:1695`), taken in `main` (`:1754`), exits 0 if already running |
> | P0-3 | ✅ done | `acquire_lock`/`release_lock` switched to `fcntl.flock` (auto-releases on process death — supersedes the PID-reclaim proposal, no stale lock possible) (`bot-errors-selfcheck.py:435-458`) → `test_deployer_failure_is_reported_and_lock_is_released` |
> | P0-4 | ✅ done | (already marked) single-use token redeem via `run_redeem` (`:1712`) → `test_redeemed_token_replay_is_rejected` |
> | P0-5 | ✅ done | `>= config.correlated_drift_freeze_threshold` (`:957`) → `test_p05_correlated_drift_freeze_fires_at_threshold` + `test_p05_below_threshold_does_not_freeze` |
> | P0-6 | ✅ done | `mass_unreachable_confirmed` defers `tier1_heal_candidate → defer_mass_unreachable` (`:1610-1613`) → `test_p06_mass_unreachable_suppresses_tier1_heal_candidate` |
> | P0-7 | ✅ done | pin re-read with `current_changed` abort (`bot-errors-selfcheck.py:901-912`) |
> | P0-8 | ✅ done | lever `stat_error` surfaced as distinct fail-CLOSED class (`bot-errors-selfcheck.py:783-789`) → `test_lever_stat_error_on_disabled_path_escalates_not_silent` + fail-closed bundle/root stat_error |
> | P0-9 | ✅ done | `default_pull_probe` rejects stale probes by `st_mtime` (`:679`) → `test_probe_path_stale_mtime_rejected` + `test_probe_path_fresh_mtime_accepted` |
>
> **Consequence:** the P0 *code* gate for live O3 fan-out is satisfied. The fan-out /
> canary GO decision remains the owner's (this reconciliation only records that the
> safety code exists and is tested; it does not authorize deployment). The remaining
> `#1876` gap is the **live deployment** of the sentinel (owner / live-fleet-gated) plus
> the P1 observability items still open below.

| # | Risk | Where | Fix |
|---|---|---|---|
| P0-1 | **`save_state` not in `try/finally`** → a crash after pop/emit but before save loses cooldown keys, resets hysteresis/flap counters, and drops the `qRemediation` pop → duplicate escalations + heal storm. Single highest-leverage fix (closes ~3 HIGH). | `bot-errors-sentinel.py:run_once ~1391` | Wrap the per-cycle body so `save_state` runs in `finally`. Add a `cycle_id`/generation so workers can detect stale events. |
| P0-2 | **No instance-level concurrency lock.** Plist has `KeepAlive` + `StartInterval=1800`; a >1800s cycle that exits non-zero starts a second copy → two writers to state, duplicate action events, doubled WhatsApp cap. | `install-bot-errors-sentinel.sh:157`; `run_once` entry | PID/`fcntl` advisory lock at `run_once` start; exit 0 if already running. Or drop `KeepAlive`, rely on interval + watchdog. |
| P0-3 | **Stale `selfcheck.lock` freezes heals forever** (no PID, not advisory) — a SIGKILL'd selfcheck leaves the lock; every later run returns `lock_busy`, no alert, no auto-recovery. | `bot-errors-selfcheck.py:434–439` | Write PID; on `FileExistsError` check `kill(pid,0)`, reclaim if dead; enforce max lock age (≥3× heal timeout). |
| P0-4 | ✅ **Q token single-use ENFORCED** (was: NOT enforced — `redeemedAt` read but never written → replay within TTL). The Q worker now redeems via `bot-errors-sentinel.py --redeem-token <token> --redeem-request-id <id>`, which under the instance lock constant-time-matches the raw token against the bound `tokenHash` and stamps `redeemedAt`. Both consumption sites (`active_q_remediation`, `expired_q_remediation`) already honor `q_remediation_redeemed`, so a redeemed token is rejected for the remainder of its TTL. Fail-closed: missing/corrupt/expired/mismatched/already-redeemed → deny, no state mutation. | `bot-errors-sentinel.py:redeem_q_remediation`, `run_redeem`, `parse_args`, `main` | DONE — `--redeem-token`/`--redeem-request-id` CLI redeem-writer + auth check; tests in `test_bot_errors_sentinel.py` (`test_redeemed_token_replay_is_rejected` et al). |
| P0-5 | **Correlated-drift freeze uses `>` not `>=`** → on a 2-host fleet two drifted hosts heal concurrently, bypassing the freeze. | `bot-errors-sentinel.py:apply_tier1_bounds ~799` | Use `>=` against the threshold; add a 2-host test. |
| P0-6 | **`mass_unreachable_confirmed` does not apply tier-1 bounds** → heals can fire on multiple hosts during a mass outage (worst time to push). | `bot-errors-sentinel.py:1367–1378` | Suppress `tier1_heal_candidate` → `defer_mass_unreachable` when the fleet action is mass-unreachable. |
| P0-7 | **Pin-update race during in-flight heal** — pin loaded at top of cycle, used unchanged through `deploy()`; a concurrent re-pin deploys the old bundle (deploy-side verify uses a static SHA list, not the pin). | `bot-errors-selfcheck.py:772–884`; `whatsoup-bot-errors-deploy.sh:22–31` | Re-read + re-verify the pin **inside the lock** before `deploy()`; abort with `current_changed` if `head_sha` changed. |
| P0-8 | **Lever `stat_error` fail-open paths.** selfcheck `lever_engaged` returns engaged on `OSError` (disables heals silently); but the deploy `sha()`/empty-output path classifies an unhashable file as `DRIFT` (fail-open → spurious heal). Make ambiguity **fail-closed + alerted**, and separate "can't hash" from "mismatch". | `bot-errors-selfcheck.py:152`; `whatsoup-bot-errors-deploy.sh:34,56` | Surface `stat_error` in `status.levers`; emit a distinct `SHA_FAILED`/`ERROR` class, never silent DRIFT. |
| P0-9 | **Probe staleness blind spot** — `default_pull_probe` reads the probe file with **no mtime check**; a 12h-old `healthy:true` probe passes as current, defeating the two-signal requirement. | `bot-errors-sentinel.py:default_pull_probe ~531` | Reject probe files older than `heartbeat_max_age_seconds`; classify as `probe_stale`. |

---

## P1 — observability (the sentinel/selfcheck are the only components with no telemetry)

- **JSONL cycle log** on both sentinel + selfcheck (match the repo's `append_private_jsonl` `{time,component,level,...}` convention): emit per-cycle host class/action transitions, SSH probe outcomes, heal results, fleet action.
- **Countable metrics** (in state + log): heals attempted/succeeded/failed/preflight-failed per host; escalations per tier; flap events; quorum-suppressions; `q_unavailable` total; probe exceptions; heartbeat staleness; fleet coverage (`healthy/stalled/unreachable/tier1Candidate` counts). — *PARTIAL: a per-cycle `metrics` block is now in the central heartbeat (`compute_cycle_metrics`): `healCandidates`, `escalations`, `flapEscalations`, `correlatedDriftFreezes`, `concurrencyDeferrals`, `massUnreachableDeferrals`, `connectivitySuppressions`, `qUnavailable`, `actionEventsEmitted`, `attentionEventsEmitted`, plus a full `byAction` distribution. The sentinel is evaluation-only, so heal EXECUTION success/failure stays selfcheck-side; still open here: per-host breakdown, probe-exception + heartbeat-staleness counts, and the SSH probe-latency / `component`+`level` log-hygiene items below.*
- **SSH probe latency** unrecorded → wrap `ssh_runtime_probe` with `monotonic()`, add `probeLatencySeconds` to signals.
- **Log field hygiene:** add `component` + `level` to every record; ack file missing `requestId` (breaks end-to-end action→ack tracing).
- **`fleet_sentinel` absent from watchdog `DEFAULT_CHECKS`**; no **`selfcheck_heartbeat` watchdog** (a dead selfcheck goes unnoticed up to `heartbeat_max_age` ~45m).
- **Crashed selfcheck doesn't update `heartbeat_path`** → central misclassifies a crash as stale heartbeat, losing the `selfcheck_error` class.

---

## P1 — error taxonomy + edge cases

**Missing failure classes** (each: name → trigger → tier):
- `process_stalled` — bot up + runtime healthy but not processing (queue growing) → tier2.
- `selfcheck_absent` — selfcheck/watchdog stopped while host reachable → tier2 after 1 cycle.
- `heal_verify_failed` — deployer exit 0 but next cycle still drifts (silent-success-without-fix) → tier2.
- `root_mismatch` — probe points at the wrong repo root (vs "file missing") → tier2.
- `clock_correction_transient` — NTP step → suppress 1 cycle before `clock_skew` escalates (clock_skew currently bypasses hysteresis).
- `probe_contradiction` / `invalid_probe_output` — `healthy` vs `class` mismatch / empty-dict probe.

**Edge cases (mostly untested):** default `hysteresis_cycles=2` escalation path untested (off-by-one risk); `classify_runtime_mismatches([])` returns `"drift"` (heals nothing → spurious heal); single-host fleet gets **no** fleet-level protection (`mass_out_of_rotation`/`suspect` require ≥2); beacon exactly-at-staleness boundary; simultaneous drift+unreachable; `flap_window_seconds=0`/`max_clock_skew=1` floors disable/over-trigger detection; **future timestamp in heal history blocks heals indefinitely** (no pruning); **roster removal mid-incident silently drops open alerts + orphans tier2 remediations** (emit a one-shot event before pruning).

---

## P2 — recovery / operator tooling (currently a total gap — every recovery is manual JSON-joining)

Add a `bot-errors-sentinel`/`selfcheck` operator surface:
- **`status`** — read-only state readout (today *every* run mutates state + probes).
- **`diagnose --host X`** — why X is in its class (joins heartbeat/probe/state).
- **`heal --host X --force`**, **`clear-flaps --host X`**, **`maintenance on/off --host X`** (per-host, vs fleet-wide `AUTOHEAL_OFF`), **`repin --sha …`**, **`rollback --host X`** (to last-known-good; LKG tracked but **never auto-triggered** + no CLI), **`autoheal on/off`**, **`ack --host X --request-id R`**, **`replay`/`--dry-run`** (feed saved snapshots through the classifier).
- Surface **deferred hosts** (`defer_tier1_concurrency_cap` emits no action event today) and **outbox backlog depth**.

---

## P2 — resilience / durability

- **Atomic write ordering:** write `status.json` (observable) before `memory.json`; both fail-safe with a fallback error record. `finalize_status` crash-between-writes leaves stale heartbeat.
- **Backup pruning only on `DEPLOY_OK`** → unbounded growth on repeated `heal_failed`; prune unconditionally + sort by mtime (not lexical).
- **Sequential SSH probes** (~240s for 10 hosts, mostly-unreachable) approach the cycle interval → run probes in a bounded thread pool.
- **`.was-absent` written incrementally** (partial on crash → rollback leaves new files) → write atomically + add a `.backup-complete` sentinel.
- **`verify_bundle` unguarded `OSError`**, **`load_memory` crash on corrupt file**, **watchdog state amnesia on bad dir perms** (re-emits all alerts as new) → graceful fallbacks.

---

## P3 — error message quality

Operator-facing errors/log reasons lack **host / invariant / values / next-step**. Worst offenders: sentinel/selfcheck `main()` crash (no host/stateDir/checkedAt), `ssh_runtime_probe` failure (no host/command), `classify_signals` reason strings (no host/age/values), `unit_bad` (no recovery hint), disk-preflight raw bytes (add MiB). Embed structured context + a one-line "Recovery:" next step.

---

## Working notes
- The active hardening stream merges to `main` rapidly; treat this as a **shared backlog** — re-verify each item against current `origin/main` and coordinate to avoid duplicate work. The P0 cluster is the gate for live O3 fan-out.
- Full per-finding detail (file:line, repro) is in the 2026-06-15 audit transcripts; this doc is the deduped, prioritized synthesis.
