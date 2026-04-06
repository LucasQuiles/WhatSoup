# Task: Duplicate Function Consolidation

**ID:** dedup-consolidation-20260404
**Profile:** BUILD
**Complexity:** Complicated
**Created:** 2026-04-04
**Status:** Execute

## Mission Brief

Consolidate semantic and structural duplicates identified by 16-agent deep scan (696 functions, 20 categories). Prioritized by LOC savings and risk reduction. ~1,650 lines estimated removable.

## Scope

Priority 1 (Quick Wins): 10 items, ~224 lines
Priority 2 (Medium): 9 items, ~1,466 lines
Full spec: docs/duplicates-report.md

## Success Criteria

1. All Priority 1 items consolidated — zero regression
2. Priority 2 items 2.1 (MCP factory), 2.5 (validation dedup), 2.6 (cache helper), 2.7 (validation constants) consolidated
3. Build passes, all 3,114+ tests pass
4. No new `as any` casts introduced

## Phase Log

- Phase 0 (Normalize): Clean state, no prior SDLC artifacts for this task
- Phase 1 (Frame): Skipped — task is well-specified from duplicate report  
- Phase 2 (Scout): Duplicate report serves as discovery brief (16 agents, 2 waves)
- Phase 3 (Architect): Bead manifest created from prioritized findings
- Phase 4 (Execute): In progress
