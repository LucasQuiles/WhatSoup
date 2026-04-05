# SP1: Media Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable MCP clients to download and access received WhatsApp media (images, audio, video, documents, stickers) via a new `download_media` tool, with automatic persistence at ingest time.

**Architecture:** Add `media_path` column to messages table. Persist media file paths at ingest time in both agent and chat runtimes. Add `download_media` MCP tool as fallback for messages not yet processed. Extend MediaDeps to include database access.

**Tech Stack:** TypeScript, Baileys 7.0.0-rc.9, vitest, SQLite

**Spec:** `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md` Section 3

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/core/database.ts` | Modify | MIGRATION_12: add `media_path TEXT` column + partial index |
| `src/core/messages.ts` | Modify | Add `media_path` to `MessageRow`, `rowToMessage`, `StoredMessage`, `rowToStoredMessage`; add `updateMediaPath()` helper |
| `src/mcp/tools/media.ts` | Modify | Add `db` to `MediaDeps`; add `download_media` tool |
| `src/mcp/register-all.ts` | Modify | Pass `db` to `registerMediaTools` |
| `src/runtimes/agent/runtime.ts` | Modify | Persist `media_path` after `writeTempFile()` |
| `src/runtimes/chat/media/processor.ts` | Modify | Save to disk and persist `media_path` after download |
| `tests/core/database.test.ts` | Modify | Test MIGRATION_12 schema |
| `tests/core/messages.test.ts` | Modify | Test `updateMediaPath()` and `media_path` in `rowToMessage` |
| `tests/mcp/tools/media.test.ts` | Modify | Test `download_media` tool (cached, fresh download, errors) |

---

## Task 1: MIGRATION_12 — `media_path` column + index

Add the database migration that creates the new column and partial index.

**Files:**
- Modify: `src/core/database.ts`
- Modify: `tests/core/database.test.ts`

- [ ] Step 1: Write the test in `tests/core/database.test.ts`. Add this test inside the existing `describe('Database schema', ...)` block, after the last `it(...)`:

```typescript
  it('messages table has media_path column (MIGRATION_12)', () => {
    const cols = db.raw.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
      type: string;
    }>;
    const col = cols.find((c) => c.name === 'media_path');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
  });

  it('idx_messages_media_path partial index exists', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_media_path'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/database.test.ts 2>&1 | tail -20
# Expected: 2 FAILED tests (media_path column, partial index)
```

- [ ] Step 3: Add MIGRATION_12 to `src/core/database.ts`. Insert this entry at the end of the `MIGRATIONS` Map (after the `[11, ...]` entry, before the closing `]);`):

```typescript
  [12, (db: DatabaseSync) => {
    const cols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'media_path')) {
      db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT');
      db.exec('CREATE INDEX idx_messages_media_path ON messages(media_path) WHERE media_path IS NOT NULL');
    }
  }],
```

- [ ] Step 4: Run tests, verify they pass:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/database.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] Step 5: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/core/database.ts tests/core/database.test.ts && git commit -m "feat(db): add MIGRATION_12 — media_path column with partial index

Adds media_path TEXT column to messages table and a partial index
on non-NULL values for efficient has_media filtering (SP1)."
```

---

## Task 2: `MessageRow` + `rowToMessage` + `StoredMessage` — add `media_path` field

Update the TypeScript interfaces and mapper functions to include the new column.

**Files:**
- Modify: `src/core/messages.ts`
- Modify: `tests/core/messages.test.ts`

- [ ] Step 1: Write the test in `tests/core/messages.test.ts`. Add inside the existing `describe('messages', ...)` block:

