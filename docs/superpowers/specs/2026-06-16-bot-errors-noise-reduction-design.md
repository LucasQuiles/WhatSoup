# Bot-Errors Noise Reduction — Design

**Date:** 2026-06-16
**Author:** Q (orchestrator)
**Status:** Approved scope — all four patterns (A+B+C+D)
**Driver:** Lucas — reduce noisy/auto-recovered renotifications, distinguish planned
restarts from crashes, outages from transient timeouts; cut false positives/negatives
and redundancy in the bot-errors incident lane.

---

## 1. Problem

The bot-errors incident digest lane pushes WhatsApp messages that require no action.
Three recent live examples, all carrying `requested_action: none — no remediation
required`, were pushed days after the underlying condition resolved:

- `<host-A>|<collector>|remote-backlog-storm` — storm-collapsed, quiet ~6 days
- `<host-B>|<instance-X>|fallback_model_unknown` — quiet ~4 days
- `<host-B>|<instance-X>|provider_fallback_restored` — a **recovery** event,
  re-announced ~4 days after recovery

### Root cause (verified in code)

The stale-renotify sweep re-sends **any** still-open incident to WhatsApp every
`INCIDENT_STALE_SECONDS` (24h) as a synthetic `severity=info` digest — regardless of
whether the incident already self-healed.

- `stale_incident_event()` — `bot-errors-dispatcher.py:1609` — forces `severity=info`
  and builds the synthetic digest for any incident quiet ≥ `INCIDENT_STALE_SECONDS`.
- `sweep_stale_incidents()` — `bot-errors-dispatcher.py:1741` — calls
  `send_whatsapp(format_event(event))`, the actual push.

There is no gate that asks "did this incident already resolve, or is it actionable?"
before re-pushing.

### Structural gaps vs. the Alertmanager noise model

| Capability | Have? | Where |
|---|---|---|
| **Grouping** (dedup identical fingerprints) | ✅ | storm-collapse (≥3 in 120s) |
| **Inhibition** (root cause suppresses symptom) | ❌ | — |
| **Silences** (planned-maintenance muting) | ❌ | — |
| **Intent detection** (clean stop vs. crash) | ❌ | watchdog treats both as down |
| **Severity tiering** (outage vs. transient) | ❌ | severity is caller-static |

Today severity is assigned statically at emit time
(`bot-errors-emit.py:328`: `severity = args.severity or ("info" if clear else
"critical")`) and never re-derived from reachability or systemd intent.

---

## 2. Goals / Non-Goals

**Goals**
- Stop re-pushing self-healed / no-op incidents while keeping them in state for audit.
- Distinguish intentional `systemctl stop/restart` from crashes; silence the former.
- Provide a maintenance-window CLI to mute an instance during planned deploys.
- Suppress symptom alerts when a known root-cause incident is open (inhibition).
- Tier transient failures (rate-limit, fallback, timeout) below hard outages so they
  warn quietly and auto-clear, never escalating to critical.

**Non-Goals**
- No change to the storm-collapse grouping logic (it works).
- No change to the collector's SSH transport or Tailscale plumbing.
- No new alerting channel; same WhatsApp lane, fewer messages.
- No self-restart to deploy — changes land on the next natural unit restart, which
  Lucas controls.

---

## 3. Design — Four Patterns

All four are env-gated (default-on where safe, default-off where behavior-changing)
so they can be rolled back per-knob without a code revert.

### Pattern A — Silence self-healed / no-op stale renotify

**Where:** `stale_incident_event()` (`dispatcher.py:1609`) and the send site in
`sweep_stale_incidents()` (`dispatcher.py:1741`).

**Logic:** before emitting a synthetic stale digest, classify the incident as
*non-actionable* if any of:
- source matches a recovery/no-op pattern: `*_restored`, `*_unknown`,
  `*_recovered`, `provider_fallback_*`, or source is in a configurable
  `STALE_RENOTIFY_SUPPRESS_SOURCES` set;
