# WhatSoup Investigation: connection_exhausted RCA

Date investigated: 2026-04-05
Incident date: 2026-04-04
Repo: /home/q/LAB/WhatSoup

## Conclusion

There is no runtime evidence that the 2026-04-04 incidents were caused by `connection_exhausted` inside `src/transport/connection.ts`.

What the evidence does show:

1. The observed incident waves are mostly explicit systemd restarts, not Baileys reconnect exhaustion.
2. The transport reconnect logic only emits `connection_exhausted` after 30 minutes of continuous failure, and I found no such events in journald or instance logs on 2026-04-04.
3. There is a separate bad-unit incident where `whatsoup@WhatSoup.service` was started even though no `WhatSoup` instance exists. That crash loop generated `service_crash` repair alerts and likely added noise to incident attribution.

## Primary Evidence

### 1. Transport code does not match the observed failure mode

- `src/transport/connection.ts:729-757` handles normal close events by invalidating the socket and calling `scheduleReconnect()` when not shutting down.
- `src/transport/connection.ts:765-785` only emits `connection_exhausted` after reconnect attempts have failed for more than 30 minutes.
- I found no `connection_exhausted` occurrences in 2026-04-04 journald or current WhatSoup logs.

### 2. Actual incidents were clean service restarts

Journald repeatedly shows this pattern:

- `systemd: Stopping whatsoup@<instance>.service`
- app log: `signal:"SIGTERM" msg:"shutting down"`
- app log: `component:"connection" reason:"Unknown" msg:"WhatsApp connection closed"`
- `systemd: Stopped whatsoup@<instance>.service`
- `systemd: Started whatsoup@<instance>.service`
- app log: `WhatsApp connected`

Examples from 2026-04-04:

- `q` restarted at `00:07:39-00:07:43 EDT`
- `q` restarted again at `00:36:58-00:36:59 EDT`
- `q` and `lab` restarted together at `01:38:41 EDT`
- `loops` restarted at `01:39:07-01:39:08 EDT`
- `besbot` restarted repeatedly at `04:22:27`, `04:27:11`, `04:29:29`, `04:46:13`, `04:50:46`, `04:53:42`, `04:56:39`, and `04:57:27 EDT`

These are operator- or automation-driven restarts at the service layer. They are not the in-process reconnect path.

### 3. The fleet server can issue these restarts, but does not log who did it

- `src/fleet/routes/ops.ts:97-135` exposes restart and stop handlers that directly run `systemctl --user restart|stop whatsoup@<name>`.
- `src/fleet/index.ts:248-276` authenticates API requests but does not log route, caller identity, remote address, or target instance before dispatching handlers.
- The console exposes these actions in multiple places:
  - `console/src/components/ActivityFeed.tsx:101-123`
  - `console/src/pages/LineDetail.tsx:1125-1158`

Implication: a valid fleet token holder can trigger restarts, but current logs do not attribute the caller.

### 4. Auth flow is another in-repo stop path, but it does not fit the main restart waves

- `src/fleet/routes/ops.ts:622-695` stops the service before starting QR auth, then starts it later on successful `connected`.
- This path explains why a bare stop can happen from the UI, but the observed `q/lab/loops/besbot` incidents were mostly immediate stop-start cycles, which match restart behavior more closely than relink auth.

### 5. Health poller is not restarting services

- `src/fleet/health-poller.ts:124-146` only records failures and emits `instance_unreachable` alerts when failures cross the unreachable threshold.
- There is no restart logic in the poller.

### 6. Invalid `whatsoup@WhatSoup` unit is a separate crash-loop incident

Evidence from journald:

- `00:36:34 EDT`: `Started whatsoup@WhatSoup.service`
- immediately after: `Failed to read instance file at /home/q/.config/whatsoup/instances/WhatSoup/config.json`
- then: `Main process exited ... status=1/FAILURE`
- then systemd retries at `00:36:50` and `00:37:13` because `deploy/whatsoup@.service:13-21` sets `Restart=on-failure`
- `OnFailure=whatsoup-heal-notify@%i.service` at `deploy/whatsoup@.service:8` triggered repair notifications to `q`

The corresponding repair-agent transcript shows a repair request for instance `WhatSoup`, and confirms the real configured instances are only `besbot`, `lab`, `loops`, `personal`, `q`, and `shandroid`.

This is not a transport exhaustion event. It is a bad service start for a nonexistent instance name.

## Secondary Operational Finding

Agent-mode restarts show many leftover child processes in the service cgroup, especially for `q`.

Example at `00:07:40 EDT` and `01:38:41 EDT`:

- systemd killed multiple `claude`, `python3`, `sh`, and `MainThread` processes
- systemd then logged `Unit process ... remains running after unit stopped`
- memory peak for `q` reached `12.6G`

This suggests a separate child-process cleanup deficiency around agent sessions and service shutdown. It is worth fixing, but it is not evidence of a connection pool leak in Baileys transport.

## What I Could Prove vs. What I Could Not

Proved:

- The observed 2026-04-04 disruptions were dominated by service restarts, not `connection_exhausted`.
- The bogus `WhatSoup` service start produced a real crash-loop and repair noise.
- The fleet API and console can trigger restarts without caller attribution in logs.
- The health poller itself does not restart services.

Not proved:

- The exact caller for the service restarts on 2026-04-04.
- The exact actor that first started `whatsoup@WhatSoup.service`.

Current logging is insufficient to attribute those actions after the fact.

## Recommended Next Steps

1. Add audit logging around fleet write routes:
   - route name
   - instance name
   - caller source (`Authorization` mode, remote addr, query-token vs bearer)
   - outcome
2. Add explicit logs in `handleRestart`, `handleStop`, and `handleAuth` before invoking `systemctl`.
3. Investigate the agent child-process leak / leftover cgroup members visible on `q` restarts.
4. Trace what external tool or user action can start `whatsoup@WhatSoup` with a mixed-case nonexistent instance name.

