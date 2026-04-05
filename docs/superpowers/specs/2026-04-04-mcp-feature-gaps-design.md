# WhatSoup MCP Feature Gaps — Design Specification

**Date:** 2026-04-04
**Status:** Approved
**Author:** Lucas + Q (brainstorming session)

---

## 1. Problem Statement

WhatSoup exposes 127 MCP tools but a live agent-usage audit revealed critical gaps: an agent cannot retrieve received media, 7 of 10 message content types return null or partial data, audio transcriptions are ephemeral, search only covers text, and there is no voice synthesis pipeline. These gaps were confirmed when an agent (Q) could not view screenshots sent by the user in a WhatsApp group despite the images being stored in the database's `raw_message` column.

## 2. Scope — Four Sub-Projects

This spec covers four independent sub-projects, each buildable and deployable on its own. They share no code dependencies on each other (except SP2 enriches data that SP1 surfaces). Each gets its own implementation plan.

| # | Sub-Project | Priority | Summary |
|---|-------------|----------|---------|
| SP1 | Media Access | CRITICAL | `download_media` tool, media path persistence, enriched message responses |
| SP2 | Content Completeness | IMPORTANT | Fix parseIncomingMessage for all 10 types, persist transcriptions, on-demand transcribe tool |
| SP3 | Search Enhancement | IMPORTANT | Metadata search (sender, date, content type), index transcriptions in FTS |
| SP4 | Two-Way Voice | FEATURE | ElevenLabs TTS pipeline, voice conversation loop |

---

## 3. Sub-Project 1: Media Access

### 3.1 Problem

No MCP tool exists to retrieve received media. When `list_messages` returns an image message, the response has `content: null` (or just a caption). The raw WAMessage in `raw_message` contains the encrypted media URL and decryption keys, but no tool exposes a download path.

### 3.2 Current Flow

1. Inbound message → `parseIncomingMessage()` (`connection.ts:986`) extracts caption as `content`, stores `raw_message` as JSON
2. Agent runtime (`runtime.ts:79`) downloads media at ingest via Baileys `downloadMediaMessage()`, saves to temp file, returns `[Image: /path]` — but this only happens in the agent runtime, not via MCP tools
3. MCP `list_messages` → `rowToMessage()` (`messages.ts:24`) returns `content` from DB — which is null for audio/stickers, caption-only for images/videos

### 3.3 Design

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
```

**Implementation:**
1. Look up `raw_message` from messages table by `message_id`
2. Parse the WAMessage JSON, extract the media message (imageMessage, videoMessage, audioMessage, documentMessage, stickerMessage)
3. Call Baileys `downloadMediaMessage()` to decrypt and download
4. Save to `{save_dir}/{message_id}.{ext}` with correct extension from MIME
5. Persist the file path in a new `media_path` column on the messages table
6. Return the path, MIME type, and size

**New column: `media_path`**

```sql
ALTER TABLE messages ADD COLUMN media_path TEXT;
```

Populated by `download_media` on first call. Subsequent calls return the cached path (skip re-download if file exists on disk).

**Files to modify:**
- `src/mcp/tools/media.ts` — add `download_media` tool alongside `send_media`
- `src/core/database.ts` — add migration for `media_path` column
- `src/core/messages.ts` — add `updateMediaPath()` helper, update `MessageRow` and `rowToMessage()` to include `media_path`
- `src/mcp/register-all.ts` — pass `db` to `registerMediaTools` (currently only passes `connection`)
- `src/mcp/tools/chat-management.ts` — include `media_path` in `rowToMessage()` output

### 3.4 Enriched Message Response

After SP1, `list_messages` returns:

```json
{
  "messageId": "ABC123",
  "content": "Check this out",
  "contentType": "image",
  "mediaPath": "/tmp/whatsoup-media/ABC123.jpg",
  "isFromMe": false
}
```

If media hasn't been downloaded yet, `mediaPath` is null. The agent calls `download_media` to populate it.

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

### 4.2 Design

**Fix `parseIncomingMessage()` content extraction:**

For non-text types, store a JSON-structured content string that preserves all metadata:

```typescript
// location example
content = JSON.stringify({
  type: 'location',
  latitude: msg.degreesLatitude,
  longitude: msg.degreesLongitude,
  name: msg.name || null,
  address: msg.address || null,
  url: msg.url || null,
});

