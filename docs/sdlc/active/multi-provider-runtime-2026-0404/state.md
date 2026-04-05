# Task: Multi-Provider CLI Agent Runtime

**ID:** multi-provider-runtime-2026-0404
**Created:** 2026-04-04
**Status:** active
**Profile:** BUILD
**Complexity:** complicated
**Cynefin:** complicated

## Objective
Enable WhatSoup to use different CLI agent providers as the backend runtime, configurable per-instance. Providers include:
- **CLI agents:** Claude Code, Codex CLI, OpenCode, Gemini CLI, Aider, etc.
- **Local LLMs:** Ollama, llama.cpp, vLLM, etc. (via API)
- **Private cloud APIs:** Anthropic API, OpenAI API, Google AI, Azure OpenAI, custom endpoints

The system currently hardcodes `claude` CLI — we need a provider abstraction layer that normalizes different backends behind a common interface, whether they're CLI subprocesses or API clients.

## Success Criteria
1. Provider interface abstraction that SessionManager dispatches through
2. At least 2 working providers: Claude Code (existing) + Codex CLI
3. Per-instance provider configuration via instance config
4. Stream parser per provider that maps to the existing `AgentEvent` union
5. Session lifecycle (spawn, resume, kill) works for each provider
6. MCP tool integration works or degrades gracefully per provider
7. Existing Claude Code behavior is 100% preserved (no regressions)

## Scope
- `src/runtimes/agent/session.ts` — refactor into provider-dispatched architecture
- `src/runtimes/agent/stream-parser.ts` — make provider-specific
- `src/runtimes/agent/runtime.ts` — provider selection from config
- `src/config.ts` — add provider config schema
- New: `src/runtimes/agent/providers/` — provider implementations
- Tests for provider abstraction

## Phase Log
| Phase | Started | Status |
|-------|---------|--------|
| Normalize | 2026-04-04 | complete (clean state) |
| Frame | 2026-04-04 | complete (from prior conversation) |
| Scout | 2026-04-04 | complete |
| Architect | 2026-04-04 | complete |
| Execute | 2026-04-04 | active |
