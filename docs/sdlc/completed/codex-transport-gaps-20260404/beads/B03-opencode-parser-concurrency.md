# Bead: B03
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `src/runtimes/agent/providers/opencode-parser.ts`, `tests/runtimes/agent/parsers/opencode-parser.test.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** beads/B03-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/parsers/opencode-parser.test.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Fix concurrency hazard in opencode-parser.ts. `_firstStepSeen` (line 17) is module-level mutable state shared across all concurrent chat sessions. In per-chat session scope with multiple simultaneous chats, the first `step_start` seen by any chat sets this flag, causing all other chats' init events to be dropped.

## Approach
1. Replace module-level `_firstStepSeen` with a factory function that returns a parser with per-instance state:
   ```typescript
   export function createOpenCodeParser(): { parse: (line: string) => AgentEvent | null; reset: () => void } {
     let firstStepSeen = false;
     return {
       parse(line: string): AgentEvent | null { /* ... uses local firstStepSeen */ },
       reset() { firstStepSeen = false; },
     };
   }
   ```
2. Update `session.ts` to create a parser instance per session instead of importing the module-level function
3. Remove the exported `resetParserState()` function
4. Test: two parser instances don't share state

## Estimated effort
30 minutes
