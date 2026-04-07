# Anti-Echo Protocol & Session Management Controls — Design Specification

**Date:** 2026-04-07
**Status:** Draft
**Author:** Q (investigation + spec), Lucas (direction)
**Depends on:** Identity drift fix (commit `3385978`) deployed

---

## 1. Problem Statement

When WhatSoup agent instances restart, multiple agents produce unsolicited messages to shared groups simultaneously. The root cause is **proactive session resume** (runtime.ts:1131-1211), which injects a `[System: session resumed...]` turn directly into agent processes on startup. The agent responds to this synthetic turn, and the response is sent to the group — **completely bypassing the ingest pipeline, access policy, and sibling filter.**

This is not a cascade where agents respond to each other. Each agent independently fires its own resume, producing parallel unsolicited messages. The sibling filter in `access-policy.ts` works correctly for normal message flow — verified by logs showing dozens of successful `sibling_bot` blocks. The problem is that proactive resume is a separate code path with no group awareness.

A secondary issue compounds it: the WHATSOUP orchestration group (`120363406689931730@g.us`) has `status='allowed'` in agent instances' access lists, meaning every non-sibling message (including Lucas's) triggers `group_auto_respond` — all agents respond independently instead of only when @mentioned.

### Verified Root Causes

| # | Root Cause | Evidence |
|---|-----------|----------|
| RC-1 | Proactive resume bypasses ingest pipeline for groups | runtime.ts:1198-1207 injects turn directly, no `shouldRespond()` check |
| RC-2 | Shared/single mode resume has no staleness check | runtime.ts:1214-1280 resumes any prior session regardless of age |
| RC-3 | Group `allowed` status causes `group_auto_respond` for non-siblings | access-policy.ts:128-131, verified in besbot + shandroid access_list |
| RC-4 | No outbound rate limiting or cooldown on group messages | outbound-queue.ts has zero throttle/cooldown logic |
| RC-5 | No admin commands for session visibility or manual kill | commands.ts only has `/new`, `/status`, `/help` |

### What Was Ruled Out

| Assertion | Verdict | Evidence |
|-----------|---------|----------|
| Sibling filter fails due to LID resolution | FALSE | Logs show successful `sibling_bot` blocks; all instances have identical 41-row lid_mappings |
| L1 hydration only knows own mappings | FALSE | Each instance's auth dir has reverse files for all agents |
| Resume fires before LID data available | FALSE | `hydrateLidMappings()` is synchronous at main.ts:138, before `runtime.start()` |
| Agents respond to each other's messages (cascade) | FALSE | Sibling filter blocks cross-agent messages; the unsolicited output comes from resume, not responses |

---

## 2. Scope — Six Sub-Projects (AE1-AE6)

| # | Sub-Project | Severity | Effort | Summary |
|---|-------------|----------|--------|---------|
| AE1 | Group Resume Suppression | High | Small | Skip proactive resume for group conversations |
| AE2 | Shared/Single Mode Staleness | High | Small | Add staleness check to shared/single resume path |
| AE3 | Orchestrated Group Access Fix | High | Small | Remove `group_auto_respond` from agent instances, mention-only |
| AE4 | Echo Guard Module | Medium | Medium | Outbound cooldown per group as defense-in-depth |
| AE5 | Session Admin Commands | Medium | Medium | `/sessions` and `/kill-session` via WhatsApp |
| AE6 | Dead Code Removal | Low | Small | Remove `sweepOrphanedSessions` (superseded by `classifyActiveSessions`) |

---

## 3. Sub-Project AE1: Group Resume Suppression

### 3.1 Problem

`runtime.ts:1131-1211` — The per_chat proactive resume loop iterates all resumable checkpoints and spawns sessions for each, including group conversations. At line 1203, it sends `[System: session resumed after service restart — continue where you left off]` directly to the agent process. The agent interprets this as a prompt to announce its status to the group. This path has no call to `shouldRespond()`, no sibling check, no access policy evaluation.

### 3.2 Design

Add a group-awareness guard inside the per_chat resume loop, before session creation:

```typescript
// After line 1135 (session_id null check), before staleness check:
if (cp.conversation_key.endsWith('_at_g.us')) {
  log.info({ conversationKey: cp.conversation_key }, 'skipping proactive resume — group chat');
  this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
  continue;
}
```

Group sessions start fresh when someone @mentions the agent. The agent picks up context from the conversation window (last 50-100 messages) — no stale session state needed.

### 3.3 Edge Cases