- the latest event's `requested_action` is `none`/empty;
- the incident is storm-collapse-derived with no live re-trigger since collapse.

Non-actionable stale incidents are **not sent**; they are marked
`stale_suppressed: true` in incident-state (audit trail preserved) and counted in a
`stale_suppressed_total` metric. Actionable stale incidents renotify as today.

**New env:** `BOT_ERRORS_SUPPRESS_STALE_INFO_RENOTIFY` (default `1`),
`BOT_ERRORS_STALE_RENOTIFY_SUPPRESS_SOURCES` (CSV, extends the built-in pattern set).

**Safety valve:** an incident suppressed N consecutive sweeps still emits **one**
"auto-closing stale incident" summary at `INCIDENT_ESCALATE_SECONDS`, then transitions
to `resolved_stale` and stops — so nothing is silently lost forever.

### Pattern B — Planned-vs-crash detection + maintenance windows

**Where:** `systemd_service_status()` (`heartbeat-watchdog.py:685`).

**Logic:** replace the bare `is-active` check with
`systemctl --user show -p Result,ActiveState,SubState,ExecMainStatus`:
- `Result=success` AND `ActiveState ∈ {inactive,deactivating}` /
  `SubState=dead` → **clean stop** → classify `intent=planned`, do not alert
  (log only).
- `Result ∈ {exit-code,signal,oom-kill,timeout,core-dump}` OR
  `ActiveState=failed` → **crash** → alert as today.
- `ActiveState=activating` (restart in flight) within a grace window → hold, do not
  alert until the window expires.

**Maintenance CLI:** `bot-errors-maintenance open <instance> <duration>` /
`close <instance>` writes a silence record to
`~/.local/state/bot-errors/maintenance.json`. The dispatcher's `should_suppress_send()`
(`dispatcher.py:~1310`) checks for an active window keyed by machine/instance and
suppresses (and tags `maintenance_silenced`) for the duration. Windows auto-expire.

**New env:** `BOT_ERRORS_WATCHDOG_INTENT_DETECTION` (default `1`),
`BOT_ERRORS_RESTART_GRACE_SECONDS` (default `45`).

### Pattern C — Inhibition table (root cause suppresses symptom)

**Where:** `should_suppress_send()` (`dispatcher.py:~1310`), consulting open-incident
state.

**Logic:** a static inhibition map: while a root-cause incident is open for an
instance, suppress its known downstream symptom incidents for that same instance.

Seed map (extensible via config):
```
whatsapp_device_bond_lost  ⇒ suppresses local_health:<instance>, instance_logged_out
instance_logged_out        ⇒ suppresses local_health:<instance>
<host unreachable>         ⇒ suppresses per-instance health on that host
```
This collapses the observed "loops alerted 3× for one bond-loss" into a single
root-cause alert. Suppressed symptoms are tagged `inhibited_by:<root_source>` and
auto-release when the root incident clears.

**New env:** `BOT_ERRORS_INHIBITION_ENABLED` (default `1`),
`BOT_ERRORS_INHIBITION_MAP` (JSON override of the seed map).

### Pattern D — Outage-vs-transient severity tiering

**Where:** wire `ssh_failure_diagnosis()` (`collector.py:863`) and emit-time
classification so reachability/transience drives severity instead of a static caller
value.

**Logic:** classify the failure mode:
- **Transient** (rate-limit, provider fallback, `*_online_ssh_timeout`, single probe
  timeout, model-unknown) → `severity=warning`, long renotify, **auto-clears on the
  next healthy probe**, never escalates to critical.
- **Hard outage** (host `tailscale_offline`, service `failed`/`dead`-crash,
  `logged_out`, bond-revoked) → current critical behavior.

Transient incidents that recover before the next renotify window never reach WhatsApp
at all. A transient that persists across `TRANSIENT_PROMOTE_SECONDS` is promoted to the
hard-outage tier (catches a "transient" that is really a slow outage — guards the
false-negative direction).

**New env:** `BOT_ERRORS_TRANSIENT_TIERING` (default `1`),
`BOT_ERRORS_TRANSIENT_PROMOTE_SECONDS` (default `1800`).

