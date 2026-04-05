# SDLC Task: P0 Production Blockers

> **ID:** p0-production-blockers-20260330
> **Created:** 2026-03-30
> **Complexity:** Moderate
> **Phase:** Frame → Execute
> **Source:** `docs/handoff-2026-03-30-baileys-parity.md`

## Objective

Fix the three P0 blockers preventing WhatSoup production cutover from legacy whatsapp-bot.

## Beads

| # | Bead | Status | Complexity | Approach |
|---|------|--------|------------|----------|
| 1 | Media bridge port | pending | moderate | Port legacy `media-bridge.ts` (246 LOC), adapt to WhatSoup types, wire into `AgentRuntime.start()` |
| 2 | Per-chat shared state race | pending | trivial | Remove `this.session`/`this.queue` shared field mutations from `ensureSessionAndQueue*`, route all reads through maps |
| 3 | Enrichment retry durability | pending | moderate | Migration 8: add `enrichment_retries` column, persist counters in poller, add admin re-enrich tool |

## Key Decisions

- Bead 1: Port verbatim then adapt (don't rewrite from scratch — legacy code is clean)
- Bead 2: Direct fix, no SDLC ceremony (surgical, <1hr, handoff agrees)
- Bead 3: Schema change requires migration + poller refactor + admin MCP tool

## Risk Register

- Media bridge: WhatSoup's `Messenger` type may differ from legacy `OutboundMedia` — verify interface compatibility first
- Race condition: Removing shared refs may break `/status` and `/new` commands that rely on them — audit all `this.session`/`this.queue` reads
- Enrichment: Migration must be idempotent (pattern established in migrations 1-7)

## Completion Criteria

- [ ] Media bridge starts with AgentRuntime, Claude Code subprocesses can send media
- [ ] No shared mutable state in per-chat event paths
- [ ] Enrichment retries survive process restart, admin can re-enrich failed messages
- [ ] All existing 1,923 tests still pass
- [ ] New tests for each bead
