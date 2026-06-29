# Agent-job dispatch gap — `create_agent_job` cron beads never run their prompt

**Status:** diagnosed, fix proposed, NOT yet implemented or deployed.
**Date:** 2026-06-29
**Author:** ana-bot (operator-agent), at Lucas Quiles's request.
**Severity:** high — a scheduled `agent_job` silently no-ops every fire. Production impact: the
BES daily invoicing sweep (bead 15 / trigger 3) has posted a bare "cron tick fired" every day
since 2026-06-26 and never executed the sweep.

## Symptom

`create_agent_job` was used to schedule the Edenwald/Manhattanville additional-work invoicing
sweep — bead 15, trigger 3, `schedule.cron` `30 15 * * *` tz `America/New_York`, report chat
`<BES-invoicing-group-jid>`. Each day the trigger fires and the only observable effect is a
WhatsApp message to the report chat:

```
*Cron tick* (trigger 3) — cron tick fired
```

The invoicing prompt stored in the bead body is never executed. The job is a no-op that *looks*
healthy (the cron fires, a message lands), which is exactly how it failed silently for days.

## Root cause (observed, source-level)

### Bug 1 — the trigger poller has no agent-dispatch path

`src/core/substrate/poller.ts:475-482`:

```typescript
if (kind === 'schedule.cron' || kind === 'schedule.at_time') {
  return {
    status: 'ok',
    fired: true,
    outputSummary: kind === 'schedule.at_time' ? 'scheduled one-shot fired' : 'cron tick fired',
    outputJson: { kind },
  };
}
```

On `fired: true`, `processTrigger` (poller.ts:336-399) calls `dispatchNotification`
(poller.ts:978-990), which does exactly one thing:
`this.messenger.sendMessage(t.report_chat_jid, formatNotification(...))`. `formatNotification`
returns `*Cron tick* (trigger N) — <outputSummary>`.

**The poller is a notification engine, not an agent dispatcher.** It never reads the linked
bead, never reads `beads.kind`, and has no handle to the agent runtime. `agent_job` appears in
only three files in the whole tree — `src/mcp/tools/substrate.ts`, `src/core/substrate/schema.ts`,
`src/core/substrate/types.ts` — i.e. the create path, the schema, and the type. **Nothing
consumes an `agent_job` bead.** `create_agent_job` creates a cron trigger plus a bead whose body
holds the prompt, and the prompt then sits inert forever.

This is a genuine platform gap, not a misconfiguration of the bead.

### Bug 2 — the cron timezone is dropped at schedule time

`src/core/substrate/poller.ts:1052-1055`:

```typescript
if (t.kind === 'schedule.cron') {
  const parsed = JSON.parse(t.spec_json) as { expr: string };
  nextFireAt = nextCronRun(parsed.expr, now);   // <-- parsed.tz is NOT passed
}
```

`src/core/cron.ts:88`:

```typescript
export function nextCronRun(expression: string, afterUnix: number, timeZone: string = 'UTC'): number
```

`timeZone` defaults to `'UTC'`, and the poller never passes the `tz` that
`create_agent_job` faithfully stored in `spec_json` (`{"expr":"30 15 * * *","tz":"America/New_York"}`).
So `30 15` is evaluated as 15:30 **UTC**.

Deterministic confirmation from the live trigger row:
- `last_fire_at = 1782747027` → 2026-06-29 **15:30 UTC** = **11:30 EDT** (chat message pk 22735 lands 11:30 ET, not the intended 3:30 PM ET).
- `next_fire_at = 1782833400` → 2026-06-30 **15:30 UTC** = **11:30 EDT**.

Intended wall-clock is 3:30 PM ET = 15:30 America/New_York = 19:30 UTC (EDT). The `30 15` expr is
correct *for* the NY timezone; it is simply being evaluated against UTC.

This bug is independent of Bug 1 and must be fixed regardless of which dispatch design is chosen —
otherwise even the notification (and any future dispatch) fires at the wrong time.

