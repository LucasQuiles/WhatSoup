# Task: Agent Runtime Hardening — Leaks, Errors, Races, Observability, Performance

**ID:** session-leak-audit-20260406
**Created:** 2026-04-06
**Status:** complete
**Profile:** REPAIR
**Complexity:** complex
**Cynefin:** complex
**Parent task:** none

## Objective

Comprehensive hardening of the WhatSoup agent runtime based on two rounds of exhaustive audit (9 specialized subagents). Addresses session/resource leaks, error handling gaps, race conditions, silent failures, logging blind spots, and performance inefficiencies. Every finding is traced to exact file path and line number.

## Success Criteria

1. All per-chat state maps cleaned up on every session-end path (crash, reset, shutdown)
2. Workspace resources evicted after idle timeout; shared-mode queues pruned
3. No fire-and-forget timers survive shutdown; all cleanup exception-safe
4. Critical error paths have try/catch with proper cleanup and logging
5. Race conditions in session lifecycle addressed (LID remap, concurrent spawn, SQLITE_BUSY)
6. Silent failures surfaced (spawn-per-turn DB args, non-zero exit, usage limit dirty state)
7. Periodic health stats emitted; critical operations logged with structured fields
8. SQLite prepared statements cached; hot-path allocations optimized
9. All 3586+ existing tests continue to pass; zero new lint/typecheck errors

## Source

- **Pass 1** (2026-04-06): 4 subagents audited Map/Set/timer/FD lifecycle across all runtime layers
- **Pass 2** (2026-04-06): 5 subagents audited logging, error handling, race conditions, silent failures, performance
- Total: 9 specialized audit agents, ~130 individual findings consolidated into 30 beads

## Loop Depth Distribution

Every bead has assigned loop depth based on Cynefin domain and turbulence:

| Loop Depth | Count | Beads |
|------------|-------|-------|
| `L0 + L1` (clear, no behavioral change) | 21 | LEAK-01→03, LEAK-05→07, LEAK-09→12, ERR-01, ERR-02, ERR-04, ERR-05, SILENT-01, SILENT-04, LOG-01, LOG-02, PERF-01→03 |
| `L0 + L1 + L2` (clear, behavioral change) | 1 | SILENT-03 |
| `L0 + L1 + L2 + L2.5` (complicated) | 7 | ERR-03, LEAK-04, LEAK-08, RACE-02, RACE-03, RACE-04, SILENT-02 |
| `L0 + L1 + L2 + L2.5 + L2.75` (complex, full loop) | 1 | RACE-01 |

**Total loop executions:** 21×2 + 1×3 + 7×4 + 1×5 = 78 loop-level passes across all beads.

## Bridge Integration

Each bead is bridge-compatible:
- **Status lifecycle:** `pending` → `running` → `submitted` → `verified` → `proven` → `hardened` → `reliability-proven` → `merged`
- **Compare-and-swap:** Bridge rejects advancement if bead not in expected status
- **Output sentinel:** Workers must produce `bead-output.md` with `<!-- BEAD_OUTPUT_COMPLETE -->`
- **Cross-model review:** L1 always uses a different model than L0
- **Advance command:** `npx tsx colony/bridge-cli.ts --bead-file <path> --loop-level <level> --completed --expected-status <status>`

## Phase Log

| Phase | Started | Status |
|-------|---------|--------|
| Normalize | 2026-04-06 | complete |
| Frame | 2026-04-06 | complete |
| Architect | 2026-04-06 | complete |
| Execute | 2026-04-06 | complete |
| Synthesize | 2026-04-06 | complete |

---

## Firing Order

Beads are ordered by dependency, severity, and risk. Execute in phases:

### Phase 1 — Correctness: Silent Bugs & Data Corruption (no dependencies, fix first)

These are bugs shipping right now. Fix before anything else.

| # | Bead | Severity | Rationale |
|---|------|----------|-----------|
| 1 | **SILENT-01** | HIGH | Spawn-per-turn `createSession` passes wrong args — every OpenCode row corrupted |
| 2 | **SILENT-02** | MEDIUM | Spawn-per-turn non-zero exit synthesizes no result — inbound seq stuck |
| 3 | **SILENT-04** | MEDIUM | Usage limit `break` leaves dirty state (inbound seq, typing, toolNames) |
| 4 | **RACE-04** | MEDIUM | `activeToolNames` shared across sessions — cross-chat corruption |
| 5 | **ERR-02** | HIGH | `this.durability!` non-null assertion crashes startup |

