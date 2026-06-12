# Code Review Handoff: Anti-Echo Protocol & Session Management Controls

**Status:** completed — review concluded; implementation merged. Preserved as historical handoff record.

**Branch:** `feat/anti-echo-session-controls`
**Base:** `main` (`d0fd32c`)
**Head:** `6d97c83`
**Diff:** 27 files, +719 / -852 lines (net -133 — more removed than added)
**Tests:** 125 backend test files, 2591 tests passing, 0 failures
**Type check:** `npx tsc --noEmit` → clean

---

## What This Is

A hardening fix for a specific operational problem: when WhatSoup agent instances restart, multiple agents simultaneously produce unsolicited messages to shared WhatsApp groups, wasting tokens and confusing the orchestration model.

This is NOT a feature build. It's six targeted fixes to close gaps in session resume, access policy, and outbound message control.

---

## Why It Matters

Every restart of the agent fleet (besbot, shandroid, loops) was costing tokens and producing noise. Agents would post "Using superpowers to recover state..." or "Please resend the last bead assignment..." to the orchestration group — unprompted. This happened because proactive session resume injects a synthetic turn directly into the agent process, completely bypassing the ingest pipeline where the sibling filter lives. It was NOT agents responding to each other (the sibling filter works correctly for normal message flow — verified by logs).

---

## The 7 Commits (in dependency order)

### 1. `f743762` — Remove dead `sweepOrphanedSessions` (AE6)
**Risk: None.** Pure deletion. Function was imported but never called — superseded by `classifyActiveSessions` in `session-classifier.ts`. Removed from source (session-db.ts) + import (runtime.ts) + 8 test mock stubs across 7 test files.

**Review focus:** Verify zero remaining references. Run `grep -r sweepOrphanedSessions src/ tests/`.

### 2. `95f6c61` — Runbook documentation (AE3)
**Risk: None.** Adds a section to `docs/runbook.md` documenting the convention that orchestrated groups should be mention-only on agent instances (no `group_auto_respond`). The actual data fix (DELETE from access_list on besbot + shandroid DBs) was applied at runtime, not in code.

**Review focus:** Read the runbook entry for accuracy.

### 3. `45d1c00` — Group resume suppression, per_chat mode (AE1)
**Risk: Low.** 10 lines added to `runtime.ts:1136-1144`. Inside the per_chat proactive resume loop, before the staleness check: if `conversation_key.endsWith('_at_g.us')`, skip the checkpoint and mark it `ended`.

**Review focus:**
- Is the guard in the right position? It must be AFTER the `session_id` null check (L1135) and BEFORE the 60-minute staleness check (L1146).
- Does `_at_g.us` correctly identify group conversation keys? (Yes — `toConversationKey('120363555555555001@g.us')` produces `120363555555555001_at_g.us`, per `conversation-key.ts:16-18`.)
- Could this accidentally skip DM resume? (No — DM keys are bare numbers like `15551230006` or `11111110000008`, never containing `_at_g.us`.)
- Does marking `ended` prevent future resume attempts? (Yes — `getResumableCheckpoints()` filters for `IN ('active', 'suspended')`, so `ended` drops out.)

### 4. `622bc0f` — Shared/single mode staleness + group guard (AE2)
**Risk: Medium.** 55 lines changed in `runtime.ts`, 245 lines of new tests. This is the most complex change — it touches the shared/single resume path at L1218-1316 with two additions:

**4a. Staleness check (L1229-1250).** Creates a mutable `priorSession` copy of the `const prior` from `getActiveSession()`. Checks `durability.getSessionCheckpoint()` for `updated_at` age > 60 minutes. If stale, marks checkpoint `ended` and nulls out `priorSession`. If no checkpoint exists OR `updated_at` is null, also nulls out (safety default). If durability is null, falls back to checking `prior.started_at` directly.

**Review focus:**
- The `else` branch (L1242) covers both "no checkpoint" AND "checkpoint with null updated_at". An earlier code review caught a bug where `else if (!checkpoint)` missed the null-updated_at case — verify the fix is in place.
- The durability-null fallback (L1247-1253) uses `started_at` directly. Verify this field exists on the `getActiveSession` return type (it does — `session-db.ts:97`).
- The `priorSession` variable replaces `prior` in the guard at L1255. Verify TypeScript narrowing works correctly.

**4b. Group startup message suppression (L1299-1316).** After `spawnSession()`, if `resumeChatJid.endsWith('@g.us')`:
- **Shared mode:** Session stays alive (it serves all chats including DMs) but `pendingStartupMessage` is NOT set. No unsolicited group message.
- **Single mode:** Session is immediately `shutdown(false)` and nulled. Single-mode sessions are bound to one chat — a group session can't serve DMs.
- **DM:** Normal path — `pendingStartupMessage` set as before.