- **DM resume unaffected.** Only `_at_g.us` conversation keys are skipped. DM resume continues with the existing 60-minute staleness check.
- **Agent loses in-progress group work.** If an agent was mid-task in a group when the restart happened, that work context is lost. This is acceptable — the orchestrator can re-assign via @mention, and the conversation window provides sufficient context.
- **Sandboxed per_chat already excluded.** The guard at line 1131 (`!this.sandboxPerChat`) already skips sandbox mode. This fix applies to the remaining non-sandboxed per_chat path.

### 3.4 Files

- `src/runtimes/agent/runtime.ts` — add group check in resume loop (~L1136)
- `tests/runtimes/agent/runtime.test.ts` — test that group checkpoints are skipped and marked `ended`

---

## 4. Sub-Project AE2: Shared/Single Mode Staleness

### 4.1 Problem

`runtime.ts:1214-1280` — The shared/single mode resume path has no staleness check. It resumes any prior active session regardless of age. If the prior session's `chat_jid` is a group, the pending startup message (`_Resuming session from *3 days ago*..._`) is sent to the group unsolicited.

Per_chat mode has a 60-minute timeout (lines 1137-1147). Shared/single mode has nothing.

### 4.2 Design

1. **Add staleness check** matching per_chat behavior:

```typescript
// After line 1218 (getActiveSession), before session creation:
if (prior) {
  const checkpoint = this.durability?.getSessionCheckpoint(
    toConversationKey(prior.chat_jid)
  );
  if (checkpoint?.updated_at) {
    const age = Date.now() - new Date(checkpoint.updated_at + 'Z').getTime();
    if (age > 60 * 60 * 1000) {
      log.info({ chatJid: prior.chat_jid, ageMinutes: Math.round(age / 60_000) },
        'skipping shared/single resume — session too stale');
      this.durability?.upsertSessionCheckpoint(
        toConversationKey(prior.chat_jid), { sessionStatus: 'ended' }
      );
      prior = null; // fall through to fresh session on next message
    }
  }
}
```

2. **Suppress startup message for groups** (not the session itself):

In shared mode, one session serves all chats. Skipping the resume entirely because `chat_jid` happens to be a group would kill DM resume too. Instead, resume the session but suppress the unsolicited startup message:

```typescript
// After line 1269 (formatAge), before setting pendingStartupMessage:
if (resumeChatJid.endsWith('@g.us')) {
  log.info({ chatJid: resumeChatJid }, 'suppressing startup message — group chat');
  // Session is resumed (serves all chats), but no unsolicited group message sent.
  // DM users trigger the session naturally when they message.
} else {
  this.pendingStartupMessage = {
    chatJid: resumeChatJid,
    text: `_Resuming session_ from *${age}*. Send a message to continue, or /new to start fresh.`,
  };
}
```

For single mode (one session, one chat): if `chat_jid` is a group, skip the resume entirely (set `prior = null`). Single mode has no cross-chat concern.

```typescript
// Before the if (prior?.session_id) block:
if (!this.shared && prior?.chat_jid?.endsWith('@g.us')) {
  log.info({ chatJid: prior.chat_jid }, 'skipping single-mode resume — group chat');
  prior = null;
}
```

### 4.3 Edge Cases

- **Shared mode resumes even with group chat_jid.** The session is shared across all chats. Only the startup notification is suppressed for groups. DMs work normally — the next inbound DM triggers the resumed session.
- **Single mode skips group resume entirely.** Single mode has one session bound to one chat. If that chat is a group, skip resume — the session starts fresh on next @mention.
- **No durability checkpoint.** If `getSessionCheckpoint()` returns null (edge case: checkpoint was never written), skip resume as a safety default.

### 4.4 Files

- `src/runtimes/agent/runtime.ts` — add staleness + group check in shared/single resume path (~L1218)
- `tests/runtimes/agent/runtime.test.ts` — test staleness skip + group skip for shared mode

---

## 5. Sub-Project AE3: Orchestrated Group Access Fix

### 5.1 Problem

The WHATSOUP group (`120363406689931730@g.us`) has `status='allowed'` in besbot's and shandroid's `access_list` tables. This triggers `group_auto_respond` at access-policy.ts:128-131, causing agents to respond to ALL non-sibling messages — including Lucas's messages, which should only reach Q (the orchestrator).

Lucas (18459780919) is not in any agent's `siblingPhones` (by design — he's the owner, not a sibling bot). But with `group_auto_respond` active, every Lucas message triggers independent responses from all agents.

### 5.2 Design

