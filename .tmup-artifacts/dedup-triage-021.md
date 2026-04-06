# Dedup consolidation triage (task 021)

Date checked: 2026-04-05
Repo: /home/q/LAB/WhatSoup
Task: dedup-consolidation-20260404

## Evidence checked
- docs/sdlc/active/dedup-consolidation-20260404/state.md
- HANDOFF-DEDUP-CONSOLIDATION.md
- docs/duplicates-report.md
- git log on main for 2026-04-04 and 2026-04-05

## Git log result
- No dedup-related commits exist on 2026-04-05.
- Latest dedup/handoff commits are on 2026-04-04.
- Latest dedup-adjacent doc update: 770f1a4 (2026-04-04 21:57:59 -0400) `docs: update handoff doc reflecting full session work`.
- Latest dedup implementation commits in the updated handoff: db30d40, 77a8404, 93e7bf1..1555b8e, 6258b78, 1932ecf, 05e3d7b, fd32167.

## Classification
DONE
- Priority 1: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10
- Priority 2: 2.1, 2.3, 2.5, 2.6, 2.7, 2.8, 2.9
- Priority 3: 3.1, 3.4

PARTIAL
- 2.2 HTTP API provider base class: explicitly deferred with rationale in updated handoff, not implemented.
- 2.4 Codex legacy parser consolidation: explicitly deferred with rationale in updated handoff, not implemented.
- 3.2 Database migration helper: explicitly deferred with rationale in updated handoff; also listed in dedup leftovers.

PENDING
- 3.3 Pinecone search simplification: still listed in dedup leftovers, no completion evidence.
- 4.1 formatAge vs formatRelative
- 4.2 ensureSessionAndQueue sync/async variants
- 4.3 getActiveQueue vs getQueueForChat
- 4.4 fleet route param cast wrappers
- 4.5 execFileAsync native replacement
- 4.6 mock data log entry factory
- SDLC archival bookkeeping: state.md still says `Status: Execute`, Phase 4 is still `In progress`, and the task has no bead files under docs/sdlc/active/dedup-consolidation-20260404/beads/.

## Conclusion
This is not archive-ready as-is.

Reason:
- The updated handoff proves substantial dedup work is complete, but it does not prove all dedup findings are complete.
- It explicitly leaves deferred or leftover items (2.2, 2.4, 3.2, 3.3, and all Priority 4 investigations).
- The SDLC task record itself is still active/incomplete.

## Recommendation
Choose one before archiving:
1. Narrow the SDLC task scope to the actually-required items already completed, record the deferred items as explicit follow-up backlog, then move the task to completed.
2. Keep the task active until deferred and leftover dedup items are either completed or formally split into separate archived/deferred backlog tasks.

My recommendation: option 1 only if the owner confirms the task success criteria intentionally exclude 2.2/2.4/3.2/3.3/P4; otherwise keep it active.
