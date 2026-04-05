# SP3: Search Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `search_messages_advanced` MCP tool with dual-path SQL (FTS-first when query is present, metadata-only when absent) supporting filters by sender, date range, content type, conversation, and media presence.

**Architecture:** Extend `src/mcp/tools/search.ts` with a new `search_messages_advanced` tool that builds one of two SQL queries depending on whether a text `query` parameter is provided. When present, join through `messages_fts` for FTS5 matching with metadata filters. When absent, query `messages` directly with metadata filters only. No schema changes needed -- SP2's `content_text` FTS trigger rebuild and SP1's `media_path` column provide all required infrastructure.

**Tech Stack:** TypeScript, vitest, SQLite FTS5

**Spec:** `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md` Section 5

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/mcp/tools/search.ts` | Modify | Add `search_messages_advanced` tool with dual-path query builder |
| `tests/mcp/tools/search.test.ts` | Modify | Test all filter combinations, dual-path behavior, edge cases |

---

## Task 1: `search_messages_advanced` — FTS path (query present)

Add the new tool with the FTS-first code path that activates when the `query` parameter is provided.

**Files:**
- Modify: `tests/mcp/tools/search.test.ts`
- Modify: `src/mcp/tools/search.ts`

- [ ] **Step 1: Extend seed data** in `tests/mcp/tools/search.test.ts`. Replace the existing `seedMessages` function with an enriched version that includes varied content types, timestamps, senders, and media paths:

```typescript
function seedMessages(db: Database) {
  db.raw.exec(`
    INSERT INTO contacts (jid, canonical_phone, display_name, notify_name)
    VALUES ('111@s.whatsapp.net', '111', 'Alice Smith', 'Alice');

    INSERT INTO contacts (jid, canonical_phone, display_name, notify_name)
    VALUES ('222@s.whatsapp.net', '222', 'Bob Jones', 'Bob');

    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text, content_type, is_from_me, timestamp, media_path)
    VALUES
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg1', 'Hello world', 'Hello world', 'text', 0, 1000, NULL),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg2', 'FTS search test', 'FTS search test', 'text', 0, 2000, NULL),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg3', 'Another world message', 'Another world message', 'text', 0, 3000, NULL),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg4', 'Secret content', 'Secret content', 'text', 0, 4000, NULL),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg5', '{"type":"image"}', 'Check out this photo', 'image', 0, 5000, '/tmp/whatsoup-media/abc.jpg'),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg6', '{"type":"audio","duration":12}', NULL, 'audio', 0, 6000, '/tmp/whatsoup-media/voice.ogg'),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'msg7', '{"type":"location","latitude":47.6}', 'Location: Downtown Seattle', 'location', 0, 7000, NULL),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob',   'msg8', '{"type":"document"}', 'Document: report.pdf', 'document', 0, 8000, '/tmp/whatsoup-media/report.pdf');
  `);
}
```

- [ ] **Step 2: Write the FTS-path tests.** Add a new `describe` block at the end of the `describe('search tools', ...)` block, after the `search_contacts` block:

```typescript
  // --- search_messages_advanced ---

  describe('search_messages_advanced', () => {
    it('is registered as global scope', () => {
      const tools = registry.listTools(globalSession());
      const tool = tools.find((t) => t.name === 'search_messages_advanced');
      expect(tool).toBeDefined();
    });

    it('is rejected in chat-scoped session', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world' },
        chatSession('111'),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
    });

    // --- FTS path (query present) ---

    it('FTS: finds messages matching the text query', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }>; total: number };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).toContain('msg1');
      expect(ids).toContain('msg3');
      expect(ids).not.toContain('msg2');
    });

    it('FTS + sender_jid: narrows results to a single sender', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world', sender_jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).toContain('msg1');
      expect(ids).not.toContain('msg3');
    });

    it('FTS + conversation_key: limits results to one conversation', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world', conversation_key: '222' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).toContain('msg3');
      expect(ids).not.toContain('msg1');
    });

    it('FTS + date range: filters by timestamp', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world', after: 2500, before: 3500 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].messageId).toBe('msg3');
    });

    it('FTS: excludes soft-deleted messages', async () => {
      db.raw.exec(`UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'msg1'`);
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'Hello world' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages.map((m) => m.messageId)).not.toContain('msg1');
    });

    it('FTS + content_type: filters by message type', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'Seattle', content_type: 'location' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].messageId).toBe('msg7');
    });

    it('FTS: respects limit parameter', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'world', limit: 1 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: unknown[] };
      expect(data.messages).toHaveLength(1);
    });

    it('FTS: returns empty results for no matches', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { query: 'zzznomatchzzz' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: unknown[]; total: number };
      expect(data.messages).toHaveLength(0);
      expect(data.total).toBe(0);
    });
  });