```typescript
  it('rowToMessage exposes media_path as mediaPath', () => {
    const msg = makeMsg({ content: 'photo caption' });
    storeMessage(db, msg);

    // Manually set media_path
    db.raw.prepare('UPDATE messages SET media_path = ? WHERE message_id = ?')
      .run('/tmp/whatsoup-media/abc123.jpg', msg.messageId);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as import('../../src/core/messages.ts').MessageRow[];

    const { rowToMessage } = require('../../src/core/messages.ts');
    const mapped = rowToMessage(rows[0]);
    expect(mapped.mediaPath).toBe('/tmp/whatsoup-media/abc123.jpg');
  });

  it('rowToMessage returns null mediaPath when column is NULL', () => {
    const msg = makeMsg({ content: 'text only' });
    storeMessage(db, msg);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as import('../../src/core/messages.ts').MessageRow[];

    const { rowToMessage } = require('../../src/core/messages.ts');
    const mapped = rowToMessage(rows[0]);
    expect(mapped.mediaPath).toBeNull();
  });
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts 2>&1 | tail -20
# Expected: 2 FAILED (mediaPath property missing)
```

- [ ] Step 3: Update `src/core/messages.ts`. Three changes:

**Change A** — Add `media_path` to the `MessageRow` interface (after the `created_at` field on line 21):

```typescript
export interface MessageRow {
  pk: number;
  message_id: string;
  conversation_key: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  content: string | null;
  content_type: ContentType;
  is_from_me: number;
  timestamp: number;
  quoted_message_id: string | null;
  created_at: string;
  media_path: string | null;
}
```

**Change B** — Add `mediaPath` to the `rowToMessage` return (after `createdAt: row.created_at,`):

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
    contentType: row.content_type,
    isFromMe: Boolean(row.is_from_me),
    timestamp: row.timestamp,
    quotedMessageId: row.quoted_message_id ?? null,
    createdAt: row.created_at,
    mediaPath: row.media_path ?? null,
  };
}
```

**Change C** — Add `media_path` to the `StoredMessage` interface (after `createdAt: string;`):

```typescript
  mediaPath: string | null;
```

And update `rowToStoredMessage` (after `createdAt: row.created_at as string,`):

```typescript
    mediaPath: (row.media_path as string | null) ?? null,
```

- [ ] Step 4: Run tests, verify they pass:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] Step 5: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/core/messages.ts tests/core/messages.test.ts && git commit -m "feat(messages): add media_path to MessageRow, rowToMessage, StoredMessage

Surfaces the new media_path column through TypeScript interfaces
and mapper functions so list_messages returns mediaPath (SP1)."
```

---

## Task 3: `updateMediaPath()` helper function

Add a helper function that persists a file path to the `media_path` column for a given message ID.

**Files:**
- Modify: `src/core/messages.ts`
- Modify: `tests/core/messages.test.ts`

- [ ] Step 1: Write the test in `tests/core/messages.test.ts`. Add inside the existing `describe('messages', ...)` block. First, add `updateMediaPath` to the import at the top of the file:

Update the import line to include `updateMediaPath`:
```typescript
import {
  storeMessage,
  getRecentMessages,
  getUnprocessedMessages,
  markMessagesProcessed,
  getMessageCount,
  deleteOldMessages,
  markMessagesWithError,
  getMessagesBySender,
  updateMediaPath,
  type StoreMessageInput,
} from '../../src/core/messages.ts';
```

Then add these tests:

```typescript
  it('updateMediaPath sets the media_path column', () => {
    const msg = makeMsg({ content: 'image caption' });
    storeMessage(db, msg);

    updateMediaPath(db, msg.messageId, '/tmp/whatsoup-media/a1b2c3d4.jpg');

    const row = db.raw
      .prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { media_path: string | null };
    expect(row.media_path).toBe('/tmp/whatsoup-media/a1b2c3d4.jpg');
  });

  it('updateMediaPath overwrites an existing media_path', () => {
    const msg = makeMsg({ content: 'image caption' });
    storeMessage(db, msg);

    updateMediaPath(db, msg.messageId, '/tmp/whatsoup-media/old.jpg');
    updateMediaPath(db, msg.messageId, '/tmp/whatsoup-media/new.jpg');

    const row = db.raw
      .prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { media_path: string | null };
    expect(row.media_path).toBe('/tmp/whatsoup-media/new.jpg');
  });

  it('updateMediaPath is a no-op for unknown message_id', () => {
    // Should not throw
    expect(() => updateMediaPath(db, 'nonexistent-id', '/tmp/x.jpg')).not.toThrow();
  });
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts 2>&1 | tail -20
# Expected: FAILED — updateMediaPath is not exported
```

