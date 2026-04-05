# WhatSoup MCP Phase 2 Features — Design Specification

**Date:** 2026-04-05
**Status:** Draft (SP5-SP7 by Q, SP8-SP11 by BES Bot, merged by Q)
**Author:** Lucas + Q (brainstorming session)
**Depends on:** Phase 1 spec (2026-04-04-mcp-feature-gaps-design.md) — SP1-SP4 must be deployed first for migrations 12-13

---

## 1. Problem Statement

Phase 1 closed critical media, content, search, and voice gaps. Phase 2 addresses the remaining agent-experience issues: agents cannot simulate natural typing behavior (presence leaks that responses are machine-generated), outbound text messages lack link previews (appearing bare and unprofessional compared to native WhatsApp clients), and media temp files accumulate unbounded on disk across instances — eventually exhausting storage on long-running fleet nodes.

## 2. Scope — Seven Sub-Projects (SP5-SP11)

This spec covers SP5-SP7. SP8-SP11 are authored separately and will be merged.

| # | Sub-Project | Priority | Summary | Author |
|---|-------------|----------|---------|--------|
| SP5 | Typing Simulation | IMPORTANT | `send_typing` MCP tool + auto-typing before agent sends | This spec |
| SP6 | Link Preview Generation | IMPORTANT | Enhance `send_message` with automatic link preview via Baileys `getUrlInfo` | This spec |
| SP7 | Media Cleanup + Retention | IMPORTANT | Background retention timer, `cleanup_media` tool, per-instance retention config | This spec |
| SP8 | Status/Stories | IMPORTANT | Unblock status@broadcast ingest, post_status tool, view received statuses | BES Bot |
| SP9 | Broadcast Lists | PROOF-GATED | Generic broadcast tool — only if live proof test passes | BES Bot |
| SP10 | Quoted Message Media | IMPORTANT | Extend download_media to handle contextInfo.quotedMessage | BES Bot |
| SP11 | Message Scheduling | FEATURE | New DB table + scheduler loop, schedule/cancel/list tools | BES Bot |

---

## 3. Sub-Project 5: Typing Simulation

### 3.1 Problem

WhatsApp shows a "typing..." indicator when a contact is composing a message. Currently, the only typing support is the internal `setTyping()` method on `ConnectionManager` (`connection.ts:300-308`), which the agent runtime calls via `queue.indicateTyping()` (`runtime.ts:1232`) before processing. No MCP tool exposes this, so:

1. MCP-connected agents (chat runtimes, external tools) cannot simulate typing
2. The existing method only supports `composing` and `paused` — there is no way to show `recording` (voice note indicator), or set presence to `available`/`unavailable`
3. There is no configurable auto-typing behavior that fires before outbound messages in the chat runtime

### 3.2 Current Flow

1. `ConnectionManager.setTyping(chatJid, typing)` at `connection.ts:300` calls `sock.sendPresenceUpdate(typing ? 'composing' : 'paused', chatJid)` — binary on/off only
2. Agent runtime calls `queue.indicateTyping()` at `runtime.ts:1232` before sending a turn to the agent — this is hardcoded, not configurable
3. MCP presence tools (`presence.ts:17-86`) expose `subscribe_presence` and `get_presence` — both read-only. No tool sends presence updates
4. The presence tools use Pattern 3 registration: `registerPresenceTools(getSock, presenceCache, register)` at `register-all.ts:71`

### 3.3 Design

**New MCP tool: `send_typing`**

```
Tool: send_typing
Scope: chat
TargetMode: injected
ReplayPolicy: safe
Parameters:
  chatJid: string (injected from session.deliveryJid)
  type: enum('composing', 'recording', 'paused', 'available', 'unavailable')
Returns:
  success: boolean
  type: string — the presence type that was sent
```

Implementation:
1. Validate `type` against the five allowed presence update values
2. Call `sock.sendPresenceUpdate(type, chatJid)` directly via the Baileys socket
3. Wrap in try/catch — presence failures are best-effort (matching existing `setTyping` pattern at `connection.ts:304-307`)

