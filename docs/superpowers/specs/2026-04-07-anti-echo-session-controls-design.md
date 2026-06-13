# Anti-Echo Protocol & Session Management Controls — Design Specification

**Date:** 2026-04-07
**Status:** completed
**Author:** Q (investigation + spec), Lucas (direction)
**Implementation:** `src/core/echo-guard.ts` and wiring in `src/runtimes/agent/outbound-queue.ts` and `runtime.ts`.
**Depends on:** Identity drift fix (commit `3385978`) deployed

---

## 1. Problem Statement

When WhatSoup agent instances restart, multiple agents produce unsolicited messages to shared groups simultaneously. The root cause is **proactive session resume** (`src/runtimes/agent/runtime.ts:1131-1211`), which injects a `[System: session resumed...]` turn directly into agent processes on startup. The agent responds to this synthetic turn, and the response is sent to the group — **completely bypassing the ingest pipeline, access policy, and sibling filter.**

This is not a cascade where agents respond to each other. Each agent independently fires its own resume, producing parallel unsolicited messages. The sibling filter in `src/core/access-policy.ts` works correctly for normal message flow — verified by logs showing dozens of successful `sibling_bot` blocks. The problem is that proactive resume is a separate code path with no group awareness.

A secondary issue compounds it: the WHATSOUP orchestration group (`120363555555555001@g.us`) has `status='allowed'` in agent instances' access lists, meaning every non-sibling message (including Lucas's) triggers `group_auto_respond` — all agents respond independently instead of only when @mentioned.

### 1.1 The Two Code Paths

**Normal inbound flow** (working correctly):
```
WhatsApp message → ingest.ts:createIngestHandler() → storeMessageIfNew()
  → access-policy.ts:shouldRespond()
    → L42-44: isFromMe check
    → L54: isSiblingBot = msg.isGroup && config.siblingPhones.has(effectivePhone)
    → L121-124: sibling filter (respond: mentioned only)
    → L127-131: group_auto_respond (if allowed in access_list)
  → runtime.handleMessage(msg)
```

**Proactive resume flow** (the problem):
```
runtime.start() → L1131: sessionScope === 'per_chat' && !sandboxPerChat
  → L1132: durability.getResumableCheckpoints()
    → SQL: SELECT ... FROM session_checkpoints WHERE session_status IN ('active', 'suspended')
  → L1163-1191: createSessionManager() for each checkpoint
  → L1198: session.spawnSession(full.session_id).then(...)
  → L1203: session.sendTurn('[System: session resumed...]')
  → Agent responds → outbound queue → WhatsApp group
  ⚠️ NO shouldRespond(), NO sibling check, NO access policy
```

### 1.2 Verified Root Causes

| # | Root Cause | Code Location | Evidence |
|---|-----------|---------------|----------|
| RC-1 | Proactive resume bypasses ingest pipeline for groups | `runtime.ts:1198-1207` — fire-and-forget `.then()` injects turn via `session.sendTurn()` | Agents post "Using superpowers to recover state..." unprompted |
| RC-2 | Shared/single mode resume has no staleness check | `runtime.ts:1218` — `getActiveSession(this.db)` returns any `active`/`suspended` session, no age filter | Per-chat has 60-min check at L1139; shared/single has none |
| RC-3 | Group `allowed` status causes `group_auto_respond` for non-siblings | `access-policy.ts:128-131` — `lookupAccess(db, 'group', msg.chatJid)` returns `allowed` | Verified: `sqlite3 besbot/bot.db "SELECT * FROM access_list WHERE subject_type='group'"` → `120363555555555001@g.us|allowed` |
| RC-4 | No outbound rate limiting or cooldown on group messages | `outbound-queue.ts:571-586` — `drainQueue()` sends immediately, only inter-message pacing via `MIN_SEND_GAP_MS` | No throttle, no group awareness in send path |
| RC-5 | No admin commands for session visibility or manual kill | `commands.ts:11` — `LOCAL_COMMANDS = new Set(['new', 'status', 'help'])` | No `/sessions` or `/kill-session` |

### 1.3 What Was Ruled Out

| Assertion | Verdict | Evidence |
|-----------|---------|----------|
| Sibling filter fails due to LID resolution | **FALSE** | Instance logs show dozens of `reason: "sibling_bot"` entries for Q's messages in the WHATSOUP group. All 3 instances (Q, besbot, shandroid) have identical 41-row `lid_mappings` tables — `diff` exit code 0. |
| L1 hydration only knows own mappings | **FALSE** | Q's auth dir (`~/.config/whatsoup/instances/q/auth/`) has 7 `lid-mapping-*_reverse.json` files including Agent C (`1111111000004` → `15551230005`), Shannon (`11111110000005` → `15551230003`), and L (`111111100000006` → `15551230002`). Baileys writes these from WhatsApp protocol events. |
| Resume fires before LID data available | **FALSE** | `main.ts:138` calls `hydrateLidMappings(db, config.authDir)` synchronously. `runtime.start()` is called later at `main.ts:676` (`await runtime.start()`). LID mappings are fully populated before resume runs. |
| Agents respond to each other's messages (cascade) | **FALSE** | The sibling filter at `access-policy.ts:121-124` correctly blocks cross-agent messages. The unsolicited output comes from proactive resume injecting turns, not from agents responding to each other. |

### 1.4 WhatsApp Identity Context

Groups use LID-only addressing. Verified across all instances:

