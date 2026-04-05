# Bead: H03
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`, `tests/runtimes/agent/session.test.ts`
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** BUILD
**Decision trace:** /home/q/LAB/WhatSoup/docs/sdlc/active/transport-hardening-20260404/beads/H03-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/session.test.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Make the Codex approval pre-filter resilient to JSON key reordering. The current `startsWith('{"jsonrpc"')` check assumes `jsonrpc` is the first key. If a future Codex version serializes differently (e.g., `{"id":1,"jsonrpc":"2.0",...}`), approvals would be missed.

## Approach
1. Replace `startsWith('{"jsonrpc"')` with a check that's both fast and order-independent:
   - Option A: `line[0] === '{' && line.includes('"jsonrpc"')` — any JSON object with jsonrpc key
   - Option B: Keep startsWith but add fallback: `startsWith('{"jsonrpc"') || (line[0] === '{' && line.includes('"jsonrpc":"2.0"'))`
2. Add regression test: approval request with `jsonrpc` NOT as first key is still intercepted
3. The full validation at the existing line 559 (`msg['jsonrpc'] === '2.0'`) remains unchanged as the safety net

## Estimated effort
10 minutes
