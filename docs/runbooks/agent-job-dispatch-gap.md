# Agent-job dispatch gap — `create_agent_job` cron beads never run their prompt

**Status:** FIXED in code on branch `fix/agent-job-dispatch-durability` — NOT yet merged or deployed (deploy = fleet restart, requires Lucas's go-ahead).
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

## Implementation (as-built on `fix/agent-job-dispatch-durability`)

Design A was implemented, with one correction to the original sketch.

### Correction: dispatch via `handleMessage`, not `turnQueue.enqueue`

The original Design A note assumed enqueuing through the global `TurnQueue`/`processTurn`.
That path is **shared-mode only**. The operator-agent (`ana-bot`) runs
`agentOptions.sessionScope: per_chat`, where `processTurn`/the global queue is NOT the active
path. The fix instead routes the synthetic turn through `AgentRuntime.handleMessage()`, the
mode-agnostic public entrypoint that already fans out correctly to shared / per_chat / single.

### Change A — agent-job dispatch (Bug 1)

- `poller.ts`: added `AgentJobDispatchFn` (`AgentJobContext` → `AgentJobDispatchResult`),
  injected via `TriggerPollerOptions.agentJobDispatch`. In the `schedule.cron`/`schedule.at_time`
  branch the poller now looks up the linked bead; if `bead.kind === 'agent_job'` it calls
  `dispatchAgentJob`, otherwise it keeps the plain "cron tick fired" notification.
- On successful dispatch the run is `ok` with `fired:false` (no bare notification — the agent
  turn does the visible work in-chat). The bead body is the prompt.
- `runtime.ts`: added `AgentRuntime.dispatchAgentJob(ctx)` — builds a synthetic `IncomingMessage`
  (admin sender JID, report chat, body as content, `isSyntheticJob:true`) and fires
  `handleMessage` fire-and-forget.
- `types.ts`: added `IncomingMessage.isSyntheticJob`; the runtime's inline imperative extractor is
  guarded by `!msg.isSyntheticJob` so a daily scheduled prompt does not spawn a proposed task bead
  on every fire.
- `main.ts`: wires `agentJobDispatch: runtime instanceof AgentRuntime ? (ctx) => runtime.dispatchAgentJob(ctx) : undefined`.

### Change B — timezone passthrough (Bug 2)

- `poller.ts` `scheduleNextFire`: parses `tz` from `spec_json` and calls
  `nextCronRun(parsed.expr, now, parsed.tz)`.
- `triggers.ts` `computeNextFireAt`: same fix at creation time so a freshly created job's first
  fire is correct.

### Fail-loud behaviour (verified by tests)

`dispatchAgentJob` fails CLOSED — `status:'failed'`, `fired:true` (immediate operator alert), and
a named `errorKind` — for: empty bead body (`agent_job_empty_body`), no dispatcher wired
(`agent_job_dispatcher_unavailable`), dispatcher threw (`agent_job_dispatch_threw`), enqueue
rejected (`agent_job_enqueue_rejected`). **Note on the circuit breaker:** a `schedule.cron`
trigger always reschedules to its next tick, so the interval circuit breaker does NOT auto-pause a
cron agent_job. This is intentional — auto-pausing a once-daily invoicing job after 5 failed days
would be the exact *silent* failure we forbid. Instead every failed fire emits its own alert; the
job stays active and keeps trying (and alerting) daily.

### Tests

`tests/core/substrate/poller.test.ts` — added `describe('TriggerPoller — agent_job dispatch')`:
cron agent_job runs the prompt as a turn (dispatcher called with body + report chat, no
notification, run `ok`, rescheduled active); fail-closed with alert when no dispatcher wired;
fail-closed on enqueue rejection; repeated cron failures alert every fire and never silently
auto-pause; tz honoured (`30 15 * * *` America/New_York from 2026-06-29T12:00Z → next fire
2026-06-29T19:30Z, i.e. 3:30 PM EDT, not 15:30 UTC). Full suite: 15329 passing; the only failures
are 3 pre-existing environmental ones (ffmpeg/transcription + a deploy health-check), confirmed
present on baseline with these changes stashed. `npm run typecheck` clean.

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