- [ ] Step 3: Add `updateMediaPath()` to `src/core/messages.ts`. Add this function after the `storeMessageIfNew` function (at the end of the file):

```typescript
/**
 * Persist the local file path for a downloaded media message.
 * Called by agent/chat runtimes after writing media to disk.
 */
export function updateMediaPath(db: Database, messageId: string, filePath: string): void {
  db.raw.prepare('UPDATE messages SET media_path = ? WHERE message_id = ?')
    .run(filePath, messageId);
}
```

- [ ] Step 4: Run tests, verify they pass:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/messages.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] Step 5: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/core/messages.ts tests/core/messages.test.ts && git commit -m "feat(messages): add updateMediaPath() helper for media path persistence

Provides a simple UPDATE wrapper used by agent and chat runtimes
to persist downloaded media file paths to the messages table (SP1)."
```

---

## Task 4: Update `MediaDeps` and `register-all.ts` — pass `db` to media tools

Extend the MediaDeps interface and wire up database access in the registration.

**Files:**
- Modify: `src/mcp/tools/media.ts`
- Modify: `src/mcp/register-all.ts`
- Modify: `tests/mcp/tools/media.test.ts`

- [ ] Step 1: Update the `MediaDeps` interface in `src/mcp/tools/media.ts`. Add the `DatabaseSync` import and `db` field:

Add this import at the top (after the existing imports):
```typescript
import type { DatabaseSync } from 'node:sqlite';
```

Change the `MediaDeps` interface from:
```typescript
export interface MediaDeps {
  connection: ConnectionManager;
}
```
to:
```typescript
export interface MediaDeps {
  connection: ConnectionManager;
  db: DatabaseSync;
}
```

- [ ] Step 2: Update `src/mcp/register-all.ts` line 52. Change:

```typescript
  try { registerMediaTools(registry, { connection }); } catch (err) { log.error({ err }, 'registerMediaTools failed'); }
```

to:

```typescript
  try { registerMediaTools(registry, { connection, db: db.raw }); } catch (err) { log.error({ err }, 'registerMediaTools failed'); }
```

- [ ] Step 3: Update `tests/mcp/tools/media.test.ts`. The existing tests must pass `db` in `MediaDeps`. Add a database setup and update the deps:

Add these imports at the top of the file (after existing imports):
```typescript
import { Database } from '../../../src/core/database.ts';
```

Add a database setup after the existing helpers (before the `describe` block):
```typescript
const testDb = new Database(':memory:');
testDb.open();
```

In `beforeEach`, change:
```typescript
    deps = { connection };
```
to:
```typescript
    deps = { connection, db: testDb.raw };
```

Add cleanup in an `afterAll` at the top level of the describe block:
```typescript
  afterAll(() => {
    testDb.close();
  });
```

Also add the `afterAll` import — change:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```
to:
```typescript
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
```

- [ ] Step 4: Run all affected tests:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/media.test.ts 2>&1 | tail -20
# Expected: all existing tests PASS (send_media still works with new deps)
```

- [ ] Step 5: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/mcp/tools/media.ts src/mcp/register-all.ts tests/mcp/tools/media.test.ts && git commit -m "feat(media): extend MediaDeps with db, wire in register-all

Adds DatabaseSync to MediaDeps interface so the download_media tool
can query and update the messages table. Updates register-all.ts
to pass db.raw. Updates test deps accordingly (SP1)."
```

---

## Task 5: `download_media` MCP tool — cached path return

Implement the first code path: return cached `media_path` if the file already exists on disk.

