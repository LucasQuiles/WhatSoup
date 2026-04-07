# Orchestrator Handoff Pack — Session Leak Audit 20260406

**Task ID:** session-leak-audit-20260406
**Prepared:** 2026-04-06
**For:** Q (Orchestrator) or any future conductor assuming this workstream
**Project:** WhatSoup (`/home/q/LAB/WhatSoup`)
**Colony group:** `120363406689931730@g.us`

---

## 1. Mission Summary

Remediate 30 verified issues across the WhatSoup agent runtime: memory leaks, error handling gaps, race conditions, silent failures, observability blind spots, and performance bottlenecks. Every issue is traced to exact file + line number, has a full implementation spec, a "Maybe I'm Wrong" validation section, required tests with GIVEN/WHEN/THEN assertions, and an assigned loop depth for the backpressure review cycle.

**What this is NOT:** A greenfield build. Every bead is a surgical fix to existing production code running Q, L, BES Bot, Shannon, and Personal instances right now.

---

## 2. Artifact Inventory

### Master Spec
| File | Purpose |
|------|---------|
| `docs/sdlc/active/session-leak-audit-20260406/state.md` | Master manifest — firing order, phase plan, severity distribution, loop depth map, bridge integration notes |

### Bead Specs (30)
All in `docs/sdlc/active/session-leak-audit-20260406/beads/`:

| Bead | File | Scope Files | Cynefin | Loop Depth |
|------|------|-------------|---------|------------|
| SILENT-01 | `SILENT-01-spawn-per-turn-db-args.md` | `session.ts` | clear | L0+L1 |
| SILENT-02 | `SILENT-02-spawn-per-turn-exit-no-result.md` | `session.ts`, `runtime.ts` | complicated | L0+L1+L2+L2.5 |
| SILENT-03 | `SILENT-03-global-crash-count.md` | `runtime.ts` | clear | L0+L1+L2 |
| SILENT-04 | `SILENT-04-usage-limit-dirty-state.md` | `runtime.ts` | clear | L0+L1 |
| ERR-01 | `ERR-01-control-slot-lock.md` | `runtime.ts` | clear | L0+L1 |
| ERR-02 | `ERR-02-durability-null-guard.md` | `runtime.ts` | clear | L0+L1 |
| ERR-03 | `ERR-03-workspace-provision-safety.md` | `workspace.ts`, `runtime.ts` | complicated | L0+L1+L2+L2.5 |
| ERR-04 | `ERR-04-shutdown-exception-safety.md` | `runtime.ts` | clear | L0+L1 |
| ERR-05 | `ERR-05-ingest-slot-safety.md` | `ingest.ts` | clear | L0+L1 |
| RACE-01 | `RACE-01-lid-remap-event-drop.md` | `runtime.ts` | complex | L0+L1+L2+L2.5+L2.75 |
| RACE-02 | `RACE-02-perchat-concurrent-spawn.md` | `runtime.ts` | complicated | L0+L1+L2+L2.5 |
| RACE-03 | `RACE-03-sqlite-busy-orphan.md` | `session.ts` | complicated | L0+L1+L2+L2.5 |
| RACE-04 | `RACE-04-active-tool-names-isolation.md` | `runtime.ts` | complicated | L0+L1+L2+L2.5 |
| LEAK-01 | `LEAK-01-cleanup-helper.md` | `runtime.ts` | clear | L0+L1 |
| LEAK-02 | `LEAK-02-wire-crash-paths.md` | `runtime.ts` | clear | L0+L1 |
| LEAK-03 | `LEAK-03-wire-shutdown.md` | `runtime.ts` | clear | L0+L1 |
| LEAK-04 | `LEAK-04-workspace-eviction.md` | `runtime.ts`, `socket-server.ts`, `media-bridge.ts` | complicated | L0+L1+L2+L2.5 |
| LEAK-05 | `LEAK-05-shared-queue-pruning.md` | `runtime.ts`, `outbound-queue.ts` | clear | L0+L1 |
| LEAK-06 | `LEAK-06-socket-destroy.md` | `socket-server.ts`, `media-bridge.ts` | clear | L0+L1 |
| LEAK-07 | `LEAK-07-respawn-timer-tracking.md` | `runtime.ts` | clear | L0+L1 |
| LEAK-08 | `LEAK-08-sigterm-grace.md` | `session.ts` | complicated | L0+L1+L2+L2.5 |
| LEAK-09 | `LEAK-09-control-timeout.md` | `runtime.ts` | clear | L0+L1 |
| LEAK-10 | `LEAK-10-module-sets.md` | `admin.ts`, `runtime.ts`, `group-resolver.ts` | clear | L0+L1 |
| LEAK-11 | `LEAK-11-fleet-cache-pruning.md` | `health-poller.ts`, `realtime-event-poller.ts`, `routes/lines.ts` | clear | L0+L1 |
| LEAK-12 | `LEAK-12-typing-interval-guard.md` | `outbound-queue.ts` | clear | L0+L1 |
| LOG-01 | `LOG-01-critical-path-logging.md` | `runtime.ts`, `session.ts`, `session-db.ts` | clear | L0+L1 |
| LOG-02 | `LOG-02-periodic-health-stats.md` | `runtime.ts` | clear | L0+L1 |
| PERF-01 | `PERF-01-durability-prepared-stmts.md` | `durability.ts` | clear | L0+L1 |
| PERF-02 | `PERF-02-streaming-buffer-optimization.md` | `outbound-queue.ts`, `session.ts`, `jid-constants.ts` | clear | L0+L1 |
| PERF-03 | `PERF-03-turn-completion-transaction.md` | `durability.ts`, `runtime.ts` | clear | L0+L1 |