All 5 are independent — can execute in parallel.

### Phase 2 — Safety: Error Handling & Exception Safety (no dependencies)

Prevent cascading failures and permanent lockouts.

| # | Bead | Severity | Rationale |
|---|------|----------|-----------|
| 6 | **ERR-01** | HIGH | Control session slot permanently locked on mkdirSync failure |
| 7 | **ERR-03** | HIGH | Workspace provisioning fs ops not in try/catch — partial state |
| 8 | **ERR-04** | MEDIUM | Shutdown cleanup not exception-safe — first failure skips rest |
| 9 | **ERR-05** | HIGH | Ingest handler slot counter corruption on unexpected throw |
| 10 | **RACE-03** | HIGH | SQLITE_BUSY orphans spawned child process |

All 5 are independent — can execute in parallel.

### Phase 3 — Leaks: Per-Chat State Lifecycle (LEAK-01 first, then 02+03 parallel)

Foundation for all leak fixes.

| # | Bead | Severity | Rationale |
|---|------|----------|-----------|
| 11 | **LEAK-01** | CRITICAL | Foundation: `cleanupPerChatState(mapKey)` helper |
| 12 | **LEAK-02** | CRITICAL | Wire cleanup into 4 crash/delete sites *(depends on LEAK-01)* |
| 13 | **LEAK-03** | CRITICAL | Wire cleanup into `shutdown()` *(depends on LEAK-01)* |

LEAK-02 and LEAK-03 can run in parallel after LEAK-01 merges.

### Phase 4 — Leaks: Resource Lifecycle (all independent)

| # | Bead | Severity | Rationale |
|---|------|----------|-----------|
| 14 | **LEAK-04** | CRITICAL | Workspace resource idle eviction (FD exhaustion risk) |
| 15 | **LEAK-05** | HIGH | Shared-mode outbound queue pruning |
| 16 | **LEAK-06** | HIGH | Socket server `stop()` destroys active connections |
| 17 | **LEAK-07** | HIGH | Track and cancel auto-respawn timers |
| 18 | **LEAK-08** | HIGH | SIGTERM grace period with SIGKILL fallback |
| 19 | **SILENT-03** | MEDIUM | Per-chat crash count (not global) |

All 6 are independent — can execute in parallel.

### Phase 5 — Races & Edge Cases (independent)

| # | Bead | Severity | Rationale |
|---|------|----------|-----------|
| 20 | **RACE-01** | HIGH | Mid-turn LID remapping drops all remaining events |
| 21 | **RACE-02** | HIGH* | Non-sandboxed per_chat concurrent spawn *(needs pre-impl verification)* |

Both are independent.

### Phase 6 — Observability (independent, low risk)

| # | Bead | Severity | Rationale |
|---|------|----------|-----------|
| 22 | **LOG-01** | MEDIUM | Critical path logging gaps (14 sites) |
| 23 | **LOG-02** | MEDIUM | Periodic health stats emission |

Both independent, can run in parallel.

### Phase 7 — Performance (PERF-01 first, then 02+03 parallel)

| # | Bead | Severity | Rationale |
|---|------|----------|-----------|
| 24 | **PERF-01** | HIGH | Cache DurabilityEngine prepared statements (40 statements) |
| 25 | **PERF-02** | MEDIUM | Streaming buffer + stdout buffer + canonicalize dedup |
| 26 | **PERF-03** | MEDIUM | Batch turn-completion SQLite writes *(depends on PERF-01)* |

### Phase 8 — Cleanup (independent, lowest priority)

| # | Bead | Severity | Rationale |
|---|------|----------|-----------|
| 27 | **LEAK-09** | MEDIUM | Cancel `controlSessionTimeout` in shutdown |
| 28 | **LEAK-10** | MEDIUM | Module-level unbounded Set eviction |
| 29 | **LEAK-11** | LOW | Fleet cache pruning for deleted instances |
| 30 | **LEAK-12** | LOW | Typing interval race guard |

All 4 independent.

### Parallelization Summary

- **Phase 1**: 5 beads in parallel
- **Phase 2**: 5 beads in parallel
- **Phase 3**: LEAK-01 → (LEAK-02 ∥ LEAK-03)
- **Phase 4**: 6 beads in parallel
- **Phase 5**: 2 beads in parallel
- **Phase 6**: 2 beads in parallel
- **Phase 7**: PERF-01 → (PERF-02 ∥ PERF-03)
- **Phase 8**: 4 beads in parallel