**Registration:** Add `send_typing` to the existing `registerPresenceTools()` function in `presence.ts`. The function already receives `getSock` which provides the Baileys socket. No new registration pattern needed.

```typescript
// In presence.ts — new tool alongside subscribe_presence and get_presence
const SendTypingSchema = z.object({
  chatJid: z.string(),
  type: z.enum(['composing', 'recording', 'paused', 'available', 'unavailable']),
});

function makeSendTyping(getSock: () => ExtendedBaileysSocket | null): ToolDeclaration {
  return {
    name: 'send_typing',
    description:
      'Send a typing/presence indicator to the current chat. Use "composing" to show typing, "recording" to show recording audio, "paused" to stop the indicator.',
    schema: SendTypingSchema,
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { chatJid, type } = SendTypingSchema.parse(params);
      const sock = getSock();
      if (!sock) {
        return { success: false, error: 'WhatsApp is not connected' };
      }
      try {
        await sock.sendPresenceUpdate(type, chatJid);
      } catch {
        // Best-effort — matches existing setTyping pattern (connection.ts:304-307)
        return { success: false, error: 'Presence update failed (best-effort)' };
      }
      return { success: true, type };
    },
  };
}
```

**Auto-typing before agent messages (configurable per-instance):**

Add an `autoTyping` config option:

```json
{
  "autoTyping": "composing"  // 'composing' | 'recording' | 'off' (default: 'off')
}
```

When `autoTyping` is not `'off'`, the chat runtime sends the configured presence type before every outbound `send_message` call. Implementation:

1. Read `config.autoTyping` from instance config (add to `config.ts:240` alongside existing `voiceReply`)
2. In the `send_message` handler (`messaging.ts:103`), before the actual send, if `autoTyping` is set, call `connection.setTyping(chatJid, true)` (or the new extended version supporting `recording`)
3. After send completes, send `paused` to clear the indicator

**Extend `ConnectionManager.setTyping()`:**

Update `connection.ts:300-308` to accept the full presence type string instead of a boolean:

```typescript
// Before:
async setTyping(chatJid: string, typing: boolean): Promise<void> {
  await this.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', chatJid);
}

// After:
async setTyping(chatJid: string, type: 'composing' | 'recording' | 'paused' = 'composing'): Promise<void> {
  await this.sock.sendPresenceUpdate(type, chatJid);
}
```

Backward compatibility: existing callers passing `true`/`false` must be updated to pass `'composing'`/`'paused'`. Grep reveals all call sites use `queue.indicateTyping()` which internally calls `setTyping(jid, true)` — update that single call site.

### 3.4 Files to Modify

- `src/mcp/tools/presence.ts:17-86` — add `makeSendTyping()`, register in `registerPresenceTools()`
- `src/transport/connection.ts:300-308` — extend `setTyping()` to accept presence type string
- `src/config.ts:240` — add `autoTyping` config option (alongside `voiceReply`)
- `src/mcp/tools/messaging.ts:103-125` — add auto-typing before send when configured

### 3.5 Success Criteria

1. Agent can call `send_typing` with type `composing` and the WhatsApp client shows "typing..."
2. Agent can call `send_typing` with type `recording` and the WhatsApp client shows "recording audio..."
3. Agent can call `send_typing` with type `paused` and the indicator clears
4. When `autoTyping: 'composing'` is set in instance config, every `send_message` call automatically shows typing before sending
5. No regression: existing agent runtime typing behavior (`runtime.ts:1232`) continues to work

---

## 4. Sub-Project 6: Link Preview Generation

### 4.1 Problem

