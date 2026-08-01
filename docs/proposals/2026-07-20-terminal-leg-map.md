# MAP — In-browser terminal / live exec surface (D-5, PDR-1) — 2026-07-20

**Stage:** MAP (research/design; no build authorization claimed).
**Sources:** review §3/§D-5 (operator-local status note `whatsoup-ui-ux-review-20260719.md`),
PDR-1 (design/implementation lineage: PR #1947).

## 1. The gap, precisely

Remote administration today is blind: Restart/Stop/Change-Mode buttons
fire systemd verbs (`SummaryTab.tsx:277-324` → `ServiceManager`,
`platform.ts:158-162`), and LogsTab polls journald. There is no
exec/read/write loop — no way to inspect a live process, run a scoped
diagnostic, or watch a session in real time. The review ranks this the
largest peer delta AND the operational-visibility answer for **#1861**
(stale-generation retention) and **#1870** (signal-after-result
misclassification): both are "which generation is ACTUALLY alive right
now" questions the console cannot answer today.

## 2. Current state (verified 2026-07-20)

- **Zero terminal machinery:** no xterm/node-pty dep, no `terminal`/`pty`
  surface in console or fleet (grep-verified).
- **Process model:** instances are `systemd --user` units (no per-instance
  tmux — tmux appears only in the superpowers colony spec, a different
  subsystem). Agent turns spawn per-turn `claude` subprocesses
  (`session.ts`; generation tracking exists — `superseded`/`this.child` —
  with NO operator surface, PDR-1/PDR-6).
- **Transport:** `FleetWebSocketServer` broadcasts typed events
  (invalidation/typing) one-way; no per-client bidirectional channel.
- **Authz today:** one fleet token gates everything — read AND control
  (restart/stop/config). Arbitrary exec is a NEW, higher tier.
- **Reusable machinery:** #1930 checkpoint browser already surfaces
  `claudePid`/`workspacePath`/resumable per conversation; #1945/#1946
  approval queue carries the `kind: 'exec'` forward-field by design.

## 3. Why Pi's model does not map directly

Pi peers run agent sessions in **tmux** (attach + capture-pane = the
terminal). WhatSoup instances are systemd units with per-turn subprocesses
and journald stdout — there is no persistent per-instance tmux to attach.
Any WhatSoup terminal must be designed against THIS process model, not
ported from Pi's.

## 4. Architecture options

### A — Streaming live-view (zero input path) — recommended v1
WS-pushed live stream (replaces LogsTab poll latency) + a **live session
inspector**: per line, the running claude generations as live process rows
(pid, ppid, etime, state — read-only `ps` probe scoped to the line's
workspace/pids from `session_checkpoints.claude_pid`) JOINED against the
checkpoint rows (#1930). The #1861/#1870 question — "which generation is
alive vs which row says it should be" — becomes directly answerable: a
checkpoint row with a live pid that ISN'T the active generation is the
stale-retention case, rendered in warn. **No exec tier needed** (read-only,
same token as today). Cost: one WS stream channel + one scoped ps probe
route. This is the largest visibility-per-risk step.

### B — Approval-gated one-shot exec — recommended v2
OpenClaw's model on OUR machinery: an exec-request card in the Approvals
tab (`kind: 'exec'` — the forward-field exists) → second-party approve →
fleet runs the single command scoped (allowlisted binaries — `ps`, `tail`,
`sqlite3` read-only, `journalctl`; cwd = instance dir; instance's user; no
sudo; output capped) → output rendered inline. No persistent shell; every
command is an auditable approval row (declinedVia/deliveredVia provenance
already exists). Covers the runbook-diagnostic class without a terminal's
trust explosion.

### C — Full PTY terminal (xterm.js + node-pty) — only if A+B prove insufficient
The actual Pi-style pane: fleet spawns a scoped PTY per authorized client
(instance's user, cwd = instance dir, no sudo, idle-timeout, size-capped),
bidirectional per-client WS channel, xterm.js surface, full session
transcript logged to the instance DB. Requires the NEW exec authz tier
(separate from the read/control token) + the audit machinery first. Highest
cost AND risk; its build should be gated on evidence that A+B leave real
operator workflows uncovered.

## 5. Trust boundary (the load-bearing section)

| Tier | What it allows | Today |
|---|---|---|
| Read | fleet views, logs, metrics | fleet token |
| Control | restart/stop/config/approvals | fleet token |
| **Exec (NEW)** | arbitrary commands on the host | **does not exist — B/C introduce it deliberately** |

A stays inside Read (no new tier). B creates exec-but-mediated (every
command is an approval row — exec exists only as approved single shots).
C creates exec-unmediated (a live shell) and therefore needs the separate
credential + per-line toggle + transcript audit BEFORE any build.

## 6. Decision points for the owner

1. **D1 — Stage order:** A → B → (C on evidence) as recommended, vs direct
   to C?
2. **D2 — Exec authz model (gates B and C):** separate exec credential?
   per-line toggle (default off)? both?
3. **D3 — A's surface:** LogsTab upgrade (stream + inspector rows inline)
   vs a new LineDetail "Live" tab?
4. **D4 — B's binary allowlist:** the proposed safe set
   (`ps/tail/sqlite3-ro/journalctl`) — amend?

## 7. Evidence hooks for whatever ships first

A: WS stream channel tests + ps-probe route tests (narrow route class —
locally runnable) + inspector join tests (checkpoint rows × live pids,
jsdom). B: exec-card flow reuses the #1945/#1946 test idioms end-to-end.
