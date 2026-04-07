# Bead: FIX-01 — DS Compliance Test Assertion Drift

**BeadID:** FIX-01

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `tests/console/design-system-scheduled-groups-primitives.test.ts`, `console/src/components/`
**Input:** Test assertion drift from console refactoring — test expects absence of `bg-d1` but component still uses it
**Output:** Either update the component to remove the class or update the test to reflect current component state
**Cynefin domain:** clear
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 0
**Loop depth:** L0 + L1
**Current loop:** —
**Bridge sync:** false

## Root Cause

`tests/console/design-system-scheduled-groups-primitives.test.ts` test "removes raw fallback colors and hardcoded numeric style literals from the new surfaces" asserts:
```typescript
expect(contactPicker).not.toContain('bg-d1')
```

But `console/src/components/shared/ContactSearchPicker.tsx` (or related component) still uses `bg-d1`. The test was added as a guardrail during DS migration but the migration hasn't reached this component yet.

## Implementation Spec

1. Check which component file the `contactPicker` variable reads
2. Either:
   a. Update the component to use the DS-compliant token (preferred), or
   b. Remove the premature assertion from the test if the migration isn't planned yet

## Required Tests

### Test 1: DS compliance test passes
```
GIVEN the full test suite
WHEN design-system-scheduled-groups-primitives tests run
THEN all 4 assertions pass
```

## Acceptance Criteria

- [ ] DS compliance test passes
- [ ] No regressions in other tests
- [ ] Typecheck + vitest pass