### Supporting Documentation
| File | Purpose |
|------|---------|
| `/home/q/agents/PROTOCOL.md` | WhatsApp Group Protocol v2 — roles, assignment format, result format |
| `/home/q/agents/q/CLAUDE.md` | Q's role summary, group JID, agent roster |
| `/home/q/agents/q/.claude/CLAUDE.md` | Q's detailed identity, service rules, collaboration protocol |
| `/home/q/LAB/sdlc-os/colony/conductor-prompt.md` | Full conductor session types (DISPATCH, EVALUATE, SYNTHESIZE, RECOVER, DISCOVER) |
| `/home/q/LAB/sdlc-os/colony/bridge-cli.ts` | Bridge CLI arguments and usage |
| `/home/q/LAB/sdlc-os/colony/bridge.ts` | Status transition map, safety constraints, compare-and-swap |
| `/home/q/LAB/sdlc-os/colony/backpressure.ts` | Six signal/response pairs |
| `/home/q/LAB/sdlc-os/colony/deacon.py` | Daemon lifecycle, lock files, budget enforcement |
| `/home/q/LAB/sdlc-os/colony/README.md` | Full colony operational reference (550+ lines) |

---

## 3. Agent Fleet

| Agent | Phone | Model | WhatSoup Instance | Working Dir | Use For |
|-------|-------|-------|-------------------|-------------|---------|
| **Q** | 18454174651 | Claude (native) | `whatsoup@q` | `/home/q/agents/q` | Orchestration only — NEVER assign beads to self |
| **L** | 18454433572 | Claude (native) | `whatsoup@lab` | `/home/q/agents/lab` | L0 implementation, L1 review of Codex work |
| **BES Bot** | 19297905323 | Codex | `whatsoup@besbot` | `/home/q/agents/besbot` | L0 implementation, L1 review of Claude work |
| **Shannon** | 18454179470 | Codex | `whatsoup@shandroid` | `/home/q/agents/shandroid` | L0 implementation, L1 review of Claude work |
| **Lucas** | 18459780919 | Human | N/A | N/A | Direction, decisions, tie-breaking only |

### Cross-Model Review Matrix

| L0 Runner | L1 Reviewer | L2 Oracle |
|-----------|-------------|-----------|
| L (Claude) | BES Bot or Shannon (Codex) | L (Claude) |
| BES Bot (Codex) | L (Claude) | Shannon (Codex) |
| Shannon (Codex) | L (Claude) | BES Bot (Codex) |

