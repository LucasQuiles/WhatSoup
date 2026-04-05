# Bead: B02-chatruntime-send-retry
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** [B01]
**Scope:** src/runtimes/chat/runtime.ts, tests/runtimes/chat/runtime.test.ts
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** REPAIR
**Decision trace:** docs/sdlc/active/whatsoup-full-hardening-20260331/beads/B02-decision-trace.md
**Deterministic checks:** [vitest-full-suite, typecheck]
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
P1-11: ChatRuntime discards computed LLM response when `sendMessage` fails. The LLM API call succeeds, response is computed, but if WhatsApp send fails, the response is silently lost with `return;` — no retry, no persistence.

Fix: Add retry with exponential backoff for send failures. If all retries fail, persist to durability engine's `outbound_ops` for post-connect recovery.

## Output
- Send failures retried (3 attempts, exponential backoff)
- Failed sends persisted to `outbound_ops` for recovery
- Tests covering: send failure + retry success, send failure + all retries fail + persistence
