# Anti-Echo Protocol & Session Management Controls — Implementation Plan

**Status:** completed — echo guard shipped as `src/core/echo-guard.ts`, wired through `src/runtimes/agent/outbound-queue.ts` and `runtime.ts`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop agents from producing unsolicited messages to shared groups on restart, and give admins WhatsApp-based session visibility and kill controls.

**Architecture:** Six independent sub-projects (AE1-AE6). AE1/AE2 add group-awareness guards to the two resume code paths in `runtime.ts`. AE3 is a data-only fix (DELETE from access_list). AE4 adds a new `echo-guard.ts` module integrated into the outbound queue send path. AE5 extends the existing `/new`/`/status`/`/help` local command system with `/sessions` and `/kill-session`. AE6 removes dead code.

**Tech Stack:** TypeScript, vitest 3.2.4, SQLite (node:sqlite DatabaseSync), Node.js 24

**Spec:** `docs/superpowers/specs/2026-04-07-anti-echo-session-controls-design.md`

**Test command:** `npx vitest run <test-file> --reporter=verbose`
**Type check command:** `npx tsc --noEmit`

---

## File Map

| File | Action | Sub-Project | Responsibility |
|------|--------|-------------|----------------|
| `src/runtimes/agent/runtime.ts` | Modify | AE1, AE2, AE5, AE6 | Resume guards, session commands, dead import removal |
| `src/runtimes/agent/commands.ts` | Modify | AE5 | Extend `CommandResult` type + `LOCAL_COMMANDS` set |
| `src/runtimes/agent/session-db.ts` | Modify | AE6 | Remove `sweepOrphanedSessions` |
| `src/core/echo-guard.ts` | Create | AE4 | Group outbound cooldown module |
| `src/config.ts` | Modify | AE4 | Add `echoGuard` config fields |
| `src/runtimes/agent/outbound-queue.ts` | Modify | AE4 | Integrate echo guard check in send path |
| `tests/core/echo-guard.test.ts` | Create | AE4 | Echo guard unit tests |
| `tests/runtimes/agent/commands.test.ts` | Modify | AE5 | Tests for new commands |
| `tests/runtimes/agent/runtime.test.ts` | Modify | AE1, AE2, AE5 | Resume guard + session command tests |
| `tests/runtimes/agent/session-db.test.ts` | Modify | AE6 | Remove `sweepOrphanedSessions` test |
| `docs/runbook.md` | Modify | AE3 | Document orchestrated group convention |

---

## Task 1: AE6 — Remove Dead Code (`sweepOrphanedSessions`)

Smallest, safest change. Gets it out of the way so we don't have to maintain mock stubs for it in later tasks.

**Files:**
- Modify: `src/runtimes/agent/session-db.ts:265-278`
- Modify: `src/runtimes/agent/runtime.ts:19`
- Modify: `tests/runtimes/agent/session-db.test.ts:19,265-278`
- Modify: 6 test files that include `sweepOrphanedSessions` in mock objects

- [ ] **Step 1: Verify no runtime call sites exist**

```bash
cd /home/q/LAB/WhatSoup
grep -rn 'sweepOrphanedSessions' src/ --include='*.ts'
```

Expected output — only the definition and the import:
```
src/runtimes/agent/session-db.ts:272:export function sweepOrphanedSessions(...)
src/runtimes/agent/runtime.ts:19:  sweepOrphanedSessions,
```

- [ ] **Step 2: Remove the function from `session-db.ts`**

Remove lines 265-278 (the JSDoc + function):

```typescript
// DELETE these lines from src/runtimes/agent/session-db.ts:
/**
 * Return rows from agent_sessions with status = 'active'.
 * The runtime should verify each PID is still alive and call markOrphaned() if not.
 */
export function sweepOrphanedSessions(db: Database): { id: number; claude_pid: number }[] {
  return db.raw
    .prepare(
      `SELECT id, claude_pid FROM agent_sessions WHERE status = 'active'`,
    )
    .all() as { id: number; claude_pid: number }[];
}
```

- [ ] **Step 3: Remove import from `runtime.ts`**

In `src/runtimes/agent/runtime.ts`, line 19 — remove `sweepOrphanedSessions,` from the import block:

```typescript
// BEFORE (lines 14-25):
import {
  ensureAgentSchema,
  getActiveSession,
  backfillWorkspaceKeys,
  markOrphaned,
  sweepOrphanedSessions,   // ← DELETE this line
  getResumableSessionForChat,
  accumulateSessionTokens,
  insertTokenEvent,
  accumulateTokensWithEvent,
  backfillSessionProvider,
} from './session-db.ts';
```

