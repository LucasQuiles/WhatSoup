# Bead: p4-degradation-timer
**Status:** merged
**Type:** implement
**Runner:** runner-p4-degradation-timer
**Dependencies:** none
**Scope:** src/main.ts (timer section ~line 496-510), tests
**Input:** See wiring description below
**Output:** Code fix + test proving periodic invocation
**Sentinel notes:**
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** REPAIR
**Decision trace:** docs/sdlc/active/heal-reliability-fixes-20260401/beads/p4-degradation-timer-decision-trace.md
**Deterministic checks:** npm run typecheck, npx vitest run --pool=forks
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}
**Assumptions:** checkDegradationSignals is safe to call frequently (it deduplicates via emitHealReport)
**Confidence:**

## Problem

`checkDegradationSignals` in `src/core/heal.ts` is exported but never called. Type 2 degradation detection (5+ unresolved decryption failures) is implemented but has no periodic trigger.

## Fix

Add a `setInterval` in `src/main.ts` alongside the existing retention and echo timeout intervals (section 10-11, around line 496-510). Run every 60 seconds. Guard with try/catch like the other intervals. Only run when `controlPeers` is configured (no point detecting degradation if no heal peer exists).

The function signature is:
```typescript
checkDegradationSignals(db, messenger, durability, runtime.currentControlReportId)
```

The `runtime` reference and `messenger` are already available in main.ts scope. Import `checkDegradationSignals` from `./core/heal.js`.
