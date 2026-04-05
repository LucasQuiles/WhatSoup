# Bead: H04
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `tests/runtimes/agent/codex-turn-lifecycle.test.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** /home/q/LAB/WhatSoup/docs/sdlc/active/transport-hardening-20260404/beads/H04-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/codex-turn-lifecycle.test.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Add integration test for Codex turn lifecycle. Oracle found no test validates the runtime's behavior when both `thread/tokenUsage/updated` (token_usage event) and `turn/completed` (result event) are emitted for a single turn. This was the root cause of the CRITICAL double-turn-completion bug found in the first oracle review.

## Tests to add
1. Simulate a full Codex turn: emit `thread/tokenUsage/updated` then `turn/completed`
2. Verify: tokens are recorded from the token_usage event
3. Verify: turn completion happens ONLY from the turn/completed result event (queue shift happens once)
4. Verify: the message queue is NOT desynchronized (next message is NOT prematurely dequeued)
5. Edge case: tokenUsage arrives AFTER turn/completed — tokens still recorded, no extra side effects

## Estimated effort
30 minutes
