# Bead: B04a
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`, `src/core/database.ts`
**Cynefin domain:** complicated
**Security sensitive:** false
**Complexity source:** essential
**Profile:** BUILD
**Decision trace:** /home/q/LAB/WhatSoup/docs/sdlc/active/codex-transport-gaps-20260404/beads/B04a-decision-trace.md
**Deterministic checks:** vitest run tests/runtimes/agent/; vitest run tests/core/database.test.ts
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Objective
ORACLE REMEDIATION: Persist `codexThreadId` to the database so it survives process restart. Currently `this.codexThreadId` is an in-memory field (session.ts:140) that is lost on crash. B04 (session resume) depends on this being available from DB after a restart.

## Approach
1. Add `provider_session_ref` column to `agent_sessions` table (or reuse `session_id` which already stores the thread ID via the init event handler)
2. Verify: when `codexThreadId` is captured from `thread/started`, it's stored in the DB session record
3. Add `getProviderSessionRef(chatJid)` query that retrieves the stored thread ID for crash resume
4. Test: create session, capture thread ID, verify it's queryable from DB

## Oracle finding addressed
"B04 has a hidden prerequisite: codexThreadId must be persisted to DB to survive process restart"