| Instance | Sender JID format in WHATSOUP group | Example |
|----------|--------------------------------------|---------|
| Q | Others appear as `@lid` | Agent C: `1111111000004@lid`, Lucas: `11111110000007@lid` |
| Agent C | Others appear as `@lid` | Q: `11111110000008@lid`, Shannon: `11111110000005@lid` |
| Shandroid | Others appear as `@lid` | Q: `11111110000008@lid`, Agent C: `1111111000004@lid` |

Self-messages use the group JID as sender: `120363555555555001@g.us`. Zero `@s.whatsapp.net` JIDs appear as `sender_jid` in group messages.

The `resolvePhoneFromJid()` call at `access-policy.ts:52` resolves these LIDs correctly via `lid_mappings` DB table → sibling filter works. The problem is that proactive resume never reaches this code path.

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

The per_chat proactive resume loop at `src/runtimes/agent/runtime.ts:1131-1211`:

```typescript
// L1131: entry guard
if (this.sessionScope === 'per_chat' && !this.sandboxPerChat && this.durability) {
  // L1132: fetch all resumable checkpoints
  const resumableCheckpoints = this.durability.getResumableCheckpoints();
  // → durability.ts:248-250: SQL: SELECT ... FROM session_checkpoints
  //   WHERE session_status IN ('active', 'suspended') AND session_id IS NOT NULL

  for (const cp of resumableCheckpoints) {
    // L1134-1135: fetch full checkpoint, skip if no session_id
    const full = this.durability.getSessionCheckpoint(cp.conversation_key);
    if (!full?.session_id) continue;

    // L1137-1147: 60-minute staleness check (ONLY guard that exists)
    const RESUME_MAX_AGE_MS = 60 * 60 * 1000;
    // ... age check ...

    // L1149-1152: derive chatJid from conversation_key
    const chatJid = cp.conversation_key.includes('_at_')
      ? cp.conversation_key.replace('_at_', '@')  // groups: '120363..._at_g.us' → '120363...@g.us'
      : `${cp.conversation_key}@lid`;              // DMs: '15551230006' → '15551230006@lid'

    // L1163-1194: create SessionManager + outbound queue (no group filter)
    // L1198-1210: fire-and-forget resume + synthetic turn injection
    session.spawnSession(full.session_id).then(async () => {
      await new Promise(r => setTimeout(r, 1_000));
      if (!session.getStatus().active) return;
      await session.sendTurn('[System: session resumed after service restart — continue where you left off]');
      //                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
      //                      This turn triggers the agent to respond to the GROUP, unsolicited.
    });
  }
}
```

The loop iterates ALL resumable checkpoints including group conversations. The `conversation_key` format for groups ends with `_at_g.us` (e.g., `120363555555555001_at_g.us`). No check exists to skip groups.

### 3.2 Design

Add a group-awareness guard inside the resume loop, between the session_id null check (L1135) and the staleness check (L1137):

```typescript
// NEW: Skip group conversations — groups should not be proactively resumed.
// Agents in groups are orchestrated via @mentions. The ingest pipeline's
// sibling filter (access-policy.ts:121-124) gates group responses, but
// proactive resume bypasses ingest entirely. Group sessions start fresh
// on the next @mention, picking up context from the conversation window
// (getRecentMessages, default 50 msgs — see window.ts:23-68).
if (cp.conversation_key.endsWith('_at_g.us')) {
  log.info({ conversationKey: cp.conversation_key }, 'skipping proactive resume — group chat');
  this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
  continue;
}
```

### 3.3 Edge Cases

- **DM resume unaffected.** Only `_at_g.us` conversation keys are skipped. DM keys are bare phone numbers (e.g., `15551230006`) or LID numbers (e.g., `11111110000008`). Resume continues with the existing 60-minute staleness check at L1137-1147.
- **Agent loses in-progress group work.** If an agent was mid-task in a group when the restart happened, that session context is lost. Acceptable because: (a) the orchestrator can re-assign via @mention, (b) the conversation window (`window.ts:23-68`, default 50-100 messages) provides recent context, and (c) the alternative (unsolicited group messages) is worse.
- **Sandboxed per_chat already excluded.** The guard at L1131 (`!this.sandboxPerChat`) skips sandbox mode. Sandbox resume happens lazily via workspace provisioning. This fix applies only to the non-sandboxed per_chat path.
- **Checkpoint marked `ended`.** `upsertSessionCheckpoint()` (`durability.ts:514-516`) updates `session_status` and `updated_at`. The `ended` status prevents the checkpoint from appearing in future `getResumableCheckpoints()` calls (query filters for `IN ('active', 'suspended')`).

### 3.4 Files

| File | Change |
|------|--------|
| `src/runtimes/agent/runtime.ts` ~L1136 | Add `_at_g.us` check + `continue` in resume loop |
| `tests/runtimes/agent/runtime.test.ts` | Test: group checkpoint skipped and marked `ended`; DM checkpoint still resumes |

---

## 4. Sub-Project AE2: Shared/Single Mode Staleness

### 4.1 Problem

The shared/single mode resume path at `src/runtimes/agent/runtime.ts:1214-1274`:

```typescript
// L1218: fetch the most recent active/suspended session (ONE session, not per-chat)
const prior = (this.sandboxPerChat || this.sessionScope === 'per_chat')
  ? null
  : getActiveSession(this.db);
// → session-db.ts:91-107: SELECT ... FROM agent_sessions
//   WHERE status IN ('active', 'suspended') AND session_id IS NOT NULL
//   ORDER BY id DESC LIMIT 1

if (prior?.session_id && prior?.chat_jid) {
  // L1223-1226: capture values, log resume
  const resumeChatJid: string = prior.chat_jid;
  const resumeSessionId: string = prior.session_id;

  // L1228-1264: create SessionManager + queue (no staleness check, no group check)

  // L1266: spawn with resume
  await this.session.spawnSession(resumeSessionId, prior.id);

  // L1269-1273: set pending startup message — sent after WA connects
  const age = formatAge(prior.started_at);
  this.pendingStartupMessage = {
    chatJid: resumeChatJid,
    text: `_Resuming session_ from *${age}*. Send a message to continue, or /new to start fresh.`,
  };
  // ⚠️ No staleness check — resumes sessions from days ago
  // ⚠️ No group check — sends startup message to groups unsolicited
}
```