// contact example
content = JSON.stringify({
  type: 'contact',
  displayName: msg.displayName,
  vcard: msg.vcard,
  phones: extractPhonesFromVcard(msg.vcard),
});

// poll example
content = JSON.stringify({
  type: 'poll',
  name: msg.name,
  options: msg.options.map(o => o.optionName),
  selectableCount: msg.selectableOptionCount,
});

// audio example
content = JSON.stringify({
  type: 'audio',
  duration: msg.seconds,
  ptt: msg.ptt || false,
  transcription: null,  // filled by whisper later
});
```

**Persist transcriptions:**

After Whisper transcription completes, update the message's `content` field:

```typescript
// In agent runtime, after transcription:
const parsed = JSON.parse(storedContent);
parsed.transcription = transcriptionText;
db.prepare('UPDATE messages SET content = ? WHERE message_id = ?')
  .run(JSON.stringify(parsed), messageId);
```

This means `list_messages` for audio messages will return the transcription text in subsequent queries.

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

Implementation: download media (via SP1's download_media logic), call Whisper, persist transcription to content field, return result.

**Files to modify:**
- `src/transport/connection.ts:986-1028` — rewrite content extraction for location, contact, poll, audio, sticker
- `src/runtimes/agent/runtime.ts:139-143` — persist transcription after Whisper call
- `src/mcp/tools/media.ts` — add `transcribe_audio` tool
- `src/runtimes/chat/providers/whisper.ts` — no changes, already works

### 4.3 Backward Compatibility

Existing messages with `content: null` for audio/stickers remain in DB. The `transcribe_audio` tool can be called retroactively to fill them in. New messages going forward will have structured content from ingest.

For consumers that expect plain text in `content`, add a `contentText` field to `rowToMessage()` that extracts the human-readable summary from the JSON:
- Location → "Location: {name or address} ({lat}, {lon})"
- Contact → "Contact: {displayName}"
- Poll → "Poll: {name} — {options.length} options"
- Audio → transcription text or "[Audio: {duration}s]"

---

## 5. Sub-Project 3: Search Enhancement

### 5.1 Problem

- FTS5 index only covers `content` column — null content = unsearchable
- No way to filter by sender, date range, or content type
- Transcriptions (once persisted by SP2) won't be in FTS unless re-indexed

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
  has_media: boolean (optional) — only messages with media_path set
  limit: number (optional, default 20)
Returns:
  messages: Message[] — standard message objects
  total: number — total matches (for pagination context)
```

SQL implementation:
```sql
SELECT m.* FROM messages m
LEFT JOIN messages_fts fts ON m.pk = fts.rowid
WHERE 1=1
  AND (:query IS NULL OR fts.content MATCH :query)
  AND (:sender IS NULL OR m.sender_jid = :sender)
  AND (:type IS NULL OR m.content_type = :type)
  AND (:conv IS NULL OR m.conversation_key = :conv)
  AND (:after IS NULL OR m.timestamp >= :after)
  AND (:before IS NULL OR m.timestamp <= :before)
  AND (:has_media IS NULL OR m.media_path IS NOT NULL)
ORDER BY m.timestamp DESC
LIMIT :limit
```

**FTS re-indexing for transcriptions:**

Add an FTS update trigger that fires when content is updated (not just inserted):

