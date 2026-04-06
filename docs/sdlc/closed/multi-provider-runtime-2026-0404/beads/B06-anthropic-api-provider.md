# Bead: B06-anthropic-api-provider
**Status:** pending
**Type:** implement
**Runner:** sonnet-implementer
**Dependencies:** [B05]
**Scope:** src/runtimes/agent/providers/anthropic-api.ts (new)
**Cynefin domain:** complicated
**Security sensitive:** true
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/multi-provider-runtime-2026-0404/beads/B06-decision-trace.md
**Deterministic checks:** []
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Implement Anthropic Messages API provider. Shares the api-loop from B05 but uses Anthropic's format:
- Different auth header (x-api-key vs Bearer)
- Different message format (Messages API vs Chat Completions)
- Different tool calling format (tool_use content blocks vs function calling)
- Different streaming format (SSE with different event types)
- Extended thinking support

Reuse `api-loop.ts` from B05 with an adapter layer.

## Output
- `providers/anthropic-api.ts` implementing the provider interface
- Adapter that maps Anthropic's format to the shared API loop