Two issues: (1) no staleness check (per_chat has one at L1137-1147; shared/single has none), and (2) no group awareness (startup message sent to `resumeChatJid` which could be a group JID).

### 4.2 Design

**Part 1: Staleness check.** Add after L1218, before the `if (prior?.session_id)` block:

```typescript
// NEW: Skip stale sessions in shared/single mode (same 60-min threshold as per_chat L1139).
if (prior) {
  const checkpoint = this.durability?.getSessionCheckpoint(
    toConversationKey(prior.chat_jid!)
  );
  if (checkpoint?.updated_at) {
    const age = Date.now() - new Date(checkpoint.updated_at + 'Z').getTime();
    if (age > 60 * 60 * 1000) {
      log.info({ chatJid: prior.chat_jid, ageMinutes: Math.round(age / 60_000) },
        'skipping shared/single resume — session too stale');
      this.durability?.upsertSessionCheckpoint(
        toConversationKey(prior.chat_jid!), { sessionStatus: 'ended' }
      );
      prior = null; // fall through — fresh session created on next inbound message
    }
  } else if (!checkpoint) {
    // Safety default: no checkpoint means we can't verify freshness — skip resume
    log.info({ chatJid: prior.chat_jid }, 'skipping shared/single resume — no checkpoint found');
    prior = null;
  }
}
```

**Part 2: Group-aware startup message suppression.** Replace L1269-1273:

```typescript
const age = formatAge(prior.started_at);

// NEW: Suppress startup message for groups.
// In shared mode, the session serves ALL chats — we resume it (it handles DMs too),
// but don't send an unsolicited notification to a group.
// In single mode (one session, one chat), skip the entire resume if it's a group.
if (resumeChatJid.endsWith('@g.us')) {
  if (!this.shared) {
    // Single mode: skip resume entirely — can't suppress message without orphaning session
    log.info({ chatJid: resumeChatJid }, 'skipping single-mode resume — group chat');
    await this.session!.shutdown(false); // marks as 'ended', kills child
    this.session = null;
    // Queue cleanup: shared mode sets outboundQueues, single mode sets this.queue
    this.queue = null;
  } else {
    log.info({ chatJid: resumeChatJid }, 'suppressing startup message — shared-mode group chat');
    // Session stays alive (serves DMs), just no unsolicited group message.
  }
} else {
  this.pendingStartupMessage = {
    chatJid: resumeChatJid,
    text: `_Resuming session_ from *${age}*. Send a message to continue, or /new to start fresh.`,
  };
}
```

### 4.3 Edge Cases

- **Shared mode resumes even with group `chat_jid`.** In shared mode (`this.shared = true`, config: `agentOptions.sessionScope: 'shared'`), one session serves all chats via `outboundQueues` map (`runtime.ts:552`). The `prior.chat_jid` reflects whichever chat created the session, not the only chat. Suppressing the startup message for groups while keeping the session alive is correct — DM users trigger the session naturally on their next message.
- **Single mode skips group resume entirely.** In single mode (`sessionScope: 'single'`), one session is bound to one chat. If that chat is a group, the session cannot serve DMs. Skipping resume is safe — the session starts fresh on next @mention. The `shutdown(false)` call at `session.ts:1234-1288` sends SIGTERM to the child process (L1265), waits 5s grace (`SHUTDOWN_GRACE_MS`), escalates to SIGKILL (L1269), and marks the `agent_sessions` row as `ended` (L1249).
- **No durability checkpoint found.** If `getSessionCheckpoint()` returns null (edge case: checkpoint never written, DB corruption, or first-ever run), skip resume as a safety default rather than resuming blindly.
- **`prior` set to null after `getActiveSession`.** The existing `if (prior?.session_id && prior?.chat_jid)` guard at L1219 handles this cleanly — the block is skipped, no session is created, startup continues. Fresh session created on first inbound message via `ensureSessionAndQueueSync()` (L1442-1444).

### 4.4 Files

| File | Change |
|------|--------|
| `src/runtimes/agent/runtime.ts` ~L1218 | Add staleness check + group suppression in shared/single resume path |
| `tests/runtimes/agent/runtime.test.ts` | Test: stale session skipped; group startup message suppressed in shared mode; single-mode group resume skipped entirely; missing checkpoint defaults to skip |

---

## 5. Sub-Project AE3: Orchestrated Group Access Fix

### 5.1 Problem

The WHATSOUP group (`120363555555555001@g.us`) has `status='allowed'` in the `access_list` table of agent instances. This was verified directly:

```
sqlite3 ~/.local/share/whatsoup/instances/besbot/bot.db \
  "SELECT * FROM access_list WHERE subject_type='group';"
→ group|120363555555555001@g.us|allowed|WHATSOUP|2026-04-06 04:19:58|

sqlite3 ~/.local/share/whatsoup/instances/shandroid/bot.db \
  "SELECT * FROM access_list WHERE subject_type='group';"
→ group|120363555555555001@g.us|allowed|WHATSOUP|2026-04-06 04:19:58|
```

This triggers `group_auto_respond` at `access-policy.ts:127-131`:

```typescript
// L127: lookup group access status
const groupEntry = lookupAccess(db, 'group', msg.chatJid);
// → access-list.ts:29-33: SELECT * FROM access_list WHERE subject_type = ? AND subject_id = ?
if (groupEntry?.status === 'allowed') {
  log.debug({ messageId: msg.messageId, chatJid: msg.chatJid }, 'trigger: group auto-respond');
  return { respond: true, reason: 'group_auto_respond' };
  //       ^^^^^^^^^^^^^^ ALL non-sibling messages trigger a response
}
```

The sibling filter at L121-124 runs first and correctly blocks agent-to-agent messages. But Lucas (`15551230006`) is NOT in any agent's `siblingPhones` (verified across all configs):

| Instance | `siblingPhones` in config | Lucas present? |
|----------|--------------------------|----------------|
| besbot | Q (`15551230001`), L (`15551230002`), Shannon (`15551230003`), Loops (`15551230004`) | **No** |
| shandroid | Q (`15551230001`), L (`15551230002`), Agent C (`15551230005`), Loops (`15551230004`) | **No** |
| loops | Q (`15551230001`), L (`15551230002`), Shannon (`15551230003`), Agent C (`15551230005`) | **No** |

So every Lucas message to the WHATSOUP group bypasses the sibling filter (not a sibling) → hits `group_auto_respond` (group is `allowed`) → ALL agents respond independently.

### 5.2 Design

**Data fix** — remove the `allowed` access_list entries for the WHATSOUP group from agent instances:

```sql
-- Run against each agent's bot.db:
-- besbot: ~/.local/share/whatsoup/instances/besbot/bot.db
-- shandroid: ~/.local/share/whatsoup/instances/shandroid/bot.db
DELETE FROM access_list
WHERE subject_type = 'group' AND subject_id = '120363555555555001@g.us';
```

**Behavioral result:** With the entry removed, `lookupAccess()` returns null → `groupEntry?.status === 'allowed'` is false → falls through to the mention check at L142-143:

```typescript
// L142-143: default group behavior — respond only if @mentioned
return { respond: mentioned, reason: mentioned ? 'mentioned' : 'not_mentioned' };
```

Agents become mention-only in the group. The orchestration model is preserved: Lucas → Q → agents via @mention.

**No code change required.** The access policy logic at `access-policy.ts:103-144` is correct. The `group_auto_respond` feature is valid for customer-facing groups where agents should respond to all messages. The data was misconfigured for this specific orchestrated group.

### 5.3 Edge Cases

- **Other groups unaffected.** Only the WHATSOUP orchestration group entry is removed. Other groups that legitimately need `auto_respond` (e.g., customer-facing groups) retain their `access_list` entries.
- **Lucas needs to reach agents directly.** @mention is sufficient. In an orchestrated group, direct human-to-agent communication should always go through the orchestrator (Q), or use explicit @mentions when needed.
- **New orchestrated groups.** Document convention: orchestrated groups should NOT be added as `allowed` to agent instances' access lists. Add to `docs/runbook.md`.
- **Q's access list.** Q (the orchestrator) does NOT have the WHATSOUP group in its access list either — Q also relies on @mentions. This is correct; Q's orchestration messages are sent proactively (not in response to `group_auto_respond`).

### 5.4 Files

| File | Change |
|------|--------|
| `~/.local/share/whatsoup/instances/besbot/bot.db` | DELETE from access_list |
| `~/.local/share/whatsoup/instances/shandroid/bot.db` | DELETE from access_list |
| `docs/runbook.md` | Add section: "Orchestrated groups should be mention-only on agent instances" |

---

## 6. Sub-Project AE4: Echo Guard Module

### 6.1 Problem

No outbound rate limiting exists in the agent runtime or outbound queue. The send path is:

```
enqueueText() (L264) → enqueue() (L563) → drainQueue() (L571)
  → sendWithPacing() (L596) → sendWithRetry() (L609)
    → messenger.sendMessage(this.chatJid, text) (L632)
```

`drainQueue()` at `outbound-queue.ts:571-586` processes the entire `sendQueue` array sequentially with only `MIN_SEND_GAP_MS` pacing between messages (anti-spam). There is no group-specific throttle, no burst detection, and no cooldown after startup. If AE1/AE2 are bypassed by a future code path, or a new feature introduces unsolicited group sends, there's no safety net.

The only existing rate control is the per-turn budget check in `session.ts:966` (via `providers/budget.ts`), which limits requests/minute and tokens/minute — but this is per-*inbound* turn, not per-outbound message.

### 6.2 Design

New module: `src/core/echo-guard.ts` (~60 lines)

**State (in-memory, process-scoped):**
```typescript
export interface EchoGuardConfig {
  enabled: boolean;         // default: true
  groupCooldownMs: number;  // default: 60_000 (60 seconds)
}

interface GroupCooldownEntry {
  lastOutboundTs: number;
}

// Module-level state — resets on process restart (intentional)
const groupCooldowns = new Map<string, GroupCooldownEntry>();
```

**API:**
```typescript
/**
 * Check if an outbound message to this JID is allowed.
 * Always returns true for non-group JIDs (DMs unaffected).
 * For groups: true if cooldown has elapsed since last outbound, false otherwise.
 */
export function canSendToGroup(chatJid: string, cfg: EchoGuardConfig): boolean;

/**
 * Record that a message was successfully sent to this group.
 * Called after messenger.sendMessage() succeeds.
 */
export function recordGroupOutbound(chatJid: string): void;

/** Reset all state (for testing). */
export function __resetForTests(): void;
```

**Integration point** — `outbound-queue.ts`, inside `sendWithPacing()` at L596, before `sendWithRetry()`:

```typescript
// L596-607 currently:
private async sendWithPacing(text: string): Promise<void> {
  const now = Date.now();
  const elapsed = now - this.lastSentAt;
  if (elapsed < MIN_SEND_GAP_MS && this.lastSentAt !== 0) {
    const wait = MIN_SEND_GAP_MS - elapsed;
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
  // NEW: Echo guard check before actual send
  if (!canSendToGroup(this.chatJid, echoGuardConfig)) {
    log.warn({ chatJid: this.chatJid, textPreview: text.slice(0, 80) },
      'echo guard: suppressed outbound group message (cooldown active)');
    return; // drop silently — if cooldown triggered, the message is unsolicited
  }
  await this.sendWithRetry(text);
  this.lastSentAt = Date.now();
  recordGroupOutbound(this.chatJid); // NEW: stamp cooldown
}
```

The echo guard config must be passed into `OutboundQueue`. Options:
- (a) Import from `config.ts` directly (current pattern for `toolUpdateMode`)
- (b) Pass as constructor parameter

Recommend (a) for consistency — `OutboundQueue` already imports from config indirectly via its callers.

**Config surface** — add to `src/config.ts` after L241 (siblingPhones):

```typescript
// Echo guard — outbound cooldown for group messages to prevent cascades.
// Applies to all outbound group messages. DMs are unaffected.
echoGuard: {
  enabled: (instance?.echoGuard as Record<string, unknown> | undefined)?.enabled !== false,
  groupCooldownMs: ((instance?.echoGuard as Record<string, unknown> | undefined)
    ?.groupCooldownMs as number | undefined) ?? 60_000,
},
```

Instance config.json (optional override):
```json
{
  "echoGuard": {
    "groupCooldownMs": 60000,
    "enabled": true
  }
}
```

### 6.3 Edge Cases

- **Legitimate rapid group messages.** An agent responding to multiple @mentions in quick succession would be throttled. Acceptable — 60s between group messages is reasonable for orchestrated groups. Operators can increase `groupCooldownMs` or set `enabled: false` per-instance for high-throughput groups.
- **Cooldown resets on restart.** In-memory state clears on restart. Intentional — AE1/AE2 handle the restart-specific resume path. The cooldown catches runtime cascades that occur while running.
- **Tool output messages.** Tool updates flow through `enqueueToolUpdate()` (L337) → `flushToolUpdates()` (L502) → `enqueueText()` (L560) → same `sendWithPacing()` path. The cooldown applies to ALL outbound group messages. If too aggressive, a future refinement could add a `bypass` flag to `enqueueText()`.
- **Admin command responses.** `/sessions` and `/status` responses go through `sendDirect()` (`runtime.ts:2373-2381`) → `queue.enqueueText()` → same send path. Admin responses should bypass the cooldown. Add an `adminBypass` parameter to `enqueueText()` that sets a flag checked in `sendWithPacing()`. Alternatively, admin responses use `messenger.sendMessage()` directly (the fallback path at `runtime.ts:2378`).
- **DMs never affected.** `canSendToGroup()` returns `true` immediately for any JID not ending with `@g.us`.

### 6.4 Files

| File | Change |
|------|--------|
| `src/core/echo-guard.ts` | New module (~60 lines): `canSendToGroup()`, `recordGroupOutbound()`, types |
| `src/config.ts` ~L242 | Add `echoGuard` config fields with defaults |
| `src/runtimes/agent/outbound-queue.ts` ~L596 | Import echo guard, add check in `sendWithPacing()` before `sendWithRetry()` |
| `tests/core/echo-guard.test.ts` | Test: cooldown blocks within window; allows after window; DMs unaffected; disabled config; reset |

---

## 7. Sub-Project AE5: Session Admin Commands

### 7.1 Problem

No way to inspect or control agent sessions from WhatsApp. The only options are SSH + SQLite queries or restarting the entire instance. When a session is stuck (infinite loop, hung tool call, runaway token usage), there's no targeted kill mechanism.

### 7.2 Design

**Step 1: Extend command classification** in `src/runtimes/agent/commands.ts`:

Current state (L5-11):
```typescript
export type CommandResult =
  | { type: 'local'; command: 'new' | 'status' | 'help' }
  | { type: 'forwarded'; text: string }
  | { type: 'message'; text: string };

const LOCAL_COMMANDS = new Set(['new', 'status', 'help']);
```

New state:
```typescript
export type CommandResult =
  | { type: 'local'; command: 'new' | 'status' | 'help' | 'sessions' | 'kill-session'; args?: string }
  | { type: 'forwarded'; text: string }
  | { type: 'message'; text: string };

const LOCAL_COMMANDS = new Set(['new', 'status', 'help', 'sessions', 'kill-session']);
```

The `args` field captures the rest of the input after the command name (e.g., `/kill-session 2` → `args: '2'`). Currently `classifyInput()` at L20-35 discards args for local commands — extend it to pass them through.

**Step 2: `/sessions` handler** in `runtime.ts`, inside the `classified.type === 'local'` switch (after L1448):