```

- [ ] **Step 3: Run tests, verify they fail:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/search.test.ts 2>&1 | tail -20
# Expected: FAILED — search_messages_advanced not registered
```

- [ ] **Step 4: Implement the tool** in `src/mcp/tools/search.ts`. Add the Zod schema and tool factory function before the `Export` section:

```typescript
// ---------------------------------------------------------------------------
// search_messages_advanced — dual-path metadata + FTS search
// ---------------------------------------------------------------------------

const SearchAdvancedSchema = z.object({
  query: z.string().optional().describe('FTS text search query. When absent, only metadata filters apply.'),
  sender_jid: z.string().optional().describe('Filter by sender JID'),
  content_type: z.string().optional().describe('Filter by content type (text, image, audio, video, document, sticker, location, contact, poll)'),
  conversation_key: z.string().optional().describe('Filter by conversation'),
  after: z.number().optional().describe('Unix timestamp — messages after this time'),
  before: z.number().optional().describe('Unix timestamp — messages before this time'),
  has_media: z.boolean().optional().describe('Filter for messages with (true) or without (false) media'),
  limit: z.number().optional().describe('Max results to return (default 20)'),
});

function makeSearchMessagesAdvanced(db: Database): ToolDeclaration {
  return {
    name: 'search_messages_advanced',
    description:
      'Advanced message search with metadata filters (sender, date range, content type, conversation, media presence) and optional full-text search. When a text query is provided, uses FTS5 for ranking. When absent, filters on metadata only.',
    schema: SearchAdvancedSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const {
        query,
        sender_jid: sender,
        content_type: contentType,
        conversation_key: conv,
        after,
        before,
        has_media: hasMedia,
        limit = 20,
      } = SearchAdvancedSchema.parse(params);

      const bindings: Record<string, unknown> = {};
      const conditions: string[] = ['m.deleted_at IS NULL'];

      // Metadata filters
      if (sender) {
        conditions.push('m.sender_jid = :sender');
        bindings[':sender'] = sender;
      }
      if (contentType) {
        conditions.push('m.content_type = :type');
        bindings[':type'] = contentType;
      }
      if (conv) {
        conditions.push('m.conversation_key = :conv');
        bindings[':conv'] = conv;
      }
      if (after != null) {
        conditions.push('m.timestamp >= :after');
        bindings[':after'] = after;
      }
      if (before != null) {
        conditions.push('m.timestamp <= :before');
        bindings[':before'] = before;
      }
      if (hasMedia === true) {
        conditions.push('m.media_path IS NOT NULL');
      } else if (hasMedia === false) {
        conditions.push('m.media_path IS NULL');
      }

      bindings[':limit'] = limit;
      const where = conditions.join(' AND ');

      let sql: string;
      if (query) {
        // FTS-first path: join through messages_fts for text matching
        bindings[':query'] = query;
        sql = `SELECT m.*
               FROM messages_fts fts
               JOIN messages m ON m.pk = fts.rowid
               WHERE fts.content MATCH :query
                 AND ${where}
               ORDER BY m.timestamp DESC
               LIMIT :limit`;
      } else {
        // Metadata-only path: query messages directly
        sql = `SELECT m.*
               FROM messages m
               WHERE ${where}
               ORDER BY m.timestamp DESC
               LIMIT :limit`;
      }

      const rows = db.raw.prepare(sql).all(bindings) as unknown as MessageRow[];

      return { messages: rows.map(rowToMessage), total: rows.length };
    },
  };
}
```

