# Bead: MR-01
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** none
**Scope:** src/core/health.ts
**Cynefin domain:** clear
**Profile:** BUILD
**Complexity source:** accidental
**Security sensitive:** false
**Decision trace:** docs/sdlc/active/mark-read-api-20260408/beads/MR-01-decision-trace.md
**Deterministic checks:** typecheck, vitest
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

**Input:** Health server pattern (POST /send, POST /access), DB schema (chats table has jid/conversation_key/unread_count, messages table has message_id/chat_jid/timestamp)

**Output:** POST /mark-read handler on the health server that:
1. Accepts `{ conversation_key: string }`
2. Looks up chat JID from `chats` table via conversation_key
3. Gets the last message (message_id, sender_jid, timestamp) from `messages` table for that conversation_key
4. Calls `sock.chatModify({ markRead: true, lastMessages: [{ key: { id, fromMe }, messageTimestamp }] }, chatJid)`
5. Updates `chats SET unread_count = 0 WHERE conversation_key = ?`
6. Returns `{ ok: true, jid, conversation_key }`

**Acceptance Criteria:**
- Handler follows the /access pattern (async IIFE, requireAuth, body parsing, error handling)
- 400 on missing conversation_key
- 404 if conversation_key not found in chats table
- 200 on success with { ok: true }
- Graceful handling when no messages exist (skip chatModify, just zero the count)
- Test: new test file verifying the handler behavior