---

## 4. Data Flow (after)

```
emit ─▶ collector ─▶ dispatcher ─────────────────────────────▶ WhatsApp
                       │   ├─ storm-collapse (unchanged)
                       │   ├─ [D] severity tiering (transient→warn, auto-clear)
                       │   ├─ [C] inhibition gate (root suppresses symptom)
                       │   ├─ [B] maintenance-window + intent gate
                       │   └─ [A] stale-renotify suppression (no-op/recovered)
heartbeat-watchdog ─▶ [B] systemd intent (planned vs crash) ──▶ dispatcher
```

Every suppression path **tags and counts** rather than silently dropping:
`stale_suppressed`, `maintenance_silenced`, `inhibited_by`, `transient_autoresolved`.
The audit record in incident-state is always written; only the WhatsApp push is gated.

---

## 5. Error Handling

- Every new gate is fail-open: if classification raises, fall back to current
  (send) behavior — we never lose a real alert to a bug in the noise filter.
- `systemctl show` parse failure → treat as unknown → alert (fail toward visibility).
- Maintenance/inhibition state files: corrupt/missing → treated as empty (no
  suppression), logged once.
- All suppression decisions logged to `logs/dispatch.jsonl` with reason codes for
  post-hoc tuning and false-negative auditing.

## 6. Testing

Extend the existing Vitest suites; add cases per pattern:
- `bot-errors-dispatcher.test.ts` — A: recovered/no-op stale incident suppressed,
  actionable stale still sent, escalate-then-resolve safety valve; C: symptom
  inhibited while root open, released on clear; B: maintenance window suppress +
  expiry.
- `bot-errors-heartbeat-watchdog.test.ts` — B: clean-stop classified planned (no
  alert), crash classified down (alert), restart grace window.
- `bot-errors-collector.test.ts` — D: transient → warning + auto-clear, persistent
  transient promoted to outage.
- Fail-open tests: each classifier raising → falls back to send.

## 7. Rollout

1. Land code + tests behind the env knobs (defaults as above).
2. Changes take effect on the **next natural restart** of the dispatcher/watchdog
   units — no self-restart; Lucas schedules.
3. Observe `*_suppressed_total` counters + `dispatch.jsonl` reason codes for one week;
   tune the source/inhibition maps from real suppression logs.

---

## 8. Backlog (out of scope for this spec)

- **WhatsApp poll reliability bugs.** The decision-poll path (AskUserQuestion /
  `send_poll`) has shown flakiness: an AskUserQuestion call returned an interrupt with
  no captured answer, requiring a re-pose; poll-vote round-tripping appears unreliable.
  Investigate poll delivery, vote-capture, and result-resolution in the poll
  handler; reproduce and harden. File as its own work item.
- **Fingerprint collision risk.** Dedup keys truncate SHA-256 to 16 chars;
  evaluate collision probability at current incident volume and whether to widen.
  (Flagged for review, low priority — likely fine at this scale.)
- **JSON-RPC timeout consistency.** Inconsistent client timeouts (15s vs 20s)
  in the dispatch path; audit for unhandled timeout exceptions. (Unverified — confirm
  before acting.)

---

## 9. Addendum v2 — Pattern E (enrichment), Pattern F (flap-storm), refinements

**Status:** Approved in principle (owner, 2026-06-17). Driven by a live wave of ~12
stale-renotify digests in ~14 min, all 5–7 days quiet, all `requested_action: none`,
several multiplying per-fingerprint within one collapsed storm, plus a
`<instance>|whatsapp_auth_bond_local_failure` incident that flapped 263× then
self-healed and renotified at `info` 7 days later. The four base patterns suppress
this noise; E and F raise the *information value* of what survives.

### Pattern E — Alert enrichment (amplify signal on every surviving alert)

**Where:** the formatter/emit path (`format_event()` in the dispatcher) and emit-time
classification.