## Why the obvious stopgaps are not durable

- **Agent-side `CronCreate` / `ScheduleWakeup`** (the operator-agent's own scheduler): auto-expires
  after 7 days and only fires while the REPL is idle. That trades one silent failure for another —
  it would quietly die in a week. Rejected as a durable answer.
- **One-time `next_fire_at` correction in the DB**: does not stick. After the trigger fires,
  `scheduleNextFire` recomputes via the buggy `nextCronRun` (Bug 2) and drifts straight back to
  UTC. The tz must be fixed in code first.

## Proposed durable fix

Two independent changes:

### Change A — wire agent-job dispatch (fixes Bug 1)

The poller and the agent runtime are deliberately decoupled: the poller (`src/core/substrate/`)
is shared infrastructure usable by every instance, including the passive `primary-line` that has
no agent. Only the agent runtime can run a turn (it owns the `TurnQueue`,
`src/runtimes/agent/turn-queue.ts`, fed today only by inbound WhatsApp messages via
`processTurn`). So dispatch belongs in the agent runtime, not the poller.

**Recommended — Design A (agent-runtime scheduler):** a small scheduler inside the operator-agent
runtime polls for due `agent_job` beads whose trigger has fired and enqueues each bead body as a
synthetic turn through the existing `TurnQueue`. The poller keeps owning scheduling/`next_fire_at`,
`trigger_runs`, the circuit breaker, and throttling; the agent runtime owns execution. For
`agent_job`-linked cron triggers, suppress the bare "cron tick fired" notification (or replace it
with a real run receipt) so the chat reflects actual work.

**Alternative — Design B (synthetic inbound via `event.message`):** have the fire emit a synthetic
inbound event into the agent's ingest pipeline (the currently-reserved `event.message` scaffold,
poller.ts:483-499). More "pure" but requires building out the reserved ingest path end-to-end.

Design A reuses the durable bead/trigger schema and the existing turn machinery with the smallest
new surface; Design B is a larger build. Recommendation: Design A.

### Change B — pass the timezone through (fixes Bug 2)

- `poller.ts:1054-1055`: parse `tz` and call `nextCronRun(parsed.expr, now, parsed.tz)`.
- Audit the creation-time next-fire computation (`computeNextFireAt`) for the same drop and fix it
  too, so a freshly created job's first fire is correct.
- After deploy, recompute trigger 3's `next_fire_at` once so it realigns to 3:30 PM ET.

### Fail-loud requirements (Lucas's directive: "does not fail silently")

- A dispatched run must write a `trigger_runs` row with real status (`ok`/`failed`) reflecting
  whether the agent turn actually ran, not just that a tick fired.
- If dispatch cannot enqueue (agent runtime down, queue full), the run is recorded `failed` with a
  named error kind and an operator-safe alert — never a silent success.
- Keep the existing circuit breaker (poller.ts:1067-1079): repeated dispatch failures pause the
  trigger and notify, rather than retry-storming.

## Deploy constraint

This checkout (`~/LAB/WhatSoup`, remote `origin` = LucasQuiles/WhatSoup on GitHub) is what the live
fleet runs (native `--experimental-strip-types`, no build step). Deploying = restarting the fleet =
restarting the operator-agent (this bot). Per `~/CLAUDE.md`, platform code changes and fleet
restarts require Lucas Quiles's explicit approval. This document and any code live on branch
`fix/agent-job-dispatch-durability`; nothing is merged or deployed without his go-ahead.

## Current invoicing status (so nothing is lost in the meantime)

Last real invoicing: **Invoice 19758** on 2026-06-25 (Manhattanville Apex additional work — units
1H, 20B, 19E, 18B; total $9,475.00). Since then only empty cron ticks (Jun 26/27/28/29); no new
Nick Skyllas Edenwald/Manhattanville reports have come into the invoicing chat. **Nothing is
currently pending to invoice.** Until the fix is deployed, the sweep must be run manually.
