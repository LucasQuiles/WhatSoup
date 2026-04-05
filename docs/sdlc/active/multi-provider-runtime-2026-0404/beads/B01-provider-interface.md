# Bead: B01-provider-interface
**Status:** pending
**Type:** design
**Runner:** sonnet-designer
**Dependencies:** []
**Scope:** src/runtimes/agent/providers/types.ts (new)
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/multi-provider-runtime-2026-0404/beads/B01-decision-trace.md
**Deterministic checks:** []
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Design the core provider abstraction. Two provider categories exist:
1. **CLI providers** — spawn subprocess, pipe stdin/stdout, parse streaming output
2. **API providers** — HTTP client, manage conversation loop + tool calling internally

The interface must normalize both into the existing `AgentEvent` stream that `runtime.ts` already consumes.

Current integration points (from Scout):
- `session.ts:162` — `spawn('claude', [...])` 
- `stream-parser.ts` — Claude-specific JSONL parsing → `AgentEvent` union
- `session.ts:437-476` — stdin write format `{type: 'user', message: {role: 'user', content: [{type: 'text', text}]}}`
- `session.ts:77,172,288-315` — resume mechanism
- `session.ts:233-243` — transcript path resolution
- `runtime.ts:622-650` — MCP .mcp.json generation

## Output
- TypeScript interface definition for `AgentProvider`
- Type definitions for provider config
- Strategy for CLI vs API provider base classes
- How resume, MCP, transcript paths, and watchdog integrate