```sql
CREATE TRIGGER IF NOT EXISTS messages_fts_update
AFTER UPDATE OF content ON messages
WHEN NEW.content IS NOT NULL
BEGIN
  DELETE FROM messages_fts WHERE rowid = NEW.pk;
  INSERT INTO messages_fts(rowid, content) VALUES (NEW.pk, NEW.content);
END;
```

This ensures that when SP2 persists a transcription into the `content` field, the FTS index is updated automatically.

**Files to modify:**
- `src/mcp/tools/search.ts` — add `search_messages_advanced` tool
- `src/core/database.ts` — add FTS update trigger migration
- `src/mcp/register-all.ts` — no changes needed (search tools already registered)

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
1. Call ElevenLabs text-to-speech API (`/v1/text-to-speech/{voice_id}`)
2. Return MP3/OGG buffer
3. Circuit breaker pattern matching Whisper's (5 failures, 60s recovery)

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

Implementation:
1. Call `synthesizeSpeech(text)`
2. Save buffer to temp file
3. Call `connection.sendMedia()` with `ptt: true` (voice note)
4. Return message ID and duration

**Voice conversation loop (agent runtime integration):**

When the agent runtime receives a voice note:
1. Download → Whisper transcribe (existing)
2. Agent processes text, generates response
3. If response should be spoken (configurable per-chat): synthesize via ElevenLabs → send as voice note
4. Voice mode controlled by config: `voiceReply: 'always' | 'when_received' | 'never'`

**Configuration:**
```json
{
  "elevenlabs": {
    "apiKey": "from-keyring",
    "defaultVoiceId": "pNInz6obpgDQGcFmaJgB",
    "defaultModel": "eleven_multilingual_v2",
    "stability": 0.5,
    "similarityBoost": 0.75
  },
  "voiceReply": "when_received"
}
```

API key retrieved from GNOME Keyring: `secret-tool lookup service elevenlabs`

**Files to create:**
- `src/runtimes/chat/providers/elevenlabs.ts` — TTS synthesis with circuit breaker
- `src/mcp/tools/voice.ts` — `send_voice_reply` tool

**Files to modify:**
- `src/runtimes/agent/runtime.ts` — voice reply option after processing voice notes
- `src/mcp/register-all.ts` — register voice tools
- `src/transport/connection.ts` — no changes (sendMedia already handles audio)

### 6.3 Dependencies

- ElevenLabs API key in GNOME Keyring
- `elevenlabs` npm package or raw HTTP via fetch (prefer raw to minimize deps)
- OpenAI key already available for Whisper

---

## 7. Migration Strategy

All sub-projects can be deployed independently. Recommended order:

1. **SP1 (Media Access)** — unblocks everything. No breaking changes.
2. **SP2 (Content Completeness)** — enriches data. New messages get structured content; old messages unchanged.
3. **SP3 (Search Enhancement)** — new tool, no breaking changes. FTS trigger auto-indexes updated content.
4. **SP4 (Two-Way Voice)** — new capability, opt-in via config.

Database migrations are additive (new column, new trigger). No existing data is modified.

## 8. Tech Stack

- **Language:** TypeScript (existing WhatSoup stack)
- **Runtime:** Node.js >=23.10.0
- **Dependencies:** Baileys 7.0.0-rc.9 (existing), OpenAI 5.23.2 (existing), ElevenLabs API (raw HTTP)
- **Testing:** vitest (existing)
- **Lint:** ESLint + Prettier (existing)

## 9. Success Criteria

1. Agent can call `download_media` with a message ID and receive a file path to a readable image/audio/video/document
2. `list_messages` returns structured content for all 10 message types (no more `content: null`)
3. Audio transcriptions persist in DB and appear in subsequent `list_messages` calls
4. `search_messages_advanced` can filter by sender, date range, content type
5. Agent can call `send_voice_reply` to synthesize and send a voice note
6. Voice notes received trigger transcription → agent response → optional voice reply
7. All new tools follow existing WhatSoup patterns (Zod schema, scope, replay policy)
8. No breaking changes to existing tools or message format