- [ ] **Step 4: Remove test from `session-db.test.ts`**

Remove the import of `sweepOrphanedSessions` at line 19 and the test block at lines 265-278:

```typescript
// DELETE from tests/runtimes/agent/session-db.test.ts line 19:
  sweepOrphanedSessions,

// DELETE the test block (~lines 265-278):
  it('sweepOrphanedSessions returns only active rows', () => {
    // ... entire test ...
  });
```

- [ ] **Step 5: Remove from mock objects in 6 test files**

Remove `sweepOrphanedSessions: vi.fn(() => []),` (or similar) from the mock objects in each of these files:

1. `tests/runtimes/agent/runtime.test.ts:98`
2. `tests/runtimes/agent/codex-turn-lifecycle.test.ts:186`
3. `tests/runtimes/agent/health-snapshot.test.ts:79`
4. `tests/runtimes/agent/zombie-sessions.test.ts:94`
5. `tests/runtimes/agent/prepare-content.test.ts:60`
6. `tests/runtimes/agent/control-timeout.test.ts:81`
7. `tests/mcp/tools/heal.test.ts:81`

- [ ] **Step 6: Run type check + tests**

```bash
cd /home/q/LAB/WhatSoup
npx tsc --noEmit 2>&1 | head -20
npx vitest run tests/runtimes/agent/session-db.test.ts --reporter=verbose 2>&1 | tail -20
npx vitest run tests/runtimes/agent/runtime.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: Clean compile, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/runtimes/agent/session-db.ts src/runtimes/agent/runtime.ts \
  tests/runtimes/agent/session-db.test.ts tests/runtimes/agent/runtime.test.ts \
  tests/runtimes/agent/codex-turn-lifecycle.test.ts tests/runtimes/agent/health-snapshot.test.ts \
  tests/runtimes/agent/zombie-sessions.test.ts tests/runtimes/agent/prepare-content.test.ts \
  tests/runtimes/agent/control-timeout.test.ts tests/mcp/tools/heal.test.ts
git commit -m "refactor: remove dead sweepOrphanedSessions (superseded by classifyActiveSessions)"
```

---

## Task 2: AE3 — Orchestrated Group Access Fix (Data)

Data-only fix. No code changes, no tests — just DELETE a row from two SQLite databases and document the convention.

**Files:**
- Modify: `~/.local/share/whatsoup/instances/besbot/bot.db` (data fix)
- Modify: `~/.local/share/whatsoup/instances/shandroid/bot.db` (data fix)
- Modify: `docs/runbook.md`

- [ ] **Step 1: Verify current state**

```bash
sqlite3 ~/.local/share/whatsoup/instances/besbot/bot.db \
  "SELECT * FROM access_list WHERE subject_type='group' AND subject_id='120363555555555001@g.us';"
sqlite3 ~/.local/share/whatsoup/instances/shandroid/bot.db \
  "SELECT * FROM access_list WHERE subject_type='group' AND subject_id='120363555555555001@g.us';"
```

Expected: Both return `group|120363555555555001@g.us|allowed|WHATSOUP|...`

- [ ] **Step 2: Delete the rows**

```bash
sqlite3 ~/.local/share/whatsoup/instances/besbot/bot.db \
  "DELETE FROM access_list WHERE subject_type='group' AND subject_id='120363555555555001@g.us';"
sqlite3 ~/.local/share/whatsoup/instances/shandroid/bot.db \
  "DELETE FROM access_list WHERE subject_type='group' AND subject_id='120363555555555001@g.us';"
```

- [ ] **Step 3: Verify deletion**

```bash
sqlite3 ~/.local/share/whatsoup/instances/besbot/bot.db \
  "SELECT COUNT(*) FROM access_list WHERE subject_type='group' AND subject_id='120363555555555001@g.us';"
sqlite3 ~/.local/share/whatsoup/instances/shandroid/bot.db \
  "SELECT COUNT(*) FROM access_list WHERE subject_type='group' AND subject_id='120363555555555001@g.us';"
```

Expected: Both return `0`.

- [ ] **Step 4: Add runbook documentation**

Add to `docs/runbook.md` (at end or in an "Access Control" section):

