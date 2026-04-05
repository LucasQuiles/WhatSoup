# WhatSoup MCP Feature Gaps — Design Specification

**Date:** 2026-04-04
**Status:** Approved (revised per council review 2026-04-05)
**Author:** Lucas + Q (brainstorming session)
**Reviewed by:** Code reviewer council — 3 critical, 5 important, 3 architectural findings addressed

---

## 1. Problem Statement

WhatSoup exposes 127 MCP tools but a live agent-usage audit revealed critical gaps: an agent cannot retrieve received media, 7 of 10 message content types return null or partial data, audio transcriptions are ephemeral, search only covers text, and there is no voice synthesis pipeline. These gaps were confirmed when an agent (Q) could not view screenshots sent by the user in a WhatsApp group despite the images being stored in the database's `raw_message` column.

## 2. Scope — Four Sub-Projects

This spec covers four independent sub-projects, each buildable and deployable on its own. They share no code dependencies on each other (except SP2 enriches data that SP1 surfaces). Each gets its own implementation plan.

| # | Sub-Project | Priority | Summary |
|---|-------------|----------|---------|
| SP1 | Media Access | CRITICAL | Download-at-ingest with `download_media` fallback, media path persistence, enriched message responses |
| SP2 | Content Completeness | IMPORTANT | Fix parseIncomingMessage for all content types, persist transcriptions, on-demand transcribe tool |
| SP3 | Search Enhancement | IMPORTANT | Metadata search (sender, date, content type), dual-path FTS query |
| SP4 | Two-Way Voice | FEATURE | ElevenLabs TTS pipeline, voice conversation loop |

---

## 3. Sub-Project 1: Media Access

### 3.1 Problem

No MCP tool exists to retrieve received media. When `list_messages` returns an image message, the response has `content: null` (or just a caption). The raw WAMessage in `raw_message` contains the encrypted media URL and decryption keys, but no tool exposes a download path.

### 3.2 Current Flow

1. Inbound message → `parseIncomingMessage()` (`connection.ts:986`) extracts caption as `content`, stores `raw_message` as JSON
2. Agent runtime (`runtime.ts:79`) downloads media at ingest via Baileys `downloadMediaMessage()`, saves to temp file via `writeTempFile()` (`media-download.ts:46`), returns `[Image: /path]` — but this path is never persisted to the DB
3. MCP `list_messages` → `rowToMessage()` (`messages.ts:24`) returns `content` from DB — which is null for audio/stickers, caption-only for images/videos

**Key insight (from council review):** The agent runtime already solves the download problem at ingest time. The gap is that the file path is not persisted and not exposed via MCP tools.

### 3.3 Design

**Architecture: Download-at-ingest + fallback on-demand**

WhatsApp CDN media URLs expire within hours. On-demand download for older messages will fail with HTTP 410/404. Therefore:

1. **Primary path (ingest-time):** When the agent runtime downloads media in `prepareContentForAgent()` (`runtime.ts:79-158`), persist the file path to the new `media_path` column on the messages table. This is the reliable path — media is downloaded while the URL is fresh.

2. **Secondary path (on-demand fallback):** The `download_media` MCP tool attempts download from `raw_message` for messages not yet processed by the agent runtime. This works for recent messages (within CDN expiry window) but may fail for older ones. The tool reports the failure clearly — not silently.

3. **Chat runtime integration:** The chat runtime (`processMedia()` in `chat/media/processor.ts`) also downloads media but as in-memory base64. Extend this to also save to disk and persist the path.

**New MCP tool: `download_media`**

```
Tool: download_media
Scope: global
Parameters:
  message_id: string (required) — the message ID to download media from
  save_dir: string (optional) — directory to save to, defaults to /tmp/whatsoup-media/
Returns:
  file_path: string — absolute path to the downloaded file
  mime_type: string — MIME type of the media
  file_size: number — bytes
  content_type: string — image/video/audio/document/sticker
  cached: boolean — true if returned from disk cache, false if freshly downloaded
```