1. **Data fix:** Remove the `allowed` access_list entries for the WHATSOUP group from agent instances:

```sql
-- besbot
DELETE FROM access_list
WHERE subject_type = 'group' AND subject_id = '120363406689931730@g.us';

-- shandroid
DELETE FROM access_list
WHERE subject_type = 'group' AND subject_id = '120363406689931730@g.us';
```

2. **Behavioral result:** Agents in the group become mention-only. The sibling filter handles agent-to-agent messages (already working). Lucas and any non-sibling human messages require explicit @mention to reach a specific agent. This matches the intended orchestration model: Lucas → Q → agents via @mention.

3. **No code change required.** The access policy logic is correct; the data is wrong.

### 5.3 Edge Cases

- **Other groups.** Only the WHATSOUP orchestration group is affected. Other groups that legitimately need `auto_respond` (e.g., customer-facing groups) retain their access_list entries.
- **Lucas needs to reach agents directly.** If Lucas wants to talk to BES Bot directly, he @mentions it. This is the correct pattern for an orchestrated group.
- **New orchestrated groups.** Future orchestrated groups should not be added to agent access lists with `allowed` status. Document this convention.

### 5.4 Files

- No code files — database-only fix
- `docs/runbook.md` — add section: "Orchestrated groups should be mention-only on agent instances"

---

## 6. Sub-Project AE4: Echo Guard Module

### 6.1 Problem

Even with AE1-AE3 fixing the known paths, defense-in-depth is needed. No outbound rate limiting exists anywhere in the agent runtime or outbound queue. If a new code path introduces unsolicited group messages in the future, there's no safety net.

### 6.2 Design

New module: `src/core/echo-guard.ts`

**State (in-memory):**
```typescript
interface GroupCooldownEntry {
  lastOutboundTs: number;
  consecutiveCount: number;
}

const groupCooldowns = new Map<string, GroupCooldownEntry>();
```

**API:**
```typescript
/** Check if an outbound message to this group is allowed. */
export function canSendToGroup(groupJid: string, config: EchoGuardConfig): boolean;

/** Record that a message was sent to this group. */
export function recordGroupOutbound(groupJid: string): void;

/** Reset state (for testing). */
export function __resetForTests(): void;
```

**Logic in `canSendToGroup`:**
1. If `groupJid` doesn't end with `@g.us`, return `true` (DMs unaffected).
2. Look up `groupCooldowns.get(groupJid)`.
3. If no entry or `Date.now() - lastOutboundTs > cooldownMs`, return `true`.
4. Otherwise return `false` and log the suppression.

