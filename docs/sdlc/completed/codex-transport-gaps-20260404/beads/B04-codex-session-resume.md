# Bead: B04
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** [B04a]
**Scope:** `src/runtimes/agent/session.ts`, `tests/runtimes/agent/session-resume.test.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** beads/B04-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
Add Codex session resume on crash. Currently when a Codex session crashes, `onCrash` spawns a new thread via `thread/start` without any resume argument. Conversation history is silently lost. Claude has `--resume {sessionId}` and `onResumeFailed`; Codex has nothing.

## Input
- `session.ts` — `spawnSession()` method, the Codex `thread/start` JSON-RPC payload
- `session.ts` — `onCrash()` handler, `getResumableSessionForChat()` DB query
- The Codex app-server `thread/start` accepts a `threadId` parameter to resume an existing thread
- `this.codexThreadId` is captured from `thread/started` notification and stored as `sessionId` in DB

## Approach
1. In `spawnSession()`, when `this.provider === 'codex-cli'` and we have a `checkpoint` or resumable session:
   - Read the stored `codexThreadId` from the DB session record
   - Pass it as `threadId` in the `thread/start` JSON-RPC call (the app-server will resume the existing thread)
2. Add `onResumeFailed` handling for Codex: if the resumed thread/start fails, fall back to creating a new thread
3. Test: verify that `thread/start` payload includes `threadId` when resuming

## Safe-to-fail
If the Codex app-server rejects the threadId (thread expired, deleted, etc.), the fallback is to create a new thread — same as current behavior. No data loss risk.

## Estimated effort
45 minutes
