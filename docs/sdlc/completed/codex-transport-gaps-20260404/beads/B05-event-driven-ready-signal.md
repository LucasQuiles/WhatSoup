# Bead: B05
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** beads/B05-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Replace busy-wait polling with event-driven ready signals for Codex and Gemini. Both use `while (!threadId) await sleep(100)` loops with 15s hard timeouts (session.ts:885-917). This wastes CPU and creates fragile timing dependencies.

## Approach
1. Add `private readyPromise: Promise<void>` and resolver fields to SessionManager
2. In `spawnSession()`, create a deferred promise: `this.readyPromise = new Promise(resolve => { this.readyResolve = resolve })`
3. In the stdout handler, when `init` event fires (thread/session ID captured), call `this.readyResolve()`
4. In `sendTurn()`, replace the while-loop with: `await Promise.race([this.readyPromise, sleep(15000).then(() => { throw new Error('Provider init timeout') })])`
5. Test: verify sendTurn awaits the ready signal, not polling

## Estimated effort
30 minutes
