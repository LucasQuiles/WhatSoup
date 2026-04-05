# SP2: Content Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `parseIncomingMessage` to store structured JSON in `content` and human-readable summaries in a new `content_text` column for all non-text content types. Persist Whisper transcriptions to the database. Add `transcribe_audio` MCP tool for on-demand transcription.

**Architecture:** Add `content_text` column to messages table. Rebuild FTS triggers to index `content_text` instead of `content`. Rewrite content extraction in `parseIncomingMessage()` for 9 content types. Add `contentText` to `IncomingMessage`, `StoreMessageInput`, `MessageRow`, and `rowToMessage`. Persist transcriptions after Whisper runs. Add `transcribe_audio` MCP tool.

**Tech Stack:** TypeScript, Baileys 7.0.0-rc.9, vitest, SQLite, OpenAI Whisper

**Spec:** `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md` Section 4

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/database.ts` | Modify | MIGRATION_13: add `content_text TEXT` column, DROP and re-CREATE all 4 FTS triggers to index `content_text` |
| `src/core/types.ts` | Modify | Add `contentText` to `IncomingMessage` interface |
| `src/core/messages.ts` | Modify | Add `content_text` to `MessageRow`, `rowToMessage`, `StoredMessage`, `rowToStoredMessage`, `StoreMessageInput`, `toInsertParams`, `storeMessage`, `storeMessageIfNew`; add `updateTranscription()` helper |
| `src/transport/connection.ts` | Modify | Rewrite content extraction in `parseIncomingMessage()` to produce both `content` (structured JSON) and `contentText` (human-readable summary) |
| `src/core/ingest.ts` | Modify | Pass `contentText` through to `storeMessageIfNew` |
| `src/runtimes/agent/runtime.ts` | Modify | Persist transcription to `content` and `content_text` after Whisper runs |
| `src/mcp/tools/media.ts` | Modify | Add `transcribe_audio` MCP tool |
| `tests/core/database.test.ts` | Modify | Test MIGRATION_13 schema and FTS trigger rebuild |
| `tests/core/messages.test.ts` | Modify | Test `content_text` in `rowToMessage`, `updateTranscription()` |
| `tests/transport/parsing.test.ts` | Modify | Test structured content extraction for all content types |
| `tests/mcp/tools/media.test.ts` | Modify | Test `transcribe_audio` tool |

---

## Task 1: MIGRATION_13 -- `content_text` column + FTS trigger rebuild

Add the database migration that creates the new column and rebuilds all 4 FTS triggers to index `content_text` instead of `content`.

**Files:**
- Modify: `src/core/database.ts`
- Modify: `tests/core/database.test.ts`

- [ ] Step 1: Write the test in `tests/core/database.test.ts`. Add these tests inside the existing `describe('Database schema', ...)` block, after the last `it(...)`:

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

  it('FTS insert trigger references content_text (MIGRATION_13)', () => {
    const triggers = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_insert'")
      .all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].sql).toContain('content_text');
  });

  it('FTS update trigger fires on content_text changes (MIGRATION_13)', () => {
    const triggers = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_update'")
      .all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].sql).toContain('content_text');
  });

  it('FTS soft_delete trigger references content_text (MIGRATION_13)', () => {
    const triggers = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_soft_delete'")
      .all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].sql).toContain('content_text');
  });

  it('FTS delete trigger references content_text (MIGRATION_13)', () => {
    const triggers = db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_delete'")
      .all() as Array<{ sql: string }>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0].sql).toContain('content_text');
  });
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/database.test.ts 2>&1 | tail -20
# Expected: 5 FAILED tests (content_text column, 4 FTS trigger tests)
```

- [ ] Step 3: Add MIGRATION_13 to `src/core/database.ts`. Insert this entry at the end of the `MIGRATIONS` Map (after the `[12, ...]` entry, before the closing `]);`):

```typescript
  [13, (db: DatabaseSync) => {
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'content_text')) {
      db.exec('ALTER TABLE messages ADD COLUMN content_text TEXT');
    }

    // Rebuild all 4 FTS triggers to index content_text instead of content.
    // Must DROP all first, then re-CREATE — atomic within the migration transaction.
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

- [ ] Step 4: Run tests, verify they pass:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/database.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] Step 5: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/core/database.ts tests/core/database.test.ts && git commit -m "feat(db): add MIGRATION_13 — content_text column + FTS trigger rebuild

Adds content_text TEXT column to messages table and rebuilds all 4
FTS triggers (insert, update, soft_delete, delete) to index
content_text instead of content for human-readable search (SP2)."
```

---

## Task 2: `IncomingMessage` + `StoreMessageInput` + `MessageRow` -- add `contentText` / `content_text`