```markdown
## Orchestrated Groups — Access Control Convention

Groups used for multi-agent orchestration (where a conductor agent like Q coordinates work
across multiple coding agents) should **NOT** have `status='allowed'` in the agent instances'
`access_list` tables. The `allowed` status triggers `group_auto_respond`, causing every agent
to respond to every non-sibling message independently.

**Correct configuration:** Agents in orchestrated groups respond only when explicitly @mentioned.
This is the default behavior when no `access_list` entry exists for the group. The sibling filter
(`access-policy.ts:121-124`) handles agent-to-agent echo suppression via `siblingPhones` in
each instance's config.

**To check:** `sqlite3 <instance>/bot.db "SELECT * FROM access_list WHERE subject_type='group';"`

**To fix:** `DELETE FROM access_list WHERE subject_type='group' AND subject_id='<group_jid>';`
```

- [ ] **Step 5: Commit**

```bash
cd /home/q/LAB/WhatSoup
git add docs/runbook.md
git commit -m "docs: add orchestrated group access control convention to runbook"
```

---

## Task 3: AE1 — Group Resume Suppression (per_chat)

**Files:**
- Modify: `src/runtimes/agent/runtime.ts:~1135`
- Modify: `tests/runtimes/agent/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/runtimes/agent/runtime.test.ts` in an appropriate `describe` block (e.g., after the existing per_chat resume tests near line 770):

```typescript
describe('per_chat proactive resume — group suppression (AE1)', () => {
  it('skips proactive resume for group conversation keys and marks checkpoint ended', async () => {
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

    const mockDurability = {
      getResumableCheckpoints: vi.fn(() => [
        { conversation_key: '120363555555555001_at_g.us', claude_pid: null, session_status: 'active' },
        { conversation_key: '15551230006', claude_pid: null, session_status: 'active' },
      ]),
      getSessionCheckpoint: vi.fn((key: string) => ({
        session_id: 'sess-' + key.slice(0, 8),
        updated_at: new Date().toISOString().replace('Z', ''), // fresh — within 60min
      })),
      upsertSessionCheckpoint: vi.fn(),
    };
    (runtime as unknown as { durability: unknown }).durability = mockDurability;

    // spawnSession never resolves — we just want to check what was skipped vs attempted
    mockSession.spawnSession.mockImplementation(() => new Promise<void>(() => {}));

    await runtime.start();

    // Group checkpoint should be marked ended, NOT resumed
    expect(mockDurability.upsertSessionCheckpoint).toHaveBeenCalledWith(
      '120363555555555001_at_g.us',
      { sessionStatus: 'ended' },
    );

    // DM checkpoint should be resumed (spawnSession called)
    expect(mockSession.spawnSession).toHaveBeenCalledTimes(1);
    expect(mockSession.spawnSession).toHaveBeenCalledWith('sess-18459780');
  });

  it('resumes DM conversation keys that do not end with _at_g.us', async () => {
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

    const mockDurability = {
      getResumableCheckpoints: vi.fn(() => [
        { conversation_key: '11111110000008', claude_pid: null, session_status: 'active' },
      ]),
      getSessionCheckpoint: vi.fn(() => ({
        session_id: 'sess-dm-lid',
        updated_at: new Date().toISOString().replace('Z', ''),
      })),
      upsertSessionCheckpoint: vi.fn(),
    };
    (runtime as unknown as { durability: unknown }).durability = mockDurability;
    mockSession.spawnSession.mockImplementation(() => new Promise<void>(() => {}));

    await runtime.start();

    // DM checkpoint should NOT be marked ended
    expect(mockDurability.upsertSessionCheckpoint).not.toHaveBeenCalledWith(
      '11111110000008',
      expect.objectContaining({ sessionStatus: 'ended' }),
    );
    // Session should be spawned
    expect(mockSession.spawnSession).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/runtimes/agent/runtime.test.ts -t "skips proactive resume for group" --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — group checkpoint is currently resumed, not skipped.

- [ ] **Step 3: Implement the group guard in `runtime.ts`**

In `src/runtimes/agent/runtime.ts`, inside the per_chat resume loop, after line 1135 (`if (!full?.session_id) continue;`), add:

```typescript
        // AE1: Skip group conversations — groups should not be proactively resumed.
        // Agents in groups are orchestrated via @mentions. Proactive resume bypasses
        // the ingest pipeline's sibling filter (access-policy.ts:121-124), causing
        // unsolicited messages. Group sessions start fresh on the next @mention.
        if (cp.conversation_key.endsWith('_at_g.us')) {
          log.info({ conversationKey: cp.conversation_key }, 'skipping proactive resume — group chat');
          this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
          continue;
        }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/runtimes/agent/runtime.test.ts -t "group suppression" --reporter=verbose 2>&1 | tail -20