**Implementation:**
1. Look up `media_path` from messages table by `message_id`
2. If `media_path` is set and file exists on disk → return cached path (skip download)
3. Otherwise: look up `raw_message`, parse WAMessage JSON, extract the media message
4. Call Baileys `downloadMediaMessage()` to decrypt and download
5. Save to `{save_dir}/{random_hex}.{ext}` (matches existing `writeTempFile` pattern — NOT `{message_id}.{ext}` to avoid predictable filenames and directory traversal risk)
6. Persist the file path to `media_path` column
7. If download fails (URL expired): return error with `{ error: "media_expired", message: "WhatsApp media URL has expired. Media is only available for download within hours of receipt." }`

**New column: `media_path`**

```sql
ALTER TABLE messages ADD COLUMN media_path TEXT;
CREATE INDEX idx_messages_media_path ON messages(media_path) WHERE media_path IS NOT NULL;
```

Index added for `has_media` filter performance (SP3).

**Files to modify:**
- `src/mcp/tools/media.ts` — add `download_media` tool alongside `send_media`. Extend `MediaDeps` interface to include `db: Database` (currently only has `connection: ConnectionManager`)
- `src/core/database.ts` — add migration for `media_path` column + index
- `src/core/messages.ts` — add `media_path` to `MessageRow` interface (line 9-22), add `mediaPath` to `rowToMessage()` output (line 24-39), add `updateMediaPath(db, messageId, path)` helper
- `src/mcp/register-all.ts:52` — change `registerMediaTools(registry, { connection })` to `registerMediaTools(registry, { connection, db })`
- `src/runtimes/agent/runtime.ts:123-136` — after `writeTempFile()`, call `updateMediaPath()` to persist the file path to DB
- `src/runtimes/chat/media/processor.ts` — after download, also save to disk and call `updateMediaPath()`

### 3.4 Enriched Message Response

After SP1, `list_messages` returns:

```json
{
  "messageId": "ABC123",
  "content": "Check this out",
  "contentType": "image",
  "mediaPath": "/tmp/whatsoup-media/a7f3c8b2.jpg",
  "isFromMe": false
}
```

If media hasn't been downloaded yet, `mediaPath` is null. The agent calls `download_media` to attempt download (may fail for old messages).

### 3.5 Security

- File paths use random hex names (existing `writeTempFile` pattern) — no predictable names, no directory traversal
- `save_dir` parameter is validated against a whitelist of allowed directories (default: `/tmp/whatsoup-media/`)
- Raw WhatsApp CDN URLs are never exposed in tool responses — only local file paths
- ElevenLabs API key (SP4) retrieved from GNOME Keyring, never stored in config files

---

## 4. Sub-Project 2: Content Completeness

### 4.1 Problem

`parseIncomingMessage()` at `connection.ts:986` discards structured data for 7 of 10 content types:

| Type | Currently Stored | Lost Data |
|------|-----------------|-----------|
| image | caption or null | — (binary handled by SP1) |
| video | caption or null | duration, dimensions |
| audio | null | duration, waveform, voice note flag |
| document | caption or filename | page count, MIME type |
| sticker | null | emoji association, pack name |
| location | address or null | latitude, longitude, name, URL |
| contact | displayName or null | vCard data, phone numbers |
| poll | poll name or null | options, selectable count, votes |

**Additional types not in original audit (from council review):**
- `extendedTextMessage` — link previews: currently extracts `.text` only, discards preview URL/title. Explicitly left as plain text (the text itself is the primary content; preview metadata is supplementary).
- `liveLocationMessage` — ongoing location shares: treated as regular location with structured content.
- `contactsArrayMessage` — multiple contacts: stored as array of contact objects.
- `reactionMessage`, `protocolMessage` — filtered out at `connection.ts:1073-1082`, never stored as messages. This is correct behavior — reactions go to the `reactions` table, protocol messages are handled as events.

### 4.2 Design

**Two-field approach: `content` (structured JSON) + `content_text` (human-readable summary for FTS)**

