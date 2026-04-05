# Bead: B04-codex-provider
**Status:** pending
**Type:** implement
**Runner:** sonnet-implementer
**Dependencies:** [B01, B02]
**Scope:** src/runtimes/agent/providers/codex.ts (new), src/runtimes/agent/providers/codex-parser.ts (new)
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** docs/sdlc/active/multi-provider-runtime-2026-0404/beads/B04-decision-trace.md
**Deterministic checks:** []
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Implement Codex CLI provider. Codex CLI is OpenAI's agentic coding tool.

Key differences from Claude Code:
- Binary: `codex` (not `claude`)
- Streaming format: Different JSONL event structure — needs investigation
- Flags: `--full-auto` (equivalent to bypassPermissions), different model flags
- Resume: Different mechanism (if any)
- MCP: Codex supports MCP but config format may differ
- System prompt: Different flag name

Research Codex CLI's actual streaming output format by checking:
1. `codex --help` output
2. Any docs at ~/.codex/ or in the codex npm package
3. Web search for "codex cli stream json format" if needed

## Output
- `providers/codex.ts` implementing the provider interface
- `providers/codex-parser.ts` mapping Codex events to AgentEvent
- Documentation of Codex CLI flags and streaming format
