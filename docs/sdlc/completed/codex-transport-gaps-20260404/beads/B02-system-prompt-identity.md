# Bead: B02
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** beads/B02-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Fix hardcoded "personal Claude Code agent" in system prompt. Lines 426 and 429 of session.ts tell every provider (including Codex, Gemini, OpenCode) that it is a "Claude Code agent". This causes identity confusion in non-Claude models.

## Input
- `session.ts:426-434` — system prompt construction in `spawnSession()`
- `session.ts` class fields — `this.provider` is available (string like 'claude-cli', 'codex-cli', etc.)
- `console/src/lib/providers.ts` — provider display names (but this is frontend-only, don't import it from backend)

## Approach
1. Create a simple `providerDisplayName(provider: string): string` helper (or inline map) in session.ts:
   - `'claude-cli'` → `'Claude Code'`
   - `'codex-cli'` → `'Codex CLI'`
   - `'gemini-cli'` → `'Gemini CLI'`
   - `'opencode-cli'` → `'OpenCode'`
   - `'anthropic-api'` → `'Anthropic API'`
   - `'openai-api'` → `'OpenAI API'`
   - default → provider ID
2. Replace `"a personal Claude Code agent"` with `"a personal ${displayName} agent"` at both lines 426 and 429
3. Add test verifying non-Claude providers get correct identity

## Output
- Modified `session.ts` with provider-aware system prompt
- New test(s)
- Zero regression in Claude path

## Estimated effort
10 minutes
