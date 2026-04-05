# Bead: B01-fix-test-failures
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** tests/core/access-policy.test.ts, tests/runtimes/agent/runtime.test.ts
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** REPAIR
**Decision trace:** docs/sdlc/active/whatsoup-full-hardening-20260331/beads/B01-decision-trace.md
**Deterministic checks:** [vitest-full-suite, typecheck]
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
28 test failures in access-policy.test.ts. Root causes from scout:
1. access-policy.test.ts: New tests for group @mention matching + edge cases are failing — likely the test assertions don't match the actual access-policy.ts implementation (the code is correct, tests need alignment)
2. runtime.test.ts: mockSession missing `trackToolStart`/`trackToolEnd` methods (added to session.ts but mock not updated)

## Output
- All 2055+ tests passing
- No regressions
- Commit the uncommitted working-tree changes once tests are green