Store structured JSON in `content` for programmatic access. Add a new `content_text` column for the human-readable summary, indexed by FTS. This solves the council's finding that raw JSON in FTS would index key names like "latitude" and "type" as search tokens.

**New column: `content_text`**

```sql
ALTER TABLE messages ADD COLUMN content_text TEXT;
```

**FTS trigger update:** The existing `messages_fts_update` trigger (MIGRATION_1 at `database.ts:42-47`) already fires on content updates and correctly handles FTS5 delete+insert. Modify the INSERT trigger (`database.ts:38-40`) and the UPDATE trigger to index `content_text` instead of `content`:

```sql
-- Replace existing insert trigger:
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
WHEN NEW.content_text IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (NEW.pk, NEW.content_text);
END;

-- Replace existing update trigger:
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content_text ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', OLD.pk, COALESCE(OLD.content_text, ''));
  INSERT INTO messages_fts(rowid, content)
    SELECT NEW.pk, NEW.content_text WHERE NEW.content_text IS NOT NULL AND NEW.deleted_at IS NULL;
END;
```

Note: the existing `messages_fts_update` trigger already exists and uses the correct FTS5 `('delete', ...)` idiom. We must DROP and re-CREATE it in a new migration — not duplicate it. The existing trigger in MIGRATION_1 fires on `content`; the new trigger fires on `content_text`.

**Content extraction in `parseIncomingMessage()`:**

For each non-text type, set both `content` (JSON) and `contentText` (human-readable):

```typescript
// location
content = JSON.stringify({
  type: 'location',
  latitude: msg.degreesLatitude,
  longitude: msg.degreesLongitude,
  name: msg.name || null,
  address: msg.address || null,
  url: msg.url || null,
});
contentText = `Location: ${msg.name || msg.address || 'shared'} (${msg.degreesLatitude}, ${msg.degreesLongitude})`;

// contact
content = JSON.stringify({
  type: 'contact',
  displayName: msg.displayName,
  vcard: msg.vcard,
});
contentText = `Contact: ${msg.displayName}`;

// contactsArray
content = JSON.stringify({
  type: 'contacts',
  contacts: msg.contacts.map(c => ({ displayName: c.displayName, vcard: c.vcard })),
});
contentText = `Contacts: ${msg.contacts.map(c => c.displayName).join(', ')}`;

// poll
content = JSON.stringify({
  type: 'poll',
  name: msg.name,
  options: msg.options.map(o => o.optionName),
  selectableCount: msg.selectableOptionCount,
});
contentText = `Poll: ${msg.name} — ${msg.options.length} options`;

// audio
content = JSON.stringify({
  type: 'audio',
  duration: msg.seconds,
  ptt: msg.ptt || false,
  transcription: null,
});
contentText = null; // filled by Whisper later

// video (caption preserved)
content = caption || JSON.stringify({
  type: 'video',
  duration: msg.seconds,
  width: msg.width,
  height: msg.height,
});
contentText = caption || `Video: ${msg.seconds}s`;

// document
content = caption || JSON.stringify({
  type: 'document',
  fileName: msg.fileName,
  mimetype: msg.mimetype,
  pageCount: msg.pageCount,
});
contentText = caption || `Document: ${msg.fileName}`;

// sticker
content = JSON.stringify({
  type: 'sticker',
  emoji: msg.emoji || null,
  isAnimated: msg.isAnimated || false,
});
contentText = msg.emoji ? `Sticker: ${msg.emoji}` : 'Sticker';

// liveLocation
content = JSON.stringify({
  type: 'liveLocation',
  latitude: msg.degreesLatitude,
  longitude: msg.degreesLongitude,
  speed: msg.speedInMps,
  sequence: msg.sequenceNumber,
});
contentText = `Live location: (${msg.degreesLatitude}, ${msg.degreesLongitude})`;
```

**Persist transcriptions:**

After Whisper transcription completes in the agent runtime (`runtime.ts:139-143`), update both fields:

```typescript
const parsed = JSON.parse(storedContent || '{}');
parsed.transcription = transcriptionText;
db.prepare('UPDATE messages SET content = ?, content_text = ? WHERE message_id = ?')
  .run(JSON.stringify(parsed), transcriptionText, messageId);
```