Update TypeScript interfaces and mapper functions to carry the new field through the entire pipeline.

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/messages.ts`
- Modify: `tests/core/messages.test.ts`

- [ ] Step 1: Write the tests in `tests/core/messages.test.ts`. Add inside the existing `describe('messages', ...)` block:

```typescript
  it('rowToMessage exposes content_text as contentText', () => {
    const msg = makeMsg({ content: '{"type":"location","latitude":40.7}', contentType: 'location' });
    storeMessage(db, msg);

    // Manually set content_text
    db.raw.prepare('UPDATE messages SET content_text = ? WHERE message_id = ?')
      .run('Location: shared (40.7, -74.0)', msg.messageId);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as import('../../src/core/messages.ts').MessageRow[];

    const mapped = rowToMessage(rows[0]);
    expect(mapped.contentText).toBe('Location: shared (40.7, -74.0)');
  });

  it('rowToMessage returns content as contentText fallback for text messages', () => {
    const msg = makeMsg({ content: 'hello world', contentType: 'text' });
    storeMessage(db, msg);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as import('../../src/core/messages.ts').MessageRow[];

    const mapped = rowToMessage(rows[0]);
    expect(mapped.contentText).toBe('hello world');
  });

  it('storeMessageIfNew persists content_text when provided', () => {
    const msg = makeMsg({
      content: '{"type":"contact","displayName":"Bob"}',
      contentType: 'contact',
      contentText: 'Contact: Bob',
    });

    const { storeMessageIfNew } = require('../../src/core/messages.ts');
    storeMessageIfNew(db, msg);

    const row = db.raw
      .prepare('SELECT content_text FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { content_text: string | null };
    expect(row.content_text).toBe('Contact: Bob');
  });
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts 2>&1 | tail -20
# Expected: FAILED — contentText property missing, contentText not in StoreMessageInput
```

- [ ] Step 3: Update `src/core/types.ts`. Add `contentText` to the `IncomingMessage` interface (after `content: string | null;`):

```typescript
  /** Human-readable summary for FTS indexing. Null for text messages (content is already readable). */
  contentText: string | null;
```

- [ ] Step 4: Update `src/core/messages.ts`. Five changes:

**Change A** -- Add `content_text` to the `MessageRow` interface (after `media_path: string | null;`):

```typescript
  content_text: string | null;
```

**Change B** -- Add `contentText` to the `rowToMessage` return (after `mediaPath: row.media_path ?? null,`):

```typescript
    contentText: row.content_text ?? row.content ?? null,
```

**Change C** -- Add `contentText` to the `StoredMessage` interface (after `mediaPath: string | null;`):

```typescript
  contentText: string | null;
```

And update `rowToStoredMessage` (after `mediaPath: (row.media_path as string | null) ?? null,`):

```typescript
    contentText: (row.content_text as string | null) ?? (row.content as string | null) ?? null,
```

**Change D** -- Add `contentText` to `StoreMessageInput` (after `rawMessage?: string | null;`):

```typescript
  /** Human-readable summary for FTS indexing (SP2). Null for text messages. */
  contentText?: string | null;
```

**Change E** -- Add `content_text` to `toInsertParams` (after `raw_message: msg.rawMessage ?? null,`):

```typescript
    content_text: msg.contentText ?? null,
```

**Change F** -- Add `content_text` to both SQL INSERT statements in `storeMessage` and `storeMessageIfNew`. In both functions, add `content_text` to the column list and `@content_text` to the VALUES list.

In `storeMessage`, also add to the ON CONFLICT clause:

```typescript
      content_text      = excluded.content_text,
```

The `storeMessage` INSERT becomes:

```typescript
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type,
       is_from_me, timestamp, quoted_message_id, raw_message, content_text)
    VALUES
      (@chat_jid, @conversation_key, @sender_jid, @sender_name, @message_id, @content, @content_type,
       @is_from_me, @timestamp, @quoted_message_id, @raw_message, @content_text)
    ON CONFLICT(message_id) DO UPDATE SET
      sender_name       = COALESCE(excluded.sender_name, sender_name),
      content           = excluded.content,
      content_type      = excluded.content_type,
      is_from_me        = excluded.is_from_me,
      timestamp         = excluded.timestamp,
      quoted_message_id = COALESCE(excluded.quoted_message_id, quoted_message_id),
      raw_message       = COALESCE(excluded.raw_message, raw_message),
      content_text      = excluded.content_text
```

The `storeMessageIfNew` INSERT becomes:

```typescript
    INSERT OR IGNORE INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type,
       is_from_me, timestamp, quoted_message_id, raw_message, content_text)
    VALUES
      (@chat_jid, @conversation_key, @sender_jid, @sender_name, @message_id, @content, @content_type,
       @is_from_me, @timestamp, @quoted_message_id, @raw_message, @content_text)
```

- [ ] Step 5: Run tests, verify they pass:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] Step 6: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/core/types.ts src/core/messages.ts tests/core/messages.test.ts && git commit -m "feat(messages): add content_text to IncomingMessage, MessageRow, StoreMessageInput

Threads content_text through the entire message pipeline: types,
interfaces, insert params, upsert, and response mappers. The
contentText field falls back to content for text messages (SP2)."
```

---

## Task 3: `updateTranscription()` helper function

Add a helper that persists Whisper transcription to both `content` (structured JSON with transcription field) and `content_text`.

**Files:**
- Modify: `src/core/messages.ts`
- Modify: `tests/core/messages.test.ts`

- [ ] Step 1: Write the test in `tests/core/messages.test.ts`. Add inside the existing `describe('messages', ...)` block. First, add `updateTranscription` to the import at the top of the file (alongside `updateMediaPath`).

Then add these tests:

```typescript
  it('updateTranscription persists transcription to content and content_text', () => {
    const msg = makeMsg({
      content: JSON.stringify({ type: 'audio', duration: 12, ptt: true, transcription: null }),
      contentType: 'audio',
    });
    storeMessage(db, msg);

    const { updateTranscription } = require('../../src/core/messages.ts');
    updateTranscription(db, msg.messageId, 'Hello, this is a test');

    const row = db.raw
      .prepare('SELECT content, content_text FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { content: string; content_text: string };

    const parsed = JSON.parse(row.content);
    expect(parsed.transcription).toBe('Hello, this is a test');
    expect(row.content_text).toBe('Hello, this is a test');
  });

  it('updateTranscription handles non-JSON content gracefully', () => {
    const msg = makeMsg({
      content: null,
      contentType: 'audio',
    });
    storeMessage(db, msg);

    const { updateTranscription } = require('../../src/core/messages.ts');
    updateTranscription(db, msg.messageId, 'Transcribed text');

    const row = db.raw
      .prepare('SELECT content, content_text FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { content: string; content_text: string };

    const parsed = JSON.parse(row.content);
    expect(parsed.transcription).toBe('Transcribed text');
    expect(row.content_text).toBe('Transcribed text');
  });

  it('updateTranscription is indexed by FTS after MIGRATION_13', () => {
    const msg = makeMsg({
      content: JSON.stringify({ type: 'audio', duration: 5, ptt: true, transcription: null }),
      contentType: 'audio',
      contentText: null,
    });
    storeMessage(db, msg);

    const { updateTranscription } = require('../../src/core/messages.ts');
    updateTranscription(db, msg.messageId, 'searchable transcription');

    const ftsResults = db.raw
      .prepare("SELECT rowid FROM messages_fts WHERE content MATCH 'searchable'")
      .all() as Array<{ rowid: number }>;
    expect(ftsResults.length).toBeGreaterThan(0);
  });
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts 2>&1 | tail -20
# Expected: FAILED — updateTranscription is not exported
```

- [ ] Step 3: Add `updateTranscription()` to `src/core/messages.ts`. Add this function after `updateMediaPath`:

```typescript
/**
 * Persist a Whisper transcription to both content (structured JSON)
 * and content_text (human-readable, FTS-indexed).
 * Called by agent runtime and transcribe_audio MCP tool after Whisper completes.
 */
export function updateTranscription(db: Database, messageId: string, transcription: string): void {
  // Read existing content to merge transcription into structured JSON
  const row = db.raw.prepare('SELECT content FROM messages WHERE message_id = ?')
    .get(messageId) as { content: string | null } | undefined;

  let updatedContent: string;
  try {
    const parsed = JSON.parse(row?.content || '{}');
    parsed.transcription = transcription;
    updatedContent = JSON.stringify(parsed);
  } catch {
    updatedContent = JSON.stringify({ transcription });
  }

  db.raw.prepare('UPDATE messages SET content = ?, content_text = ? WHERE message_id = ?')
    .run(updatedContent, transcription, messageId);
}
```

- [ ] Step 4: Run tests, verify they pass:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] Step 5: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/core/messages.ts tests/core/messages.test.ts && git commit -m "feat(messages): add updateTranscription() for persisting Whisper results

Reads existing structured JSON content, merges transcription field,
and updates both content and content_text columns. The content_text
update fires the FTS trigger for search indexing (SP2)."
```

---

## Task 4: Rewrite `parseIncomingMessage` content extraction

Rewrite the content extraction block in `parseIncomingMessage()` to produce structured JSON in `content` and human-readable summaries in `contentText` for all non-text content types.

**Files:**
- Modify: `src/transport/connection.ts`
- Modify: `tests/transport/parsing.test.ts`

- [ ] Step 1: Write the tests in `tests/transport/parsing.test.ts`. Add a new `describe` block after the existing ones:

```typescript
// ---------------------------------------------------------------------------
// SP2: Structured content extraction
// ---------------------------------------------------------------------------

