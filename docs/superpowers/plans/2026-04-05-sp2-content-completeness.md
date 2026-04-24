# SP2: Content Completeness Implementation Plan

**Status:** completed — shipped as SP2 bead in the `whatsapp-mcp-features` epic (Phase 1, merged 2026-04-05).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `parseIncomingMessage()` to capture structured data for all 10+ content types, persist audio transcriptions to the database, and add a `transcribe_audio` MCP tool — so agents work with complete message metadata instead of null/partial content.

**Architecture:** Add `content_text` column to messages table for human-readable summaries (indexed by FTS). Rewrite content extraction in `parseIncomingMessage()` to store structured JSON in `content` and summaries in `content_text`. Persist Whisper transcriptions to both fields. Add `transcribe_audio` MCP tool that chains SP1's `download_media` → Whisper → DB persist.

**Tech Stack:** TypeScript, Baileys 7.0.0-rc.9, vitest, SQLite, OpenAI Whisper API

**Spec:** `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md` Section 4

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/database.ts` | Modify | MIGRATION_13: add `content_text TEXT` column, DROP + re-CREATE all 4 FTS triggers to index `content_text` instead of `content` |
| `src/core/messages.ts` | Modify | Add `content_text` to `MessageRow`, `rowToMessage`, `StoredMessage`, `rowToStoredMessage`, `StoreMessageInput`, `toInsertParams`, `storeMessage`, `storeMessageIfNew`; add `updateContentText()` helper |
| `src/core/types.ts` | Modify | Add `contentText` to `IncomingMessage` interface |
| `src/transport/connection.ts` | Modify | Rewrite content extraction in `parseIncomingMessage()` to produce structured `content` (JSON) + `contentText` (human-readable) for all content types |
| `src/core/ingest.ts` | Modify | Pass `contentText` from `IncomingMessage` through to `storeMessageIfNew()` |
| `src/runtimes/agent/runtime.ts` | Modify | After Whisper transcription, persist transcription text to `content` and `content_text` via `updateContentText()` |
| `src/mcp/tools/media.ts` | Modify | Add `transcribe_audio` tool |
| `tests/core/database.test.ts` | Modify | Test MIGRATION_13 schema + FTS trigger rebuild |
| `tests/core/messages.test.ts` | Modify | Test `content_text` in interfaces, `updateContentText()` helper |
| `tests/transport/parsing.test.ts` | Modify | Test structured content extraction for all content types |
| `tests/mcp/tools/media.test.ts` | Modify | Test `transcribe_audio` tool |

---

## Task 1: MIGRATION_13 — `content_text` column + FTS trigger rebuild

Add the database migration that creates the new column and rebuilds all 4 FTS triggers to index `content_text` instead of `content`.

**Files:**
- Modify: `src/core/database.ts`
- Modify: `tests/core/database.test.ts`

- [ ] **Step 1: Write the tests** in `tests/core/database.test.ts`. Add these tests inside the existing `describe('Database schema', ...)` block, after the last `it(...)` (the `idx_messages_media_path` test):

```typescript
  it('messages table has content_text column (MIGRATION_13)', () => {
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
      type: string;
    }>;
    const col = cols.find((c) => c.name === 'content_text');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
  });
```

Then add this test inside the existing `describe('FTS5 triggers', ...)` block, after the last `it(...)` (the `physical delete trigger` test):

```typescript
  it('FTS indexes content_text instead of content after MIGRATION_13', () => {
    // Insert a message where content is JSON but content_text is human-readable
    db.raw.prepare(
      `INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, content, content_text, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      '15550100001@s.whatsapp.net',
      '15550100001',
      '15550100001@s.whatsapp.net',
      '{"type":"location","latitude":40.7}',
      'Location: Downtown Seattle',
      Date.now(),
    );
    const pk = (db.raw.prepare('SELECT pk FROM messages ORDER BY pk DESC LIMIT 1').get() as { pk: number }).pk;

    // FTS should match on content_text, not on JSON content
    expect(ftsMatch('Seattle')).toContain(pk);
    expect(ftsMatch('latitude')).not.toContain(pk);
  });

  it('FTS insert trigger skips rows with null content_text', () => {
    db.raw.prepare(
      `INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, content, content_text, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      '15550100001@s.whatsapp.net',
      '15550100001',
      '15550100001@s.whatsapp.net',
      '{"type":"audio","duration":5}',
      null,
      Date.now(),
    );
    const pk = (db.raw.prepare('SELECT pk FROM messages ORDER BY pk DESC LIMIT 1').get() as { pk: number }).pk;
    // Null content_text means not indexed
    expect(ftsMatch('audio')).not.toContain(pk);
  });

  it('FTS update trigger re-indexes when content_text changes', () => {
    db.raw.prepare(
      `INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, content, content_text, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      '15550100001@s.whatsapp.net',
      '15550100001',
      '15550100001@s.whatsapp.net',
      '{"type":"audio"}',
      null,
      Date.now(),
    );
    const pk = (db.raw.prepare('SELECT pk FROM messages ORDER BY pk DESC LIMIT 1').get() as { pk: number }).pk;

    // Update content_text (simulates transcription persistence)
    db.raw.prepare('UPDATE messages SET content_text = ? WHERE pk = ?').run('Hello this is a voice note', pk);
    expect(ftsMatch('voice')).toContain(pk);
  });
```

- [ ] **Step 2: Run tests, verify they fail:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/database.test.ts --pool=forks 2>&1 | tail -30
# Expected: FAIL — content_text column does not exist, FTS trigger tests fail
```

- [ ] **Step 3: Add MIGRATION_13 to `src/core/database.ts`.** Insert this entry at the end of the `MIGRATIONS` Map (after the `[12, ...]` entry, before the closing `]);`):

```typescript
  [13, (db: DatabaseSync) => {
    // SP2: Add content_text column for human-readable message summaries
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'content_text')) {
      db.exec('ALTER TABLE messages ADD COLUMN content_text TEXT');
    }

    // Rebuild FTS triggers to index content_text instead of content.
    // For text messages, content_text will be set equal to content at insert time.
    // For structured types, content_text holds the human-readable summary.
    // Must DROP all 4 triggers and re-CREATE them atomically.
    db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_insert;
      DROP TRIGGER IF EXISTS messages_fts_update;
      DROP TRIGGER IF EXISTS messages_fts_soft_delete;
      DROP TRIGGER IF EXISTS messages_fts_delete;

      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
        WHEN NEW.content_text IS NOT NULL AND NEW.deleted_at IS NULL
      BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (NEW.pk, NEW.content_text);
      END;

      CREATE TRIGGER messages_fts_update AFTER UPDATE OF content_text ON messages
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', OLD.pk, COALESCE(OLD.content_text, ''));
        INSERT INTO messages_fts(rowid, content)
          SELECT NEW.pk, NEW.content_text
          WHERE NEW.content_text IS NOT NULL AND NEW.deleted_at IS NULL;
      END;

      CREATE TRIGGER messages_fts_soft_delete AFTER UPDATE OF deleted_at ON messages
        WHEN NEW.deleted_at IS NOT NULL
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', OLD.pk, COALESCE(OLD.content_text, ''));
      END;

      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages
      BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
          VALUES ('delete', OLD.pk, COALESCE(OLD.content_text, ''));
      END;
    `);
  }],
```

- [ ] **Step 4: Fix the existing FTS tests.** The existing tests insert messages without `content_text` and test FTS indexing on `content`. Since the triggers now watch `content_text`, update the existing `insertMsg` helper in the `FTS5 triggers` describe block to also set `content_text`:

Replace the existing `insertMsg` function in the `FTS5 triggers` block with:

```typescript
  function insertMsg(opts: {
    chatJid?: string;
    conversationKey?: string;
    senderJid?: string;
    content?: string | null;
    contentText?: string | null;
    deletedAt?: string | null;
  }) {
    const {
      chatJid = '15550100001@s.whatsapp.net',
      conversationKey = '15550100001',
      senderJid = '15550100001@s.whatsapp.net',
      content = 'hello world',
      contentText,
      deletedAt = null,
    } = opts;
    // Default contentText to content (matches real text message behavior)
    const effectiveContentText = contentText === undefined ? content : contentText;
    db.raw
      .prepare(
        `INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, content, content_text, timestamp, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatJid, conversationKey, senderJid, content, effectiveContentText, Date.now(), deletedAt);
    const row = db.raw
      .prepare('SELECT pk FROM messages ORDER BY pk DESC LIMIT 1')
      .get() as { pk: number };
    return row.pk;
  }