When an agent sends a text message containing a URL via `send_message`, the message arrives without a link preview — no title, description, or thumbnail. Native WhatsApp clients auto-generate these previews. This makes bot-sent messages look stripped-down and reduces engagement (recipients don't see what the link is about before clicking).

Baileys supports link previews via `getUrlInfo()` (`node_modules/@whiskeysockets/baileys/lib/Utils/link-preview.d.ts:20`) and the `linkPreview` property on `AnyRegularMessageContent` (`Types/Message.d.ts:159`). The socket is even created with `generateHighQualityLinkPreview: false` (`connection.ts:226`), which controls Baileys' *internal* auto-preview on `sendMessage`. We want explicit, controlled preview generation.

### 4.2 Current Flow

1. `send_message` handler (`messaging.ts:103-125`) builds a `{ text, mentions? }` content object
2. Passes to `connection.sendRaw(chatJid, content)` which calls `sock.sendMessage(chatJid, content)`
3. Baileys `sendMessage` internally calls `generateLinkPreviewIfRequired()` (`Utils/messages.js:269`) but only if `options.getUrlInfo` is set — and the socket was created with `generateHighQualityLinkPreview: false`, so the internal path is disabled
4. Result: no link preview is ever generated

### 4.3 Design

**Not a new tool** — enhance the existing `send_message` tool in `messaging.ts`.

**New parameter: `link_preview`**

```typescript
schema: z.object({
  chatJid: z.string(),
  text: z.string(),
  viewOnce: z.boolean().optional(),
  link_preview: z.enum(['auto', 'off']).optional()
    .describe('Generate link preview for URLs in the message. Default: auto.'),
}),
```

**Implementation in `send_message` handler:**

```typescript
import { getUrlInfo } from '@whiskeysockets/baileys/lib/Utils/link-preview.js';
import type { WAUrlInfo } from '@whiskeysockets/baileys';

// Inside handler, after formatMentions:
const linkPreviewMode = (params['link_preview'] as string | undefined) ?? 'auto';
let linkPreview: WAUrlInfo | undefined;

if (linkPreviewMode === 'auto') {
  try {
    linkPreview = await getUrlInfo(formatted, {
      thumbnailWidth: 300,
      fetchOpts: { timeout: 5_000 },
    });
  } catch {
    // Best-effort — preview failure must not block message send
    log.debug('Link preview generation failed — sending without preview');
  }
}

const content: Record<string, unknown> = hasMentions
  ? { text: formatted, mentions }
  : { text: formatted };
if (linkPreview) content['linkPreview'] = linkPreview;
if (viewOnce) content['viewOnce'] = true;

await connection.sendRaw(chatJid, content);
```

**Key design decisions:**

1. **Default `auto`** — matches native WhatsApp behavior. Agents get previews without opting in.
2. **5-second timeout** on `getUrlInfo` — prevents slow websites from blocking message delivery. The Baileys `getUrlInfo` already supports `fetchOpts.timeout`.
3. **Best-effort** — if preview generation fails (network error, timeout, unparseable HTML), the message is sent without a preview. The failure is logged but not surfaced as an error.
4. **No caching** — link previews are generated per-send. URLs are rarely repeated in the same conversation, and caching adds complexity with minimal benefit.
5. **`link_preview: 'off'`** — opt-out for agents that send many URLs and don't want the latency cost, or for privacy-sensitive contexts where the server shouldn't fetch external URLs.

**Baileys `WAUrlInfo` type** (from `Types/Message.d.ts:61-66`):

```typescript
interface WAUrlInfo {
  'canonical-url': string;
  'matched-text': string;
  title: string;
  description?: string;
  jpegThumbnail?: Buffer;
}
```

The `linkPreview` field is passed directly in the message content object. Baileys `sendMessage` at `Utils/messages.js:269` recognizes it and builds the appropriate protobuf `extendedTextMessage` with preview metadata.

**Also enhance `reply_message`:**

Apply the same link preview logic to `reply_message` (`messaging.ts:140-163`). When the reply text contains a URL, auto-generate a preview. Add the same `link_preview` parameter.

### 4.4 Files to Modify

- `src/mcp/tools/messaging.ts:92-125` — add `link_preview` parameter to `send_message`, add preview generation logic before send
- `src/mcp/tools/messaging.ts:129-163` — add `link_preview` parameter to `reply_message`, same logic
- No new imports needed beyond Baileys' existing `getUrlInfo` and `WAUrlInfo`

### 4.5 Success Criteria

1. `send_message` with text containing `https://github.com` generates a link preview with title "GitHub" and description
2. `send_message` with `link_preview: 'off'` sends the URL as bare text (no preview)
3. `send_message` with a URL to a slow/dead server still sends within 6 seconds (5s preview timeout + 1s buffer)
4. `reply_message` with URL also generates a link preview
5. Messages without URLs are unaffected — no latency regression
6. Preview generation failure is logged at debug level but does not surface as a tool error

---

## 5. Sub-Project 7: Media Cleanup + Retention

### 5.1 Problem

Every downloaded media file lands in `config.mediaDir` (`config.ts:95` — resolves to `~/.local/share/whatsoup/instances/<name>/media/tmp/`). Files are written by `writeTempFile()` (`media-download.ts:46-52`) using random hex names. The only cleanup is `cleanupTempFile()` (`media-download.ts:54-60`) which is called in isolated spots — it is not part of any retention lifecycle.

Over time, media files accumulate:
- Agent runtime downloads at ingest (`runtime.ts:138`)
- MCP `download_media` tool downloads on demand (`media.ts:311`)
- Voice synthesis outputs (`voice.ts:70`, `runtime.ts:2180`)
- Agent runtime relocates some files to workspaces (`runtime.ts:182-196`), but the originals in the global temp dir may remain

On a fleet node running 10+ instances, each processing hundreds of messages daily, the `media/tmp/` directories can grow to gigabytes within weeks. There is no automated cleanup, no retention policy, and no visibility into disk usage.

### 5.2 Current Flow

1. `writeTempFile(buffer, ext)` at `media-download.ts:46` writes to `config.mediaDir` (`~/.local/share/whatsoup/instances/<name>/media/tmp/`)
2. Files use random hex names: `{8 random hex bytes}.{ext}` (e.g., `a7f3c8b2e1d4f690.jpg`)
3. `cleanupTempFile(path)` at `media-download.ts:54` does `unlinkSync(path)` — best-effort, called in a few spots
4. SP1 added `media_path` column to messages table (migration 12, `database.ts:408-414`). When a file is cleaned up, the DB still references a now-deleted path.
5. Per-instance media directories are defined by `instancePaths()` at `fleet/paths.ts:44` — `path.join(data, 'media', 'tmp')`

### 5.3 Design

**Background retention timer:**

New module `src/core/media-retention.ts` implementing a periodic cleanup loop.

```typescript
interface RetentionConfig {
  /** Interval between cleanup runs in milliseconds. Default: 6 hours. */
  intervalMs: number;
  /** Max age for temp media files (downloads, transcodes) in milliseconds. Default: 72 hours. */
  tempMaxAgeMs: number;
  /** Max age for cache files (previews, thumbnails) in milliseconds. Default: 7 days. */
  cacheMaxAgeMs: number;
}

const DEFAULT_RETENTION: RetentionConfig = {
  intervalMs: 6 * 60 * 60 * 1000,      // 6 hours
  tempMaxAgeMs: 72 * 60 * 60 * 1000,   // 72 hours
  cacheMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};
```

**Cleanup logic:**

```typescript
async function runCleanup(mediaDir: string, db: Database, retention: RetentionConfig): Promise<CleanupResult> {
  const now = Date.now();
  const entries = readdirSync(mediaDir, { withFileTypes: true });
  let deleted = 0;
  let skipped = 0;
  let bytesFreed = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(mediaDir, entry.name);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue; // race condition — file deleted between readdir and stat
    }

    const ageMs = now - stat.mtimeMs;
    const maxAge = isCacheFile(entry.name) ? retention.cacheMaxAgeMs : retention.tempMaxAgeMs;

    if (ageMs > maxAge) {
      try {
        unlinkSync(fullPath);
        bytesFreed += stat.size;
        deleted++;

        // Nullify media_path in DB so queries don't reference a ghost file
        db.raw.prepare('UPDATE messages SET media_path = NULL WHERE media_path = ?').run(fullPath);
      } catch {
        skipped++; // best-effort — log and continue
      }
    }
  }

  return { deleted, skipped, bytesFreed };
}
```

**File classification:** Determine max age based on file extension:

- Cache files (longer retention): `.webp` (sticker thumbnails), `.preview.*`
- Temp files (shorter retention): everything else (`.jpg`, `.mp4`, `.ogg`, `.mp3`, `.opus`, `.pdf`, `.doc`, etc.)

**Timer lifecycle:**

```typescript
export class MediaRetentionTimer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private mediaDir: string,
    private db: Database,
    private retention: RetentionConfig = DEFAULT_RETENTION,
  ) {}

  start(): void {
    // Run immediately on start, then at interval
    this.run();
    this.timer = setInterval(() => this.run(), this.retention.intervalMs);
    this.timer.unref(); // Don't prevent process exit
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async run(): Promise<CleanupResult> {
    return runCleanup(this.mediaDir, this.db, this.retention);
  }
}
```

The timer is created and started during instance boot, after DB initialization. It uses `timer.unref()` so it doesn't prevent graceful shutdown.

**New MCP tool: `cleanup_media`**

```
Tool: cleanup_media
Scope: global
TargetMode: caller-supplied
ReplayPolicy: safe
Parameters:
  max_age_hours: number (optional) — override temp file max age for this run. Default: uses instance retention config.
  dry_run: boolean (optional) — if true, report what would be deleted without deleting. Default: false.
Returns:
  deleted: number — files removed
  skipped: number — files that couldn't be removed
  bytes_freed: number — total bytes reclaimed
  dry_run: boolean — whether this was a dry run
```

Implementation:
1. If `dry_run`, scan the media directory and report counts without deleting
2. Otherwise, call `runCleanup()` with the provided (or default) max age
3. Return the cleanup result

**Registration:** Pattern 1 (options-object). Create a new `registerRetentionTools()` function, or add to an existing module. Given this is a global maintenance tool, add it to a new `src/mcp/tools/retention.ts` file.

**Per-instance configuration:**

Add retention settings to instance config:

```json
{
  "mediaRetention": {
    "intervalHours": 6,
    "tempMaxAgeHours": 72,
    "cacheMaxAgeDays": 7
  }
}
```

Read from `config.ts` alongside existing instance config parsing. Convert hours/days to milliseconds for the `RetentionConfig` interface.

**DB `media_path` nullification:**

When a file is deleted by the retention timer (or by `cleanup_media`), the corresponding `media_path` in the messages table must be set to NULL. This prevents `list_messages` from returning paths to files that no longer exist. The cleanup logic runs:

```sql
UPDATE messages SET media_path = NULL WHERE media_path = ?
```

For each deleted file. This is a simple indexed lookup (SP1 added `idx_messages_media_path` partial index at `database.ts:412`).

### 5.4 Files to Create

- `src/core/media-retention.ts` — `MediaRetentionTimer`, `runCleanup()`, `RetentionConfig`, `CleanupResult`
- `src/mcp/tools/retention.ts` — `cleanup_media` tool, `registerRetentionTools()`

### 5.5 Files to Modify

- `src/config.ts:240` — add `mediaRetention` config block parsing
- `src/mcp/register-all.ts:37-80` — add `registerRetentionTools` import and registration (Pattern 1)
- `src/runtimes/agent/runtime.ts` (boot sequence) — create and start `MediaRetentionTimer` after DB init
- `src/runtimes/passive/runtime.ts` (if applicable) — same timer start

### 5.6 Success Criteria

1. After 72 hours, temp media files are automatically deleted from `config.mediaDir`
2. After 7 days, cache files (sticker thumbnails, previews) are automatically deleted
3. `media_path` is set to NULL in the messages table when a file is cleaned up
4. `cleanup_media` with `dry_run: true` reports what would be deleted without deleting
5. `cleanup_media` without `dry_run` deletes expired files immediately and returns byte count
6. Retention intervals are configurable per-instance via `mediaRetention` config
7. Timer uses `unref()` and does not prevent graceful shutdown
8. Cleanup logs each run's stats (deleted count, bytes freed) at info level

---

## 6. Sub-Project 8: _Reserved for BES Bot_

_Placeholder — SP8 design will be merged from BES Bot's spec._

---

## 7. Sub-Project 9: _Reserved for BES Bot_

_Placeholder — SP9 design will be merged from BES Bot's spec._

---

## 8. Sub-Project 10: _Reserved for BES Bot_

_Placeholder — SP10 design will be merged from BES Bot's spec._

---

## 9. Sub-Project 11: _Reserved for BES Bot_

_Placeholder — SP11 design will be merged from BES Bot's spec._

---

## 10. Migration Strategy

SP5-SP7 have no database migrations. Phase 1 migrations (12-13) must be deployed first.

| SP | DB Changes | Config Changes | New Files | Risk |
|----|-----------|----------------|-----------|------|
| SP5 | None | `autoTyping` in instance config | None | Low — presence updates are best-effort |
| SP6 | None | None | None | Low — preview failure falls back silently |
| SP7 | None (uses existing `media_path` column from SP1) | `mediaRetention` in instance config | `media-retention.ts`, `retention.ts` | Medium — file deletion is irreversible |

Recommended deployment order:

1. **SP5 (Typing Simulation)** — no dependencies, purely additive
2. **SP6 (Link Preview Generation)** — no dependencies, enhances existing tool
3. **SP7 (Media Cleanup + Retention)** — depends on SP1's `media_path` column being populated
4. **SP8 (Status/Stories)** — requires unblocking status@broadcast in connection.ts
5. **SP10 (Quoted Message Media)** — extends SP1's download_media pattern
6. **SP9 (Broadcast Lists)** — proof-gated, only if live test passes
7. **SP11 (Message Scheduling)** — new DB table, most complex, last

---

## Sprint B: Platform Expansion (SP8, SP9, SP10)

### Sub-Project 8: Status/Stories

**Problem:** WhatSoup currently drops `status@broadcast` messages at `connection.ts:1170-1171`. Agents cannot post WhatsApp Status updates or view others' statuses.

**Design:**

1. **Unblock ingest:** Remove the status@broadcast filter in `parseIncomingMessage()`. Store status messages but mark them as non-response-worthy (don't trigger agent sessions).
2. **Post status:** New `post_status` MCP tool. Uses `sendMessage('status@broadcast', content, { statusJidList })`. Supports text, image, and video status posts. Requires building a contact JID list for visibility.
3. **View status:** New `list_statuses` MCP tool. Queries stored status messages from DB, grouped by sender.
4. **Read receipt:** Send status read receipts when viewing.

**Files to modify:**
- `src/transport/connection.ts:1170-1171` — remove status@broadcast filter
- `src/core/ingest.ts` — mark status messages as non-response-worthy
- `src/mcp/tools/status.ts` — new file: `post_status`, `list_statuses` tools

**Limitations:** Baileys has no high-level stories list/view API. We receive statuses passively via message events. The `fetchStatus()` method returns user profile status text, not Stories.

### Sub-Project 9: Broadcast Lists (Proof-Gated)

**Problem:** Agents cannot send to broadcast lists. Baileys has `broadcast?: boolean` in message types but runtime usage is unproven.

**Design:**

1. **Phase 1 — Proof harness:** Write a standalone test that attempts `sendMessage` with `broadcast: true` to a list of JIDs. Verify delivery.
2. **Phase 2 (if proof passes):** New `send_broadcast` MCP tool with recipient list + dry-run validation.
3. **If proof fails:** Keep status@broadcast posting only (SP8). Document the limitation.

**Gate:** SP9 implementation only proceeds if the proof harness confirms reliable delivery. This gate is checked manually before writing the implementation plan.

### Sub-Project 10: Quoted Message Media Download

**Problem:** `download_media` only works on direct messages. Media in quoted/forwarded messages (via `contextInfo.quotedMessage`) cannot be retrieved.

**Design:**

1. **Extend `download_media`:** Add `quoted: boolean` optional parameter. When true, extract media from `raw_message.message.*.contextInfo.quotedMessage` instead of the message itself.
2. **WAMessage wrapper:** Build a synthetic `WAMessage` object from the quoted message proto, compatible with `downloadMediaMessage()`.
3. **Cache:** Persist downloaded quoted media to `media_path` same as regular media.

**Files to modify:**
- `src/mcp/tools/media.ts` — extend `download_media` handler with quoted path
- Helper function to extract and normalize quoted message into downloadable form

---

## Sprint C: Infrastructure (SP11)

### Sub-Project 11: Message Scheduling

**Problem:** No scheduled/delayed message sending. Agents cannot "send at X time."

**Design:**

1. **New DB table: `scheduled_messages`**
   ```sql
   CREATE TABLE scheduled_messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     chat_jid TEXT NOT NULL,
     content_type TEXT NOT NULL DEFAULT 'text',
     payload TEXT NOT NULL,  -- JSON: normalized outbound envelope
     scheduled_at INTEGER NOT NULL,  -- Unix timestamp (UTC)
     status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | cancelled
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     sent_at TEXT,
     error TEXT,
     retry_count INTEGER DEFAULT 0
   );
   ```
2. **Scheduler loop:** Periodic check (every 30s) in `src/main.ts` alongside existing timers. Picks up `pending` rows where `scheduled_at <= now()`, executes via existing send paths (`sendRaw`/`sendMedia`).
3. **MCP tools:**
   - `schedule_message` — create a scheduled message with chat_jid, content, and scheduled_at timestamp
   - `list_scheduled` — list pending scheduled messages
   - `cancel_scheduled` — cancel a pending scheduled message by ID
4. **Safety:** Idempotency guard (don't send twice on restart), dead-letter state for repeated failures (3 retries max), timezone-safe (all timestamps UTC).

**Files to create:**
- `src/core/scheduler.ts` — scheduler logic, DB queries
- `src/mcp/tools/scheduling.ts` — MCP tools

**Files to modify:**
- `src/core/database.ts` — MIGRATION_14 for scheduled_messages table
- `src/main.ts` — start scheduler loop

## 11. Tech Stack

- **Language:** TypeScript (existing WhatSoup stack)
- **Runtime:** Node.js >=23.10.0
- **Dependencies:** Baileys 7.0.0-rc.9 (existing — `getUrlInfo` from `Utils/link-preview.js`, `sendPresenceUpdate` from socket)
- **New npm deps:** None — all functionality comes from Baileys internals and Node.js stdlib (`fs`, `path`, `crypto`)
- **Testing:** vitest (existing)
- **Lint:** ESLint + Prettier (existing)

## 12. Success Criteria (Phase 2, SP5-SP11)

**Sprint A:**
1. Agent can send typing/recording indicators via `send_typing` MCP tool
2. Auto-typing before messages is configurable per-instance via `autoTyping` config
3. Text messages with URLs automatically include link previews (title, description, thumbnail)
4. Link preview can be disabled per-message via `link_preview: 'off'`
5. Media temp files are automatically cleaned up on a configurable schedule (72h temp, 7d cache)
6. Manual cleanup is available via `cleanup_media` MCP tool with dry-run support
7. Cleaned-up files have their `media_path` nullified in the DB — no ghost references

**Sprint B:**
8. Inbound status messages are stored (not dropped) but don't trigger agent sessions
9. Agent can post text/image/video status via `post_status` tool
10. Agent can list received statuses via `list_statuses` tool
11. Agent can download media from quoted messages via `download_media` with `quoted: true`
12. SP9 (broadcast) ships only if proof test confirms reliable delivery

**Sprint C:**
13. Agent can schedule messages via `schedule_message` tool with UTC timestamp
14. Scheduled messages execute reliably with retry and dead-letter handling
15. Agent can list and cancel pending scheduled messages

**Cross-cutting:**
16. All new tools follow existing WhatSoup patterns (Zod schema, scope, replay policy)
17. Only MIGRATION_14 (scheduled_messages table) added — no other schema changes
18. No new npm dependencies
