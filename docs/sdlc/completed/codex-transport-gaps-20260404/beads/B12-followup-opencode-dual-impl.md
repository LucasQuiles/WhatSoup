# Bead: B12
**Status:** pending
**Type:** investigate
**Runner:** unassigned
**Dependencies:** [B03]
**Scope:** `src/runtimes/agent/providers/opencode-adapter.ts`, `src/runtimes/agent/session.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** beads/B12-decision-trace.md
**Deterministic checks:** grep -n 'opencode' src/runtimes/agent/session.ts src/runtimes/agent/providers/opencode-adapter.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Investigate the OpenCode dual-implementation split. `OpenCodeAdapter` (HTTP, providers/opencode-adapter.ts) and the `SessionManager` opencode path are two different implementations of the same provider. Determine which is canonical, whether they're in sync, and recommend consolidation or deprecation.

## Output
- Finding: which implementation is production, which is dead
- Recommendation: consolidate, deprecate, or document the split
- If action needed: new bead B12a created with implementation spec