```

And update the existing `content update trigger` test to update `content_text` instead of `content`:

```typescript
  it('content_text update trigger re-indexes updated content', () => {
    const pk = insertMsg({ content: 'xyzbeta original phrasing', contentText: 'xyzbeta original phrasing' });
    expect(ftsMatch('xyzbeta')).toContain(pk);

    db.raw.prepare('UPDATE messages SET content_text = ? WHERE pk = ?').run('xyzgamma updated phrasing', pk);

    // Old term no longer indexed; new term is indexed
    expect(ftsMatch('xyzbeta')).not.toContain(pk);
    expect(ftsMatch('xyzgamma')).toContain(pk);
  });
```

- [ ] **Step 5: Run tests, verify they all pass:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/database.test.ts --pool=forks 2>&1 | tail -30
# Expected: all PASS
```

- [ ] **Step 6: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/core/database.ts tests/core/database.test.ts && git commit -m "feat(db): add MIGRATION_13 — content_text column + FTS trigger rebuild

Adds content_text TEXT column to messages table for human-readable
message summaries. Rebuilds all 4 FTS triggers to index content_text
instead of content, enabling full-text search across all message
types after structured content extraction (SP2)."
```

---

## Task 2: `MessageRow` + `rowToMessage` + `StoredMessage` — add `content_text` field

Update the TypeScript interfaces and mapper functions to include the new column. Also add `contentText` to `StoreMessageInput` and the write path so it can be set at ingest time.

**Files:**
- Modify: `src/core/messages.ts`
- Modify: `tests/core/messages.test.ts`

- [ ] **Step 1: Write the test** in `tests/core/messages.test.ts`. Add a new describe block for `content_text` support. Make sure the test file imports `updateContentText`, `rowToMessage`, and `MessageRow` from `../../src/core/messages.ts` (add to the existing import statement):

```typescript
describe('content_text support', () => {
  it('updateContentText persists content_text to the database', () => {
    // Insert a test message
    db.raw.prepare(
      `INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, message_id, content, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'ct-test-001', '{"type":"audio","duration":5}', 'audio', Date.now());

    updateContentText(db, 'ct-test-001', 'Hello this is a transcription', '{"type":"audio","duration":5,"transcription":"Hello this is a transcription"}');

    const row = db.raw.prepare('SELECT content, content_text FROM messages WHERE message_id = ?').get('ct-test-001') as { content: string; content_text: string };
    expect(row.content_text).toBe('Hello this is a transcription');
    expect(JSON.parse(row.content).transcription).toBe('Hello this is a transcription');
  });

  it('updateContentText works without content parameter', () => {
    db.raw.prepare(
      `INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, message_id, content, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'ct-test-004', '{"type":"audio"}', 'audio', Date.now());

    updateContentText(db, 'ct-test-004', 'Just the text');

    const row = db.raw.prepare('SELECT content, content_text FROM messages WHERE message_id = ?').get('ct-test-004') as { content: string; content_text: string };
    expect(row.content_text).toBe('Just the text');
    expect(row.content).toBe('{"type":"audio"}'); // unchanged
  });

  it('rowToMessage includes contentText field', () => {
    db.raw.prepare(
      `INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, message_id, content, content_text, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'ct-test-002', '{"type":"location"}', 'Location: Downtown Seattle', 'location', Date.now());

    const row = db.raw.prepare('SELECT * FROM messages WHERE message_id = ?').get('ct-test-002') as MessageRow;
    const msg = rowToMessage(row);
    expect(msg.contentText).toBe('Location: Downtown Seattle');
  });

  it('rowToMessage falls back contentText to content for text messages', () => {
    db.raw.prepare(
      `INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, message_id, content, content_text, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'ct-test-003', 'Hello world', 'Hello world', 'text', Date.now());

    const row = db.raw.prepare('SELECT * FROM messages WHERE message_id = ?').get('ct-test-003') as MessageRow;
    const msg = rowToMessage(row);
    expect(msg.contentText).toBe('Hello world');
  });

  it('rowToMessage falls back contentText to content when content_text is null', () => {
    db.raw.prepare(
      `INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, message_id, content, content_text, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'ct-test-005', 'fallback text', null, 'text', Date.now());

    const row = db.raw.prepare('SELECT * FROM messages WHERE message_id = ?').get('ct-test-005') as MessageRow;
    const msg = rowToMessage(row);
    expect(msg.contentText).toBe('fallback text');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts --pool=forks 2>&1 | tail -30
# Expected: FAIL — updateContentText not exported, contentText not in rowToMessage output
```

- [ ] **Step 3: Update `src/core/messages.ts`.** Make all these changes:

**3a.** Add `content_text` to `MessageRow` (after the `content` line):

```typescript
export interface MessageRow {
  pk: number;
  message_id: string;
  conversation_key: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  content: string | null;
  content_text: string | null;
  content_type: ContentType;
  is_from_me: number;
  timestamp: number;
  quoted_message_id: string | null;
  created_at: string;
  media_path: string | null;
}
```

**3b.** Add `contentText` to `rowToMessage` output (after `content`):

```typescript
export function rowToMessage(row: MessageRow) {
  return {
    pk: row.pk,
    messageId: row.message_id,
    conversationKey: row.conversation_key,
    chatJid: row.chat_jid,
    senderJid: row.sender_jid,
    senderName: row.sender_name ?? null,
    content: row.content ?? null,
    contentText: row.content_text ?? row.content ?? null,
    contentType: row.content_type,
    isFromMe: Boolean(row.is_from_me),
    timestamp: row.timestamp,
    quotedMessageId: row.quoted_message_id ?? null,
    createdAt: row.created_at,
    mediaPath: row.media_path ?? null,
  };
}
```

**3c.** Add `contentText` to `StoredMessage` (after `content`):

```typescript
  content: string | null;
  contentText: string | null;
```

**3d.** Add `contentText` to `rowToStoredMessage` (after the `content` line):

```typescript
    content: (row.content as string | null) ?? null,
    contentText: (row.content_text as string | null) ?? (row.content as string | null) ?? null,
```

**3e.** Add `contentText` to `StoreMessageInput` (after `content`):

```typescript
  content?: string | null;
  contentText?: string | null;
```

**3f.** Add `content_text` to `toInsertParams` (after `content`):

```typescript
    content: msg.content ?? null,
    content_text: msg.contentText ?? msg.content ?? null,
```

**3g.** Add `content_text` to the SQL in `storeMessage` — both the INSERT column list and VALUES list, and the ON CONFLICT SET:

```typescript
export function storeMessage(db: Database, msg: StoreMessageInput): void {
  db.raw.prepare(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text, content_type,
       is_from_me, timestamp, quoted_message_id, raw_message)
    VALUES
      (@chat_jid, @conversation_key, @sender_jid, @sender_name, @message_id, @content, @content_text, @content_type,
       @is_from_me, @timestamp, @quoted_message_id, @raw_message)
    ON CONFLICT(message_id) DO UPDATE SET
      sender_name       = COALESCE(excluded.sender_name, sender_name),
      content           = excluded.content,
      content_text      = excluded.content_text,
      content_type      = excluded.content_type,
      is_from_me        = excluded.is_from_me,
      timestamp         = excluded.timestamp,
      quoted_message_id = COALESCE(excluded.quoted_message_id, quoted_message_id),
      raw_message       = COALESCE(excluded.raw_message, raw_message)
  `).run(toInsertParams(msg));
}
```

**3h.** Add `content_text` to `storeMessageIfNew` SQL:

```typescript
export function storeMessageIfNew(db: Database, msg: StoreMessageInput): boolean {
  const result = db.raw.prepare(`
    INSERT OR IGNORE INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text, content_type,
       is_from_me, timestamp, quoted_message_id, raw_message)
    VALUES
      (@chat_jid, @conversation_key, @sender_jid, @sender_name, @message_id, @content, @content_text, @content_type,
       @is_from_me, @timestamp, @quoted_message_id, @raw_message)
  `).run(toInsertParams(msg));
  const inserted = (result.changes as number) > 0;
  if (inserted) {
    resolveDecryptionFailure(db, msg.messageId);
  }
  return inserted;
}
```

**3i.** Add the `updateContentText` helper at the end of the file (after `updateMediaPath`):

```typescript
/**
 * Persist transcription or enriched content text for a message.
 * Updates both the structured `content` JSON and the human-readable `content_text`.
 * Called by agent runtime after Whisper transcription completes.
 */
export function updateContentText(db: Database, messageId: string, contentText: string, content?: string): void {
  if (content) {
    db.raw.prepare('UPDATE messages SET content = ?, content_text = ? WHERE message_id = ?')
      .run(content, contentText, messageId);
  } else {
    db.raw.prepare('UPDATE messages SET content_text = ? WHERE message_id = ?')
      .run(contentText, messageId);
  }
}
```

- [ ] **Step 4: Run tests, verify they pass:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts --pool=forks 2>&1 | tail -30
# Expected: all PASS
```

- [ ] **Step 5: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/core/messages.ts tests/core/messages.test.ts && git commit -m "feat(messages): add content_text to interfaces and write path

Adds content_text field to MessageRow, StoredMessage, StoreMessageInput,
rowToMessage, and rowToStoredMessage. Adds updateContentText() helper
for persisting transcriptions. contentText falls back to content for
plain text messages (SP2)."
```

---

## Task 3: `IncomingMessage` + `parseIncomingMessage` — structured content extraction

Rewrite the content extraction in `parseIncomingMessage()` to produce structured JSON in `content` and human-readable text in `contentText` for all content types.

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/transport/connection.ts`
- Modify: `tests/transport/parsing.test.ts`

- [ ] **Step 1: Add `contentText` to `IncomingMessage`** in `src/core/types.ts`. After the `content` field (line 29), add:

```typescript
  content: string | null;
  /** Human-readable summary for FTS indexing. For text messages, equals content. */
  contentText: string | null;
```

- [ ] **Step 2: Write the tests** in `tests/transport/parsing.test.ts`. Add a new describe block after the existing `parseIncomingMessage — positive cases` block:

```typescript
// ---------------------------------------------------------------------------
// T-SP2: Structured content extraction + contentText
// ---------------------------------------------------------------------------

describe('parseIncomingMessage — structured content (SP2)', () => {
  it('text message: contentText equals content', () => {
    const msg = msgWith({ conversation: 'Hello world' });
    const result = parseIncomingMessage(msg);
    expect(result!.contentText).toBe('Hello world');
    expect(result!.content).toBe('Hello world');
  });

  it('extended text: contentText equals content', () => {
    const msg = msgWith({ extendedTextMessage: { text: 'Extended hello' } });
    const result = parseIncomingMessage(msg);
    expect(result!.contentText).toBe('Extended hello');
  });

  it('location: content is structured JSON, contentText is readable summary', () => {
    const msg = msgWith({
      locationMessage: {
        degreesLatitude: 47.6062,
        degreesLongitude: -122.3321,
        name: 'Downtown Seattle',
        address: '123 Pike St',
        url: 'https://maps.google.com/...',
      },
    });
    const result = parseIncomingMessage(msg);
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('location');
    expect(parsed.latitude).toBe(47.6062);
    expect(parsed.longitude).toBe(-122.3321);
    expect(parsed.name).toBe('Downtown Seattle');
    expect(result!.contentText).toContain('Downtown Seattle');
    expect(result!.contentText).toContain('47.6062');
  });

  it('location without name: falls back to address in contentText', () => {
    const msg = msgWith({
      locationMessage: {
        degreesLatitude: 40.7128,
        degreesLongitude: -74.006,
        address: '123 Main St',
      },
    });
    const result = parseIncomingMessage(msg);
    expect(result!.contentText).toContain('123 Main St');
  });

  it('contact: content is structured JSON with vcard', () => {
    const msg = msgWith({
      contactMessage: {
        displayName: 'Bob Smith',
        vcard: 'BEGIN:VCARD\nFN:Bob Smith\nTEL:+1555\nEND:VCARD',
      },
    });
    const result = parseIncomingMessage(msg);
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('contact');
    expect(parsed.displayName).toBe('Bob Smith');
    expect(parsed.vcard).toContain('BEGIN:VCARD');
    expect(result!.contentText).toBe('Contact: Bob Smith');
  });

  it('poll: content is structured JSON with options', () => {
    const msg = msgWith({
      pollCreationMessage: {
        name: 'Favourite color?',
        options: [{ optionName: 'Red' }, { optionName: 'Blue' }, { optionName: 'Green' }],
        selectableOptionCount: 1,
      },
    });
    const result = parseIncomingMessage(msg);
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('poll');
    expect(parsed.name).toBe('Favourite color?');
    expect(parsed.options).toEqual(['Red', 'Blue', 'Green']);
    expect(parsed.selectableCount).toBe(1);
    expect(result!.contentText).toContain('Favourite color?');
    expect(result!.contentText).toContain('3 options');
  });

  it('audio: content is structured JSON, contentText is null (filled later by Whisper)', () => {
    const msg = msgWith({
      audioMessage: { mimetype: 'audio/ogg', seconds: 12, ptt: true },
    });
    const result = parseIncomingMessage(msg);
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('audio');
    expect(parsed.duration).toBe(12);
    expect(parsed.ptt).toBe(true);
    expect(result!.contentText).toBeNull();
  });

  it('video with caption: content is caption, contentText is caption', () => {
    const msg = msgWith({
      videoMessage: { caption: 'Check this out', seconds: 30, width: 1920, height: 1080 },
    });
    const result = parseIncomingMessage(msg);
    expect(result!.content).toBe('Check this out');
    expect(result!.contentText).toBe('Check this out');
  });

  it('video without caption: content is structured JSON, contentText is summary', () => {
    const msg = msgWith({
      videoMessage: { seconds: 30, width: 1920, height: 1080 },
    });
    const result = parseIncomingMessage(msg);
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('video');
    expect(parsed.duration).toBe(30);
    expect(result!.contentText).toContain('Video');
    expect(result!.contentText).toContain('30s');
  });

  it('document with caption: content is caption, contentText is caption', () => {
    const msg = msgWith({
      documentMessage: { caption: 'See attached', fileName: 'report.pdf', mimetype: 'application/pdf', pageCount: 5 },
    });
    const result = parseIncomingMessage(msg);
    expect(result!.content).toBe('See attached');
    expect(result!.contentText).toBe('See attached');
  });

  it('document without caption: content is structured JSON, contentText is summary', () => {
    const msg = msgWith({
      documentMessage: { fileName: 'report.pdf', mimetype: 'application/pdf', pageCount: 5 },
    });
    const result = parseIncomingMessage(msg);
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('document');
    expect(parsed.fileName).toBe('report.pdf');
    expect(parsed.mimetype).toBe('application/pdf');
    expect(result!.contentText).toContain('report.pdf');
  });

  it('sticker: content is structured JSON, contentText is "Sticker"', () => {
    const msg = msgWith({
      stickerMessage: { mimetype: 'image/webp', isAnimated: true },
    });
    const result = parseIncomingMessage(msg);
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('sticker');
    expect(result!.contentText).toBe('Sticker');
  });

  it('image with caption: content is caption, contentText is caption', () => {
    const msg = msgWith({
      imageMessage: { caption: 'Look at this', mimeType: 'image/jpeg' },
    });
    const result = parseIncomingMessage(msg);
    expect(result!.content).toBe('Look at this');
    expect(result!.contentText).toBe('Look at this');
  });

  it('image without caption: content and contentText are null', () => {
    const msg = msgWith({
      imageMessage: { mimeType: 'image/jpeg' },
    });
    const result = parseIncomingMessage(msg);
    expect(result!.content).toBeNull();
    expect(result!.contentText).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests, verify they fail:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/transport/parsing.test.ts --pool=forks 2>&1 | tail -30
# Expected: FAIL — contentText property does not exist on result
```

- [ ] **Step 4: Rewrite content extraction in `parseIncomingMessage()`** in `src/transport/connection.ts`. Replace the content extraction block (the `if/else if` chain at lines 1176-1209, from `let content` through the end of the `pollCreationMessage` branch) with:

```typescript
  // --- Content extraction ---
  let content: string | null = null;
  let contentText: string | null = null;
  let contentType: import('../core/types.ts').ContentType = 'unknown';

  if (innerMessage.conversation) {
    content = innerMessage.conversation;
    contentText = content;
    contentType = 'text';
  } else if (innerMessage.extendedTextMessage?.text) {
    content = innerMessage.extendedTextMessage.text;
    contentText = content;
    contentType = 'text';
  } else if (innerMessage.imageMessage) {
    const caption = innerMessage.imageMessage.caption ?? null;
    content = caption;
    contentText = caption;
    contentType = 'image';
  } else if (innerMessage.videoMessage) {
    const caption = innerMessage.videoMessage.caption ?? null;
    const vMsg = innerMessage.videoMessage;
    if (caption) {
      content = caption;
      contentText = caption;
    } else {
      content = JSON.stringify({
        type: 'video',
        duration: vMsg.seconds ?? null,
        width: vMsg.width ?? null,
        height: vMsg.height ?? null,
      });
      contentText = `Video: ${vMsg.seconds ?? '?'}s`;
    }
    contentType = 'video';
  } else if (innerMessage.documentMessage) {
    const dMsg = innerMessage.documentMessage;
    const caption = dMsg.caption ?? null;
    if (caption) {
      content = caption;
      contentText = caption;
    } else {
      content = JSON.stringify({
        type: 'document',
        fileName: dMsg.fileName ?? null,
        mimetype: dMsg.mimetype ?? null,
        pageCount: dMsg.pageCount ?? null,
      });
      contentText = `Document: ${dMsg.fileName ?? 'unknown'}`;
    }
    contentType = 'document';
  } else if (innerMessage.audioMessage) {
    const aMsg = innerMessage.audioMessage;
    content = JSON.stringify({
      type: 'audio',
      duration: aMsg.seconds ?? null,
      ptt: aMsg.ptt ?? false,
      transcription: null,
    });
    contentText = null; // filled by Whisper later
    contentType = 'audio';
  } else if (innerMessage.stickerMessage) {
    const sMsg = innerMessage.stickerMessage;
    content = JSON.stringify({
      type: 'sticker',
      emoji: (sMsg as any).emoji ?? null,
      isAnimated: sMsg.isAnimated ?? false,
    });
    contentText = (sMsg as any).emoji ? `Sticker: ${(sMsg as any).emoji}` : 'Sticker';
    contentType = 'sticker';
  } else if (innerMessage.locationMessage) {
    const lMsg = innerMessage.locationMessage;
    content = JSON.stringify({
      type: 'location',
      latitude: lMsg.degreesLatitude ?? null,
      longitude: lMsg.degreesLongitude ?? null,
      name: lMsg.name ?? null,
      address: lMsg.address ?? null,
      url: lMsg.url ?? null,
    });
    const label = lMsg.name || lMsg.address || 'shared';
    contentText = `Location: ${label} (${lMsg.degreesLatitude}, ${lMsg.degreesLongitude})`;
    contentType = 'location';
  } else if (innerMessage.contactMessage) {
    const cMsg = innerMessage.contactMessage;
    content = JSON.stringify({
      type: 'contact',
      displayName: cMsg.displayName ?? null,
      vcard: cMsg.vcard ?? null,
    });
    contentText = `Contact: ${cMsg.displayName ?? 'unknown'}`;
    contentType = 'contact';
  } else if ((innerMessage as any).contactsArrayMessage) {
    const contacts = (innerMessage as any).contactsArrayMessage.contacts ?? [];
    content = JSON.stringify({
      type: 'contacts',
      contacts: contacts.map((c: any) => ({
        displayName: c.displayName ?? null,
        vcard: c.vcard ?? null,
      })),
    });
    contentText = `Contacts: ${contacts.map((c: any) => c.displayName).join(', ')}`;
    contentType = 'contact';
  } else if (innerMessage.pollCreationMessage) {
    const pMsg = innerMessage.pollCreationMessage;
    const options = pMsg.options?.map((o: any) => o.optionName) ?? [];
    content = JSON.stringify({
      type: 'poll',
      name: pMsg.name ?? null,
      options,
      selectableCount: pMsg.selectableOptionCount ?? null,
    });
    contentText = `Poll: ${pMsg.name ?? 'untitled'} — ${options.length} options`;
    contentType = 'poll';
  } else if ((innerMessage as any).liveLocationMessage) {
    const llMsg = (innerMessage as any).liveLocationMessage;
    content = JSON.stringify({
      type: 'liveLocation',
      latitude: llMsg.degreesLatitude ?? null,
      longitude: llMsg.degreesLongitude ?? null,
      speed: llMsg.speedInMps ?? null,
      sequence: llMsg.sequenceNumber ?? null,
    });
    contentText = `Live location: (${llMsg.degreesLatitude}, ${llMsg.degreesLongitude})`;
    contentType = 'location';
  }
```

Then update the return statement (around line 1265) to include `contentText`:

```typescript
  return {
    messageId: msg.key.id!,
    chatJid: msg.key.remoteJid!,
    senderJid,
    senderName,
    content,
    contentText,
    contentType,
    isFromMe: msg.key.fromMe ?? false,
    isGroup: isJidGroup(msg.key.remoteJid!) ?? false,
    mentionedJids,
    timestamp,
    quotedMessageId,
    isResponseWorthy,
    rawMessage: msg,
  };
```

- [ ] **Step 5: Update breaking existing tests** in `tests/transport/parsing.test.ts`. Three existing positive-case tests check `content` for location, contact, and poll — these now return JSON instead of plain strings. Update them:

**Location test** (was: `expect(result!.content).toBe('123 Main St')`):
```typescript
  it('location with address → content is structured JSON, contentType=location', () => {
    const msg = msgWith({ locationMessage: { address: '123 Main St', degreesLatitude: 40.7, degreesLongitude: -74.0 } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('location');
    expect(parsed.address).toBe('123 Main St');
    expect(result!.contentType).toBe('location');
  });
```

**Contact test** (was: `expect(result!.content).toBe('Bob Smith')`):
```typescript
  it('contact → content is structured JSON, contentType=contact', () => {
    const msg = msgWith({ contactMessage: { displayName: 'Bob Smith', vcard: 'BEGIN:VCARD\nEND:VCARD' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content!);
    expect(parsed.displayName).toBe('Bob Smith');
    expect(result!.contentType).toBe('contact');
  });
```

**Poll test** (was: `expect(result!.content).toBe('Favourite color?')`):
```typescript
  it('poll creation → content is structured JSON, contentType=poll', () => {
    const msg = msgWith({ pollCreationMessage: { name: 'Favourite color?', options: [] } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content!);
    expect(parsed.name).toBe('Favourite color?');
    expect(result!.contentType).toBe('poll');
  });
```

Also update the **audio** negative test — content is now JSON, not null:
```typescript
  it('audio with structured content → isResponseWorthy=true (media processed via pipeline)', () => {
    const msg = msgWith({ audioMessage: { mimeType: 'audio/ogg' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content!);
    expect(parsed.type).toBe('audio');
    expect(result!.contentType).toBe('audio');
    expect(result!.isResponseWorthy).toBe(true);
  });
```

And the **sticker** branches — content is now JSON, not null:
Update the existing sticker test if one exists, or the new SP2 tests cover it.

And the **document** test — content is now JSON when there's no caption:
```typescript
  // The existing document test with `caption ?? fileName` fallback now
  // returns caption if present, JSON if not. If the test uses a caption,
  // it should still work. If it uses fileName only, update to check JSON.
```

- [ ] **Step 6: Run all parsing tests:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/transport/parsing.test.ts --pool=forks 2>&1 | tail -30
# Expected: all PASS
```

- [ ] **Step 7: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/core/types.ts src/transport/connection.ts tests/transport/parsing.test.ts && git commit -m "feat(parsing): structured content extraction for all message types

Rewrites parseIncomingMessage() to produce structured JSON in content
and human-readable summaries in contentText for location, contact,
poll, audio, video, document, sticker, contactsArray, and
liveLocation message types. Text messages: contentText = content.
Audio contentText is null (filled by Whisper later) (SP2)."
```

---

## Task 4: Ingest pipeline — pass `contentText` through to storage

Wire `contentText` from `IncomingMessage` through the ingest pipeline so it is stored in the `content_text` column at insert time.

**Files:**
- Modify: `src/core/ingest.ts`

- [ ] **Step 1: Update `src/core/ingest.ts`** at the `storeMessageIfNew` call (around line 105). Add `contentText` to the object passed:

```typescript
        const isNew = storeMessageIfNew(db, {
          chatJid: msg.chatJid,
          conversationKey,
          senderJid: msg.senderJid,
          senderName: msg.senderName,
          messageId: msg.messageId,
          content: msg.content,
          contentText: msg.contentText,
          contentType: msg.contentType,
          isFromMe: msg.isFromMe,
          timestamp: msg.timestamp,
          quotedMessageId: msg.quotedMessageId,
          rawMessage: msg.rawMessage != null ? JSON.stringify(msg.rawMessage) : null,
        });
```

- [ ] **Step 2: Run the full test suite to check for regressions:**

```bash
cd ~/LAB/WhatSoup && npx vitest run --pool=forks 2>&1 > /tmp/sp2-task4.log && echo "ALL PASS" || echo "FAILURES"
grep -E "FAIL|Tests |Test Files" /tmp/sp2-task4.log
# Expected: all PASS (or at least no new failures)
```

- [ ] **Step 3: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/core/ingest.ts && git commit -m "feat(ingest): pass contentText through to storeMessageIfNew

Wires IncomingMessage.contentText through the ingest pipeline so
structured message summaries are stored in the content_text column
at insert time (SP2)."
```

---

## Task 5: Transcription persistence — update agent runtime

After Whisper transcription completes in the agent runtime, persist the transcription text to both `content` (updated JSON with transcription field) and `content_text` (plain transcription text).

**Files:**
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/prepare-content.test.ts`

- [ ] **Step 1: Read the existing test file first** to understand the mock patterns:

```bash
cd ~/LAB/WhatSoup && head -60 tests/runtimes/agent/prepare-content.test.ts
```

- [ ] **Step 2: Write the test** in `tests/runtimes/agent/prepare-content.test.ts`. Add a test that verifies transcription is persisted after Whisper runs. Follow the existing mock patterns in the file. The key assertion: after `prepareContentForAgent` runs on an audio message with a valid `db` and `messageId`, the database's `content_text` should be updated with the transcription text.

Example test (adapt to match existing mock patterns):

```typescript
  it('audio message: persists transcription to content and content_text', async () => {
    // This test depends on the mock structure in the file.
    // Key assertion: after prepareContentForAgent runs, updateContentText
    // should be called with the transcription text.
    //
    // If the existing tests use a real in-memory DB, insert a message first:
    //   db.raw.prepare('INSERT INTO messages ...').run(...)
    //   await prepareContentForAgent(audioMsg, db, 'audio-001')
    //   const row = db.raw.prepare('SELECT content_text FROM messages WHERE message_id = ?').get('audio-001')
    //   expect(row.content_text).toBe(transcriptionText)
    //
    // If the existing tests use mocks, verify the mock was called:
    //   expect(mockDb.raw.prepare).toHaveBeenCalledWith(expect.stringContaining('content_text'))
  });
```

**Note:** Read the test file structure first (Step 1) and adapt this test to match. The exact implementation depends on whether the existing tests use a real DB or mocks for `prepareContentForAgent`.

- [ ] **Step 3: Run tests, verify they fail:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/runtimes/agent/prepare-content.test.ts --pool=forks 2>&1 | tail -30
# Expected: FAIL — transcription not persisted in current code
```

- [ ] **Step 4: Update `src/runtimes/agent/runtime.ts`**. In the `prepareContentForAgent` function, find the audio case (around line 148-152):

```typescript
    case 'audio': {
      const { transcribeAudio } = await import('../chat/providers/whisper.ts');
      const transcript = await transcribeAudio(result.buffer, result.mimeType);
      return `[Voice note transcription]: ${transcript}\n[Audio file: ${filePath}]`;
    }
```

Replace with:

```typescript
    case 'audio': {
      const { transcribeAudio } = await import('../chat/providers/whisper.ts');
      const transcript = await transcribeAudio(result.buffer, result.mimeType);

      // Persist transcription to database for MCP access and FTS search
      if (db && messageId && transcript && !transcript.includes('unavailable')) {
        try {
          const { updateContentText } = await import('../../core/messages.ts');
          // Update content JSON with transcription field
          let updatedContent: string | undefined;
          try {
            const parsed = JSON.parse(msg.content || '{}');
            parsed.transcription = transcript;
            updatedContent = JSON.stringify(parsed);
          } catch {
            updatedContent = undefined;
          }
          updateContentText(db, messageId, transcript, updatedContent);
        } catch (err) {
          createChildLogger('agent:transcription').warn({ err, messageId }, 'Failed to persist transcription');
        }
      }

      return `[Voice note transcription]: ${transcript}\n[Audio file: ${filePath}]`;
    }
```

- [ ] **Step 5: Run tests, verify they pass:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/runtimes/agent/prepare-content.test.ts --pool=forks 2>&1 | tail -30
# Expected: all PASS
```

- [ ] **Step 6: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/runtimes/agent/runtime.ts tests/runtimes/agent/prepare-content.test.ts && git commit -m "feat(agent): persist Whisper transcriptions to content_text

After audio transcription, updates both content (JSON with
transcription field) and content_text (plain text) in the database.
Enables FTS search and MCP retrieval of audio transcriptions (SP2)."
```

---

## Task 6: `transcribe_audio` MCP tool

Add a new MCP tool that allows agents to transcribe audio messages on demand.

**Files:**
- Modify: `src/mcp/tools/media.ts`
- Modify: `tests/mcp/tools/media.test.ts`

- [ ] **Step 1: Read the existing test file** to understand patterns:

```bash
cd ~/LAB/WhatSoup && head -80 tests/mcp/tools/media.test.ts
```

- [ ] **Step 2: Write the tests** in `tests/mcp/tools/media.test.ts`. Add a new describe block for `transcribe_audio` following the existing test patterns. Key cases:

```typescript
describe('transcribe_audio', () => {
  it('returns error for non-existent message', async () => {
    const result = await callTool('transcribe_audio', { message_id: 'nonexistent-001' });
    expect(result.error).toBe('not_found');
  });

  it('returns error for non-audio message', async () => {
    // Insert a text message first
    db.raw.prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, content_text, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net', 'text-001', 'hello', 'hello', 'text', Date.now());

    const result = await callTool('transcribe_audio', { message_id: 'text-001' });
    expect(result.error).toBe('not_audio');
  });

  it('returns cached transcription if content_text already set', async () => {
    db.raw.prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, content_text, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net',
      'audio-cached-001',
      '{"type":"audio","duration":5,"transcription":"Hello world"}',
      'Hello world',
      'audio',
      Date.now(),
    );

    const result = await callTool('transcribe_audio', { message_id: 'audio-cached-001' });
    expect(result.transcription).toBe('Hello world');
    expect(result.cached).toBe(true);
    expect(result.duration).toBe(5);
  });

  it('returns cached transcription from content JSON if content_text is null', async () => {
    db.raw.prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, content_text, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net',
      'audio-json-001',
      '{"type":"audio","duration":8,"transcription":"From JSON"}',
      null,
      'audio',
      Date.now(),
    );

    const result = await callTool('transcribe_audio', { message_id: 'audio-json-001' });
    expect(result.transcription).toBe('From JSON');
    expect(result.cached).toBe(true);
  });

  it('returns error when no media available and no raw_message', async () => {
    db.raw.prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, content_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '15550100001@s.whatsapp.net', '15550100001', '15550100001@s.whatsapp.net',
      'audio-nomedia-001',
      '{"type":"audio","duration":3}',
      'audio',
      Date.now(),
    );

    const result = await callTool('transcribe_audio', { message_id: 'audio-nomedia-001' });
    expect(result.error).toBe('no_media');
  });
});
```

Adapt `callTool` and `db` to match the existing test file patterns.

- [ ] **Step 3: Run tests, verify they fail:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/media.test.ts --pool=forks 2>&1 | tail -30
# Expected: FAIL — transcribe_audio tool not registered
```