```typescript
case 'sessions': {
  // Admin-only (consistent with /new admin check at L1452)
  if (!isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
    return;
  }

  const entries: string[] = [];
  let idx = 1;

  if (this.sessionScope === 'per_chat') {
    // Per-chat mode: iterate chatSessions map
    for (const [mapKey, session] of this.chatSessions) {
      const status = session.getStatus();
      if (!status.active) continue;
      const isGroup = mapKey.includes('_at_g.us') || session.chatJid.endsWith('@g.us');
      const type = isGroup ? 'Group' : 'DM';
      const age = status.startedAt ? formatAge(status.startedAt) : '?';
      const tokens = (status.totalInputTokens ?? 0) + (status.totalOutputTokens ?? 0);
      const tokenStr = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
      entries.push(
        `${idx}. ${mapKey} (${type}) — ${age}, ${status.messageCount} msgs, ${tokenStr} tokens`
      );
      idx++;
    }
  } else {
    // Shared/single mode: single session
    const status = this.session?.getStatus();
    if (status?.active) {
      const age = status.startedAt ? formatAge(status.startedAt) : '?';
      entries.push(`1. ${status.chatJid ?? 'unknown'} — ${age}, ${status.messageCount} msgs`);
    }
  }

  const text = entries.length > 0
    ? `*Active Sessions (${entries.length})*\n\n${entries.join('\n')}\n\n/kill-session <number> to terminate`
    : '_No active sessions._';
  this.sendDirect(chatJid, text);
  break;
}
```

Data comes from `SessionManager.getStatus()` (`session.ts`) which returns `{ active, pid, sessionId, startedAt, lastMessageAt, messageCount, ... }`, plus the `chatSessions` map keys which encode the conversation identity.

**Step 3: `/kill-session <N>` handler**, following the `/new` command pattern at L1450-1502:

```typescript
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
    // Build ordered list matching /sessions output
    const activeSessions = [...this.chatSessions.entries()]
      .filter(([, s]) => s.getStatus().active);

    if (targetIdx > activeSessions.length) {
      this.sendDirect(chatJid, `_Invalid session number. ${activeSessions.length} active._`);
      break;
    }

    const [mapKey, targetSession] = activeSessions[targetIdx - 1];
    const targetChatJid = targetSession.chatJid;

    // Follow /new cleanup pattern (runtime.ts:1468-1497):
    // 1. Abort the queue (clears timers, typing, buffers)
    this.chatQueues.get(mapKey)?.abortTurn();
    // 2. Delete from maps
    this.chatSessions.delete(mapKey);
    this.chatQueues.delete(mapKey);
    // 3. Clean up per-chat ephemeral state
    this.cleanupPerChatState(mapKey);  // runtime.ts:2771-2777 equivalent
    // 4. Shutdown session (non-resumable)
    await targetSession.shutdown(false);
    // → session.ts:1234-1288: SIGTERM → 5s grace → SIGKILL
    // → agent_sessions marked 'ended' (L1249)
    // → session_checkpoints updated (L1256)

    // 5. Confirm — use sendDirect which falls back to messenger.sendMessage
    //    if the queue for the admin's chat was the one we just killed
    const label = mapKey.includes('_at_g.us') ? 'Group' : 'DM';
    this.sendDirect(chatJid, `_Session killed: ${mapKey} (${label})_`);
  } else {
    // Shared/single mode: kill the single session
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

### 7.3 Edge Cases

- **Kill during active turn.** `abortTurn()` at `outbound-queue.ts:414-425` clears: `toolTimer`, `toolMaxAgeTimer`, `streamTimer` (all `clearTimeout`), `streamBufferParts`, `toolBuffer`, `minimalSentDetails`, stops typing indicator via `stopTyping(false)` (without sending 'paused'). The child process receives SIGTERM at `session.ts:1265`, with `SHUTDOWN_GRACE_MS` (5s) before SIGKILL escalation at L1269.
- **Kill the session you're talking to.** If admin sends `/kill-session 1` from the DM that IS session 1, `chatQueues.get(mapKey)?.abortTurn()` kills the queue, then `sendDirect()` at `runtime.ts:2373-2381` tries `getQueueForChat()` which returns null (we just deleted it), so it falls back to `messenger.sendMessage(chatJid, text)` (L2378) — direct Baileys send, bypassing the queue. Confirmation message still arrives.
- **Race with crash handler.** If the session crashes between `/sessions` and `/kill-session`, `targetSession.getStatus().active` will be false. The `shutdown(false)` call is idempotent — at `session.ts:1236` it sets `this.active = false`, and at L1262 the null check on `this.child` skips process termination if already dead. Safe to call.
- **Index staleness.** The list is rebuilt from live `chatSessions` map state. Between `/sessions` and `/kill-session`, sessions may end (shrinking the list) or new ones may start (growing it). The kill handler rebuilds the list and validates the index. The confirmation message includes the `mapKey` so the operator can verify the correct session was killed.
- **`cleanupPerChatState` scope.** `cleanupPerChatCrashTurnState()` at `runtime.ts:2771-2777` clears: `activeToolNames`, `turnHadVisibleOutput`, `currentTurnChatJid`, `perChatTurnContentType`, `perChatTurnText`, `perChatAssistantItemText`. There's also `perChatInboundSeqQueue`, `perChatCrashCount`, `pendingRespawnTimers` that should be cleaned up. The kill handler should call the same cleanup methods that `handlePerChatCrash()` uses (L2694-2760).

### 7.4 Files

| File | Change |
|------|--------|
| `src/runtimes/agent/commands.ts` L5-11 | Extend `CommandResult` union + `LOCAL_COMMANDS` set; parse `args` |
| `src/runtimes/agent/runtime.ts` ~L1448 | Add `case 'sessions'` and `case 'kill-session'` handlers in switch |
| `tests/runtimes/agent/commands.test.ts` | Test: `/sessions` classified as local; `/kill-session 2` parsed with args; `/kill-session` without args classified correctly |
| `tests/runtimes/agent/runtime.test.ts` | Test: session list format; kill cleanup (maps cleared, shutdown called); admin-only enforcement; invalid index handling |

---

## 8. Sub-Project AE6: Dead Code Removal

### 8.1 Problem

`sweepOrphanedSessions` at `src/runtimes/agent/session-db.ts:268-278`:

```typescript
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