Phases 1-2 should be prioritized. Phases 3-8 can overlap once Phase 1-2 are stable.

---

## Bead Manifest

### Phase 1 — Correctness: Silent Bugs & Data Corruption
| Bead | Type | Status | Runner | Severity | Notes |
|------|------|--------|--------|----------|-------|
| [SILENT-01](beads/SILENT-01-spawn-per-turn-db-args.md) | implement | pending | — | HIGH | `createSession` passes instanceName as cwd, omits chatJid |
| [SILENT-02](beads/SILENT-02-spawn-per-turn-exit-no-result.md) | implement | pending | — | MEDIUM | Non-zero exit: no result event, inbound seq stuck |
| [SILENT-04](beads/SILENT-04-usage-limit-dirty-state.md) | implement | pending | — | MEDIUM | Usage limit break skips turn cleanup |
| [RACE-04](beads/RACE-04-active-tool-names-isolation.md) | implement | pending | — | MEDIUM | activeToolNames shared across sessions |
| [ERR-02](beads/ERR-02-durability-null-guard.md) | implement | pending | — | HIGH | `this.durability!` crashes on null |

### Phase 2 — Safety: Error Handling & Exception Safety
| Bead | Type | Status | Runner | Severity | Notes |
|------|------|--------|--------|----------|-------|
| [ERR-01](beads/ERR-01-control-slot-lock.md) | implement | pending | — | HIGH | Control slot permanently locked on mkdirSync failure |
| [ERR-03](beads/ERR-03-workspace-provision-safety.md) | implement | pending | — | HIGH | Workspace provisioning not exception-safe |
| [ERR-04](beads/ERR-04-shutdown-exception-safety.md) | implement | pending | — | MEDIUM | Shutdown cleanup cascading failure |
| [ERR-05](beads/ERR-05-ingest-slot-safety.md) | implement | pending | — | HIGH | Ingest slot counter corruption |
| [RACE-03](beads/RACE-03-sqlite-busy-orphan.md) | implement | pending | — | HIGH | SQLITE_BUSY orphans child process |

### Phase 3 — Leaks: Per-Chat State Lifecycle
| Bead | Type | Status | Runner | Severity | Notes |
|------|------|--------|--------|----------|-------|
| [LEAK-01](beads/LEAK-01-cleanup-helper.md) | implement | pending | — | CRITICAL | Foundation: `cleanupPerChatState(mapKey)` |
| [LEAK-02](beads/LEAK-02-wire-crash-paths.md) | implement | pending | — | CRITICAL | Wire into 4 crash/delete sites |
| [LEAK-03](beads/LEAK-03-wire-shutdown.md) | implement | pending | — | CRITICAL | Wire into shutdown |

### Phase 4 — Leaks: Resource Lifecycle
| Bead | Type | Status | Runner | Severity | Notes |
|------|------|--------|--------|----------|-------|
| [LEAK-04](beads/LEAK-04-workspace-eviction.md) | implement | pending | — | CRITICAL | Workspace resource idle eviction |
| [LEAK-05](beads/LEAK-05-shared-queue-pruning.md) | implement | pending | — | HIGH | Shared-mode queue pruning |
| [LEAK-06](beads/LEAK-06-socket-destroy.md) | implement | pending | — | HIGH | Socket stop destroys connections |
| [LEAK-07](beads/LEAK-07-respawn-timer-tracking.md) | implement | pending | — | HIGH | Track respawn timers |
| [LEAK-08](beads/LEAK-08-sigterm-grace.md) | implement | pending | — | HIGH | SIGTERM→SIGKILL escalation |
| [SILENT-03](beads/SILENT-03-global-crash-count.md) | implement | pending | — | MEDIUM | Per-chat crash count |

### Phase 5 — Races & Edge Cases
| Bead | Type | Status | Runner | Severity | Notes |
|------|------|--------|--------|----------|-------|
| [RACE-01](beads/RACE-01-lid-remap-event-drop.md) | implement | pending | — | HIGH | Mid-turn LID remap drops events |
| [RACE-02](beads/RACE-02-perchat-concurrent-spawn.md) | implement | pending | — | HIGH* | Concurrent spawn race *(needs verification)* |