**Integration point:** `outbound-queue.ts` — check `canSendToGroup()` before sending to groups. If blocked, log and drop the message (don't queue it — the message is unsolicited by definition if it hits the cooldown).

**Config surface** (in instance config.json, optional):
```json
{
  "echoGuard": {
    "groupCooldownMs": 60000,
    "enabled": true
  }
}
```

Defaults: enabled=true, cooldownMs=60000 (60 seconds). Config is optional — defaults baked in.

### 6.3 Edge Cases

- **Legitimate rapid group messages.** An agent responding to multiple @mentions in quick succession would be throttled. This is acceptable — 60s between group messages is a reasonable pace for orchestrated groups. For high-throughput groups, operators can increase `groupCooldownMs` or disable per-instance.
- **Cooldown resets on restart.** In-memory state clears on restart. This is intentional — restart is the most vulnerable moment, but AE1/AE2 already handle the resume path. The cooldown catches runtime cascades, not startup cascades.
- **Tool output messages.** Agent tool output (code blocks, status updates) flows through the outbound queue too. The cooldown applies to ALL outbound group messages, not just text. This prevents tool-output floods. If this is too aggressive, a future refinement could exempt tool-output messages or use a separate higher limit.
- **Admin messages bypass.** Messages from admin commands (`/sessions` response, etc.) should bypass the cooldown. Add an `isAdmin` flag to the outbound queue's send path.

### 6.4 Files

- `src/core/echo-guard.ts` — new module (~60 lines)
- `src/config.ts` — add `echoGuard` config fields
- `src/runtimes/agent/outbound-queue.ts` — integrate `canSendToGroup()` check before send
- `tests/core/echo-guard.test.ts` — test cooldown behavior, reset, group-only filtering

---

## 7. Sub-Project AE5: Session Admin Commands

### 7.1 Problem

No way to inspect or control agent sessions from WhatsApp. Operators must SSH into the server, query SQLite, and manually kill PIDs. When a session is stuck (infinite loop, hung tool call, runaway token usage), the only recourse is restarting the entire instance.

### 7.2 Design

Add two new local commands to `commands.ts` and handle them in the agent runtime.

**Command: `/sessions`**

Lists all active sessions for this instance. Response format:

```
*Active Sessions (3)*

1. 18459780919 (DM) — 45min, 23 msgs, 12.4k tokens, claude-cli
2. 120363406689931730@g.us (Group) — 2h, 8 msgs, 45.2k tokens, claude-cli
3. 18454433572 (DM) — 5min, 3 msgs, 1.1k tokens, codex-cli

/kill-session <number> to terminate
```

Data sources:
- `chatSessions` map (runtime) for active sessions + their `getStatus()` for PID, age
- `agent_sessions` table for token counts, message counts, provider
- Session manager's `chatJid` for the target chat

**Command: `/kill-session <number>`**

Kills a specific session by its list index from `/sessions`. Follows the `/new` command pattern:

1. Validate index, resolve to session reference from `chatSessions` map
2. Call `abortTurn()` on the session's outbound queue
3. Delete session from `chatSessions` and `chatQueues` maps
4. Call `cleanupPerChatState(mapKey)` for per-chat ephemeral state
5. Call `session.shutdown(false)` (non-resumable, marks as `ended`)
6. Reply: `_Session killed: 18459780919 (DM)_`

For shared/single mode: `/kill-session` kills the single session — equivalent to a softer `/new` that doesn't spawn a replacement.

**Admin-only enforcement:** Both commands are admin-only. Check `isAdminPhone(resolvePhoneFromJid(msg.senderJid, db), config.adminPhones)` before executing. Non-admins get no response (consistent with existing admin-only `/new` behavior in shared mode).

### 7.3 Edge Cases

- **Kill during active turn.** The `abortTurn()` call clears tool timers, buffered content, and stops typing indicators. The session's child process receives SIGTERM with a 5s grace period before SIGKILL. Outbound queue is replaced before session teardown to prevent stale output from leaking.
- **Kill the session you're talking to.** If an admin sends `/kill-session 1` from a DM that IS session 1, the kill executes but the confirmation message may fail to send (the queue was just aborted). Handle by sending confirmation through a fresh temporary queue or via `sendDirect()`.
- **Race with crash handler.** If the session crashes between `/sessions` and `/kill-session`, the session reference may be gone. Check for null and reply: `_Session already ended._`
- **Index staleness.** Between `/sessions` and `/kill-session`, a session may end or a new one may start. The index could point to a different session. Mitigate by including the conversation key in the kill confirmation and requiring the operator to verify.

### 7.4 Files

- `src/runtimes/agent/commands.ts` — add `sessions` and `kill-session` to LOCAL_COMMANDS, extend `CommandResult` type
- `src/runtimes/agent/runtime.ts` — add handlers for new commands in the `classified.type === 'local'` switch
- `tests/runtimes/agent/commands.test.ts` — test command classification
- `tests/runtimes/agent/runtime.test.ts` — test session listing and kill flow

---

## 8. Sub-Project AE6: Dead Code Removal

### 8.1 Problem

`sweepOrphanedSessions` in `session-db.ts:272-278` is imported but never called in the runtime. It was superseded by `classifyActiveSessions` (in `session-classifier.ts`), which provides richer classification (authoritative_live, stale_live, stale_dead, ambiguous) and is the actual function called at startup (runtime.ts:1097).

### 8.2 Design

1. Remove `sweepOrphanedSessions` from `session-db.ts`
2. Remove its import from `runtime.ts:19`
3. Verify no other files reference it

### 8.3 Files

- `src/runtimes/agent/session-db.ts` — remove function
- `src/runtimes/agent/runtime.ts` — remove import

---

## 9. Testing Strategy

### 9.1 Unit Tests

| Sub-Project | Test File | Tests |
|-------------|-----------|-------|
| AE1 | `tests/runtimes/agent/runtime.test.ts` | Resume loop skips `_at_g.us` conversation keys; marks them `ended`; DM resume unaffected |
| AE2 | `tests/runtimes/agent/runtime.test.ts` | Shared mode skips stale sessions (>60min); skips group chat_jids; resumes fresh DM sessions |
| AE4 | `tests/core/echo-guard.test.ts` | Cooldown blocks within window; allows after window; DMs unaffected; reset clears state; admin bypass works |
| AE5 | `tests/runtimes/agent/commands.test.ts` | `/sessions` and `/kill-session` classified as local; `/kill-session` requires numeric arg |
| AE5 | `tests/runtimes/agent/runtime.test.ts` | Session list format; kill follows cleanup pattern; admin-only enforcement; kill-self edge case; stale index handling |
| AE6 | (compile check) | Verify no references to removed function |

### 9.2 Integration Tests

- **Restart simulation:** Start an agent runtime with group + DM checkpoints in the DB. Verify only DM sessions resume. Verify group checkpoints marked `ended`.
- **Echo guard integration:** Send 3 rapid messages to a group outbound queue. Verify only the first is delivered; others are logged and dropped.
- **Session kill flow:** Create a session via `ensureSessionAndQueueSync`, then kill it via the command handler. Verify PID is terminated, maps are cleaned, DB status is `ended`.

---

## 10. Deployment Sequence

1. **AE3 first (data fix).** Remove `allowed` group entries from besbot + shandroid DBs. No code deploy needed. Immediate effect on next message.
2. **AE1 + AE2 + AE6 (code, low risk).** Small changes in runtime.ts, no new modules. Deploy together.
3. **AE4 (code, new module).** Echo guard + outbound queue integration. Deploy after AE1/AE2 verified.
4. **AE5 (code, new commands).** Session admin commands. Can deploy independently.

---

## 11. Out of Scope (Deferred)

| Topic | Reason | Future Spec |
|-------|--------|-------------|
| Identity function consolidation (11 duplicates found) | Tech debt, not the cascade root cause. Separate spec. | `identity-consolidation-design.md` |
| Sessions page in console UI | Requires API endpoints (AE5 commands are WhatsApp-only). Separate spec after backend hardening. | `sessions-page-design.md` |
| Fleet-wide session dashboard | Requires cross-instance session aggregation in fleet server. | `sessions-page-design.md` |
| Tiered staleness (15m/60m/24h) | Simpler binary 60m cutoff is sufficient for now. Revisit if operators need finer control. | Future iteration |
| Cross-instance LID sync at startup (L5) | Not needed — all instances already have complete mappings via Baileys auth dir. | N/A |

---

## 12. Appendix: Investigation Summary

### A. Identity Resolution Audit

The identity management system was thoroughly audited during this investigation. Key findings:

- **LID resolution is reliable.** All instances have identical 41-row `lid_mappings` tables. Baileys auth dirs contain reverse mapping files for all agents. L1 hydration at startup populates mappings synchronously before any runtime code executes.
- **Sibling filter works correctly.** Access-policy.ts:121-124 runs before group_auto_respond at L128. Verified by logs showing successful `sibling_bot` blocks across all instances.
- **Groups are LID-only.** All non-self senders in group messages use `@lid` format. No `@s.whatsapp.net` JIDs appear as sender_jid in group messages across any instance.
- **DMs use both formats.** The same person can have DM chats under both `phone@s.whatsapp.net` and `phone@lid`. This is a separate concern from the echo cascade.

### B. Duplicate Functions Identified (Deferred)

| # | Functions | Overlap | Priority |
|---|-----------|---------|----------|
| 1 | `getAllLidMappings` vs `buildLidMappings` | Same SQL query, different return shapes | HIGH |
| 2 | `canonicalizeChatJid` vs `resolveLid` | Duplicate prepared statement caches for identical query | HIGH |
| 3 | 7x inline `SELECT lid, phone_jid FROM lid_mappings` | Same query in 7 locations | HIGH |
| 4 | `extractLocal` wrapping `toConversationKey` | Misleading alias, adds only try/catch | MED |
| 5 | `toConversationKey` reimplements `normalizeLid` | Identical colon-strip logic | MED |
| 6 | `resolvePhoneFromJid` manual `indexOf('@')` | Should use `bareNumber` + `isLidJid` | LOW |
| 7 | `contacts-sync.ts` regex fallback | Should use `bareNumber()` | LOW |
| 8 | `advanced.ts` raw domain string literals | Should use `isPnJid`/`isLidJid` | LOW |
| 9 | `phoneFromJid` in fleet lines | Misleading name for LID inputs | LOW |
| 10 | SQL CASE reimplements normalizeLid in reconciliation | Duplicated within same query | LOW |
| 11 | Ingest vs runtime LID-to-key resolution | Different functions, different output formats | HIGH |

### C. Brick Observations (Noted, Not Addressed)

- Crash risk in deferred startup notification (shared mode)
- Missing `this.shared` checks in some runtime paths
- `sendDirect` type mismatch at runtime.ts:2845
- Multiple worktree runtime files needing consistency checks