**Review focus:**
- In shared mode, does the session correctly serve DMs after the group message is suppressed? (Yes — the session is spawned at L1293, stays alive, DM users trigger it naturally on their next message.)
- In single mode, does `shutdown(false)` correctly clean up? (Yes — `session.ts:1234-1288` sends SIGTERM, waits 5s, SIGKILL, marks `agent_sessions.status = 'ended'`, updates checkpoint.)
- Is `this.queue = null` correct for single mode? (Yes — single mode uses `this.queue`, not `outboundQueues` map.)

### 5. `d3b0c39` — Echo guard module (AE4)
**Risk: Low-Medium.** New module `src/core/echo-guard.ts` (42 lines) + config in `config.ts` + integration in `outbound-queue.ts:608`. Defense-in-depth: suppresses group outbound messages if another message was sent to the same group within 60 seconds.

**Review focus:**
- **False positives:** Could the cooldown suppress legitimate agent responses? Yes — if an agent is @mentioned twice in the same group within 60s, the second response would be dropped. The spec acknowledges this as acceptable for orchestrated groups. Operators can increase `groupCooldownMs` or disable with `echoGuard.enabled: false`.
- **Integration point:** The check is in `sendWithPacing()` at L608, BEFORE `sendWithRetry()`. If blocked, the message is silently dropped (no retry, no queue). Verify this is the correct place — it should be after pacing but before the actual send.
- **Config defaults:** `enabled: true`, `groupCooldownMs: 60_000`. Verify these are reasonable and that the config parsing in `config.ts:246-249` handles missing/invalid values.
- **DM safety:** `canSendToGroup()` returns `true` immediately for non-`@g.us` JIDs. DMs are never affected. Verify this.

### 6. `6dc14c2` — Session admin commands (AE5)
**Risk: Low.** New `/sessions` and `/kill-session` WhatsApp admin commands. Changes to `commands.ts` (type extension + args capture) and `runtime.ts` (two new switch cases).