**Files:**
- Modify: `src/mcp/tools/media.ts`
- Modify: `tests/mcp/tools/media.test.ts`

- [ ] Step 1: Write the test in `tests/mcp/tools/media.test.ts`. Add a new `describe` block after the existing `describe('registerMediaTools', ...)` block:

```typescript
describe('download_media', () => {
  let registry: ToolRegistry;
  let mediaCalls: Array<{ chatJid: string; media: unknown }>;
  let connection: ReturnType<typeof makeConnection>;
  let db: Database;
  let deps: MediaDeps;
  let workspace: string;
  let filesToClean: string[] = [];
  let dirsToClean: string[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaCalls = makeCalls();
    connection = makeConnection(mediaCalls);
    deps = { connection, db: db.raw };
    registerMediaTools(registry, deps);
    workspace = tempDir();
    dirsToClean.push(workspace);
    filesToClean = [];
  });

  afterEach(() => {
    db.close();
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    for (const d of [...dirsToClean].reverse()) {
      try { rmdirSync(d, { recursive: true } as any); } catch { /* ignore */ }
    }
    dirsToClean = [];
  });

  function insertMessage(
    messageId: string,
    contentType: string,
    opts: { mediaPath?: string; rawMessage?: string } = {},
  ): void {
    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp, media_path, raw_message)
      VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', ?, ?, 0, 1700000000, ?, ?)
    `).run(messageId, contentType, opts.mediaPath ?? null, opts.rawMessage ?? null);
  }

  it('returns cached file when media_path is set and file exists', async () => {
    const filePath = join(workspace, 'cached.jpg');
    writeFileSync(filePath, 'fake-image-data');
    filesToClean.push(filePath);

    insertMessage('msg-cached', 'image', { mediaPath: filePath });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-cached' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.file_path).toBe(filePath);
    expect(body.cached).toBe(true);
    expect(body.content_type).toBe('image');
  });

  it('returns unsupported_type error for text messages', async () => {
    insertMessage('msg-text', 'text');

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-text' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('unsupported_type');
  });

  it('returns error for unknown message_id', async () => {
    const result = await registry.call(
      'download_media',
      { message_id: 'nonexistent' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('not_found');
  });

  it('falls through to download when media_path file is missing from disk', async () => {
    // media_path is set but file was deleted
    insertMessage('msg-stale', 'image', {
      mediaPath: '/tmp/whatsoup-media/deleted.jpg',
      rawMessage: null,
    });

    const result = await registry.call(
      'download_media',
      { message_id: 'msg-stale' },
      { tier: 'global' } as SessionContext,
    );

    // Without raw_message, download will fail with unsupported_type
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('no_raw_message');
  });
});
```

- [ ] Step 2: Run tests, verify they fail:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/media.test.ts 2>&1 | tail -20
# Expected: FAILED — download_media tool not registered
```

- [ ] Step 3: Implement the `download_media` tool in `src/mcp/tools/media.ts`. Add these imports at the top (after existing imports):

```typescript
import { existsSync, statSync as fstatSync } from 'node:fs';
import type { MessageRow } from '../../core/messages.ts';
```

Add the tool registration inside `registerMediaTools`, after the `send_media` registration (before the closing `}` of the function):

