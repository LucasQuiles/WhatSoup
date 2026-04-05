# Bead: B02-extract-claude-provider
**Status:** pending
**Type:** implement
**Runner:** sonnet-implementer
**Dependencies:** [B01]
**Scope:** src/runtimes/agent/providers/claude.ts (new), src/runtimes/agent/session.ts, src/runtimes/agent/stream-parser.ts
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/multi-provider-runtime-2026-0404/beads/B02-decision-trace.md
**Deterministic checks:** []
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Extract the existing Claude Code behavior into a provider implementation. This is a pure refactor — zero behavior change. Move Claude-specific logic from session.ts into `providers/claude.ts`:
- CLI binary name + flags (session.ts:162-172)
- Stream parser (stream-parser.ts — rename to providers/claude-parser.ts or keep as default)
- stdin message format (session.ts:437-476)
- Resume mechanism (session.ts:77,172,288-315)
- Transcript path derivation (session.ts:233-243)
- MCP .mcp.json generation (runtime.ts:622-650, workspace.ts:207-226)

## Output
- `providers/claude.ts` implementing the provider interface from B01
- `session.ts` refactored to use provider interface instead of hardcoded Claude logic
- All existing tests still pass (zero behavior change)
