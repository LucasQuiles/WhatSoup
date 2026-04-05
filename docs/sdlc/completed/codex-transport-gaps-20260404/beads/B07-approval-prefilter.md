# Bead: B07
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** beads/B07-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Tighten the Codex approval pre-filter heuristic. Line 556 of session.ts checks `line.includes('"method"') && line.includes('"id"')` which triggers JSON.parse on any stdout line containing those substrings (including large tool output). The actual validation at line 559 is proper, but the pre-filter is wasteful and could be more precise.

## Approach
1. Replace the broad `includes` check with a more targeted prefix check:
   - JSON-RPC lines start with `{"jsonrpc"` — check `line.startsWith('{"jsonrpc"')` or `line.trimStart().startsWith('{"jsonrpc"')`
   - This eliminates false positives from tool output containing "method" and "id" substrings
2. Keep the full validation at line 559 (`msg['jsonrpc'] === '2.0' && ...`)
3. Test: verify approval handler doesn't fire on tool output containing "method" and "id"

## Estimated effort
15 minutes
