# Bead: B01
**Status:** verified
**Type:** implement
**Runner:** ac2ace977d2438ef1
**Dependencies:** none
**Scope:** `src/runtimes/agent/providers/codex-parser.ts`, `tests/runtimes/agent/parsers/codex-parser.test.ts`
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** /home/q/LAB/WhatSoup/docs/sdlc/active/codex-transport-gaps-20260404/beads/B01-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/parsers/codex-parser.test.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Fix silent Codex token loss. The `thread/tokenUsage/updated` notification (codex-parser.ts:182) is mapped to `{ type: 'ignored' }`. Token data flows in but is discarded.

## Result
- Separated `thread/tokenUsage/updated` from ignored cases into its own handler
- Calls `extractTokenCounts(params)` and returns `{ type: 'result', text: null, inputTokens, outputTokens }`
- 3 new tests: nested tokenUsage, top-level fields, empty params
- All 142 test files pass (3119 tests)

## Feedback for follow-up beads
- `extractTokenCounts()` from parser-utils.ts handles both nested and top-level formats — B06 (budget wiring) can rely on this for consistent token data
- No new AgentEvent type needed — reusing `result` event with `text: null` matches Claude's pattern