**Protect against ON CONFLICT overwrite (council finding):**

`storeMessage()` at `messages.ts:125-131` has `ON CONFLICT(message_id) DO UPDATE SET content = excluded.content`. This would overwrite enriched JSON content (including persisted transcriptions) on message re-delivery.

Fix: change the upsert to preserve enriched content when the new value is less informative:

```typescript
ON CONFLICT(message_id) DO UPDATE SET
  content = CASE
    WHEN excluded.content IS NOT NULL AND messages.content IS NULL THEN excluded.content
    WHEN excluded.content IS NOT NULL AND excluded.content != messages.content
      AND messages.content NOT LIKE '{"type":"%' THEN excluded.content
    ELSE messages.content
  END,
  content_text = COALESCE(excluded.content_text, messages.content_text),
```

Logic: if existing content is structured JSON (`{"type":"`...), don't overwrite with a re-delivered raw value. Otherwise accept the new value.

**New MCP tool: `transcribe_audio`**

```
Tool: transcribe_audio
Scope: global
Parameters:
  message_id: string (required) — audio message to transcribe
Returns:
  transcription: string — the transcribed text
  duration: number — audio duration in seconds
  language: string — detected language
```

Implementation: call `download_media` (SP1) to get the audio file, call Whisper, persist transcription to both `content` and `content_text` fields, return result.

**Response enrichment in `rowToMessage()` (`messages.ts:24-39`):**

Add `contentText` field that extracts the human-readable summary:

```typescript
function rowToMessage(row: MessageRow): Message {
  return {
    // ... existing fields ...
    contentText: row.content_text ?? row.content,  // fallback to content for text messages
    mediaPath: row.media_path ?? null,
  };
}
```

**Files to modify:**
- `src/transport/connection.ts:986-1028` — rewrite content extraction, add `content_text` generation
- `src/core/messages.ts` — add `content_text` and `media_path` to `MessageRow` (line 9-22), update `rowToMessage()` (line 24-39), update `StoreMessageInput` (line 58-71), fix ON CONFLICT in `storeMessage()` (line 125-131)
- `src/core/database.ts` — add migration for `content_text` column, update FTS triggers
- `src/runtimes/agent/runtime.ts:139-143` — persist transcription after Whisper call
- `src/mcp/tools/media.ts` — add `transcribe_audio` tool

### 4.3 Backward Compatibility

- Existing messages with `content: null` remain unchanged in DB
- New `content_text` column defaults to NULL; text messages don't need it (FTS trigger falls back to `content`)
- `rowToMessage()` returns `contentText` which falls back to `content` for plain text messages — no breaking change for consumers
- `transcribe_audio` can be called retroactively on old audio messages (if media still available)

---

## 5. Sub-Project 3: Search Enhancement

### 5.1 Problem

- FTS5 index only covers `content` column — null content = unsearchable
- No way to filter by sender, date range, or content type
- After SP2, FTS will index `content_text` (human-readable summaries) — enabling search across all message types

### 5.2 Design

**New MCP tool: `search_messages_advanced`**

```
Tool: search_messages_advanced
Scope: global
Parameters:
  query: string (optional) — FTS text search
  sender_jid: string (optional) — filter by sender
  content_type: string (optional) — filter by content type (image, audio, etc.)
  conversation_key: string (optional) — filter by conversation
  after: number (optional) — Unix timestamp, messages after this time
  before: number (optional) — Unix timestamp, messages before this time
  has_media: boolean (optional) — filter for messages with/without media
  limit: number (optional, default 20)
Returns:
  messages: Message[] — standard message objects
  total: number — total matches
```

**Dual-path SQL implementation (council finding: FTS JOIN pattern is wrong when query is NULL):**