```

Expected: Both tests PASS.

- [ ] **Step 5: Run full runtime test suite for regressions**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/runtimes/agent/runtime.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/runtimes/agent/runtime.ts tests/runtimes/agent/runtime.test.ts
git commit -m "fix: skip proactive resume for group chats in per_chat mode (AE1)"
```

---

## Task 4: AE2 — Shared/Single Mode Staleness + Group Guard

**Files:**
- Modify: `src/runtimes/agent/runtime.ts:~1218`
- Modify: `tests/runtimes/agent/runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/runtimes/agent/runtime.test.ts`:

```typescript
describe('shared/single mode resume — staleness + group guard (AE2)', () => {
  it('skips shared/single resume when session is older than 60 minutes', async () => {
    const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'single' });

    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('Z', '');
    const mockDurability = {
      getSessionCheckpoint: vi.fn(() => ({ updated_at: staleTime })),
      upsertSessionCheckpoint: vi.fn(),
    };
    (runtime as unknown as { durability: unknown }).durability = mockDurability;

    // Mock getActiveSession to return a stale session
    const mockGetActiveSession = vi.fn(() => ({
      id: 1, session_id: 'stale-sess', claude_pid: 999, status: 'active',
      chat_jid: '15551230006@s.whatsapp.net', started_at: staleTime,
      last_message_at: staleTime, message_count: 5,
    }));
    vi.mocked(await import('../../../src/runtimes/agent/session-db.ts')).getActiveSession = mockGetActiveSession;

    await runtime.start();

    // Session should NOT be created — no spawnSession call
    expect(mockSession.spawnSession).not.toHaveBeenCalled();
    // Checkpoint should be marked ended
    expect(mockDurability.upsertSessionCheckpoint).toHaveBeenCalled();
  });

  it('suppresses startup message for group chat_jid in shared mode', async () => {
    const runtime = new AgentRuntime(db, messenger, 'test', { shared: true });

    const freshTime = new Date().toISOString().replace('Z', '');
    const mockDurability = {
      getSessionCheckpoint: vi.fn(() => ({ updated_at: freshTime })),
      upsertSessionCheckpoint: vi.fn(),
    };
    (runtime as unknown as { durability: unknown }).durability = mockDurability;

    const mockGetActiveSession = vi.fn(() => ({
      id: 1, session_id: 'shared-sess', claude_pid: 999, status: 'active',
      chat_jid: '120363555555555001@g.us', started_at: freshTime,
      last_message_at: freshTime, message_count: 3,
    }));
    vi.mocked(await import('../../../src/runtimes/agent/session-db.ts')).getActiveSession = mockGetActiveSession;

    mockSession.spawnSession.mockResolvedValue(undefined);
    mockSession.getStatus.mockReturnValue({ active: true, pid: 999, sessionId: 'shared-sess', startedAt: freshTime, messageCount: 3, lastMessageAt: freshTime });

    await runtime.start();

    // Session should be spawned (shared mode — serves all chats)
    expect(mockSession.spawnSession).toHaveBeenCalled();
    // But pendingStartupMessage should NOT be set (group target)
    expect((runtime as unknown as { pendingStartupMessage: unknown }).pendingStartupMessage).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/runtimes/agent/runtime.test.ts -t "staleness" --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — no staleness check exists in shared/single mode.

- [ ] **Step 3: Implement staleness check + group guard in `runtime.ts`**

In `src/runtimes/agent/runtime.ts`, after line 1218 (`const prior = ...`), add the staleness check. Then replace lines 1269-1273 (the `pendingStartupMessage` assignment) with group-aware logic:

```typescript
    // AE2: Staleness check for shared/single mode — match per_chat's 60-minute threshold.
    let priorMut = prior; // mutable copy for null-out
    if (priorMut && this.durability) {
      const checkpoint = this.durability.getSessionCheckpoint(
        toConversationKey(priorMut.chat_jid!),
      );
      if (checkpoint?.updated_at) {
        const ageMs = Date.now() - new Date(checkpoint.updated_at + 'Z').getTime();
        if (ageMs > 60 * 60 * 1000) {
          log.info({ chatJid: priorMut.chat_jid, ageMinutes: Math.round(ageMs / 60_000) },
            'skipping shared/single resume — session too stale');
          this.durability.upsertSessionCheckpoint(
            toConversationKey(priorMut.chat_jid!), { sessionStatus: 'ended' },
          );
          priorMut = null;
        }
      } else if (!checkpoint) {
        log.info({ chatJid: priorMut?.chat_jid }, 'skipping shared/single resume — no checkpoint found');
        priorMut = null;
      }
    }
