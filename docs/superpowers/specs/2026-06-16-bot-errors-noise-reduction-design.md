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