```typescript
  // ── download_media ──────────────────────────────────────────────────────────

  const MEDIA_CONTENT_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker']);

  registry.register({
    name: 'download_media',
    description:
      'Download media from a received WhatsApp message. Returns the local file path. Uses cached path if media was already downloaded.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    schema: z.object({
      message_id: z.string().describe('The message ID to download media from'),
    }),
    handler: async (params) => {
      const messageId = params['message_id'] as string;

      // Look up the message
      const row = db.prepare(
        'SELECT message_id, content_type, media_path, raw_message FROM messages WHERE message_id = ?',
      ).get(messageId) as Pick<MessageRow, 'message_id' | 'content_type' | 'media_path'> & { raw_message: string | null } | undefined;

      if (!row) {
        return { error: 'not_found', message: `No message found with ID: ${messageId}` };
      }

      // Reject non-media types
      if (!MEDIA_CONTENT_TYPES.has(row.content_type)) {
        return { error: 'unsupported_type', message: 'Message does not contain downloadable media.' };
      }

      // Return cached path if file still exists on disk
      if (row.media_path && existsSync(row.media_path)) {
        let fileSize = 0;
        try { fileSize = fstatSync(row.media_path).size; } catch { /* ignore */ }
        return {
          file_path: row.media_path,
          content_type: row.content_type,
          file_size: fileSize,
          cached: true,
        };
      }

      // Need raw_message to attempt download
      if (!row.raw_message) {
        return { error: 'no_raw_message', message: 'Message has no raw data for media download. Media may not have been stored.' };
      }

      // On-demand download will be implemented in Task 6
      return { error: 'not_implemented', message: 'On-demand download not yet available.' };
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
cd ~/LAB/WhatSoup && git add src/mcp/tools/media.ts tests/mcp/tools/media.test.ts && git commit -m "feat(media): add download_media tool — cached path return

Registers download_media MCP tool that returns cached media_path
when the file exists on disk. Handles not_found, unsupported_type,
and no_raw_message error cases. On-demand download next (SP1)."
```

---

## Task 6: `download_media` — on-demand download path

Implement the fallback path that downloads from `raw_message` when no cached file exists.

**Files:**
- Modify: `src/mcp/tools/media.ts`
- Modify: `tests/mcp/tools/media.test.ts`

- [ ] Step 1: Write the test. Add these tests inside the existing `describe('download_media', ...)` block:

```typescript
  it('downloads media from raw_message when no cached file exists', async () => {
    // Create a fake raw_message with imageMessage structure
    const rawMessage = JSON.stringify({
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/fake',
          mimetype: 'image/jpeg',
          mediaKey: Buffer.from('fake-key').toString('base64'),
          fileEncSha256: Buffer.from('fake-hash').toString('base64'),
          fileSha256: Buffer.from('fake-sha').toString('base64'),
          fileLength: 1024,
          directPath: '/fake/path',
        },
      },
    });

    insertMessage('msg-download', 'image', { rawMessage });

    // Mock the downloadMediaMessage function
    const { vi } = await import('vitest');

    // We can't easily mock Baileys in this integration test, so we verify
    // the error path when Baileys download fails (media expired)
    const result = await registry.call(
      'download_media',
      { message_id: 'msg-download' },
      { tier: 'global' } as SessionContext,
    );

    const body = JSON.parse(result.content[0].text);
    // Download will fail because the URL is fake — should get media_expired or download_failed
    expect(['media_expired', 'download_failed', 'download_timeout']).toContain(body.error);
  });
```

- [ ] Step 2: Implement the on-demand download path in `src/mcp/tools/media.ts`. Add these imports at the top:

```typescript
import { downloadMedia as coreDownloadMedia, writeTempFile } from '../../core/media-download.ts';
import { extractRawMime } from '../../core/media-mime.ts';
import { updateMediaPath } from '../../core/messages.ts';
import { createChildLogger } from '../../logger.ts';
```

Add a logger after the imports:
```typescript
const log = createChildLogger('mcp:media');
```

Replace the placeholder at the end of the `download_media` handler (the `return { error: 'not_implemented', ... }` block and everything after the `// Need raw_message` check) with the full download implementation:

