# Task: mark-read-api-20260408

**Description:** Wire mark-read API endpoint through fleet server — POST /api/lines/:name/mark-read proxying to instance health server, health server handler calling existing mark_chat_read MCP tool, Inbox UI button.

**Profile:** BUILD
**Cynefin:** Complicated
**Status:** complete
**Phase:** Synthesize

## Phase Log
- 2026-04-08 Phase 0 (Normalize): clean state, no prior artifacts
- 2026-04-08 Phase 1 (Frame): mission defined inline — skip formal investigator
- 2026-04-08 Phase 2 (Scout): context gathered from prior session investigation

## Mission Brief
**Objective:** Enable console users to mark WhatsApp conversations as read from the Inbox page.

**Scope:**
1. Fleet API: POST /api/lines/:name/mark-read endpoint (proxy to instance health server)
2. Instance health server: /mark-read handler (calls mark_chat_read MCP tool or direct Baileys chatModify)
3. Console frontend: "Mark read" button in Inbox chat detail panel
4. Console API client: api.markRead() method

**Constraints:**
- Follow existing proxyToInstance pattern (proven for send, access, restart, stop)
- mark_chat_read MCP tool requires chatJid, read, last_message_key, last_message_timestamp
- The fleet API must simplify the interface — console only needs to send instance name + conversation_key
- Health server resolves conversation_key → chatJid and fetches last message metadata from DB

**Success Criteria:**
1. POST /api/lines/:name/mark-read with { conversation_key } returns 200
2. WhatsApp chat is marked as read (Baileys chatModify called)
3. DB unread_count updated to 0 for the conversation
4. Inbox UI shows "Mark read" button, optimistically updates unread badge
5. All existing tests pass + new tests for endpoint and handler
