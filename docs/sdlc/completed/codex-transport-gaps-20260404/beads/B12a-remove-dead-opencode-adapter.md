# Bead: B12a
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** [B03]
**Scope:** `src/runtimes/agent/providers/opencode-adapter.ts`
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** /home/q/LAB/WhatSoup/docs/sdlc/active/codex-transport-gaps-20260404/beads/B12a-decision-trace.md
**Deterministic checks:** vitest run; grep -r 'OpenCodeAdapter' src/
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
B12 guppy confirmed `OpenCodeAdapter` is dead code — never imported or instantiated. The production path uses `SessionManager` inline handling. Remove `opencode-adapter.ts` to reduce confusion and codebase size.

## Approach
1. Verify zero imports of `OpenCodeAdapter` across the codebase
2. Delete `src/runtimes/agent/providers/opencode-adapter.ts`
3. Remove any re-exports from index files
4. Run tests to confirm no breakage

## Estimated effort
10 minutes

## Origin
B12 investigation finding: "OpenCodeAdapter is dead code"