```typescript
      // Need raw_message to attempt download
      if (!row.raw_message) {
        return { error: 'no_raw_message', message: 'Message has no raw data for media download. Media may not have been stored.' };
      }

      // Parse raw_message and attempt download
      let rawMsg: unknown;
      try {
        rawMsg = JSON.parse(row.raw_message);
      } catch {
        return { error: 'no_raw_message', message: 'Cannot parse raw message data.' };
      }

      // Determine MIME type and file extension
      const mimeMap: Record<string, { defaultMime: string; ext: string }> = {
        image:    { defaultMime: 'image/jpeg', ext: 'jpg' },
        sticker:  { defaultMime: 'image/webp', ext: 'webp' },
        audio:    { defaultMime: 'audio/ogg',  ext: 'ogg' },
        video:    { defaultMime: 'video/mp4',  ext: 'mp4' },
        document: { defaultMime: 'application/octet-stream', ext: 'bin' },
      };

      const typeInfo = mimeMap[row.content_type];
      if (!typeInfo) {
        return { error: 'unsupported_type', message: 'Message does not contain downloadable media.' };
      }

      const mime = extractRawMime(rawMsg, row.content_type) ?? typeInfo.defaultMime;

      // Build download function using Baileys
      const downloadFn = async (): Promise<Buffer> => {
        const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
        return downloadMediaMessage(rawMsg as any, 'buffer', {}) as Promise<Buffer>;
      };

      // Attempt download with timeout and size checks
      let result: Awaited<ReturnType<typeof coreDownloadMedia>>;
      try {
        result = await coreDownloadMedia(downloadFn, mime);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/timed? ?out/i.test(msg)) {
          return { error: 'download_timeout', message: 'Media download timed out after 30s.' };
        }
        if (/404|410|gone|expired/i.test(msg)) {
          return { error: 'media_expired', message: 'WhatsApp media URL has expired. Media is only available for download within hours of receipt.' };
        }
        log.error({ err, messageId }, 'download_media failed');
        return { error: 'download_failed', message: 'Media download failed.' };
      }

      if (!result) {
        // coreDownloadMedia returns null on timeout, oversize, or error
        return { error: 'download_failed', message: 'Media download failed. The URL may have expired or the file exceeds the 25MB limit.' };
      }

      // Determine file extension — for documents, try original filename
      let ext = typeInfo.ext;
      if (row.content_type === 'document') {
        // raw message may contain fileName
        const docMsg = (rawMsg as any)?.message?.documentMessage
          ?? (rawMsg as any)?.message?.documentWithCaptionMessage?.message?.documentMessage;
        const fileName = docMsg?.fileName as string | undefined;
        if (fileName) {
          const dotIdx = fileName.lastIndexOf('.');
          if (dotIdx > 0) ext = fileName.substring(dotIdx + 1).toLowerCase();
        }
      }

      // Save to disk
      const filePath = writeTempFile(result.buffer, ext);

      // Persist path to database
      const dbWrapper = { raw: db } as import('../../core/database.ts').Database;
      updateMediaPath(dbWrapper, messageId, filePath);

      return {
        file_path: filePath,
        mime_type: result.mimeType,
        file_size: result.buffer.length,
        content_type: row.content_type,
        cached: false,
      };
```

- [ ] Step 3: Run tests:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/media.test.ts 2>&1 | tail -20
# Expected: all PASS (the new test verifies error handling on fake URL)
```

- [ ] Step 4: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/mcp/tools/media.ts tests/mcp/tools/media.test.ts && git commit -m "feat(media): download_media on-demand download from raw_message

Implements the fallback download path that parses raw_message,
downloads via Baileys downloadMediaMessage, saves to disk via
writeTempFile, and persists the path. Returns structured errors
for expired URLs, timeouts, and oversize files (SP1)."
```

---

## Task 7: Agent runtime — persist `media_path` after `writeTempFile`

After the agent runtime downloads media and writes it to a temp file, persist the path to the database.

**Files:**
- Modify: `src/runtimes/agent/runtime.ts`

- [ ] Step 1: Add the import for `updateMediaPath` at the top of `src/runtimes/agent/runtime.ts`. Add after the existing imports:

```typescript
import { updateMediaPath } from '../../core/messages.ts';
```

- [ ] Step 2: In `prepareContentForAgent`, the function needs access to `db` and `messageId`. This function is a standalone export (line 79). It does not currently receive the database or message ID. We need to add these parameters.

