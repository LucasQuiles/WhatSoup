# Bead: B08
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`, `src/runtimes/agent/providers/mcp-bridge.ts`
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** beads/B08-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Centralize .mcp.json generation. The inline MCP config in `runtime.ts:647-655` duplicates logic in `providers/mcp-bridge.ts:generateMcpConfigFile()`. The runtime should call the bridge module so new provider MCP formats don't require multiple touch points.

## Approach
1. Read `mcp-bridge.ts` to understand `generateMcpConfigFile()` signature and behavior
2. Replace the inline .mcp.json generation in `runtime.ts` with a call to the bridge module
3. Ensure the bridge module handles all provider types correctly
4. Test: verify .mcp.json is generated correctly via the centralized path

## Estimated effort
20 minutes
