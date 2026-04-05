# Bead: B05-api-provider
**Status:** pending
**Type:** implement
**Runner:** sonnet-implementer
**Dependencies:** [B01, B02]
**Scope:** src/runtimes/agent/providers/openai-api.ts (new), src/runtimes/agent/providers/api-loop.ts (new)
**Cynefin domain:** complex
**Security sensitive:** true
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/multi-provider-runtime-2026-0404/beads/B05-decision-trace.md
**Deterministic checks:** []
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Implement an OpenAI-compatible API provider. This covers:
- OpenAI API (GPT-4o, o3, etc.)
- Anthropic API (via Messages API — separate adapter)
- Ollama (OpenAI-compatible endpoint at localhost:11434/v1)
- vLLM (OpenAI-compatible endpoint)
- Azure OpenAI
- Any OpenAI-compatible endpoint

This is fundamentally different from CLI providers:
- No subprocess — HTTP client
- WE manage the conversation loop (user message → LLM → tool calls → tool results → LLM → ...)
- WE must expose WhatSoup MCP tools as function definitions to the API
- WE must handle streaming responses (SSE) and map to AgentEvent
- WE manage conversation history / context window
- API key retrieval from GNOME Keyring via `secret-tool lookup service <name>`

Key design decisions:
1. Tool definitions: Convert WhatSoup's MCP tool registry to OpenAI function calling format
2. Conversation loop: Iterate until LLM produces a final text response (no more tool calls)
3. Streaming: Use SSE streaming to emit assistant_text events incrementally
4. Context management: Track token usage, handle context window limits

## Output
- `providers/openai-api.ts` implementing the provider interface for OpenAI-compatible APIs
- `providers/api-loop.ts` implementing the agentic tool-calling loop
- Graceful degradation when tools aren't supported by the model
