# Task: heal-reliability-fixes-20260401

**Objective:** Fix three reliability issues from the 2026-03-31 session: zombie session accumulation (P0), control session timeout (P1), and degradation timer wiring (P4).

**Profile:** REPAIR
**Complexity:** Complicated (3 independent Clear-domain beads)
**Created:** 2026-04-01

## Phase Log

| Phase | Status | Notes |
|-------|--------|-------|
| Normalize | complete | Clean entry, no recovery needed |
| Frame | skipped | REPAIR profile, well-specified fixes |
| Scout | skipped | Root-caused in prior session |
| Architect | skipped | Fix paths are known |
| Execute | complete | P0+P4 parallel, then P1 serialized |
| Synthesize | complete | All deterministic checks passed |

## Beads

| ID | Status | Type | Domain | Files |
|----|--------|------|--------|-------|
| p0-zombie-sessions | merged | implement | clear | runtime.ts |
| p1-control-timeout | merged | implement | clear | runtime.ts |
| p4-degradation-timer | merged | implement | clear | main.ts |