Change the function signature from:
```typescript
export async function prepareContentForAgent(msg: IncomingMessage): Promise<string> {
```
to:
```typescript
export async function prepareContentForAgent(msg: IncomingMessage, db?: Database, messageId?: string): Promise<string> {
```

Add the `Database` type import at the top if not already present:
```typescript
import type { Database } from '../../core/database.ts';
```

- [ ] Step 3: After the `writeTempFile` call on line 136 (`const filePath = writeTempFile(result.buffer, ext);`), add the persistence call:

```typescript
  // Save to disk — do NOT clean up immediately; agent needs time to read the file
  const filePath = writeTempFile(result.buffer, ext);

  // Persist media path to database for MCP access
  if (db && messageId) {
    try {
      updateMediaPath(db, messageId, filePath);
    } catch (err) {
      // Non-fatal: log and continue — the agent still gets the file path
      const { createChildLogger } = await import('../../logger.ts');
      createChildLogger('agent:media').warn({ err, messageId }, 'Failed to persist media_path');
    }
  }
```

- [ ] Step 4: Find the call site of `prepareContentForAgent` and pass `db` and `messageId`. Search for the caller:

```bash
cd ~/LAB/WhatSoup && grep -rn 'prepareContentForAgent' src/ --include='*.ts'
```

Update each call site to pass `db` and `msg.messageId`. The caller is in the agent runtime's message handler — it has access to both `this.db` and `msg.messageId`. Update the call from:
```typescript
prepareContentForAgent(msg)
```
to:
```typescript
prepareContentForAgent(msg, this.db, msg.messageId)
```

(If the call site uses a different variable name for the database, match accordingly.)

- [ ] Step 5: Run type check:

```bash
cd ~/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -20
# Expected: clean (0 errors)
```

- [ ] Step 6: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/runtimes/agent/runtime.ts && git commit -m "feat(agent): persist media_path after writeTempFile in prepareContentForAgent