**Rule:** L1 reviewer MUST be a different model family than L0 implementer. L2 oracle alternates again.

---

## 4. Firing Order — Execution Plan

### Phase 1 — Correctness (5 beads, all parallel)

Fix bugs shipping in production right now. No dependencies between them.

| Bead | Assign To | Rationale |
|------|-----------|-----------|
| SILENT-01 | L | Trivial arg fix in session.ts — Claude-native for quick turnaround |
| SILENT-04 | Shannon | Clear scope, isolated in runtime.ts result handler |
| ERR-02 | BES Bot | Small guard replacement, no behavioral change |
| RACE-04 | L | Touches runtime.ts event dispatch — benefits from Claude's context |
| SILENT-02 | Shannon | Complicated (L0+L1+L2+L2.5), needs synthesized result event — start early |

**Blocked until Phase 1 complete:** Nothing. Phase 2 can begin as soon as agents free up.

### Phase 2 — Safety (5 beads, all parallel)

Error handling and exception safety. No dependencies.

| Bead | Assign To | Rationale |
|------|-----------|-----------|
| ERR-01 | BES Bot | Control session try/catch — contained scope |
| ERR-03 | L | Complicated (workspace provisioning) — benefits from Claude's fs knowledge |
| ERR-04 | Shannon | Shutdown loop wrapping — mechanical |
| ERR-05 | BES Bot | Ingest slot safety — isolated in ingest.ts |
| RACE-03 | L | SQLITE_BUSY orphan — complicated, touches session.ts spawn path |

### Phase 3 — Leak Foundation (3 beads, sequential then parallel)

**LEAK-01 must merge first.** Then LEAK-02 and LEAK-03 can run in parallel.

| Order | Bead | Assign To |
|-------|------|-----------|
| First | LEAK-01 | L (foundation helper — must be right) |
| Then parallel | LEAK-02 | BES Bot (wire into crash paths) |
| Then parallel | LEAK-03 | Shannon (wire into shutdown) |

### Phase 4 — Leak Resources (6 beads, all parallel)

| Bead | Assign To |
|------|-----------|
| LEAK-04 | L (complicated — workspace eviction) |
| LEAK-05 | Shannon (shared queue pruning) |
| LEAK-06 | BES Bot (socket destroy) |
| LEAK-07 | Shannon (respawn timer tracking) |
| LEAK-08 | L (complicated — SIGTERM grace) |
| SILENT-03 | BES Bot (per-chat crash count) |

### Phase 5 — Races (2 beads, parallel)

| Bead | Assign To | Note |
|------|-----------|------|
| RACE-01 | L | Complex — full loop (L0+L1+L2+L2.5+L2.75). Highest-risk bead. |
| RACE-02 | BES Bot | May be wontfix — needs pre-implementation verification first |

### Phase 6 — Observability (2 beads, parallel)

| Bead | Assign To |
|------|-----------|
| LOG-01 | Shannon |
| LOG-02 | BES Bot |

### Phase 7 — Performance (3 beads, PERF-01 first)

| Order | Bead | Assign To |
|-------|------|-----------|
| First | PERF-01 | L (40 prepared statements — mechanical but large) |
| Then parallel | PERF-02 | Shannon (buffer optimization) |
| Then parallel | PERF-03 | BES Bot (transaction batching — depends on PERF-01 cached stmts) |

### Phase 8 — Cleanup (4 beads, all parallel, lowest priority)

| Bead | Assign To |
|------|-----------|
| LEAK-09 | Any available |
| LEAK-10 | Any available |
| LEAK-11 | Any available |
| LEAK-12 | Any available |

---

## 5. Assignment Protocol

### Message Format (WhatsApp)

```
@18454433572 L — LEAK-01: Add cleanupPerChatState(mapKey) private method to AgentRuntime.
Files: src/runtimes/agent/runtime.ts
Branch: fix/leak-01-cleanup-helper
Acceptance: method deletes from all 6 per-chat maps, typecheck + vitest pass, 3 new tests.
Spec: docs/sdlc/active/session-leak-audit-20260406/beads/LEAK-01-cleanup-helper.md
```

### Result Processing