- [ ] **Step 5: Register the tool.** Update the `registerSearchTools` export function to include the new tool:

```typescript
export function registerSearchTools(db: Database, register: (tool: ToolDeclaration) => void): void {
  register(makeSearchMessages(db));
  register(makeSearchChatMessages(db));
  register(makeSearchContacts(db));
  register(makeSearchMessagesAdvanced(db));
}
```

- [ ] **Step 6: Run tests, verify they pass:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/search.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] **Step 7: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/mcp/tools/search.ts tests/mcp/tools/search.test.ts && git commit -m "feat(search): add search_messages_advanced MCP tool — FTS path

Adds search_messages_advanced with dual-path SQL. When a text query
is present, joins through messages_fts for FTS5 matching with
metadata filters (sender, date range, content_type, conversation).
Metadata-only path next (SP3)."
```

---

## Task 2: `search_messages_advanced` — metadata-only path (query absent)

Add tests for the metadata-only code path that activates when no `query` parameter is provided.

**Files:**
- Modify: `tests/mcp/tools/search.test.ts`

- [ ] **Step 1: Write the metadata-only tests.** Add these tests inside the existing `describe('search_messages_advanced', ...)` block, after the FTS tests:

```typescript
    // --- Metadata-only path (no query) ---

    it('metadata: returns all messages when no filters are set', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        {},
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }>; total: number };
      // Should return all 8 seed messages, ordered by timestamp DESC
      expect(data.messages).toHaveLength(8);
      expect(data.messages[0].messageId).toBe('msg8');
      expect(data.messages[7].messageId).toBe('msg1');
    });

    it('metadata: filter by sender_jid only', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { sender_jid: '222@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).toEqual(expect.arrayContaining(['msg3', 'msg4', 'msg6', 'msg8']));
      expect(ids).not.toContain('msg1');
      expect(ids).not.toContain('msg2');
    });

    it('metadata: filter by content_type only', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { content_type: 'image' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].messageId).toBe('msg5');
    });

    it('metadata: filter by date range', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { after: 4000, before: 6000 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).toEqual(expect.arrayContaining(['msg4', 'msg5', 'msg6']));
      expect(ids).not.toContain('msg3');
      expect(ids).not.toContain('msg7');
    });

    it('metadata: filter by conversation_key', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { conversation_key: '111' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).toEqual(expect.arrayContaining(['msg1', 'msg2', 'msg5', 'msg7']));
      expect(ids).not.toContain('msg3');
    });

    it('metadata: has_media=true returns only messages with media_path', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { has_media: true },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      // msg5 (image), msg6 (audio), msg8 (document) have media_path set
      expect(ids).toEqual(expect.arrayContaining(['msg5', 'msg6', 'msg8']));
      expect(ids).not.toContain('msg1');
      expect(ids).not.toContain('msg7');
    });

    it('metadata: has_media=false returns only messages without media_path', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { has_media: false },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).not.toContain('msg5');
      expect(ids).not.toContain('msg6');
      expect(ids).not.toContain('msg8');
      expect(ids).toEqual(expect.arrayContaining(['msg1', 'msg2', 'msg3', 'msg4', 'msg7']));
    });

    it('metadata: combined filters (sender + content_type + date range)', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { sender_jid: '222@s.whatsapp.net', content_type: 'text', after: 3000, before: 5000 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      const ids = data.messages.map((m) => m.messageId);
      expect(ids).toContain('msg3');
      expect(ids).toContain('msg4');
      expect(ids).toHaveLength(2);
    });

    it('metadata: respects limit', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { limit: 3 },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: unknown[] };
      expect(data.messages).toHaveLength(3);
    });

    it('metadata: excludes soft-deleted messages', async () => {
      db.raw.exec(`UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'msg4'`);
      const result = await registry.call(
        'search_messages_advanced',
        { sender_jid: '222@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: Array<{ messageId: string }> };
      expect(data.messages.map((m) => m.messageId)).not.toContain('msg4');
    });

    it('metadata: returns empty for impossible filter combination', async () => {
      const result = await registry.call(
        'search_messages_advanced',
        { sender_jid: '111@s.whatsapp.net', content_type: 'audio' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { messages: unknown[]; total: number };
      expect(data.messages).toHaveLength(0);
      expect(data.total).toBe(0);
    });
```

- [ ] **Step 2: Run tests, verify they pass** (the implementation from Task 1 already handles both paths):

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/search.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] **Step 3: Commit:**

```bash
cd ~/LAB/WhatSoup && git add tests/mcp/tools/search.test.ts && git commit -m "test(search): add metadata-only path tests for search_messages_advanced

Tests sender_jid, content_type, date range, conversation_key,
has_media filters without FTS query. Verifies combined filters,
soft-delete exclusion, limit, and empty result edge cases (SP3)."
```

---

## Task 3: Full test suite verification

Run the full test suite to verify no regressions.

**Files:**
- All test files

- [ ] **Step 1: Run the full test suite:**

```bash
cd ~/LAB/WhatSoup && npx vitest run --pool=forks 2>&1 > /tmp/sp3-test-results.log && echo "ALL PASS" || echo "FAILURES FOUND"
grep -E "FAIL|Tests |Test Files" /tmp/sp3-test-results.log
```

- [ ] **Step 2: If any tests fail, fix them.** Common regressions to watch for:

1. **Existing search tests that use the old `seedMessages`** -- The updated `seedMessages` adds more rows with new content types. Existing `search_messages` tests that count results (like `limit: 1`) should still work, but tests that assert exact result sets may need adjustment if new seed messages match their FTS queries.

2. **Tests that check `content_text` for FTS matching** -- The new seed data includes `content_text` values for FTS indexing. Verify the existing FTS tests still match the expected messages.

- [ ] **Step 3: If all tests pass, commit any fixes:**

```bash
cd ~/LAB/WhatSoup && git add -A && git commit -m "fix: patch test regressions from SP3 search enhancement changes

Updates seed data and test assertions to accommodate the enriched
search_messages_advanced seed messages."
```

- [ ] **Step 4: Final verification:**

```bash
cd ~/LAB/WhatSoup && npx vitest run --pool=forks 2>&1 > /tmp/sp3-final.log && echo "ALL PASS" || echo "FAILURES"
grep -E "Test Files|Tests " /tmp/sp3-final.log
# Expected: ALL PASS — 0 failures
```

---

## Spec Coverage Checklist

| Spec Requirement | Task | Status |
|-----------------|------|--------|
| `search_messages_advanced` tool registration (global scope) | Task 1 | Covered |
| Zod schema: query, sender_jid, content_type, conversation_key, after, before, has_media, limit | Task 1 | Covered |
| FTS-first path (query present) with metadata filters | Task 1 | Covered |
| Metadata-only path (query absent) | Task 2 | Covered |
| `has_media` three-way conditional (true/false/null) | Task 1 | Covered |
| Soft-deleted message exclusion | Task 1, 2 | Covered |
| Returns `messages: Message[]` + `total: number` | Task 1 | Covered |
| No new FTS migration needed (uses SP2 triggers) | N/A | Confirmed |
| `rowToMessage` standard response format | Task 1 | Covered |
| Existing search tools unmodified | Task 1 | Confirmed |