After downloading media and writing to a temp file, the agent
runtime now calls updateMediaPath() to persist the path to the
messages table. This is the primary ingest-time persistence (SP1)."
```

---

## Task 8: Chat runtime — save to disk and persist `media_path`

The chat runtime (`processMedia`) downloads media as in-memory buffers but never saves to disk. Add disk persistence.

**Files:**
- Modify: `src/runtimes/chat/media/processor.ts`

- [ ] Step 1: Add imports at the top of `src/runtimes/chat/media/processor.ts`:

```typescript
import { writeTempFile } from '../../../core/media-download.ts';
import { updateMediaPath } from '../../../core/messages.ts';
import type { Database } from '../../../core/database.ts';
```

Note: `downloadMedia` is already imported. `writeTempFile` must be added.

- [ ] Step 2: Update the `processMedia` function signature to accept `db` and `messageId`:

Change from:
```typescript
export async function processMedia(
  msg: IncomingMessage,
  downloadFn: (() => Promise<Buffer>) | null,
): Promise<ProcessedMedia> {
```
to:
```typescript
export async function processMedia(
  msg: IncomingMessage,
  downloadFn: (() => Promise<Buffer>) | null,
  db?: Database,
  messageId?: string,
): Promise<ProcessedMedia> {
```

- [ ] Step 3: Add a helper function inside the file (before `processMedia`) that saves to disk and persists:

```typescript
function persistMediaPath(
  buffer: Buffer,
  ext: string,
  db: Database | undefined,
  messageId: string | undefined,
): string | null {
  if (!db || !messageId) return null;
  try {
    const filePath = writeTempFile(buffer, ext);
    updateMediaPath(db, messageId, filePath);
    return filePath;
  } catch (err) {
    log.warn({ err, messageId }, 'Failed to persist media to disk');
    return null;
  }
}
```

- [ ] Step 4: Add `persistMediaPath` calls after each successful `downloadMedia` call. There are 5 media type blocks (image/sticker, audio, video, document). For each, call `persistMediaPath` after the download succeeds.

**Image/sticker block** (after `const result = await downloadMedia(downloadFn, mimeType);` succeeds, before the return):
```typescript
    const ext = contentType === 'sticker' ? 'webp' : 'jpg';
    persistMediaPath(result.buffer, ext, db, messageId);

    return {
      content: content ?? '',
      images: [{ mimeType: result.mimeType, base64: result.buffer.toString('base64') }],
    };
```

**Audio block** (after `const result = await downloadMedia(downloadFn, audioMime);` succeeds):
```typescript
    persistMediaPath(result.buffer, 'ogg', db, messageId);
```

**Video block** (after `const result = await downloadMedia(downloadFn, videoMime);` succeeds):
```typescript
    persistMediaPath(result.buffer, 'mp4', db, messageId);
```

**Document block** (after `const result = await downloadMedia(downloadFn, docMime);` succeeds):
```typescript
    // Determine extension from filename
    let docExt = 'bin';
    const docFileName = content ?? 'document';
    const dotIdx = docFileName.lastIndexOf('.');
    if (dotIdx > 0) docExt = docFileName.substring(dotIdx + 1).toLowerCase();
    persistMediaPath(result.buffer, docExt, db, messageId);
```

- [ ] Step 5: Find and update the call site(s) of `processMedia` to pass `db` and `messageId`:

```bash
cd ~/LAB/WhatSoup && grep -rn 'processMedia(' src/ --include='*.ts' | grep -v 'processor.ts'
```

Update each call to pass the database and message ID. The new parameters are optional, so existing callers continue to work without changes, but the chat runtime handler should pass them for full persistence.

- [ ] Step 6: Run type check:

```bash
cd ~/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -20
# Expected: clean (0 errors)
```

- [ ] Step 7: Commit:

```bash
cd ~/LAB/WhatSoup && git add src/runtimes/chat/media/processor.ts && git commit -m "feat(chat): persist media to disk and save media_path in processMedia

The chat runtime now writes downloaded media to disk via writeTempFile
and persists the path via updateMediaPath, matching the agent runtime
behavior. Both runtimes now contribute to ingest-time persistence (SP1)."
```

---

## Task 9: Integration verification — full flow

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

- [ ] Step 3: Run the specific SP1-related test files:

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/core/database.test.ts tests/core/messages.test.ts tests/mcp/tools/media.test.ts 2>&1 | tail -30
# Expected: all PASS
```

- [ ] Step 4: Verify `list_messages` now returns `mediaPath` by checking `rowToMessage`:

```bash
cd ~/LAB/WhatSoup && grep -A 2 'mediaPath' src/core/messages.ts
# Expected: mediaPath: row.media_path ?? null
```

- [ ] Step 5: Verify `download_media` tool is registered:

```bash
cd ~/LAB/WhatSoup && grep 'download_media' src/mcp/tools/media.ts
# Expected: name: 'download_media'
```

- [ ] Step 6: If any failures, fix and commit. Otherwise, no action needed.

---

## Spec Coverage Checklist

| Spec Requirement | Task | Status |
|-----------------|------|--------|
| MIGRATION_12: `media_path TEXT` + index | Task 1 | Covered |
| `MessageRow` + `rowToMessage` update | Task 2 | Covered |
| `StoredMessage` + `rowToStoredMessage` update | Task 2 | Covered |
| `updateMediaPath()` helper | Task 3 | Covered |
| `MediaDeps` — add `db` | Task 4 | Covered |
| `register-all.ts` — pass `db` | Task 4 | Covered |
| `download_media` — cached path return | Task 5 | Covered |
| `download_media` — on-demand download | Task 6 | Covered |
| `download_media` — structured errors (expired, timeout, too large, unsupported) | Task 6 | Covered |
| Agent runtime — persist after `writeTempFile` | Task 7 | Covered |
| Chat runtime — save to disk + persist | Task 8 | Covered |
| `list_messages` returns `mediaPath` | Task 2 | Covered (via `rowToMessage`) |
| Enriched response format per spec Section 3.4 | Task 2 | Covered |