```

Then update the `if` guard to use `priorMut` instead of `prior`, and replace the `pendingStartupMessage` block:

```typescript
    // Replace the pendingStartupMessage assignment (currently L1269-1273) with:
      const age = formatAge(priorMut.started_at);
      // AE2: Suppress startup message for groups.
      if (resumeChatJid.endsWith('@g.us')) {
        if (!this.shared) {
          // Single mode: kill the resumed session — can't suppress message without orphaning it
          log.info({ chatJid: resumeChatJid }, 'skipping single-mode resume — group chat');
          await this.session!.shutdown(false);
          this.session = null;
          this.queue = null;
        } else {
          log.info({ chatJid: resumeChatJid }, 'suppressing startup message — shared-mode group chat');
        }
      } else {
        this.pendingStartupMessage = {
          chatJid: resumeChatJid,
          text: `_Resuming session_ from *${age}*. Send a message to continue, or /new to start fresh.`,
        };
      }
```

Note: The exact edit will depend on the current code layout. The engineer must read lines 1214-1274 and integrate these two blocks without breaking the existing logic.

- [ ] **Step 4: Run tests**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/runtimes/agent/runtime.test.ts -t "staleness" --reporter=verbose 2>&1 | tail -20
npx vitest run tests/runtimes/agent/runtime.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: New tests pass. All existing tests pass.

- [ ] **Step 5: Type check**

```bash
cd /home/q/LAB/WhatSoup
npx tsc --noEmit 2>&1 | head -20
```

Expected: Clean.

- [ ] **Step 6: Commit**

```bash
git add src/runtimes/agent/runtime.ts tests/runtimes/agent/runtime.test.ts
git commit -m "fix: add staleness check + group guard to shared/single resume (AE2)"
```

---

## Task 5: AE4 — Echo Guard Module

**Files:**
- Create: `src/core/echo-guard.ts`
- Create: `tests/core/echo-guard.test.ts`
- Modify: `src/config.ts:~242`
- Modify: `src/runtimes/agent/outbound-queue.ts:~596`

- [ ] **Step 1: Write the echo guard tests**

Create `tests/core/echo-guard.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { canSendToGroup, recordGroupOutbound, __resetForTests } from '../../src/core/echo-guard.ts';
import type { EchoGuardConfig } from '../../src/core/echo-guard.ts';

const DEFAULT_CFG: EchoGuardConfig = { enabled: true, groupCooldownMs: 60_000 };