- [ ] **Step 4: Add `transcribe_audio` tool** to `src/mcp/tools/media.ts`. Add this registration inside `registerMediaTools()`, after the `download_media` registration (before the closing `}` of the function):

```typescript
  // ── transcribe_audio ──────────────��───────────────────────────────────────────

  registry.register({
    name: 'transcribe_audio',
    description:
      'Transcribe an audio/voice note message using Whisper. Returns cached transcription if already transcribed. Persists result to database for future retrieval.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    schema: z.object({
      message_id: z.string().describe('The audio message ID to transcribe'),
    }),
    handler: async (params) => {
      const messageId = params['message_id'] as string;

      // Look up the message
      const row = db.raw.prepare(
        'SELECT message_id, content, content_text, content_type, media_path, raw_message FROM messages WHERE message_id = ?',
      ).get(messageId) as {
        message_id: string;
        content: string | null;
        content_text: string | null;
        content_type: string;
        media_path: string | null;
        raw_message: string | null;
      } | undefined;

      if (!row) {
        return { error: 'not_found', message: `No message found with ID: ${messageId}` };
      }

      if (row.content_type !== 'audio') {
        return { error: 'not_audio', message: `Message is ${row.content_type}, not audio.` };
      }

      // Check for cached transcription in content_text
      if (row.content_text) {
        let duration: number | null = null;
        try {
          const parsed = JSON.parse(row.content || '{}');
          duration = parsed.duration ?? null;
        } catch { /* ignore */ }
        return {
          transcription: row.content_text,
          duration,
          cached: true,
        };
      }

      // Check if content JSON has transcription field
      if (row.content) {
        try {
          const parsed = JSON.parse(row.content);
          if (parsed.transcription) {
            return {
              transcription: parsed.transcription,
              duration: parsed.duration ?? null,
              cached: true,
            };
          }
        } catch { /* ignore */ }
      }

      // Need to download and transcribe
      let audioBuffer: Buffer | null = null;
      let mimeType = 'audio/ogg';

      // Try cached media path first
      if (row.media_path && existsSync(row.media_path)) {
        try {
          audioBuffer = readFileSync(row.media_path);
          const ext = row.media_path.split('.').pop()?.toLowerCase();
          if (ext === 'mp3') mimeType = 'audio/mpeg';
          else if (ext === 'm4a') mimeType = 'audio/mp4';
          else if (ext === 'wav') mimeType = 'audio/wav';
        } catch {
          audioBuffer = null;
        }
      }

      // If no cached file, try downloading from raw_message
      if (!audioBuffer) {
        if (!row.raw_message) {
          return { error: 'no_media', message: 'No audio file cached and no raw message data for download. Media may have expired.' };
        }

        let rawMsg: unknown;
        try {
          rawMsg = JSON.parse(row.raw_message);
        } catch {
          return { error: 'no_media', message: 'Cannot parse raw message data.' };
        }

        const rawMime = extractRawMime(rawMsg, 'audio') ?? 'audio/ogg';
        mimeType = rawMime;

        const downloadFn = async (): Promise<Buffer> => {
          const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
          return downloadMediaMessage(rawMsg as any, 'buffer', {}) as Promise<Buffer>;
        };

        try {
          const result = await coreDownloadMedia(downloadFn, rawMime);
          if (!result) {
            return { error: 'download_failed', message: 'Audio download failed. The URL may have expired.' };
          }
          audioBuffer = result.buffer;
          mimeType = result.mimeType;

          // Save to disk and persist path
          const filePath = writeTempFile(result.buffer, mimeType.includes('ogg') ? 'ogg' : 'mp3');
          updateMediaPath(db, messageId, filePath);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (/404|410|gone|expired/i.test(errMsg)) {
            return { error: 'media_expired', message: 'WhatsApp media URL has expired.' };
          }
          return { error: 'download_failed', message: 'Audio download failed.' };
        }
      }

      // Transcribe via Whisper
      const { transcribeAudio } = await import('../../runtimes/chat/providers/whisper.ts');
      const transcription = await transcribeAudio(audioBuffer, mimeType);

      if (transcription.includes('unavailable')) {
        return { error: 'transcription_failed', message: 'Whisper transcription failed or circuit breaker is open.' };
      }

      // Parse duration and persist transcription
      let duration: number | null = null;
      try {
        const parsed = JSON.parse(row.content || '{}');
        duration = parsed.duration ?? null;
        parsed.transcription = transcription;
        updateContentText(db, messageId, transcription, JSON.stringify(parsed));
      } catch {
        // Still persist content_text even if content JSON parsing fails
        try {
          updateContentText(db, messageId, transcription);
        } catch { /* ignore */ }
      }

      return {
        transcription,
        duration,
        cached: false,
      };
    },
  });
```