This function is imported at `runtime.ts:19` but never called anywhere in the runtime. It was superseded by `classifyActiveSessions()` in `src/runtimes/agent/session-classifier.ts:1-314`, which provides richer classification with safety rules (PID ownership verification via PPID, checkpoint cross-referencing, ambiguity handling). The classifier is called at `runtime.ts:1097`:

```typescript
const classified = classifyActiveSessions(this.db, this.durability);
```

### 8.2 Design

1. Remove `sweepOrphanedSessions` function from `session-db.ts:268-278` (including JSDoc at L265-271)
2. Remove import from `runtime.ts:19`: `sweepOrphanedSessions,`
3. Verify no other files import it: `grep -r 'sweepOrphanedSessions' src/`
4. Check if any test files reference it and update accordingly

### 8.3 Files

| File | Change |
|------|--------|
| `src/runtimes/agent/session-db.ts` L265-278 | Remove function + JSDoc |
| `src/runtimes/agent/runtime.ts` L19 | Remove from import list |
| `tests/runtimes/agent/session-db.test.ts` (if exists) | Remove any tests for the function |

---

## 9. Testing Strategy

### 9.1 Unit Tests

| Sub-Project | Test File | Test Cases |
|-------------|-----------|------------|
| AE1 | `tests/runtimes/agent/runtime.test.ts` | (1) Resume loop encounters `conversation_key: '120363555555555001_at_g.us'` → skipped, checkpoint marked `ended` via `upsertSessionCheckpoint`. (2) DM checkpoint `'15551230006'` → resumed normally. (3) Multiple group checkpoints all skipped in same loop iteration. |
| AE2 | `tests/runtimes/agent/runtime.test.ts` | (1) Shared mode: `updated_at` 2h ago → `prior` set to null, session not created. (2) Shared mode: `chat_jid` ends with `@g.us` → session resumes but `pendingStartupMessage` not set. (3) Single mode: group `chat_jid` → `prior` nullified, `shutdown(false)` called. (4) No checkpoint found → resume skipped (safety default). |
| AE4 | `tests/core/echo-guard.test.ts` | (1) First send to group → allowed, recorded. (2) Second send within 60s → blocked. (3) Send after 60s → allowed. (4) DM send → always allowed regardless of cooldown. (5) `enabled: false` → always allowed. (6) `__resetForTests()` clears state. |
| AE5 | `tests/runtimes/agent/commands.test.ts` | (1) `/sessions` → `{ type: 'local', command: 'sessions' }`. (2) `/kill-session 3` → `{ type: 'local', command: 'kill-session', args: '3' }`. (3) `/kill-session` (no arg) → `{ type: 'local', command: 'kill-session', args: undefined }`. |
| AE5 | `tests/runtimes/agent/runtime.test.ts` | (1) `/sessions` returns formatted list matching `chatSessions` map. (2) `/kill-session 1`: `abortTurn()` called, maps cleared, `shutdown(false)` called, confirmation sent. (3) Non-admin sender → no response. (4) Invalid index → error message. (5) Session already dead → `_Session already ended._`. |
| AE6 | (compile check) | `grep -r 'sweepOrphanedSessions' src/` returns 0 results after removal. TypeScript compiles cleanly. |

### 9.2 Integration Tests

- **Restart simulation:** Seed `session_checkpoints` with 3 rows: one group (`120363555555555001_at_g.us`, status `active`), one fresh DM (`15551230006`, status `active`, `updated_at` 5 min ago), one stale DM (`15551230002`, status `active`, `updated_at` 3 hours ago). Start runtime. Verify: group checkpoint → `ended`; fresh DM → session created + system turn sent; stale DM → `ended`.
- **Echo guard integration:** Wire a mock `messenger.sendMessage` that counts calls per JID. Enqueue 3 messages to a group queue within 60s. Verify: first message sent (count=1), second and third dropped (count stays 1). Wait 60s, enqueue fourth → sent (count=2).
- **Session kill flow:** Create a session via `ensureSessionAndQueueSync()` (L1442). Verify it appears in `chatSessions`. Send `/kill-session 1`. Verify: `chatSessions.has(mapKey)` → false, `chatQueues.has(mapKey)` → false, `session.getStatus().active` → false, `agent_sessions.status` → `'ended'`.

---

## 10. Deployment Sequence

| Step | Sub-Project | Type | Risk | Action |
|------|-------------|------|------|--------|
| 1 | AE3 | Data fix | None | Run DELETE SQL on besbot + shandroid DBs. No restart needed — takes effect on next message through `lookupAccess()`. |
| 2 | AE1 + AE2 + AE6 | Code | Low | ~20 lines changed in `runtime.ts`, ~15 lines removed from `session-db.ts`. No new modules, no new dependencies. Deploy together, restart all agent instances. |
| 3 | AE4 | Code | Low-Med | New `echo-guard.ts` module + integration in `outbound-queue.ts`. One new `config.ts` field. Deploy after AE1/AE2 verified working. |
| 4 | AE5 | Code | Low | New commands in `commands.ts` + handlers in `runtime.ts`. Self-contained, no effect on existing flows. Can deploy independently. |

**Rollback plan:** AE3 is reversed by re-inserting the `access_list` row. AE1/AE2/AE6 are reversed by reverting the commit. AE4 can be disabled per-instance via `echoGuard.enabled: false`. AE5 adds new commands without modifying existing ones.

---

## 11. Out of Scope (Deferred)