describe('echo-guard', () => {
  beforeEach(() => {
    __resetForTests();
  });

  it('allows first send to a group', () => {
    expect(canSendToGroup('120363555555555001@g.us', DEFAULT_CFG)).toBe(true);
  });

  it('blocks second send within cooldown window', () => {
    const jid = '120363555555555001@g.us';
    recordGroupOutbound(jid);
    expect(canSendToGroup(jid, DEFAULT_CFG)).toBe(false);
  });

  it('allows send after cooldown expires', () => {
    const jid = '120363555555555001@g.us';
    const cfg: EchoGuardConfig = { enabled: true, groupCooldownMs: 10 }; // 10ms for test
    recordGroupOutbound(jid);

    // Wait for cooldown to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(canSendToGroup(jid, cfg)).toBe(true);
        resolve();
      }, 15);
    });
  });

  it('always allows DM sends regardless of cooldown', () => {
    const dmJid = '15551230006@s.whatsapp.net';
    recordGroupOutbound(dmJid); // shouldn't matter
    expect(canSendToGroup(dmJid, DEFAULT_CFG)).toBe(true);
  });

  it('always allows LID DM sends', () => {
    const lidJid = '11111110000008@lid';
    recordGroupOutbound(lidJid);
    expect(canSendToGroup(lidJid, DEFAULT_CFG)).toBe(true);
  });

  it('allows all sends when disabled', () => {
    const jid = '120363555555555001@g.us';
    const cfg: EchoGuardConfig = { enabled: false, groupCooldownMs: 60_000 };
    recordGroupOutbound(jid);
    expect(canSendToGroup(jid, cfg)).toBe(true);
  });

  it('tracks cooldown per group independently', () => {
    const group1 = '111111111@g.us';
    const group2 = '222222222@g.us';
    recordGroupOutbound(group1);
    // group1 blocked, group2 allowed
    expect(canSendToGroup(group1, DEFAULT_CFG)).toBe(false);
    expect(canSendToGroup(group2, DEFAULT_CFG)).toBe(true);
  });

  it('__resetForTests clears all cooldown state', () => {
    const jid = '120363555555555001@g.us';
    recordGroupOutbound(jid);
    expect(canSendToGroup(jid, DEFAULT_CFG)).toBe(false);
    __resetForTests();
    expect(canSendToGroup(jid, DEFAULT_CFG)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (module doesn't exist)**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/core/echo-guard.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/core/echo-guard.ts`**

```typescript
// src/core/echo-guard.ts
// Defense-in-depth: per-group outbound cooldown to prevent cascade floods.
// In-memory state — resets on process restart (intentional).

import { createChildLogger } from '../logger.ts';

const log = createChildLogger('echo-guard');

export interface EchoGuardConfig {
  enabled: boolean;
  groupCooldownMs: number;
}

interface GroupCooldownEntry {
  lastOutboundTs: number;
}

const groupCooldowns = new Map<string, GroupCooldownEntry>();

/**
 * Check if an outbound message to this JID is allowed.
 * Always returns true for non-group JIDs (DMs unaffected).
 * For groups: true if cooldown has elapsed since last outbound, false otherwise.
 */
export function canSendToGroup(chatJid: string, cfg: EchoGuardConfig): boolean {
  if (!cfg.enabled) return true;
  if (!chatJid.endsWith('@g.us')) return true;

  const entry = groupCooldowns.get(chatJid);
  if (!entry) return true;

  const elapsed = Date.now() - entry.lastOutboundTs;
  if (elapsed >= cfg.groupCooldownMs) return true;

  log.warn({ chatJid, elapsedMs: elapsed, cooldownMs: cfg.groupCooldownMs },
    'echo guard: outbound group message suppressed (cooldown active)');
  return false;
}

/**
 * Record that a message was successfully sent to this JID.
 * Only tracks groups (JIDs ending with @g.us).
 */
export function recordGroupOutbound(chatJid: string): void {
  if (!chatJid.endsWith('@g.us')) return;
  groupCooldowns.set(chatJid, { lastOutboundTs: Date.now() });
}

/** Reset all state (for testing). */
export function __resetForTests(): void {
  groupCooldowns.clear();
}
```

- [ ] **Step 4: Run echo guard tests**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/core/echo-guard.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: All 8 tests PASS.

- [ ] **Step 5: Add config fields to `src/config.ts`**

After the `siblingPhones` block (~line 242), add:

```typescript
  // Echo guard — per-group outbound cooldown to prevent cascade floods.
  // In-memory, resets on restart. DMs are never affected.
  echoGuard: {
    enabled: ((instance?.echoGuard as Record<string, unknown> | undefined)?.enabled as boolean | undefined) !== false,
    groupCooldownMs: ((instance?.echoGuard as Record<string, unknown> | undefined)?.groupCooldownMs as number | undefined) ?? 60_000,
  },
```

- [ ] **Step 6: Integrate into `outbound-queue.ts`**

In `src/runtimes/agent/outbound-queue.ts`, add imports at the top:

```typescript
import { canSendToGroup, recordGroupOutbound } from '../../core/echo-guard.ts';
import { config } from '../../config.ts';
```

Then in `sendWithPacing()` (~line 596), add the echo guard check after the pacing wait and before `sendWithRetry()`:

```typescript
  private async sendWithPacing(text: string): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSentAt;
    if (elapsed < MIN_SEND_GAP_MS && this.lastSentAt !== 0) {
      const wait = MIN_SEND_GAP_MS - elapsed;
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    // AE4: Echo guard — suppress group messages during cooldown
    if (!canSendToGroup(this.chatJid, config.echoGuard)) {
      return; // silently drop — cooldown means this is likely unsolicited
    }
    await this.sendWithRetry(text);
    this.lastSentAt = Date.now();
    recordGroupOutbound(this.chatJid);
  }
```

- [ ] **Step 7: Type check + run outbound queue tests**

```bash
cd /home/q/LAB/WhatSoup
npx tsc --noEmit 2>&1 | head -20
npx vitest run tests/runtimes/agent/outbound-queue.test.ts --reporter=verbose 2>&1 | tail -20
npx vitest run tests/core/echo-guard.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: Clean compile, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/echo-guard.ts tests/core/echo-guard.test.ts \
  src/config.ts src/runtimes/agent/outbound-queue.ts
git commit -m "feat: add echo guard module — per-group outbound cooldown (AE4)"
```

---

## Task 6: AE5 — Session Admin Commands

**Files:**
- Modify: `src/runtimes/agent/commands.ts`
- Modify: `src/runtimes/agent/runtime.ts:~1448`
- Modify: `tests/runtimes/agent/commands.test.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`

- [ ] **Step 1: Write command classification tests**

Add to `tests/runtimes/agent/commands.test.ts`:

```typescript
  describe('session admin commands (AE5)', () => {
    it('/sessions returns local command "sessions"', () => {
      expect(classifyInput('/sessions')).toEqual({ type: 'local', command: 'sessions' });
    });

    it('/kill-session 2 returns local command with args', () => {
      expect(classifyInput('/kill-session 2')).toEqual({ type: 'local', command: 'kill-session', args: '2' });
    });

    it('/kill-session without args returns local command with undefined args', () => {
      expect(classifyInput('/kill-session')).toEqual({ type: 'local', command: 'kill-session', args: undefined });
    });

    it('/SESSIONS (uppercase) is treated as local command', () => {
      expect(classifyInput('/SESSIONS')).toEqual({ type: 'local', command: 'sessions' });
    });

    it('/Kill-Session 5 (mixed case) is treated as local command with args', () => {
      expect(classifyInput('/Kill-Session 5')).toEqual({ type: 'local', command: 'kill-session', args: '5' });
    });
  });
```

- [ ] **Step 2: Run to verify fail**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/runtimes/agent/commands.test.ts -t "session admin" --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `sessions` and `kill-session` not in LOCAL_COMMANDS, `args` not in CommandResult.

- [ ] **Step 3: Update `commands.ts`**

Replace the contents of `src/runtimes/agent/commands.ts`:

```typescript
// src/runtimes/agent/commands.ts
// Classifies incoming user input as a local command, forwarded slash command,
// or a regular message to be passed through to the agent.

export type CommandResult =
  | { type: 'local'; command: 'new' | 'status' | 'help' | 'sessions' | 'kill-session'; args?: string }
  | { type: 'forwarded'; text: string }
  | { type: 'message'; text: string };

/** Commands handled locally by the bot runtime. */
const LOCAL_COMMANDS = new Set(['new', 'status', 'help', 'sessions', 'kill-session']);

/**
 * Classify a user input string.
 *
 * - `/new`, `/status`, `/help`, `/sessions`, `/kill-session` (case-insensitive) → local
 * - Any other `/…` slash command → forwarded (passed through to Claude Code)
 * - No leading `/` → message
 */
export function classifyInput(text: string): CommandResult {
  if (!text.startsWith('/')) {
    return { type: 'message', text };
  }

  // Extract the command name: the word directly after the leading slash,
  // lowercased. E.g. "/Kill-Session 2" → "kill-session".
  const rest = text.slice(1);
  const parts = rest.split(/\s+/);
  const commandName = parts[0].toLowerCase();

  if (LOCAL_COMMANDS.has(commandName)) {
    const args = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
    return { type: 'local', command: commandName as CommandResult & { type: 'local' } extends { command: infer C } ? C : never, args };
  }

  return { type: 'forwarded', text };
}
```

Note: The type assertion for `command` needs to match the union. Simpler approach:

```typescript
    return { type: 'local', command: commandName as 'new' | 'status' | 'help' | 'sessions' | 'kill-session', args };
```

- [ ] **Step 4: Run command tests**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/runtimes/agent/commands.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: All tests pass (existing + new).

- [ ] **Step 5: Implement `/sessions` and `/kill-session` handlers in `runtime.ts`**

In `src/runtimes/agent/runtime.ts`, inside the `switch (classified.command)` block (after the `case 'help'` block, ~line 1542), add:

```typescript
        case 'sessions': {
          // Admin-only
          if (!isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
            return;
          }
          const entries: string[] = [];
          let idx = 1;
          if (this.sessionScope === 'per_chat') {
            for (const [mapKey, sess] of this.chatSessions) {
              const st = sess.getStatus();
              if (!st.active) continue;
              const isGrp = mapKey.includes('_at_g.us') || sess.chatJid.endsWith('@g.us');
              const label = isGrp ? 'Group' : 'DM';
              const ageStr = st.startedAt ? formatAge(st.startedAt) : '?';
              const tkTotal = (st.totalInputTokens ?? 0) + (st.totalOutputTokens ?? 0);
              const tkStr = tkTotal > 1000 ? `${(tkTotal / 1000).toFixed(1)}k` : String(tkTotal);
              entries.push(`${idx}. ${mapKey} (${label}) — ${ageStr}, ${st.messageCount} msgs, ${tkStr} tokens`);
              idx++;
            }
          } else {
            const st = this.session?.getStatus();
            if (st?.active) {
              const ageStr = st.startedAt ? formatAge(st.startedAt) : '?';
              entries.push(`1. ${this.activeChatJid ?? 'unknown'} — ${ageStr}, ${st.messageCount} msgs`);
            }
          }
          const text = entries.length > 0
            ? `*Active Sessions (${entries.length})*\n\n${entries.join('\n')}\n\n/kill-session <number> to terminate`
            : '_No active sessions._';
          this.sendDirect(chatJid, text);
          break;
        }

        case 'kill-session': {
          // Admin-only
          if (!isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
            return;
          }
          const targetIdx = parseInt(classified.args ?? '', 10);
          if (isNaN(targetIdx) || targetIdx < 1) {
            this.sendDirect(chatJid, '_Usage: /kill-session <number>_\nRun /sessions first to see the list.');
            break;
          }
          if (this.sessionScope === 'per_chat') {
            const activeSessions = [...this.chatSessions.entries()].filter(([, s]) => s.getStatus().active);
            if (targetIdx > activeSessions.length) {
              this.sendDirect(chatJid, `_Invalid session number. ${activeSessions.length} active._`);
              break;
            }
            const [mapKey, targetSession] = activeSessions[targetIdx - 1];
            this.chatQueues.get(mapKey)?.abortTurn();
            this.chatSessions.delete(mapKey);
            this.chatQueues.delete(mapKey);
            this.cleanupPerChatCrashTurnState(mapKey);
            await targetSession.shutdown(false);
            const label = mapKey.includes('_at_g.us') ? 'Group' : 'DM';
            this.sendDirect(chatJid, `_Session killed: ${mapKey} (${label})_`);
          } else {
            if (!this.session?.getStatus().active) {
              this.sendDirect(chatJid, '_No active session to kill._');
              break;
            }
            this.getActiveQueue()?.abortTurn();
            await this.session.shutdown(false);
            this.session = null;
            this.queue = null;
            this.sendDirect(chatJid, '_Session killed._');
          }
          break;
        }
```

Also update the `/help` response at ~line 1534 to include the new commands:

```typescript
        case 'help': {
          const helpText =
            '*/new* — start a fresh session\n' +
            '*/status* — show current session status\n' +
            '*/sessions* — list all active sessions _(admin)_\n' +
            '*/kill-session <N>* — terminate a session by number _(admin)_\n' +
            '*/help* — show this help\n' +
            '_Any other message is forwarded to Claude Code._\n' +
            'Other slash commands (e.g. `/compact`) are passed directly to Claude Code.';
          this.sendDirect(chatJid, helpText);
          break;
        }
```

- [ ] **Step 6: Type check**

```bash
cd /home/q/LAB/WhatSoup
npx tsc --noEmit 2>&1 | head -20
```

Expected: Clean compile. If `classified.args` causes a type error on the existing `CommandResult` consumers, verify the union type allows `args?: string` on all local commands (it's optional, so existing destructures of `{ command }` are unaffected).

- [ ] **Step 7: Run all tests**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run tests/runtimes/agent/commands.test.ts --reporter=verbose 2>&1 | tail -20
npx vitest run tests/runtimes/agent/runtime.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: All pass.

- [ ] **Step 8: Commit**

```bash
git add src/runtimes/agent/commands.ts src/runtimes/agent/runtime.ts \
  tests/runtimes/agent/commands.test.ts tests/runtimes/agent/runtime.test.ts
git commit -m "feat: add /sessions and /kill-session admin commands (AE5)"
```

---

## Task 7: Full Test Suite + Type Check

Final verification across the entire codebase.

- [ ] **Step 1: Full type check**

```bash
cd /home/q/LAB/WhatSoup
npx tsc --noEmit 2>&1 | tail -20
```

Expected: No errors.

- [ ] **Step 2: Full test suite**

```bash
cd /home/q/LAB/WhatSoup
npx vitest run --reporter=verbose 2>&1 | tail -40
```

Expected: All tests pass (should be ~3586+ tests, matching the last known green count plus new tests).

- [ ] **Step 3: Commit any fixups (if needed)**

Only if Steps 1-2 revealed issues from cross-task interactions.

---

## Deployment Notes

After all tasks are complete and tests pass:

1. **AE3 (Task 2)** can be deployed immediately — it's a data fix already applied.
2. **AE1 + AE2 + AE6 (Tasks 1, 3, 4)** — push to main, restart agent instances.
3. **AE4 (Task 5)** — push to main, restart agent instances. Can be disabled per-instance via `echoGuard.enabled: false`.
4. **AE5 (Task 6)** — push to main, restart agent instances. Test `/sessions` and `/kill-session` from admin DM.

Services need restart to pick up changes. Use `systemctl --user restart whatsoup@<name>` for each agent instance.