When an agent posts `@Q — done. LEAK-01 [commit abc1234] [summary]`:

1. **Read the commit diff** — verify it matches the spec
2. **Run bridge CLI** to advance bead status:
   ```bash
   cd /home/q/LAB/WhatSoup
   npx tsx /home/q/LAB/sdlc-os/colony/bridge-cli.ts \
     --bead-file docs/sdlc/active/session-leak-audit-20260406/beads/LEAK-01-cleanup-helper.md \
     --clone-dir /home/q/LAB/WhatSoup \
     --loop-level L0 \
     --completed \
     --project-dir /home/q/LAB/WhatSoup \
     --expected-branch main \
     --expected-status running
   ```
3. **Dispatch L1 review** to a DIFFERENT-MODEL agent:
   ```
   @19297905323 BES Bot — LEAK-01 L1 review: Review commit abc1234 against spec LEAK-01-cleanup-helper.md.
   Validate: code matches spec, tests are durable/repeatable/observable/provable, no regressions.
   Run: npm run typecheck && npx vitest run
   Spec: docs/sdlc/active/session-leak-audit-20260406/beads/LEAK-01-cleanup-helper.md
   ```
4. **On L1 pass**, advance via bridge (`--loop-level L1 --expected-status submitted`)
5. **For L0+L1 beads** (21 of 30): bead is done after L1 passes — mark merged
6. **For deeper loops**: dispatch L2, then run L2.5/L2.75 inline

### Failure Handling

If an agent reports failure or the bridge rejects:

```bash
npx tsx /home/q/LAB/sdlc-os/colony/bridge-cli.ts \
  --bead-file docs/sdlc/active/session-leak-audit-20260406/beads/LEAK-01-cleanup-helper.md \
  --clone-dir /home/q/LAB/WhatSoup \
  --loop-level L0 \
  --finding "Tests failed: src/runtimes/agent/runtime.test.ts line 42 — cleanupPerChatState not exported" \
  --cycle 1 \
  --project-dir /home/q/LAB/WhatSoup \
  --expected-branch main
```

Then re-assign with correction context. After 3 failures on the same bead, invoke backpressure: `pause_retries` → escalate to Lucas.

---

## 6. Bridge CLI Reference

**Location:** `/home/q/LAB/sdlc-os/colony/bridge-cli.ts`
**Run:** `npx tsx /home/q/LAB/sdlc-os/colony/bridge-cli.ts [args]`

### Arguments

| Arg | Required | Description |
|-----|----------|-------------|
| `--bead-file` | Yes | Path to bead markdown file |
| `--clone-dir` | Yes | Worker clone directory (or repo root) |
| `--loop-level` | Yes | `L0`, `L1`, `L2`, `L2.5`, or `L2.75` |
| `--completed` | Flag | Mark loop level as passed |
| `--finding` | No | Failure reason text |
| `--cycle` | No | Retry attempt number |
| `--project-dir` | Yes | Project root path |
| `--expected-branch` | Yes | `main` or feature branch name |
| `--expected-status` | No | Compare-and-swap guard |

### Status Transitions

| Loop Level | From Status | To Status |
|------------|-------------|-----------|
| L0 | `running` | `submitted` |
| L1 | `submitted` | `verified` |
| L2 | `verified` | `proven` |
| L2.5 | `proven` | `hardened` |
| L2.75 | `hardened` | `reliability-proven` |

### Safety Constraints Enforced by Bridge

| ID | Rule |
|----|------|
| SC-COL-14 | NULL loop level = fatal error |
| SC-COL-15 | Compare-and-swap: rejects if current status != expected |
| SC-COL-22 | Output must exist, >100 bytes, contain `<!-- BEAD_OUTPUT_COMPLETE -->` |
| SC-COL-26 | Clone must have commits beyond origin/main (L0 only) |
| SC-COL-28 | Atomic file write (temp + rename) |
| SC-COL-29 | `git add -- <specific-file>` only, never `-A` |
| SC-COL-30 | Branch verification before commit |

---

## 7. Backpressure Signals

The system self-regulates via six signal/response pairs. Monitor for these:

| Signal | Detection | Response | Action for Orchestrator |
|--------|-----------|----------|------------------------|
| `stuck_task` | Bead retried 3+ times | `pause_retries` | Stop assigning. Escalate to Lucas. |
| `oscillating_state` | Bead bounced 3+ between pass/fail | `freeze_bead` | Halt work. Manual review required. |
| `rising_escalation` | >50% findings are escalations | `slow_promotion` | Delay advancement, increase review scrutiny |
| `queue_starvation` | No events for 30+ min, no active beads | `trigger_discover` | Run discovery pass — look for blocked work |
| `low_confidence_flood` | 10+ findings with confidence <0.5 | `trigger_clustering` | Group findings, improve signal-to-noise |
| `review_disagreement` | 3+ rejections from L1+ reviewers | `escalate_to_human` | Lucas breaks the tie |

---

## 8. Deacon Integration

The Deacon is a persistent Python daemon that can automate conductor sessions. For this task it is optional — Q can operate manually via WhatsApp assignment. But if the Deacon is active:

### Service
```bash
systemctl --user status sdlc-colony-deacon
systemctl --user start sdlc-colony-deacon
journalctl --user -u sdlc-colony-deacon -f
```

### Environment Variables
| Var | Value | Purpose |
|-----|-------|---------|
| `TMUP_DB_PATH` | Path to tmup SQLite DB | Task management |
| `SDLC_PROJECT_DIR` | `/home/q/LAB/WhatSoup` | Project root |
| `CONDUCTOR_BUDGET_USD` | `10.00` | Per-session cost cap |
| `EXPECTED_BRANCH` | `main` | Git branch for verification |
| `BEAD_COST_CEILING_USD` | `50.0` | Per-bead total cost cap |

### Lock Files
| File | Purpose | Stale After |
|------|---------|-------------|
| `/tmp/sdlc-colony-conductor.lock` | Conductor session mutex | 180s |
| `/tmp/sdlc-colony-bridge.lock` | Bridge CLI mutex | 60s |

### Monitoring Files
| File | Format | Content |
|------|--------|---------|
| `~/.local/share/sdlc-os/colony-sessions.log` | JSONL | Session ID, cost, timing, bead IDs |
| `/tmp/sdlc-colony/colony-bridge.log` | JSONL | Bridge events, status transitions |

---

## 9. Monitoring & Observability During Execution

### What to Watch

| Metric | How to Check | Concern Threshold |
|--------|-------------|-------------------|
| Test suite | `cd /home/q/LAB/WhatSoup && npx vitest run 2>&1 \| tail -5` | Any failure = block merge |
| TypeScript | `npm run typecheck 2>&1 \| tail -5` | Any error = block merge |
| Active sessions | `journalctl --user -u whatsoup@q -f \| grep 'agent runtime stats'` | After LOG-02 merges, periodic stats appear |
| Map sizes | Same as above — look for `chatSessions.size`, `workspaceResources.size` | Growth > 50 without corresponding chat activity |
| Crash rate | `grep 'crashed' /home/q/LAB/WhatSoup/data/q/agent.db` via `sqlite3` | Crash spikes after merging LEAK/RACE beads |
| FD count | `ls /proc/$(pgrep -f 'whatsoup q')/fd \| wc -l` | >200 = leak in workspace resources |
| Bridge log | `tail -f /tmp/sdlc-colony/colony-bridge.log` | `action: "error"` entries |

### Post-Merge Verification Checklist

After each bead merges to main:

1. `npm run typecheck` — clean
2. `npx vitest run` — all pass (capture count, compare to 3586 baseline)
3. No new lint warnings: `npx eslint src/ --quiet 2>&1 | wc -l` should be 0 or unchanged
4. Service restart test (for behavioral changes): restart a non-Q instance and verify normal operation
5. Update bead status in `state.md` manifest

---

## 10. Tools, Skills & MCPs Available

### MCP Servers (Q has access to all)