**Review focus:**
- **Command parsing:** `classifyInput` now returns `args?: string` on local commands. Verify this doesn't break existing command handling — `args` is `undefined` for `/new`, `/status`, `/help`, and vitest's `toEqual` treats `{a: 1}` and `{a: 1, b: undefined}` as equal.
- **Exception:** The test for `/new start fresh` (commands.test.ts) was updated to expect `args: 'start fresh'`. This is a BEHAVIORAL CHANGE — previously args were discarded for local commands. Verify no code path relies on `/new` NOT having args. (The `/new` handler in runtime.ts at L1495-1497 doesn't reference `classified.args`, so this is safe.)
- **Admin enforcement:** Both commands check `isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)` and return silently for non-admins. Same pattern as existing `/new` admin check at L1452.
- **Kill sequence:** `/kill-session` follows the `/new` cleanup pattern: `abortTurn → delete maps → cleanupPerChatState → shutdown(false)`. Verify `cleanupPerChatState` (not `cleanupPerChatCrashTurnState`) is called — an earlier code review caught this.
- **Token display in `/sessions`:** Queries `agent_sessions` table for `total_input_tokens + total_output_tokens` via `sess.getDbRowId()`. Verify the SQL and type cast are correct.

### 7. `6d97c83` — Code review fixes
**Risk: Low.** Three fixes from formal code review:

**7a.** `cleanupPerChatCrashTurnState` → `cleanupPerChatState` in kill-session handler. The crash variant clears globals (`activeToolNames`) and misses per-key state (`perChatCrashCount`, `perChatInboundSeqQueue`, `pendingTurnText`). The session-removal variant is correct.

**7b.** `sendDirect` bypass for admin commands. Added `bypassEchoGuard` parameter (default `false`). All `sendDirect` calls inside `/sessions` and `/kill-session` pass `true`, routing directly through `messenger.sendMessage` instead of the outbound queue (which would hit the echo guard cooldown).

**7c.** Durability-null staleness fallback. If `this.durability` is null, falls back to checking `priorSession.started_at` directly for the 60-minute threshold. Three existing tests had `started_at` set to exactly 60 minutes, causing flaky failures due to sub-millisecond drift — changed to 30 minutes.

---

## What Was NOT Changed

- **Access policy logic** (`access-policy.ts`). The sibling filter and `group_auto_respond` logic are untouched. The investigation verified they work correctly — the problem was the resume path bypassing them entirely.
- **Session resume for DMs.** All changes specifically target group JIDs. DM resume behavior is preserved.
- **Existing commands** (`/new`, `/status`, `/help`). Only new commands added. The `args` field on `CommandResult` is optional and `undefined` for existing commands.
- **Identity resolution system.** The LID→phone resolution, lid_mappings, and sibling detection are all working correctly and were not modified.

---

## Known Deferred Items

These were discovered during investigation but are OUT OF SCOPE for this branch:

1. **Identity function consolidation** (11 duplicate functions, mostly around LID mapping queries). Documented in the spec's Appendix B. Will be a separate `identity-consolidation-design.md` spec.
2. **Sessions page in console UI.** AE5 gives WhatsApp-based session control. A web dashboard requires fleet API endpoints — separate spec.
3. **Echo guard admin bypass granularity.** Currently bypasses the queue entirely for admin responses. A more refined approach would add a flag to the queue itself. Acceptable for now.

---

## Files to Audit (Priority Order)

| Priority | File | Lines Changed | What to Check |
|----------|------|---------------|---------------|
| **1** | `src/runtimes/agent/runtime.ts` | +188 / -19 | AE1 guard at L1136, AE2 staleness at L1229, AE2 group suppress at L1299, AE5 command handlers at L1590+L1643, AE7 fixes |
| **2** | `src/core/echo-guard.ts` | +42 (new) | Correctness of cooldown logic, DM safety, module-level state |
| **3** | `src/runtimes/agent/outbound-queue.ts` | +7 | Echo guard integration in `sendWithPacing` at L608 |
| **4** | `src/runtimes/agent/commands.ts` | +14 / -5 | Type safety of `args` field, no regression on existing commands |
| **5** | `src/config.ts` | +7 | Echo guard config parsing, defaults |
| **6** | `src/runtimes/agent/session-db.ts` | -12 | Verify clean removal of `sweepOrphanedSessions` |
| **7** | `tests/runtimes/agent/runtime.test.ts` | +336 | Test quality, mock correctness, coverage of edge cases |
| **8** | `tests/core/echo-guard.test.ts` | +64 (new) | Coverage of cooldown, DM bypass, disable, per-group independence |
| **9** | `tests/runtimes/agent/commands.test.ts` | +30 / -1 | New command classification tests + `/new` args regression |
| **10** | `docs/runbook.md` | +10 | Accuracy of convention documentation |

---

## Verification Commands

```bash
cd /home/q/LAB/WhatSoup/.worktrees/anti-echo

# Type check
npx tsc --noEmit

# Full backend test suite
npx vitest run tests/runtimes/ tests/core/ tests/mcp/

# Targeted test runs
npx vitest run tests/runtimes/agent/runtime.test.ts    # AE1, AE2, AE5
npx vitest run tests/core/echo-guard.test.ts            # AE4
npx vitest run tests/runtimes/agent/commands.test.ts    # AE5 parsing
npx vitest run tests/runtimes/agent/outbound-queue.test.ts  # AE4 integration

# Verify dead code removal
grep -rn 'sweepOrphanedSessions' src/ tests/ --include='*.ts'
# Expected: zero matches

# View all changes
git diff main
git log --oneline feat/anti-echo-session-controls ^main
```

---

## Red Flags to Watch For

1. **Shared mode session lifecycle.** AE2 resumes the session but suppresses the startup message for groups. If the session spawn fails silently, DM users get no session. Check that `spawnSession` errors are caught by the existing `.catch()` handler at L1335.

2. **Echo guard false positives.** A 60-second cooldown means agents in high-activity groups can only send once per minute. For orchestrated groups this is fine, but if WhatSoup is used for customer-facing groups with rapid back-and-forth, this would be a problem. The `enabled: false` escape hatch exists but must be documented.

3. **Kill-session index stability.** The `/sessions` list is rebuilt from the live `chatSessions` map on each call. Between `/sessions` and `/kill-session`, the map could change (sessions end, new ones start). The kill handler validates the index but the confirmation message includes the `mapKey` — the admin should verify they killed the right one.

4. **`args` field on existing commands.** With the `classifyInput` change, `/new start fresh` now returns `args: 'start fresh'`. The `/new` handler doesn't reference `classified.args`, but verify no downstream code destructures `CommandResult` in a way that would break.

5. **Test timing sensitivity.** Three AE2 tests originally used `Date.now() - 3_600_000` (exactly 60 min) for `started_at`, causing sub-millisecond drift failures. Changed to 30 minutes. Check that other time-sensitive tests don't have similar boundary issues.