When `query` is provided, use FTS-first join:
```sql
SELECT m.* FROM messages_fts fts
JOIN messages m ON m.pk = fts.rowid
WHERE fts.content MATCH :query
  AND (:sender IS NULL OR m.sender_jid = :sender)
  AND (:type IS NULL OR m.content_type = :type)
  AND (:conv IS NULL OR m.conversation_key = :conv)
  AND (:after IS NULL OR m.timestamp >= :after)
  AND (:before IS NULL OR m.timestamp <= :before)
  AND (:has_media IS NULL
       OR (:has_media = 1 AND m.media_path IS NOT NULL)
       OR (:has_media = 0 AND m.media_path IS NULL))
ORDER BY m.timestamp DESC
LIMIT :limit
```

When `query` is absent, query `messages` directly (no FTS join):
```sql
SELECT m.* FROM messages m
WHERE 1=1
  AND (:sender IS NULL OR m.sender_jid = :sender)
  AND (:type IS NULL OR m.content_type = :type)
  AND (:conv IS NULL OR m.conversation_key = :conv)
  AND (:after IS NULL OR m.timestamp >= :after)
  AND (:before IS NULL OR m.timestamp <= :before)
  AND (:has_media IS NULL
       OR (:has_media = 1 AND m.media_path IS NOT NULL)
       OR (:has_media = 0 AND m.media_path IS NULL))
ORDER BY m.timestamp DESC
LIMIT :limit
```

**No new FTS migration needed.** The existing FTS triggers in MIGRATION_1 (`database.ts:36-58`) already handle insert, update, and delete correctly using proper FTS5 idioms. SP2's migration changes the triggers to index `content_text` instead of `content` — that's the only FTS change needed. No SP3-specific FTS migration.

**Files to modify:**
- `src/mcp/tools/search.ts` — add `search_messages_advanced` tool with dual-path query builder

---

## 6. Sub-Project 4: Two-Way Voice (ElevenLabs)

### 6.1 Problem

No voice synthesis capability exists. The infrastructure for sending voice notes is present (`send_media` with `ptt: true`), and STT exists (Whisper), but there's no TTS pipeline to generate spoken audio from text.

### 6.2 Design

**New module: `src/runtimes/chat/providers/elevenlabs.ts`**

```typescript
interface VoiceSynthesisResult {
  buffer: Buffer;
  duration: number;
  mimeType: string;
}

async function synthesizeSpeech(
  text: string,
  options?: {
    voiceId?: string;
    modelId?: string;
    stability?: number;
    similarityBoost?: number;
  }
): Promise<VoiceSynthesisResult>
```

Implementation:
1. Call ElevenLabs text-to-speech API (`/v1/text-to-speech/{voice_id}`) via raw `fetch` (no additional npm dependencies)
2. Return OGG/MP3 buffer
3. Circuit breaker pattern matching Whisper's (5 failures, 60s recovery window)
4. API key retrieved from GNOME Keyring: `secret-tool lookup service elevenlabs`

**New MCP tool: `send_voice_reply`**

```
Tool: send_voice_reply
Scope: chat
Parameters:
  text: string (required) — text to synthesize and send as voice note
  voice_id: string (optional) — ElevenLabs voice ID, defaults to config
  reply_to: string (optional) — message ID to reply to
Returns:
  message_id: string — sent message ID
  duration: number — audio duration in seconds
```

**Registration pattern:** Pattern 1 (options-object) — tool needs both `connection` (to send media) and `db` (to look up reply-to message JID). Register via `registerVoiceTools(registry, { connection, db })`.

Implementation:
1. Call `synthesizeSpeech(text)`
2. Save buffer to temp file via existing `writeTempFile()`
3. Call `connection.sendMedia()` with `ptt: true` (voice note)
4. Return message ID and duration

**Voice conversation loop (agent runtime integration):**

When the agent runtime receives a voice note:
1. Download → Whisper transcribe (existing)
2. Agent processes text, generates response
3. If response should be spoken (configurable per-instance): synthesize via ElevenLabs → send as voice note
4. Voice mode controlled by instance config: `voiceReply: 'always' | 'when_received' | 'never'` (default: `'never'`)

