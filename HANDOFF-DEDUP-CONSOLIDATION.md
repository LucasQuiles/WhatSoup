# Handoff: Dedup Consolidation + Codex Transport + Colony Architecture

**From:** L (lab agent) — full session covering 3 major work streams
**Date:** 2026-04-04
**Branch:** `main` (pushed)
**HEAD:** `c6f6499`
**WhatSoup Tests:** 145 files, 3,167 passed, 0 failed
**sdlc-os Colony Tests:** 13 files, 128 TS + 84 Python = 212 tests, 0 failed

---

## What This Session Accomplished

### Stream 1: Dedup Consolidation Complete (13 commits)

All 9 remaining items from the prior handoff addressed: 6 implemented, 3 deferred with rationale.

#### Completed Items

| Item | What | Commit | Impact |
|------|------|--------|--------|
| 1.4 | `upsertAllowed` removed, tests migrated to `upsertAccess` | `db30d40` | dead code removed |
| 1.5 | `extractPhone` alias removed, 7 test files migrated to `extractLocal` | `77a8404` | dead code removed |
| 2.1 | Sock tool factory for 6 MCP tool files | `93e7bf1`..`1555b8e` | 3155 -> 1684 lines |
| 2.3 | `buildBaseChildEnv` extracted as shared module | `6258b78` | 3 copies -> 1 |
| 3.1 | `ExtendedBaileysSocket` interface, 70 `(sock as any)` casts eliminated | `1932ecf`, `05e3d7b` | type safety |
| 3.4 | Tool mapper switch/if-chains -> lookup tables | `fd32167` | cleaner dispatch |

#### Deferred with Rationale

| Item | What | Why |
|------|------|-----|
| 2.2 | HTTP API provider base class | Anthropic and OpenAI APIs are diverging (tool schemas, streaming format); forced abstraction would create maintenance burden |
| 2.4 | Codex legacy parser consolidation | Legacy format still used in production session resume; removing it breaks crash recovery |
| 3.2 | Database migration helper | Low ROI; migration code runs once per schema version |

### Stream 2: Codex Transport Layer Gaps Fixed (10 commits + 5 hardening)

Systematic closure of transport-layer gaps between WhatSoup and the Codex CLI provider.

| What | Commit | Category |
|------|--------|----------|
| Token tracking via `thread/tokenUsage/updated` -> `token_usage` event | `c964579` | fix |
| Provider-aware system prompt identity | `80e69dc` | fix |
| Codex thread ID persisted for crash resume | `5aa13e7` | fix |
| OpenCode parser concurrency-safe via factory pattern | `ab86b2d` | fix |
| MCP config centralized via mcp-bridge module | `bfd147e` | refactor |
| Event-driven ready signals (replaced busy-wait polling) | `222583a` | fix |
| ProviderBudget wired into session manager | `60f753b` | feat |
| Dead OpenCodeAdapter class removed | `4156831` | refactor |
| Codex session resume on crash | `d003431` | feat |
| Approval pre-filter resilient to JSON key ordering | `a427b6d` | fix |
| Pessimistic request counting (budget burst bypass) | `33d3420` | fix |
| Double turn-completion bug fixed (`token_usage` event type) | `24aa39a` | fix |
| Budget + burst limit test coverage | `520240a`, `41ab6d1` | test |

### Stream 3: Colony Orchestration Architecture (spec + 17 implementation commits)

Full architecture spec (1,300 lines, 13 design principles) plus phased implementation.

**Spec:** `c6f6499` — MCP feature gaps design spec with 4 sub-projects

**Phase 1 — Foundation:**
- Events DB, findings store, cost enforcement
- Conductor journal, bootstrap sequence
- Commits: `1396f95`, `78a3430`

**Phase 2 — Integration:**
- Bridge events, Brick hooks, cross-model review protocol
- DISCOVER session type
- Commits: `612e705`, `62f5530`, `d2f55ef`

**Phase 3 — Autonomy:**
- State ledger rehydration, backpressure control loop
- Boundary detection, adjacency discovery, promotion pattern matching
- Commits: `45ef7b2`, `a9905d6`

---

## Current State

- All code pushed to `origin/main`
- WhatSoup: 145 test files, 3,167 tests, 0 failures
- sdlc-os colony: 13 test files, 212 tests (128 TS + 84 Python), 0 failures
- Build: vite build exit 0, lint clean

---

## What Remains

### Colony E2E
- All modules built and unit-tested but not yet exercised end-to-end with a real tmux grid and live workers
- Next step: run a real colony session and tune parameters

### Spec Open Questions (deferred)
- Local model triage: when to use Haiku vs Sonnet vs Opus for colony sub-tasks
- Merge coordination: how parallel workers reconcile conflicting file edits
- Cross-workstream learning: propagating findings from one colony session to the next

### Phase 3 Autonomy Tuning
- Backpressure thresholds, promotion confidence scores, and boundary detection sensitivity all need real-world exercise to calibrate

### Dedup Leftovers (low priority)
- Priority 3 items (3.2, 3.3) and Priority 4 investigate items from the original scan
- These are small wins; tackle opportunistically

---

## Verification Commands

```bash
# Full WhatSoup regression
cd /home/q/LAB/WhatSoup && npx vitest run 2>&1 | tail -5

# Build check
cd /home/q/LAB/WhatSoup/console && npx vite build 2>&1 | tail -5

# sdlc-os colony tests
cd /home/q/LAB/sdlc-os && npx vitest run 2>&1 | tail -5
cd /home/q/LAB/sdlc-os && python -m pytest 2>&1 | tail -5
```

---

## Key Files Created/Modified This Session

| File | Purpose |
|------|---------|
| `src/mcp/tools/sock-tool-factory.ts` | Generic factory for MCP sock tools |
| `src/mcp/types.ts` (`ExtendedBaileysSocket`) | Typed interface for Baileys methods used by MCP tools |
| `src/runtimes/agent/providers/child-env.ts` | Shared `buildBaseChildEnv()` |
| `src/runtimes/agent/providers/mcp-bridge.ts` | Centralized MCP config generation |
| `docs/colony-orchestration-spec.md` | 1,300-line colony architecture spec |