Add the import for `updateContentText` at the top of the file (add to existing import from `../../core/messages.ts`):

```typescript
import { updateMediaPath, updateContentText } from '../../core/messages.ts';
```

- [ ] **Step 5: Run tests, verify they pass:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/media.test.ts --pool=forks 2>&1 | tail -30
# Expected: all PASS
```

- [ ] **Step 6: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/mcp/tools/media.ts tests/mcp/tools/media.test.ts && git commit -m "feat(mcp): add transcribe_audio tool

Adds transcribe_audio MCP tool that transcribes audio messages via
Whisper. Returns cached transcription if available. Downloads audio
via SP1 download_media path if needed. Persists transcription to
both content (JSON) and content_text (plain) for FTS search (SP2)."
```

---

## Task 7: Full integration test + regression check

Run the full test suite and fix any regressions from the SP2 changes.

**Files:**
- All test files

- [ ] **Step 1: Run the full test suite:**

```bash
cd ~/LAB/WhatSoup && npx vitest run --pool=forks 2>&1 > /tmp/sp2-test-results.log && echo "ALL PASS" || echo "FAILURES FOUND"
grep -E "FAIL|Tests |Test Files" /tmp/sp2-test-results.log
```

- [ ] **Step 2: If any tests fail, fix them.** Common regressions to watch for:

1. **Tests that insert messages without `content_text`** — The FTS triggers now watch `content_text` not `content`. Tests that insert raw SQL without setting `content_text` won't trigger FTS indexing. This is correct behavior (mimics old messages without enrichment).

2. **Tests that check `content` value for location/contact/poll messages** — These now get JSON instead of plain strings. Update assertions to match.

3. **Tests that mock `IncomingMessage` without `contentText` field** — Add `contentText: null` to mock objects throughout the codebase. Search for:
```bash
grep -rn "contentType:" tests/ | grep -v contentText | head -20
```
Any test creating an `IncomingMessage`-shaped object needs a `contentText` field.

4. **`StoredMessage` mocks missing `contentText`** — Same as above, add the field.

- [ ] **Step 3: If all tests pass, commit any fixes:**

```bash
cd ~/LAB/WhatSoup && git add -A && git commit -m "fix: patch test regressions from SP2 content extraction changes

Updates test assertions and mock objects to match the new structured
content format (JSON in content, human-readable in contentText)."
```

- [ ] **Step 4: Final verification:**

```bash
cd ~/LAB/WhatSoup && npx vitest run --pool=forks 2>&1 > /tmp/sp2-final.log && echo "ALL PASS" || echo "FAILURES"
grep -E "Test Files|Tests " /tmp/sp2-final.log
# Expected: ALL PASS — 0 failures
```