**Configuration:**
```json
{
  "elevenlabs": {
    "defaultVoiceId": "pNInz6obpgDQGcFmaJgB",
    "defaultModel": "eleven_multilingual_v2",
    "stability": 0.5,
    "similarityBoost": 0.75
  },
  "voiceReply": "when_received"
}
```

**Files to create:**
- `src/runtimes/chat/providers/elevenlabs.ts` — TTS synthesis with circuit breaker
- `src/mcp/tools/voice.ts` — `send_voice_reply` tool registration

**Files to modify:**
- `src/runtimes/agent/runtime.ts` — voice reply option after processing voice notes
- `src/mcp/register-all.ts` — register voice tools with Pattern 1 (options-object)

---

## 7. Migration Strategy

All sub-projects can be deployed independently. Recommended order:

1. **SP1 (Media Access)** — unblocks everything. Additive: new column + index.
2. **SP2 (Content Completeness)** — enriches data. Additive: new column, updated FTS triggers. New messages get structured content; old messages unchanged.
3. **SP3 (Search Enhancement)** — new tool only, no schema changes. FTS already updated by SP2.
4. **SP4 (Two-Way Voice)** — new capability, opt-in via config.

Database migrations are additive. The ON CONFLICT fix (SP2) is the only change to existing write behavior — it preserves enriched content on re-delivery rather than overwriting.

## 8. Tech Stack

- **Language:** TypeScript (existing WhatSoup stack)
- **Runtime:** Node.js >=23.10.0
- **Dependencies:** Baileys 7.0.0-rc.9 (existing), OpenAI 5.23.2 (existing), ElevenLabs API (raw `fetch`, no new npm deps)
- **Testing:** vitest (existing)
- **Lint:** ESLint + Prettier (existing)

## 9. Success Criteria

1. Agent can call `download_media` with a message ID and receive a file path to a readable image/audio/video/document
2. Media downloaded at ingest time is automatically persisted to `media_path` — no manual download needed for messages processed by the agent runtime
3. `list_messages` returns `contentText` (human-readable) and `content` (structured JSON) for all message types
4. Audio transcriptions persist in DB via `content_text` and appear in subsequent `list_messages` calls and FTS search
5. `search_messages_advanced` can filter by sender, date range, content type, and media presence
6. Agent can call `send_voice_reply` to synthesize and send a voice note via ElevenLabs
7. Voice notes received trigger transcription → agent response → optional voice reply (configurable)
8. All new tools follow existing WhatSoup patterns (Zod schema, scope, replay policy, Pattern 1 registration)
9. No breaking changes to existing tools or message format — `contentText` falls back to `content` for text messages
10. ON CONFLICT upsert preserves enriched content on message re-delivery

## Appendix: Council Review Log

**Review date:** 2026-04-05

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| C1 | Critical | Media URL expiry makes on-demand download unreliable | Pivoted to download-at-ingest primary path; on-demand as fallback with explicit error |
| C2 | Critical | FTS update trigger already exists in MIGRATION_1 | Removed SP3 FTS migration; SP2 updates existing triggers to index content_text |
| C3 | Critical | `has_media` boolean filter SQL wrong | Fixed three-way conditional in SQL |
| I1 | Important | `MediaDeps` interface needs explicit `db` addition | Specified in SP1 files-to-modify |
| I2 | Important | `storeMessage` ON CONFLICT overwrites enriched content | Added conditional upsert logic |
| I3 | Important | `rowToMessage` is in messages.ts not chat-management.ts | Fixed file attribution |
| I4 | Important | SP4 registration pattern unspecified | Specified Pattern 1 (options-object) |
| I5 | Important | Edge types (liveLocation, contactsArray, extendedText) not addressed | Added to SP2 content extraction |
| A1 | Architecture | Spec re-invents agent runtime download pattern | Reframed SP1 as persist-at-ingest + fallback |
| A2 | Architecture | FTS JOIN pattern wrong when query is NULL | Split into dual-path query builder |
| A3 | Architecture | JSON in FTS indexes key names not human text | Added content_text column; FTS indexes that instead |
