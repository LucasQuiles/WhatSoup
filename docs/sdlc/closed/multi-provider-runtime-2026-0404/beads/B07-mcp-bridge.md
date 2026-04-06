# Bead: B07-mcp-bridge
**Status:** pending
**Type:** implement
**Runner:** sonnet-implementer
**Dependencies:** [B02, B05]
**Scope:** src/runtimes/agent/providers/mcp-bridge.ts (new), src/runtimes/agent/runtime.ts, src/core/workspace.ts
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/multi-provider-runtime-2026-0404/beads/B07-decision-trace.md
**Deterministic checks:** []
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Make MCP tool integration provider-aware:

**CLI providers (Claude, Codex):**
- Write .mcp.json in the provider's expected format
- Provider-specific MCP config (Claude format vs Codex format)
- Existing behavior: runtime.ts:622-650 writes .mcp.json, workspace.ts:207-226 for sandboxed

**API providers:**
- No .mcp.json needed — we call tools directly
- Convert WhatSoup's MCP tool registry into the API's function/tool definition format
- Bridge: when API says "call tool X", we execute via our MCP socket server and return the result

Key: The MCP bridge converts between WhatSoup's tool registry and whatever format the provider needs.

## Output
- `providers/mcp-bridge.ts` — tool registry ↔ provider format adapter
- Updated runtime.ts — conditional .mcp.json generation based on provider type
- Updated workspace.ts — same