### Phase 6 — Observability
| Bead | Type | Status | Runner | Severity | Notes |
|------|------|--------|--------|----------|-------|
| [LOG-01](beads/LOG-01-critical-path-logging.md) | implement | pending | — | MEDIUM | 14 logging gap sites |
| [LOG-02](beads/LOG-02-periodic-health-stats.md) | implement | pending | — | MEDIUM | Periodic stats emission |

### Phase 7 — Performance
| Bead | Type | Status | Runner | Severity | Notes |
|------|------|--------|--------|----------|-------|
| [PERF-01](beads/PERF-01-durability-prepared-stmts.md) | implement | pending | — | HIGH | Cache 40 prepared statements |
| [PERF-02](beads/PERF-02-streaming-buffer-optimization.md) | implement | pending | — | MEDIUM | Buffer allocation optimization |
| [PERF-03](beads/PERF-03-turn-completion-transaction.md) | implement | pending | — | MEDIUM | Batch 5 writes into 1 transaction |

### Phase 8 — Cleanup
| Bead | Type | Status | Runner | Severity | Notes |
|------|------|--------|--------|----------|-------|
| [LEAK-09](beads/LEAK-09-control-timeout.md) | implement | pending | — | MEDIUM | Control session timeout in shutdown |
| [LEAK-10](beads/LEAK-10-module-sets.md) | implement | pending | — | MEDIUM | Module-level Set eviction |
| [LEAK-11](beads/LEAK-11-fleet-cache-pruning.md) | implement | pending | — | LOW | Fleet cache pruning |
| [LEAK-12](beads/LEAK-12-typing-interval-guard.md) | implement | pending | — | LOW | Typing interval guard |

---

## Severity Distribution

| Severity | Count | Beads |
|----------|-------|-------|
| CRITICAL | 3 | LEAK-01, LEAK-02, LEAK-03, LEAK-04 |
| HIGH | 13 | SILENT-01, ERR-01, ERR-02, ERR-03, ERR-05, RACE-01, RACE-02, RACE-03, LEAK-05, LEAK-06, LEAK-07, LEAK-08, PERF-01 |
| MEDIUM | 11 | SILENT-02, SILENT-03, SILENT-04, RACE-04, ERR-04, LOG-01, LOG-02, LEAK-09, LEAK-10, PERF-02, PERF-03 |
| LOW | 2 | LEAK-11, LEAK-12 |

## Audit Coverage Map

| Layer | Files | Beads |
|-------|-------|-------|
| Agent Runtime | `runtime.ts` | LEAK-01→03, LEAK-04→05, LEAK-07, LEAK-09, ERR-01, ERR-04, RACE-01, RACE-02, RACE-04, SILENT-03, SILENT-04, LOG-01, LOG-02, PERF-02 |
| Session Manager | `session.ts` | LEAK-08, RACE-03, SILENT-01, SILENT-02, PERF-02 |
| Outbound Queue | `outbound-queue.ts` | LEAK-05, LEAK-12, PERF-02 |
| Socket Server | `socket-server.ts` | LEAK-06 |
| Media Bridge | `media-bridge.ts` | LEAK-06 |
| Workspace | `workspace.ts` | ERR-03 |
| Ingest | `ingest.ts` | ERR-05 |
| Durability | `durability.ts` | ERR-02, PERF-01, PERF-03 |
| JID Constants | `jid-constants.ts` | PERF-01, PERF-02 |
| Session DB | `session-db.ts` | SILENT-01, LOG-01 |
| Fleet | `health-poller.ts`, `realtime-event-poller.ts`, `routes/lines.ts` | LEAK-11 |
| Core | `admin.ts`, `group-resolver.ts` | LEAK-10 |

## Workers

- **Q**: Orchestrator — spec authoring, assignment, review
- **L / BES Bot / Shannon**: Implementation agents — one bead per agent, cross-model review

## Key Artifacts

- **Pass 1 audit**: 4 subagents — Map/Set/timer/FD lifecycle (2026-04-06)
- **Pass 2 audit**: 5 subagents — logging, errors, races, silent failures, performance (2026-04-06)
- Primary file: `src/runtimes/agent/runtime.ts` (~2500 lines)
- Supporting: `session.ts`, `socket-server.ts`, `media-bridge.ts`, `outbound-queue.ts`, `durability.ts`, `workspace.ts`, `ingest.ts`, `session-db.ts`