**Logic:** every alert that *does* send carries:
- **One authoritative `requested_action` (SSOT).** Today digests carry two
  contradictory fields — an inner evidence `requested_action` ("Q verify…") and a
  top-level `requested_action` ("none — no remediation"). Collapse to a single
  derived field; delete the contradictory one. The action is *derived* from the
  final classification (intent + tier + inhibition state), not author-supplied.
- **Intent tag** inline: `planned` vs `crash` (from Pattern B's systemd intent).
- **Severity rationale**: one phrase on why this tier (e.g. "transient: cleared on
  next probe" / "outage: host unreachable 3 probes").
- **Recent-change context**: most recent deploy/restart/config touch for the
  instance within a lookback window, when available (answers "did we cause this?").

**New env:** `BOT_ERRORS_ENRICH_ALERTS` (default `1`),
`BOT_ERRORS_REQUESTED_ACTION_SSOT` (default `1`),
`BOT_ERRORS_CHANGE_CONTEXT_LOOKBACK_SECONDS` (default `900`).

### Pattern F — Flap-storm detection (consolidate **and** escalate)

A flapping source is not just noise to collapse — sustained self-heal-then-fail is a
**fault signature** and must raise its own alert. Pure consolidation that goes quiet
would hide the 263× bond instability; pure per-event sending is the spam we are
removing. F does both.

**Where:** a flap detector keyed on `incident_key`, consulted in the dispatcher
before per-event send and in the stale sweep.

**Logic:**
- Track trip-rate per `incident_key` over a sliding window `W`.
- When trips cross `FLAP_TRIP_THRESHOLD` in `W`, **suppress the individual member
  events** and emit ONE `flap_storm` alert for that key.
- The `flap_storm` severity is **tiered by intensity, not `info`**: `warning` at
  threshold; **promote to `critical`** if the rate stays high across
  `FLAP_PROMOTE_SECONDS` or the cumulative count crosses `FLAP_CRITICAL_COUNT`
  (the 263 case → critical). Ties into Pattern D's promote-on-persist.
- The `flap_storm` alert carries full Pattern E enrichment: count · rate · window ·
  first/last-seen · underlying source · intent · a real `requested_action`
  ("source unstable — investigate root cause", never "none").
- **Dedup by `incident_key`, not fingerprint** — collapses the observed
  per-fingerprint multiplication of stale-renotify within a single collapsed storm.
- On stabilize (quiet ≥ `FLAP_STABLE_SECONDS`) emit ONE terminal
  *"resolved after N flaps over Tm"* summary, then transition to `resolved_stale`.
- A source that never crosses the threshold and never paged → silent (state only),
  per the symmetric-recovery principle.

**Recovery visibility (resolved decision):** recoveries are **summarized, buffered,
and consolidated as a flap problem** — never 200 individual alerts. This supersedes
the three recovery-visibility options previously floated; F is the mechanism.

**New env:** `BOT_ERRORS_FLAP_DETECTION` (default `1`),
`BOT_ERRORS_FLAP_TRIP_THRESHOLD` (default `5`),
`BOT_ERRORS_FLAP_WINDOW_SECONDS` (default `600`),
`BOT_ERRORS_FLAP_PROMOTE_SECONDS` (default `1800`),
`BOT_ERRORS_FLAP_CRITICAL_COUNT` (default `50`),
`BOT_ERRORS_FLAP_STABLE_SECONDS` (default `3600`).

### Folded refinements (from the live wave + prior review)

1. **`requested_action` SSOT** — covered by Pattern E (the dual-field contradiction).
2. **`incident_key`-level stale dedup** — covered by Pattern F (storm-member
   multiplication: 3+ digests sharing one key, differing only by fingerprint suffix).
3. **Terminal/self-closing recovery events** — `*_reverted`, `*_restored`,
   `*_recovered`, `provider_fallback_*` should auto-close on emit, not open an
   incident that renotifies on the dup threshold forever (observed:
   `provider_fallback_reverted` held `open` and re-notified at the suppression
   threshold).
4. **Pattern A liveness safety valve** — before suppressing a stale incident as
   recovered, a cheap liveness probe confirms the source is actually back; suppress
   only on a positive probe, else fall through to send (guards false-negatives).
5. **Failure-counter reset** — a "N consecutive failures" counter must reset when a
   re-baseline/clearing run already cleared the cause (observed: a supervisor kept
   counting past a clean re-baseline until the timer naturally elapsed).
6. **Recovery glyph correctness** — recovery summaries must not render the 🔴
   down-glyph; formatter bug to fix alongside Pattern E.
7. **AskUserQuestion suppression gap** — WhatsApp-bridged decision polls never
   register a `toolId`, so the suppression check at `runtime.ts:~4849` falls through
   to a false `critical`; folded with the poll-reliability backlog item.

### Sequencing

1. **Wave 1:** Pattern A + Pattern F (flap-storm) + Pattern E `requested_action`
   SSOT — this trio kills the exact noise wave observed 2026-06-17.
2. **Wave 2:** Pattern B (intent detection + maintenance windows).
3. **Wave 3:** Pattern C (inhibition) + Pattern D (transient tiering) + remaining
   Pattern E enrichment fields.
4. **Parallel:** WhatsApp poll-reliability fix (§8) + AskUserQuestion gap (#7).

### Data flow (revised)

```
emit ─▶ collector ─▶ dispatcher ─────────────────────────────────▶ WhatsApp
                       │   ├─ storm-collapse (unchanged)
                       │   ├─ [F] flap detector (consolidate + escalate, by key)
                       │   ├─ [D] severity tiering (transient→warn, auto-clear)
                       │   ├─ [C] inhibition gate (root suppresses symptom)
                       │   ├─ [B] maintenance-window + intent gate
                       │   ├─ [A] stale-renotify suppression (+ liveness valve)
                       │   └─ [E] enrichment (SSOT action, intent, rationale, change)
heartbeat-watchdog ─▶ [B] systemd intent (planned vs crash) ──────▶ dispatcher
```

### Testing (additions)

- `bot-errors-dispatcher.test.ts` — E: dual `requested_action` collapsed to one
  derived SSOT field; enrichment fields populated; F: N trips in W → one `flap_storm`
  (members suppressed), warning→critical promotion at count/duration thresholds,
  per-`incident_key` dedup of storm members, terminal resolve after stable window,
  `*_reverted`/`*_restored` self-close on emit.
- Fail-open: flap detector / enrichment raising → falls back to current send.

---

## 10. Review-wave synthesis (2026-06-17) — folded corrections

Four independent reviewers (gap, adversarial-false-negative, hardening-against-live-code,
cross-model MiniMax-M2.7) reviewed §1–9. They converged on one design-invalidating
finding and a set of high-value corrections. All are folded below; they are binding on
the implementation plan.

### C0 — BLOCKER: flap state (Pattern F) must be disk-persisted

**Unanimous across all four reviewers.** The dispatcher runs **run-once** under a systemd
timer — each invocation is a fresh process that loads state, processes, saves, and exits.
An in-memory sliding-window trip counter is therefore impossible: it resets every run, so
the 263× burst (which the design exists to catch) could never accumulate. **Pattern F is
invalid as written until flap state is persisted.**

**Fix:** persist flap state in the existing `incident-state.json` under a `flapState` key,
keyed by `incident_key`: `{tripTimestamps:[epoch…], cumulativeCount, stormAt, promoteAt,
stableAt}`. Trip timestamps are recorded at **dispatcher-local wall-clock** (`time.time()`),
never author-supplied `createdAt` (collector clock skew). Prune timestamps older than
`FLAP_WINDOW_SECONDS` on each read. Same corrupt/missing → empty fallback as incident-state.

### C1 — Pattern F ordering and key semantics (must be specified, not implied)

- Define `source`, `incident_key`, `fingerprint` as explicit schema fields. Working
  definition: `incident_key = machine|instance|source`; `fingerprint` = the SHA-256(16)
  dedup key used by storm-collapse.
- **F counts trips BEFORE storm-collapse consumes them** — otherwise collapsed members are
  invisible to the flap counter. F dedups its *output* by `incident_key`; it counts its
  *input* per raw trip.
- Specify F's interaction with C (inhibition must not hide symptom-level flaps from F) and
  D (transient auto-clear must not reset F's accumulation).

### C2 — Liveness probe: source-specific, and it must gate F's resolve too

- The probe is **per source class**, not a generic host ping: `network`(ssh/tailscale),
  `systemd`(unit state), `app`(health endpoint), `whatsapp_bond`(session-token/last-seen),
  `none`(suppress only if action=none). A WhatsApp-bond incident must probe the bond, not
  TCP reachability (a host can be SSH-green while the bond is revoked).
- The probe must gate **Pattern F's stabilize→resolved transition**, not only Pattern A.
  Collector silence ≠ recovery; resolve only on positive liveness, else hold `flap_active`.
- Probe raises → **catch-and-send** (log `liveness_probe_failed`, fall through). Never
  catch-and-drop.

### C3 — Chronic low-level instability (slow-flapper false-negative)

A source failing just under threshold every window forever never fires F, and D auto-clears
each event. Add a secondary **N-of-M-windows** counter: tripped in ≥3 of the last 5 windows
→ escalate as `chronic_instability` regardless of per-window burst count. Mirror with a
cross-incident `transient_recurrence_count` / `transient_total_downtime` that survives
individual close/reopen so oscillating transients promote.

### C4 — requested_action SSOT ordering + flap_storm exemption

- Pattern A's "action is none" check must read the **incident-level SSOT field** (Pattern E),
  written **before** the stale sweep evaluates it. Explicit ordering constraint.
- `flap_storm` incidents are classified `requested_action: investigate` (never `none`) and
  are **exempt from Pattern A suppression**; their renotify cadence is separate
  (≈ once per `FLAP_PROMOTE_SECONDS` while active).
- One-line fix landable now: remove the inner `requested_action=…` baked into the evidence
  string in `stale_incident_event` (≈`dispatcher.py:1648`); let `format_event` be the sole
  source. Kills the live dual-field contradiction immediately.

### C5 — Live-code hardening (verified against current dispatcher)

- **`openIncidents` is unbounded** — live state holds 161 incidents, 79 `stale`, never
  pruned. `resolved_stale` must be a **terminal removal** from `openIncidents` + `lastSentAt`,
  not a status tag. Add a prune pass in `run_once()`.
- Invariant: all state mutations in one `run_once()` happen sequentially under the existing
  `LOCK_EX` lock — never parallelize `process_one`. Pass the loaded state into
  `sweep_stale_incidents` instead of re-reading from disk.
- `append_private_jsonl` lacks fsync (audit-log gap on crash) — low priority.

### C6 — Intent classification false-negatives (Pattern B)

- **OOM/cgroup cross-check:** `Result=success` on a unit whose child was OOM-killed in a
  parent cgroup reads as clean stop. Cross-check kernel journal (`journalctl -k -p3`) for OOM
  on the instance's cgroup within the grace window → override to crash.
- **Non-renewable grace window:** re-entering `activating` must not reset the grace timer
  (else a crash-loop hides as "restart in flight" forever).
- **Consecutive ssh-timeout reclassify:** N consecutive `online_ssh_timeout` with no success
  → `offline_unconfirmed`, promote to outage (guards a real outage misread as transient).
- **Pattern B must cover launchd (darwin), not only systemd.** The collector/deadman hosts
  are darwin (launchd), and that is where most observed noise originates. Add a launchd
  intent classifier mirroring the systemd one: `launchctl print` / last-exit-status +
  signal. **A clean `SIGTERM` (signal 15) — especially when the job is currently running
  again — is a planned stop/restart, not a failure** and must not page. Live evidence
  (2026-06-17): a `launchd-deadman` critical (open since 06-12, 15 dups) was dominated by
  `com.q.dreammachine-ingest` "killed by signal 15, currently running pid=83006" — an
  intentional restart misreported as a failing surface. The deadman sweep itself needs the
  same intent gate: signal-15 + live pid → healthy; nonzero-exit on a periodic job →
  route through Pattern G benign-exit classification before escalating.

### C7 — Inhibition precision + maintenance integrity

- Inhibition must match root **and symptom sub-cause** — suppress `local_health` only for
  bond-downstream sub-causes (conn-refused/auth), never for disjoint causes (disk/OOM/mem),
  which are independent real incidents. Requires a `sub_cause` field on symptom events.
- Maintenance windows: max-duration cap (`BOT_ERRORS_MAINTENANCE_MAX_DURATION_SECONDS`),
  append-only open/close audit log, auto-expiry prune on every read, and a
  `requires_post_maintenance_review` tag so an incident that began *during* a window is
  re-surfaced at close instead of being swallowed by Pattern A.

### C8 — False-negative observability

`stale_suppressed_total` counts suppressions but not *correctness*. Add a retrospective
`was_suppressed_before_escalation` tag: when a previously-suppressed source later emits
`critical`, flag it on the new alert — operators can audit missed signals from
`dispatch.jsonl` without external correlation.

### C9 — NEW pattern needed: runtime-tool-error over-paging (live critical, this session)

A `runtime-tool-error:claude-cli:Bash` incident has been **open since 2026-06-13 with 49
suppressed duplicates, escalated to critical** — fed by *benign* non-zero exits (a
`git add` of a gitignored path, `grep` no-match, test probes). The agent runtime emits
`severity=critical` for **any** tool non-zero exit. This is a first-class false-positive
source A–F do not cover.

**Fix (Pattern G — runtime-tool-error classification):** classify expected/benign exits as
non-actionable before emit — `git`(ignored-path/nothing-to-commit), `grep`/`rg`(exit 1 =
no match), exit codes from probing commands → `warning`/suppressed, never `critical`.
Only genuine runtime faults (uncaught exceptions, OOM, transport deadlock, repeated
identical failures) page. Env: `BOT_ERRORS_TOOLERROR_BENIGN_CLASSIFICATION` (default `1`).

### Cross-model note

Of three panelists, only MiniMax-M2.7 returned (both DeepSeek lines silent-emptied — known
failure mode on structured/diff tasks). MiniMax's arithmetic on the 263-case window was off
(it averaged trips over the 5-day quiet span, ~0.26/600s, rather than the 34-min burst,
~77/600s) — the burst is far above threshold; the real lesson is C0/C1 (persistence +
precise window semantics), not a threshold change. Single-model cross-review is weak
evidence; re-run with minimax-only or add GLM before treating cross-model as load-bearing.

---

## 11. Wave 1 — implementation status (2026-06-17)

Branch `feat/bot-errors-noise-reduction`. All changes in
`deploy/scripts/bot-errors-dispatcher.py`; tests are **pytest** under
`deploy/scripts/tests/` (the §6 reference to Vitest was wrong — the dispatcher
suite is Python). 769 pass; the single `test_bot_errors_deploy_sha_failed`
failure is the expected SHA-pin drift for a modified pinned script, cleared by
the approved `whatsoup-bot-errors-deploy.sh pin` step, not in-band.

**Code correction to C0:** the dispatcher runs as a **daemon** (`--daemon
--interval 30`), not run-once under a timer. In-memory flap counters would
therefore survive within a daemon lifetime — but disk-persistence is still
correct (survives natural restarts) and is what we implemented. C0's mandate
stands; its premise (run-once) was imprecise.

**Landed (committed, behind default-on env knobs, fail-open):**
- **Pattern E SSOT** (`06b0aa9e`) — `requested_action_text()` is the sole action
  deriver; removed the two baked inner `requested_action=` evidence strings;
  precedence reordered so a real action wins over the info "none" fallback
  (fixes the awaiting_physical false-negative). 4 tests (f10).
- **Pattern A** (`3bb50ef3`, `cfd4e160`) — `stale_renotify_is_nonactionable()`
  suppresses self-healed/no-op stale renotify (SSOT action==none OR
  stale verify-filler OR recovery/no-op source signatures); tag+count+audit;
  §C5 terminal removal of past-escalate incidents from `openIncidents`+`lastSentAt`
  with ONE consolidated auto-close summary. 6 tests (f11).
- **Pattern F** (`140e75f1`) — disk-persisted `flapState` (§C0); `flap_scan_outbox`
  counts raw trips before storm-collapse (§C1) and emits one consolidated,
  E-enriched `flap_storm` alert (warning→critical on persistence/count);
  members suppressed in `should_suppress_send`; `sweep_flap_storms` emits the
  terminal resolve summary. flap_storm exempt from Pattern A (§C4). 11 tests (f12).

**Wave 2 — landed (2026-06-17):**
- **Pattern B Part 1 — planned-vs-crash intent detection** (`heartbeat-watchdog.py`).
  Replaced the bare `systemctl is-active` check with structured
  `systemctl --user show -p Result,ActiveState,SubState,ExecMainStatus,StateChangeTimestampMonotonic`.
  `classify_service_intent()` returns `active|planned|activating_grace|crash`:
  clean stop (`Result=success` + inactive/deactivating) → planned (log-only,
  no alert); restart in flight (`activating` within `BOT_ERRORS_RESTART_GRACE_SECONDS`,
  default 45, measured via CLOCK_MONOTONIC vs systemd's monotonic stamp) → hold;
  `failed` / non-success `Result` (exit-code, signal, oom-kill, timeout, …) /
  stalled-activating → crash, alerts as before. **Fail-closed**: unknown state,
  probe error, or exception classifies as crash so a real outage is never dropped.
  Incident key `local_service:<service>` is preserved (dedup continuity). Env
  `BOT_ERRORS_WATCHDOG_INTENT_DETECTION` (default 1); gate-off falls back to the
  legacy is-active path. Dry channel `BOT_ERRORS_DRY_SERVICE_INTENT` (JSON props).
  21 tests (`test_bot_errors_heartbeat_watchdog_intent.py`).
- **Still deferred for Pattern B:** Part 2 (maintenance-window CLI + dispatcher
  `should_suppress_send` gate, §C6) and launchd/darwin intent parity.

**Deferred follow-ups (precisely scoped):**
- **Pattern G — runtime-tool-error benign classification** (NOT landed; TS, own
  bead). Root cause is `src/runtimes/agent/runtime.ts`: `tool_result` handler at
  **line ~4860** calls `maybeEmitToolFailureAlert` for **every** `event.isError`,
  and `emitAlertChecked` defaults severity to critical. `classifyToolError`
  (line 1311) yields only `cancelled|blocked|error`. Fix: add
  `isBenignToolError(toolName, content, classification)` and gate the alert call
  (`if (!isBenign) this.maybeEmitToolFailureAlert(...)`; still enqueue the UI
  toolUpdate). Benign signatures: category `cancelled`/`blocked`; git
  nothing-to-commit / gitignored-path / did-not-match; grep/rg exit 1 = no match;
  bare `Exit code 1` from a probe with no stderr fault. Env
  `BOT_ERRORS_TOOLERROR_BENIGN_CLASSIFICATION` (default 1). Second call site at
  line ~8203 takes the same gate. Live impact: a `runtime-tool-error:claude-cli:Bash`
  critical open since 06-13 with 49 benign dups.
- **C2 liveness-gated resolve** for Pattern F (currently time-stable only) and
  **C3 N-of-M slow-flapper** counter — both noted in code comments.
- **Pattern B Part 2** (maintenance-window CLI + launchd/darwin, §C6) and
  **Pattern C/D** (inhibition + transient tiering) — Wave 3, untouched.

**Deploy:** changes take effect on the **next natural dispatcher restart** (Lucas
controls; no self-restart). The SHA-pin (`deploy/bot-errors-runtime-manifest.json`
+ approved ledger) must be regenerated in that step.