| MCP | Tools Prefix | Use For |
|-----|-------------|---------|
| WhatSoup | `mcp__whatsoup__*` | Send/receive WhatsApp messages, manage groups |
| Google Workspace | `mcp__google-workspace__*` | Gmail, Drive, Sheets, Calendar, Docs |
| Pinecone | `mcp__pinecone__*` | Vector search, episodic memory, doc search |
| Playwright | `mcp__playwright__*` | Browser automation, screenshot, DOM inspection |

### Key Skills

| Skill | When to Use |
|-------|-------------|
| `superpowers:brainstorming` | Before any creative/design decision |
| `superpowers:test-driven-development` | When implementing any bead (agents should use this) |
| `superpowers:systematic-debugging` | When a bead fails or produces unexpected behavior |
| `superpowers:verification-before-completion` | Before claiming any bead is done |
| `superpowers:dispatching-parallel-agents` | When assigning multiple independent beads simultaneously |
| `superpowers:requesting-code-review` | When reviewing agent output at L1/L2 |
| `episodic-memory:search-conversations` | To recall past decisions about these patterns |
| `code-review:code-review` | For PR-level review of merged beads |
| `ralph-loop-v2:ralph-v2` | For hardened autonomous loops if needed |

### Key Commands

```bash
# Bridge CLI
npx tsx /home/q/LAB/sdlc-os/colony/bridge-cli.ts [args]

# Test suite
cd /home/q/LAB/WhatSoup && npx vitest run

# Typecheck
cd /home/q/LAB/WhatSoup && npm run typecheck

# WhatsApp notification
whatsapp-notify lucas "Phase 1 complete — 5/5 beads merged. Proceeding to Phase 2."

# Credential lookup
secret-tool lookup service github
secret-tool lookup service anthropic

# Service status (never restart Q)
systemctl --user status whatsoup@q
systemctl --user status whatsoup@lab
systemctl --user status whatsoup@besbot
systemctl --user status whatsoup@shandroid

# Git operations
cd /home/q/LAB/WhatSoup
git log --oneline -10
git diff main..HEAD
```

---

## 11. Critical Rules — Do Not Violate

1. **NEVER restart `whatsoup@q.service`** — you are running inside it. Self-restart kills your process, orphans MCP servers, and drops active conversations.

2. **NEVER restart other WhatSoup instances without Lucas's explicit confirmation** — each instance has active WhatsApp sessions. Restarting drops connections.

3. **ONE bead per agent at a time** — do not over-assign. Wait for result before assigning next.

4. **Every task has a bead ID** — no informal "hey can you also fix this" assignments.

5. **Cross-model review is mandatory** — if L (Claude) wrote the code, BES Bot or Shannon (Codex) reviews it. Never same-model review.

6. **Bridge is the source of truth for status** — don't manually edit bead status fields. Run the bridge CLI.

7. **Silence over noise** — don't narrate your process, don't post status tables unless asked, don't respond to terminal messages ("done", "standing by").

8. **Escalate to Lucas when you need direction, decisions, or approval** — not for routine execution.

9. **Test before merge, always** — `npm run typecheck && npx vitest run` must pass before ANY bridge advancement.

10. **Code changes require restart to take effect** — commit and push changes, tell Lucas what changed, let Lucas decide when to restart.

---

## 12. Quick-Start Sequence

To begin execution of this task:

1. **Read `state.md`** — understand the full manifest and firing order
2. **Pick Phase 1** — 5 independent beads, assign one per available agent
3. **Send assignment messages** using the format in Section 5
4. **Wait for results** — agents post `@Q — done. <bead-id> [commit] [summary]`
5. **Process each result:**
   - Read the diff
   - Run bridge CLI for L0
   - Assign L1 review to a different-model agent
   - Run bridge CLI for L1
   - For L0+L1 beads: mark as merged in state.md
   - For deeper beads: continue through loop levels
6. **After Phase 1 complete:** Begin Phase 2 (agents freed from Phase 1 can start Phase 2 beads immediately)
7. **Continue through all 8 phases** per the firing order
8. **After all beads merged:** Create `delivery.md` with final verification results

---

## 13. File Quick-Reference