describe('parseIncomingMessage — structured content (SP2)', () => {
  it('location: content is JSON with lat/lng, contentText is human summary', () => {
    const msg = msgWith({
      locationMessage: {
        degreesLatitude: 40.7128,
        degreesLongitude: -74.006,
        name: 'New York',
        address: '123 Broadway',
        url: 'https://maps.google.com/...',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('location');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('location');
    expect(parsed.latitude).toBe(40.7128);
    expect(parsed.longitude).toBe(-74.006);
    expect(parsed.name).toBe('New York');
    expect(parsed.address).toBe('123 Broadway');

    expect(result.contentText).toContain('Location');
    expect(result.contentText).toContain('New York');
    expect(result.contentText).toContain('40.7128');
  });

  it('location without name: falls back to address in contentText', () => {
    const msg = msgWith({
      locationMessage: {
        degreesLatitude: 51.5,
        degreesLongitude: -0.12,
        address: '10 Downing St',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentText).toContain('10 Downing St');
  });

  it('contact: content is JSON with vcard, contentText is display name', () => {
    const msg = msgWith({
      contactMessage: {
        displayName: 'Bob Smith',
        vcard: 'BEGIN:VCARD\nFN:Bob Smith\nTEL:+1234567890\nEND:VCARD',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('contact');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('contact');
    expect(parsed.displayName).toBe('Bob Smith');
    expect(parsed.vcard).toContain('BEGIN:VCARD');

    expect(result.contentText).toBe('Contact: Bob Smith');
  });

  it('contactsArray: content is JSON array, contentText lists names', () => {
    const msg = msgWith({
      contactsArrayMessage: {
        contacts: [
          { displayName: 'Alice', vcard: 'BEGIN:VCARD\nFN:Alice\nEND:VCARD' },
          { displayName: 'Bob', vcard: 'BEGIN:VCARD\nFN:Bob\nEND:VCARD' },
        ],
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('contact');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('contacts');
    expect(parsed.contacts).toHaveLength(2);

    expect(result.contentText).toContain('Alice');
    expect(result.contentText).toContain('Bob');
  });

  it('poll: content is JSON with options, contentText is poll summary', () => {
    const msg = msgWith({
      pollCreationMessage: {
        name: 'Favourite color?',
        options: [
          { optionName: 'Red' },
          { optionName: 'Blue' },
          { optionName: 'Green' },
        ],
        selectableOptionCount: 1,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('poll');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('poll');
    expect(parsed.name).toBe('Favourite color?');
    expect(parsed.options).toEqual(['Red', 'Blue', 'Green']);
    expect(parsed.selectableCount).toBe(1);

    expect(result.contentText).toContain('Poll');
    expect(result.contentText).toContain('Favourite color?');
    expect(result.contentText).toContain('3 options');
  });

  it('audio: content is JSON with duration/ptt, contentText is null (filled by Whisper later)', () => {
    const msg = msgWith({
      audioMessage: {
        seconds: 15,
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('audio');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('audio');
    expect(parsed.duration).toBe(15);
    expect(parsed.ptt).toBe(true);
    expect(parsed.transcription).toBeNull();

    expect(result.contentText).toBeNull();
  });

  it('video with caption: content preserves caption, contentText is caption', () => {
    const msg = msgWith({
      videoMessage: {
        caption: 'Check this out',
        seconds: 30,
        width: 1920,
        height: 1080,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('video');
    expect(result.content).toBe('Check this out');
    expect(result.contentText).toBe('Check this out');
  });

  it('video without caption: content is JSON metadata, contentText is duration summary', () => {
    const msg = msgWith({
      videoMessage: {
        seconds: 45,
        width: 1280,
        height: 720,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('video');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('video');
    expect(parsed.duration).toBe(45);

    expect(result.contentText).toContain('Video');
    expect(result.contentText).toContain('45');
  });

  it('document with caption: content preserves caption, contentText is caption', () => {
    const msg = msgWith({
      documentMessage: {
        caption: 'Here is the report',
        fileName: 'report.pdf',
        mimetype: 'application/pdf',
        pageCount: 5,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('document');
    expect(result.content).toBe('Here is the report');
    expect(result.contentText).toBe('Here is the report');
  });

  it('document without caption: content is JSON metadata, contentText is filename summary', () => {
    const msg = msgWith({
      documentMessage: {
        fileName: 'data.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('document');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('document');
    expect(parsed.fileName).toBe('data.xlsx');

    expect(result.contentText).toContain('Document');
    expect(result.contentText).toContain('data.xlsx');
  });

  it('sticker: content is JSON with emoji, contentText is emoji summary', () => {
    const msg = msgWith({
      stickerMessage: {
        mimetype: 'image/webp',
        isAnimated: false,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('sticker');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('sticker');

    expect(result.contentText).toBe('Sticker');
  });

  it('sticker with emoji association: contentText includes emoji', () => {
    const msg = msgWith({
      stickerMessage: {
        mimetype: 'image/webp',
        isAnimated: true,
        // Baileys uses this non-standard property name for the emoji tag
        associatedEmoji: '😂',
      },
    });
    // Need to handle both possible property names
    const innerMsg = msg.message.stickerMessage;
    innerMsg.emoji = innerMsg.associatedEmoji;

    const result = parseIncomingMessage(msg)!;
    const parsed = JSON.parse(result.content!);
    expect(parsed.emoji).toBeTruthy();
  });

  it('liveLocation: content is JSON with lat/lng/speed, contentText is summary', () => {
    const msg = msgWith({
      liveLocationMessage: {
        degreesLatitude: 37.7749,
        degreesLongitude: -122.4194,
        speedInMps: 5.2,
        sequenceNumber: 3,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('location');

    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('liveLocation');
    expect(parsed.latitude).toBe(37.7749);
    expect(parsed.speed).toBe(5.2);

    expect(result.contentText).toContain('Live location');
    expect(result.contentText).toContain('37.7749');
  });

  it('image with caption: content preserves caption, contentText is caption', () => {
    const msg = msgWith({
      imageMessage: { caption: 'Beach sunset', mimeType: 'image/jpeg' },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('image');
    expect(result.content).toBe('Beach sunset');
    expect(result.contentText).toBe('Beach sunset');
  });

  it('image without caption: content is null, contentText is null', () => {
    const msg = msgWith({
      imageMessage: { mimeType: 'image/jpeg' },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('image');
    expect(result.content).toBeNull();
    expect(result.contentText).toBeNull();
  });

  it('plain text: contentText is null (content IS the readable text)', () => {
    const msg = msgWith({ conversation: 'Hello world' });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('text');
    expect(result.content).toBe('Hello world');
    expect(result.contentText).toBeNull();
  });
});
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/transport/parsing.test.ts 2>&1 | tail -30
# Expected: FAILED — contentText property missing on result
```

- [ ] Step 3: Rewrite the content extraction block in `src/transport/connection.ts` `parseIncomingMessage()` (lines 1176-1209). Replace the entire content extraction section from `let content: string | null = null;` through the closing `}` of the poll branch:

```typescript
  // --- Content extraction ---
  let content: string | null = null;
  let contentText: string | null = null;
  let contentType: import('../core/types.ts').ContentType = 'unknown';

  if (innerMessage.conversation) {
    content = innerMessage.conversation;
    contentText = null; // text IS the readable content; no separate summary needed
    contentType = 'text';
  } else if (innerMessage.extendedTextMessage?.text) {
    content = innerMessage.extendedTextMessage.text;
    contentText = null;
    contentType = 'text';
  } else if (innerMessage.imageMessage) {
    const caption = innerMessage.imageMessage.caption ?? null;
    content = caption;
    contentText = caption;
    contentType = 'image';
  } else if (innerMessage.videoMessage) {
    const caption = innerMessage.videoMessage.caption ?? null;
    const vm = innerMessage.videoMessage;
    if (caption) {
      content = caption;
      contentText = caption;
    } else {
      content = JSON.stringify({
        type: 'video',
        duration: vm.seconds ?? null,
        width: vm.width ?? null,
        height: vm.height ?? null,
      });
      contentText = `Video: ${vm.seconds ?? '?'}s`;
    }
    contentType = 'video';
  } else if (innerMessage.documentMessage) {
    const dm = innerMessage.documentMessage;
    const caption = dm.caption ?? null;
    if (caption) {
      content = caption;
      contentText = caption;
    } else {
      content = JSON.stringify({
        type: 'document',
        fileName: dm.fileName ?? null,
        mimetype: dm.mimetype ?? null,
        pageCount: dm.pageCount ?? null,
      });
      contentText = `Document: ${dm.fileName ?? 'file'}`;
    }
    contentType = 'document';
  } else if (innerMessage.audioMessage) {
    const am = innerMessage.audioMessage;
    content = JSON.stringify({
      type: 'audio',
      duration: am.seconds ?? null,
      ptt: am.ptt ?? false,
      transcription: null,
    });
    contentText = null; // filled by Whisper later
    contentType = 'audio';
  } else if (innerMessage.stickerMessage) {
    const sm = innerMessage.stickerMessage;
    const emoji = (sm as any).emoji ?? (sm as any).associatedEmoji ?? null;
    content = JSON.stringify({
      type: 'sticker',
      emoji,
      isAnimated: sm.isAnimated ?? false,
    });
    contentText = emoji ? `Sticker: ${emoji}` : 'Sticker';
    contentType = 'sticker';
  } else if (innerMessage.locationMessage) {
    const lm = innerMessage.locationMessage;
    content = JSON.stringify({
      type: 'location',
      latitude: lm.degreesLatitude ?? null,
      longitude: lm.degreesLongitude ?? null,
      name: lm.name ?? null,
      address: lm.address ?? null,
      url: lm.url ?? null,
    });
    contentText = `Location: ${lm.name || lm.address || 'shared'} (${lm.degreesLatitude}, ${lm.degreesLongitude})`;
    contentType = 'location';
  } else if (innerMessage.liveLocationMessage) {
    const ll = innerMessage.liveLocationMessage;
    content = JSON.stringify({
      type: 'liveLocation',
      latitude: ll.degreesLatitude ?? null,
      longitude: ll.degreesLongitude ?? null,
      speed: ll.speedInMps ?? null,
      sequence: ll.sequenceNumber ?? null,
    });
    contentText = `Live location: (${ll.degreesLatitude}, ${ll.degreesLongitude})`;
    contentType = 'location';
  } else if (innerMessage.contactMessage) {
    const cm = innerMessage.contactMessage;
    content = JSON.stringify({
      type: 'contact',
      displayName: cm.displayName ?? null,
      vcard: cm.vcard ?? null,
    });
    contentText = `Contact: ${cm.displayName ?? 'Unknown'}`;
    contentType = 'contact';
  } else if (innerMessage.contactsArrayMessage) {
    const contacts = (innerMessage.contactsArrayMessage.contacts ?? []).map((c: any) => ({
      displayName: c.displayName ?? null,
      vcard: c.vcard ?? null,
    }));
    content = JSON.stringify({
      type: 'contacts',
      contacts,
    });
    contentText = `Contacts: ${contacts.map((c: any) => c.displayName).join(', ')}`;
    contentType = 'contact';
  } else if (innerMessage.pollCreationMessage) {
    const pm = innerMessage.pollCreationMessage;
    const options = (pm.options ?? []).map((o: any) => o.optionName);
    content = JSON.stringify({
      type: 'poll',
      name: pm.name ?? null,
      options,
      selectableCount: pm.selectableOptionCount ?? null,
    });
    contentText = `Poll: ${pm.name ?? 'Unnamed'} \u2014 ${options.length} options`;
    contentType = 'poll';
  }
```

- [ ] Step 4: Add `contentText` to the return object of `parseIncomingMessage()`. Find the return statement (around line 1265) and add `contentText` after `content`:

Change from:
```typescript
  return {
    messageId: msg.key.id!,
    chatJid: msg.key.remoteJid!,
    senderJid,
    senderName,
    content,
    contentType,
```

to:
```typescript
  return {
    messageId: msg.key.id!,
    chatJid: msg.key.remoteJid!,
    senderJid,
    senderName,
    content,
    contentText,
    contentType,
```

- [ ] Step 5: Run tests, verify they pass:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/transport/parsing.test.ts 2>&1 | tail -30
# Expected: all PASS (both old positive-case tests and new SP2 tests)
```

- [ ] Step 6: Verify existing parsing tests still pass (the old tests checked `content` values which are now different for some types like location). The old test `'location with address -> content=address'` will now fail because `content` is JSON. **Update the old tests** to match the new behavior:

Find the old test:
```typescript
  it('location with address → content=address, contentType=location', () => {
```

Update its expectation to check for JSON content:
```typescript
  it('location with address → content is structured JSON, contentType=location', () => {
    const msg = msgWith({ locationMessage: { address: '123 Main St', degreesLatitude: 40.7, degreesLongitude: -74.0 } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content!);
    expect(parsed.address).toBe('123 Main St');
    expect(result!.contentType).toBe('location');
  });
```

Similarly update the old `contact` test:
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

And the old `poll` test:
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

And the old `audio` test (content was `null`, now it is JSON):
```typescript
  // No change needed for audio — old test checked content=null,
  // but content is now JSON. If the old suite has:
  //   expect(result!.content).toBeNull()
  // change to:
  //   expect(result!.content).not.toBeNull();
  //   expect(JSON.parse(result!.content!).type).toBe('audio');
```

And the old `sticker` test (content was `null`, now it is JSON):
```typescript
  // Similar — sticker content is now JSON. Update:
  //   expect(result!.content).toBeNull()
  // to:
  //   expect(result!.content).not.toBeNull();
  //   expect(JSON.parse(result!.content!).type).toBe('sticker');
```

- [ ] Step 7: Run the full parsing test file again:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/transport/parsing.test.ts 2>&1 | tail -30
# Expected: all PASS
```

- [ ] Step 8: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/transport/connection.ts tests/transport/parsing.test.ts && git commit -m "feat(parsing): rewrite parseIncomingMessage for structured content extraction

Produces JSON in content and human-readable summary in contentText
for location, contact, contactsArray, poll, audio, video, document,
sticker, and liveLocation message types. Text messages use content
directly with null contentText. Handles caption preservation (SP2)."
```

---

## Task 5: Thread `contentText` through ingest pipeline

Wire `contentText` from the `IncomingMessage` through to `storeMessageIfNew` in the ingest pipeline so it is persisted to the `content_text` column at ingest time.

**Files:**
- Modify: `src/core/ingest.ts`

- [ ] Step 1: Update the `storeMessageIfNew` call in `src/core/ingest.ts` (around line 105). Add `contentText` to the object passed to `storeMessageIfNew`:

Change from:
```typescript
        const isNew = storeMessageIfNew(db, {
          chatJid: msg.chatJid,
          conversationKey,
          senderJid: msg.senderJid,
          senderName: msg.senderName,
          messageId: msg.messageId,
          content: msg.content,
          contentType: msg.contentType,
          isFromMe: msg.isFromMe,
          timestamp: msg.timestamp,
          quotedMessageId: msg.quotedMessageId,
          rawMessage: msg.rawMessage != null ? JSON.stringify(msg.rawMessage) : null,
        });
```

to:
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

- [ ] Step 2: Run type check to verify wiring is correct:

```bash
cd ~/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -20
# Expected: clean (0 errors)
```

- [ ] Step 3: Run the ingest test suite:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/ingest.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] Step 4: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/core/ingest.ts && git commit -m "feat(ingest): pass contentText through to storeMessageIfNew

Threads the human-readable content_text from parseIncomingMessage
through the ingest pipeline so it is persisted at message insertion
time and indexed by FTS (SP2)."
```

---

## Task 6: Persist transcription in agent runtime

After Whisper transcription completes in `prepareContentForAgent`, call `updateTranscription()` to persist the result to both `content` and `content_text`.

**Files:**
- Modify: `src/runtimes/agent/runtime.ts`

- [ ] Step 1: Add the import for `updateTranscription` at the top of the file (near the existing `updateMediaPath` import):

```typescript
import { updateMediaPath, updateTranscription } from '../../core/messages.ts';
```

(If `updateMediaPath` is already imported from a different location, add `updateTranscription` to the same import.)

- [ ] Step 2: Find the audio transcription block in `prepareContentForAgent` (around line 148-152):

```typescript
    case 'audio': {
      const { transcribeAudio } = await import('../chat/providers/whisper.ts');
      const transcript = await transcribeAudio(result.buffer, result.mimeType);
      return `[Voice note transcription]: ${transcript}\n[Audio file: ${filePath}]`;
    }
```

Add transcription persistence after the `transcribeAudio` call:

```typescript
    case 'audio': {
      const { transcribeAudio } = await import('../chat/providers/whisper.ts');
      const transcript = await transcribeAudio(result.buffer, result.mimeType);

      // Persist transcription to DB for MCP access and FTS search
      if (db && messageId && transcript && !transcript.includes('transcription unavailable')) {
        try {
          updateTranscription(db, messageId, transcript);
        } catch (err) {
          createChildLogger('agent:transcription').warn({ err, messageId }, 'Failed to persist transcription');
        }
      }

      return `[Voice note transcription]: ${transcript}\n[Audio file: ${filePath}]`;
    }
```

- [ ] Step 3: Run type check:

```bash
cd ~/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -20
# Expected: clean (0 errors)
```

- [ ] Step 4: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/runtimes/agent/runtime.ts && git commit -m "feat(agent): persist Whisper transcription to content + content_text

After successful audio transcription, calls updateTranscription()
to merge the text into the structured JSON content and set
content_text for FTS indexing. Skips fallback text (SP2)."
```

---

## Task 7: `transcribe_audio` MCP tool

Add a new MCP tool that downloads audio from a message, transcribes it via Whisper, persists the result, and returns the transcription.

**Files:**
- Modify: `src/mcp/tools/media.ts`
- Modify: `tests/mcp/tools/media.test.ts`

- [ ] Step 1: Write the test in `tests/mcp/tools/media.test.ts`. Add a new `describe` block (or inside the existing `download_media` describe, add a new nested describe). The test should verify the tool exists and handles error cases:

```typescript
describe('transcribe_audio', () => {
  let registry: ToolRegistry;
  let connection: ReturnType<typeof makeConnection>;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let testDb: Database;
  let deps: MediaDeps;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db: testDb };
    registerMediaTools(registry, deps);
  });

  afterEach(() => {
    testDb.close();
  });

  function insertAudioMessage(
    messageId: string,
    opts: { mediaPath?: string; content?: string } = {},
  ): void {
    testDb.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type,
        content, is_from_me, timestamp, media_path)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', ?, 'audio', ?, 0, 1700000000, ?)
    `).run(
      messageId,
      opts.content ?? JSON.stringify({ type: 'audio', duration: 10, ptt: true, transcription: null }),
      opts.mediaPath ?? null,
    );
  }

  it('returns error for non-audio message', async () => {
    testDb.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'msg-image', 'image', 0, 1700000000)
    `).run();

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-image' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('not_audio');
  });

  it('returns error for unknown message_id', async () => {
    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'nonexistent' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('not_found');
  });

  it('returns cached transcription if already transcribed', async () => {
    insertAudioMessage('msg-transcribed', {
      content: JSON.stringify({ type: 'audio', duration: 5, ptt: true, transcription: 'Already done' }),
    });

    // Set content_text too
    testDb.raw.prepare('UPDATE messages SET content_text = ? WHERE message_id = ?')
      .run('Already done', 'msg-transcribed');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-transcribed' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.transcription).toBe('Already done');
    expect(body.cached).toBe(true);
  });

  it('returns error when no media_path and no raw_message', async () => {
    insertAudioMessage('msg-no-media');

    const result = await registry.call(
      'transcribe_audio',
      { message_id: 'msg-no-media' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBeTruthy();
  });
});
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/media.test.ts 2>&1 | tail -20
# Expected: FAILED — transcribe_audio tool not registered
```

- [ ] Step 3: Implement the `transcribe_audio` tool in `src/mcp/tools/media.ts`. Add the import for `updateTranscription` at the top:

```typescript
import { updateMediaPath, updateTranscription } from '../../core/messages.ts';
```

Add the tool registration inside `registerMediaTools`, after the `download_media` registration:

```typescript
  // ── transcribe_audio ─────────────────────────────────────────────────────────

  registry.register({
    name: 'transcribe_audio',
    description:
      'Transcribe an audio/voice message using Whisper. Downloads the audio if needed, transcribes it, and persists the transcription. Returns cached transcription if already transcribed.',
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
        'SELECT message_id, content_type, content, content_text, media_path, raw_message FROM messages WHERE message_id = ?',
      ).get(messageId) as {
        message_id: string;
        content_type: string;
        content: string | null;
        content_text: string | null;
        media_path: string | null;
        raw_message: string | null;
      } | undefined;

      if (!row) {
        return { error: 'not_found', message: `No message found with ID: ${messageId}` };
      }

      if (row.content_type !== 'audio') {
        return { error: 'not_audio', message: `Message is type "${row.content_type}", not audio.` };
      }

      // Check for cached transcription
      if (row.content_text && row.content_text.length > 0) {
        // Verify it's a real transcription, not a fallback
        if (!row.content_text.includes('transcription unavailable')) {
          return { transcription: row.content_text, cached: true };
        }
      }

      // Also check structured content for existing transcription
      if (row.content) {
        try {
          const parsed = JSON.parse(row.content);
          if (parsed.transcription && !parsed.transcription.includes('transcription unavailable')) {
            return { transcription: parsed.transcription, cached: true };
          }
        } catch { /* not JSON, continue */ }
      }

      // Need audio data — try media_path first, then download_media fallback
      let audioBuffer: Buffer | null = null;
      let audioMime = 'audio/ogg';

      if (row.media_path && existsSync(row.media_path)) {
        audioBuffer = readFileSync(row.media_path) as unknown as Buffer;
        // Infer MIME from extension
        const ext = row.media_path.split('.').pop()?.toLowerCase();
        if (ext === 'mp3') audioMime = 'audio/mpeg';
        else if (ext === 'm4a') audioMime = 'audio/mp4';
        else if (ext === 'wav') audioMime = 'audio/wav';
        else if (ext === 'webm') audioMime = 'audio/webm';
      } else if (row.raw_message) {
        // Attempt to download from raw_message
        let rawMsg: unknown;
        try {
          rawMsg = JSON.parse(row.raw_message);
        } catch {
          return { error: 'no_audio_data', message: 'Cannot parse raw message data for audio download.' };
        }

        const mime = extractRawMime(rawMsg, 'audio') ?? 'audio/ogg';
        const downloadFn = async (): Promise<Buffer> => {
          const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
          return downloadMediaMessage(rawMsg as any, 'buffer', {}) as Promise<Buffer>;
        };

        try {
          const result = await coreDownloadMedia(downloadFn, mime);
          if (result) {
            audioBuffer = result.buffer;
            audioMime = result.mimeType;

            // Save to disk and persist path
            const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
            const filePath = writeTempFile(result.buffer, ext);
            updateMediaPath(db, messageId, filePath);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/404|410|gone|expired/i.test(msg)) {
            return { error: 'media_expired', message: 'Audio media URL has expired.' };
          }
          return { error: 'download_failed', message: 'Failed to download audio for transcription.' };
        }
      }

      if (!audioBuffer) {
        return { error: 'no_audio_data', message: 'No audio data available. Media path missing and raw message unavailable.' };
      }

      // Transcribe via Whisper
      const { transcribeAudio } = await import('../../runtimes/chat/providers/whisper.ts');
      const transcription = await transcribeAudio(audioBuffer, audioMime);

      if (!transcription || transcription.includes('transcription unavailable')) {
        return { error: 'transcription_failed', message: 'Whisper transcription failed or is unavailable.' };
      }

      // Persist transcription
      updateTranscription(db, messageId, transcription);

      // Extract duration from structured content if available
      let duration: number | null = null;
      try {
        const parsed = JSON.parse(row.content || '{}');
        duration = parsed.duration ?? null;
      } catch { /* ignore */ }

      return {
        transcription,
        duration,
        cached: false,
      };
    },
  });
```

- [ ] Step 4: Run tests, verify they pass:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/media.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] Step 5: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/mcp/tools/media.ts tests/mcp/tools/media.test.ts && git commit -m "feat(media): add transcribe_audio MCP tool

Downloads audio (from cache or raw_message), transcribes via Whisper,
persists result to content + content_text, returns transcription.
Handles cached transcriptions, expired media, and non-audio types (SP2)."
```

---

## Task 8: Integration verification -- full flow

Verify everything works end to end with type checking and the full test suite.

- [ ] Step 1: Run the TypeScript compiler:

```bash
cd ~/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -30
# Expected: 0 errors
```

- [ ] Step 2: Run the full test suite:

```bash
cd ~/LAB/WhatSoup && npx vitest run 2>&1 | tail -30
# Expected: all tests pass
```

- [ ] Step 3: Run the specific SP2-related test files:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/database.test.ts tests/core/messages.test.ts tests/transport/parsing.test.ts tests/mcp/tools/media.test.ts 2>&1 | tail -30
# Expected: all PASS
```

- [ ] Step 4: Verify `content_text` flows through the system:

```bash
cd ~/LAB/WhatSoup && grep -n 'content_text\|contentText' src/core/messages.ts src/core/types.ts src/core/ingest.ts src/transport/connection.ts
# Expected: content_text in messages.ts (MessageRow, toInsertParams, SQL), contentText in types.ts (IncomingMessage), ingest.ts (storeMessageIfNew call), connection.ts (parseIncomingMessage)
```

- [ ] Step 5: Verify `transcribe_audio` tool is registered:

```bash
cd ~/LAB/WhatSoup && grep 'transcribe_audio' src/mcp/tools/media.ts
# Expected: name: 'transcribe_audio'
```

- [ ] Step 6: Verify FTS triggers index `content_text`:

```bash
cd ~/LAB/WhatSoup && grep -A 3 'messages_fts_insert' src/core/database.ts | head -10
# Expected: trigger references content_text, not content
```

- [ ] Step 7: If any failures, fix and commit. Otherwise, no action needed.

---

## Spec Coverage Checklist

| Spec Requirement | Task | Status |
|-----------------|------|--------|
| MIGRATION_13: `content_text TEXT` + FTS trigger rebuild | Task 1 | Covered |
| `IncomingMessage` -- add `contentText` | Task 2 | Covered |
| `StoreMessageInput` -- add `contentText` | Task 2 | Covered |
| `MessageRow` + `rowToMessage` -- add `content_text` / `contentText` | Task 2 | Covered |
| `StoredMessage` + `rowToStoredMessage` -- add `contentText` | Task 2 | Covered |
| `toInsertParams` + SQL INSERT -- include `content_text` | Task 2 | Covered |
| `updateTranscription()` helper | Task 3 | Covered |
| `parseIncomingMessage` rewrite -- location | Task 4 | Covered |
| `parseIncomingMessage` rewrite -- contact | Task 4 | Covered |
| `parseIncomingMessage` rewrite -- contactsArray | Task 4 | Covered |
| `parseIncomingMessage` rewrite -- poll | Task 4 | Covered |
| `parseIncomingMessage` rewrite -- audio | Task 4 | Covered |
| `parseIncomingMessage` rewrite -- video (caption + metadata) | Task 4 | Covered |
| `parseIncomingMessage` rewrite -- document (caption + metadata) | Task 4 | Covered |
| `parseIncomingMessage` rewrite -- sticker | Task 4 | Covered |
| `parseIncomingMessage` rewrite -- liveLocation | Task 4 | Covered |
| Ingest pipeline threads `contentText` | Task 5 | Covered |
| Agent runtime persists transcription after Whisper | Task 6 | Covered |
| `transcribe_audio` MCP tool -- download, transcribe, persist | Task 7 | Covered |
| `transcribe_audio` -- cached transcription return | Task 7 | Covered |
| `transcribe_audio` -- error handling (expired, not audio, not found) | Task 7 | Covered |
| `contentText` falls back to `content` for text messages | Task 2 | Covered (via `rowToMessage`) |
| FTS indexes `content_text` not `content` | Task 1 | Covered |
| Backward compatible -- old messages unchanged | Task 1 | Covered (column defaults NULL) |