| Topic | Reason | Future Spec |
|-------|--------|-------------|
| Identity function consolidation (11 duplicates found) | Tech debt, not the cascade root cause. See Appendix B. | `identity-consolidation-design.md` |
| Sessions page in console UI | Requires fleet API endpoints. AE5 gives immediate phone-based control. | `sessions-page-design.md` |
| Fleet-wide session dashboard | Requires cross-instance session aggregation via fleet server's `db-reader.ts`. | `sessions-page-design.md` |
| Tiered staleness (15m/60m/24h) | Binary 60m cutoff matches per_chat behavior (L1139). Revisit if finer control needed. | Future iteration |
| Cross-instance LID sync at startup (L5) | Not needed — all instances already have complete mappings via Baileys auth dir. Verified: `diff` of lid_mappings across Q/besbot/shandroid = identical 41 rows. | N/A |

---

## 12. Appendix: Investigation Summary

### A. Identity Resolution Audit

The identity management system was thoroughly audited during this investigation. Relevant files and findings:

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `src/core/jid-constants.ts` | L29-116 | JID builders (`toPersonalJid`, `toLidJid`), type detection (`isLidJid`, `isPnJid`), normalization (`bareNumber`, `normalizeLid`), canonicalization (`canonicalizeChatJid`) | Working correctly |
| `src/core/lid-resolver.ts` | L1-369 | 6-layer LID↔phone resolution (L1 startup hydration, L2 real-time events, L3 message mining, L4 group metadata, L5 fleet sync, L6 periodic reconciliation) | Working correctly; all instances have complete mappings |
| `src/core/access-list.ts` | L129-144 | `resolvePhoneFromJid()` — main entry point for JID→phone resolution | Working correctly; sibling detection depends on this |
| `src/core/access-policy.ts` | L36-144 | `shouldRespond()` — the access policy decision maker | Working correctly; sibling filter at L121-124 runs before `group_auto_respond` at L128 |
| `src/core/conversation-key.ts` | L11-33 | `toConversationKey()` — normalizes JIDs to stable keys for DB storage | Working correctly |

Key findings:
- **LID resolution is reliable.** All instances have identical 41-row `lid_mappings` tables.
- **Sibling filter works correctly.** `access-policy.ts:121-124` runs before `group_auto_respond` at L128.
- **Groups are LID-only.** Zero `@s.whatsapp.net` sender JIDs in group messages across any instance.
- **DMs use both formats.** Same person can appear as `phone@s.whatsapp.net` and `phone@lid` — separate concern.

### B. Duplicate Functions Identified (Deferred)

| # | Functions | Files:Lines | Overlap | Priority |
|---|-----------|-------------|---------|----------|
| 1 | `getAllLidMappings` vs `buildLidMappings` | `lid-resolver.ts:360` vs `mentions.ts:185` | Same SQL, different return shapes; `buildLidMappings` uses `.split('@')[0]` instead of `bareNumber()` | HIGH |
| 2 | `canonicalizeChatJid` vs `resolveLid` | `jid-constants.ts:88` vs `lid-resolver.ts:338` | Identical `SELECT phone_jid FROM lid_mappings WHERE lid = ?` with separate prepared statement caches (`cachedLidLookupStmt` vs `_resolveLidStmt`) | HIGH |
| 3 | 7× inline `SELECT lid, phone_jid FROM lid_mappings` | `lid-resolver.ts:253,362`; `mentions.ts:188`; `admin.ts:151`; `fleet/index.ts:319,347`; `fleet/routes/lines.ts:395` | Same query in 7 locations | HIGH |
| 4 | `extractLocal` wraps `toConversationKey` | `access-list.ts:98` wraps `conversation-key.ts:11` | Adds only try/catch fallback; misleading name (returns conversation key for groups, not local part) | MED |
| 5 | `toConversationKey` reimplements `normalizeLid` | `conversation-key.ts:24-26` vs `jid-constants.ts:64-67` | Identical colon-strip logic (`indexOf(':')` + `slice`/`substring`) | MED |
| 6 | `resolvePhoneFromJid` manual `indexOf('@')` | `access-list.ts:130-134` | Should use `bareNumber()` + `isLidJid()` from `jid-constants.ts` | LOW |
| 7 | `contacts-sync.ts` regex fallback | `contacts-sync.ts:29` uses `c.id.replace(/@.*$/, '')` | Should use `bareNumber()` | LOW |
| 8 | `advanced.ts` raw domain string literals | `mcp/tools/advanced.ts:237` | Should use `isPnJid()`/`isLidJid()` + domain constants | LOW |
| 9 | `phoneFromJid` in fleet lines | `fleet/routes/lines.ts:33` | Returns LID number for LID inputs but function name implies phone | LOW |
| 10 | SQL CASE reimplements normalizeLid | `lid-resolver.ts:276-289` | Duplicated `CASE WHEN INSTR(...)` expression within same reconciliation query | LOW |
| 11 | Ingest vs runtime LID-to-key resolution | `ingest.ts:197-200` vs `runtime.ts:2340-2344` | Ingest uses `resolvePhoneFromJid()` (returns bare digits); runtime uses `canonicalizeChatJid()` (returns full JID) — different output formats for same purpose | HIGH |

### C. Brick Observations (Noted, Not Addressed)

- Crash risk in deferred startup notification (shared mode `pendingStartupMessage` sent after WA connects — if connection fails, message is orphaned)
- Missing `this.shared` checks in some runtime paths
- `sendDirect` type mismatch at `runtime.ts:2845` (possibly sends non-string to `sendDirect` which expects string)
- Multiple worktree runtime files needing consistency checks across branches
