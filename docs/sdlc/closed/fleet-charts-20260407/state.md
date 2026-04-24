# SDLC Task: Fleet Charts Expansion

**Task ID:** fleet-charts-20260407
**Created:** 2026-04-07
**Branch:** feat/fleet-charts
**Profile:** BUILD
**Complexity:** COMPLEX
**Cynefin:** Complicated (most beads) / Clear (chart components)
**Status:** deferred — Phase 4-Execute was incomplete when the folder was moved to closed/. Beads 01-11 remain unimplemented. Shelved, not finished.

## Source Documents

| Document | Path |
|----------|------|
| Design spec | `docs/superpowers/specs/2026-04-07-soup-kitchen-fleet-charts.md` |
| Implementation plan | `docs/superpowers/plans/2026-04-07-fleet-charts.md` |
| Team kickoff | `docs/superpowers/handoffs/2026-04-07-fleet-charts-kickoff.md` |
| Project statement | `docs/superpowers/handoffs/2026-04-07-fleet-charts-project-statement.md` |
| SOP | `docs/superpowers/handoffs/2026-04-07-fleet-charts-sop.md` |
| Guidelines | `docs/superpowers/handoffs/2026-04-07-fleet-charts-guidelines.md` |

## Phase Log

| Phase | Status | Notes |
|-------|--------|-------|
| 0-Normalize | complete | Clean start from main. Spec/plan/kickoff already written. |
| 1-Frame | skipped | Complete spec exists with objective, scope, constraints, success criteria |
| 2-Scout | skipped | Codebase fully explored during spec authoring session |
| 3-Architect | skipped | 11-task bead manifest derived from locked implementation plan |
| 4-Execute | **active** | Backend tasks 1-5 sequential, frontend 6-11 |
| 4.5-Harden | pending | |
| 5-Synthesize | pending | |

## Bead Manifest

| Bead | Type | Task | Domain | Complexity Source | Deps | Status |
|------|------|------|--------|-------------------|------|--------|
| B01 | implement | Migration 18 | complicated | accidental | — | pending |
| B02 | implement | Token event writer + ended_at | complicated | essential | B01 | pending |
| B03 | implement | Extended metrics collector | complicated | essential | B02 | pending |
| B04 | implement | Bucket densification | complicated | essential | B03 | pending |
| B05 | implement | Fleet + per-line API routes | complicated | essential | B04 | pending |
| B06 | implement | Types + chart-utils + sparklines | clear | accidental | B05 | pending |
| B07 | implement | ChartPanel wrapper | complicated | essential | B06 | pending |
| B08 | implement | FleetMetricsChart media | clear | accidental | B07 | pending |
| B09 | implement | FleetTokenChart | clear | accidental | B07 | pending |
| B10 | implement | FleetSessionChart | clear | accidental | B07 | pending |
| B11 | implement | SoupKitchen integration | complicated | essential | B08-B10 | pending |

## Quality Gates

### Backend Completion (after B05)
- [ ] All 5 backend tasks committed
- [ ] `npx vitest run --pool=forks` passes
- [ ] `npm run typecheck` passes
- [ ] Fleet server restarts cleanly
- [ ] API returns tokenUsage, sessionActivity, meta keys

### Frontend Completion (after B11)
- [ ] `npx eslint src/ --max-warnings 0` passes (0 violations)
- [ ] `npx tsc --noEmit` passes (0 type errors)
- [ ] `npm run build` succeeds

## Execution Notes

- Subagent-driven development: Sonnet runners execute each bead
- TDD throughout: red-green-commit cycle per task
- B08-B10 parallelizable after B07 completes