```
/home/q/LAB/WhatSoup/
├── docs/sdlc/active/session-leak-audit-20260406/
│   ├── state.md                          # Master manifest
│   ├── orchestrator-handoff.md           # This document
│   └── beads/
│       ├── SILENT-01-spawn-per-turn-db-args.md
│       ├── SILENT-02-spawn-per-turn-exit-no-result.md
│       ├── SILENT-03-global-crash-count.md
│       ├── SILENT-04-usage-limit-dirty-state.md
│       ├── ERR-01-control-slot-lock.md
│       ├── ERR-02-durability-null-guard.md
│       ├── ERR-03-workspace-provision-safety.md
│       ├── ERR-04-shutdown-exception-safety.md
│       ├── ERR-05-ingest-slot-safety.md
│       ├── RACE-01-lid-remap-event-drop.md
│       ├── RACE-02-perchat-concurrent-spawn.md
│       ├── RACE-03-sqlite-busy-orphan.md
│       ├── RACE-04-active-tool-names-isolation.md
│       ├── LEAK-01-cleanup-helper.md
│       ├── LEAK-02-wire-crash-paths.md
│       ├── LEAK-03-wire-shutdown.md
│       ├── LEAK-04-workspace-eviction.md
│       ├── LEAK-05-shared-queue-pruning.md
│       ├── LEAK-06-socket-destroy.md
│       ├── LEAK-07-respawn-timer-tracking.md
│       ├── LEAK-08-sigterm-grace.md
│       ├── LEAK-09-control-timeout.md
│       ├── LEAK-10-module-sets.md
│       ├── LEAK-11-fleet-cache-pruning.md
│       ├── LEAK-12-typing-interval-guard.md
│       ├── LOG-01-critical-path-logging.md
│       ├── LOG-02-periodic-health-stats.md
│       ├── PERF-01-durability-prepared-stmts.md
│       ├── PERF-02-streaming-buffer-optimization.md
│       └── PERF-03-turn-completion-transaction.md
├── src/runtimes/agent/
│   ├── runtime.ts                        # Primary target (~2500 lines)
│   ├── session.ts                        # Session lifecycle (~1200 lines)
│   ├── outbound-queue.ts                 # Queue + delivery (~650 lines)
│   ├── media-bridge.ts                   # Media bridge lifecycle
│   ├── session-db.ts                     # DB schema + CRUD
│   ├── session-classifier.ts             # Stale session reaper
│   └── turn-queue.ts                     # Shared-mode turn serializer
├── src/mcp/
│   ├── socket-server.ts                  # MCP Unix socket server
│   └── registry.ts                       # Tool registry + schema
├── src/core/
│   ├── workspace.ts                      # Workspace provisioning
│   ├── durability.ts                     # Durability engine (40 stmts)
│   ├── ingest.ts                         # Message ingest pipeline
│   ├── admin.ts                          # Admin commands + replayedIds
│   ├── jid-constants.ts                  # canonicalizeChatJid
│   └── retry.ts                          # jitteredDelay backoff
├── src/fleet/
│   ├── health-poller.ts                  # Fleet health polling
│   ├── realtime-event-poller.ts          # DB snapshot diffs
│   ├── group-resolver.ts                 # attemptedCache
│   └── routes/lines.ts                   # 5 stats caches
└── src/transport/
    ├── connection.ts                     # WhatsApp connection
    └── presence-cache.ts                 # LRU presence (clean)

/home/q/LAB/sdlc-os/colony/
├── bridge-cli.ts                         # Bridge CLI entry point
├── bridge.ts                             # Status transition engine
├── backpressure.ts                       # 6 signal/response pairs
├── deacon.py                             # Daemon (systemd)
├── conductor-prompt.md                   # Conductor behavior spec
├── state-ledger.ts                       # CRUD + rehydration
├── types.ts                              # Type definitions
└── README.md                             # Full operational reference

/home/q/agents/
├── PROTOCOL.md                           # WhatsApp Group Protocol v2
├── q/                                    # Q orchestrator
│   ├── CLAUDE.md                         # Role summary
│   └── .claude/CLAUDE.md                 # Detailed instructions
├── lab/                                  # L agent
├── besbot/                               # BES Bot agent
└── shandroid/                            # Shannon agent
```

---

*End of handoff. Begin with Phase 1.*
