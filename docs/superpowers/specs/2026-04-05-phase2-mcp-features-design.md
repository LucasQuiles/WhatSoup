# WhatSoup MCP Phase 2 Features — Design Specification

**Date:** 2026-04-05
**Status:** completed — shipped as Phase 2 of the `whatsapp-mcp-features` epic. _Originally "Approved (SP5-SP7 by Q, SP8-SP11 by BES Bot, merged by Q)."_
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
  type: enum('composing', 'recording', 'paused')
Returns:
  success: boolean
  type: string — the presence type that was sent
```

`available` and `unavailable` are global presence states (not per-chat typing indicators) and are excluded from this tool. Use a separate presence management tool if global availability control is needed.

Implementation:
1. Validate `type` against the three allowed per-chat typing values
2. Call `sock.sendPresenceUpdate(type, chatJid)` directly via the Baileys socket
3. Wrap in try/catch — presence failures are best-effort (matching existing `setTyping` pattern at `connection.ts:304-307`)

**Registration:** Add `send_typing` to the existing `registerPresenceTools()` function in `presence.ts`. The function already receives `getSock` which provides the Baileys socket. No new registration pattern needed.

```typescript
// In presence.ts — new tool alongside subscribe_presence and get_presence
const SendTypingSchema = z.object({
  chatJid: z.string(),
  type: z.enum(['composing', 'recording', 'paused']),
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

When `autoTyping` is not `'off'`, the configured presence type fires before every outbound message — this covers both MCP tool sends and chat runtime sends. Implementation:

1. Read `config.autoTyping` from instance config (add to `config.ts:240` alongside existing `voiceReply`)
2. In `ConnectionManager.sendMessage` and `ConnectionManager.sendRaw` (`connection.ts`), before calling `sock.sendMessage`, if `autoTyping` is set, call `this.setTyping(chatJid, config.autoTyping)` using the extended version supporting `recording`
3. After the send completes, call `this.setTyping(chatJid, 'paused')` to clear the indicator

Placing the hook in `ConnectionManager` (rather than the `send_message` MCP handler in `messaging.ts`) ensures auto-typing fires before **any** outbound message — including sends initiated by the chat runtime, reply flows, and future send paths — not only MCP `send_message` calls.

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
- `src/transport/connection.ts` (`sendMessage`/`sendRaw`) — add auto-typing guard before every outbound send when `autoTyping` is configured
- `src/config.ts:240` — add `autoTyping` config option (alongside `voiceReply`)

### 3.5 Success Criteria

1. Agent can call `send_typing` with type `composing` and the WhatsApp client shows "typing..."
2. Agent can call `send_typing` with type `recording` and the WhatsApp client shows "recording audio..."
3. Agent can call `send_typing` with type `paused` and the indicator clears
4. When `autoTyping: 'composing'` is set in instance config, every outbound message (via `ConnectionManager.sendMessage`/`sendRaw`) automatically shows typing before sending — covers both MCP tools and chat runtime sends
5. No regression: existing agent runtime typing behavior (`runtime.ts:1232`) continues to work

---

## 4. Sub-Project 6: Link Preview Generation

### 4.1 Problem

Agents need the ability to suppress link previews for specific sends (privacy-sensitive contexts, high-volume URL sends where latency matters, or cases where a bare URL is intentional). Per-instance, we may also want to enable high-quality previews which Baileys supports but currently has disabled.

### 4.2 Current Flow

1. `send_message` handler (`messaging.ts:103-125`) builds a `{ text, mentions? }` content object
2. Passes to `connection.sendRaw(chatJid, content)` which calls `sock.sendMessage(chatJid, content)`
3. Baileys `sendMessage` internally calls `generateLinkPreviewIfRequired()` (`messages-send.js:897-908`) via `getUrlInfo()` — **link previews are already auto-generated by Baileys** for messages containing URLs
4. The socket is created with `generateHighQualityLinkPreview: false` (`connection.ts:219-227`), which means standard-quality previews are generated automatically; high-quality thumbnails are opt-in per instance

### 4.3 Design

**Not a new tool** — enhance the existing `send_message` tool in `messaging.ts` with an opt-out parameter.

**New parameter: `link_preview`**

```typescript
schema: z.object({
  chatJid: z.string(),
  text: z.string(),
  viewOnce: z.boolean().optional(),
  link_preview: z.enum(['auto', 'off']).optional()
    .describe('Control link preview generation. "auto" (default) uses Baileys auto-preview. "off" suppresses the preview entirely.'),
}),
```

**Implementation in `send_message` handler:**

```typescript
// Inside handler, after formatMentions:
const linkPreviewMode = (params['link_preview'] as string | undefined) ?? 'auto';

const content: Record<string, unknown> = hasMentions
  ? { text: formatted, mentions }
  : { text: formatted };
if (linkPreviewMode === 'off') content['linkPreview'] = null; // null suppresses Baileys auto-preview
if (viewOnce) content['viewOnce'] = true;

await connection.sendRaw(chatJid, content);
```

When `link_preview: 'off'`, pass `linkPreview: null` in the content object — Baileys treats `null` as an explicit suppression signal and skips `generateLinkPreviewIfRequired()`.

**Key design decisions:**

1. **Default `auto`** — Baileys already handles preview generation; no additional code needed for the happy path.
2. **`link_preview: 'off'`** — opt-out by passing `linkPreview: null`. Use for privacy-sensitive contexts, agents sending many URLs where the extra fetch latency is undesirable, or when a bare URL is intentional.
3. **No manual `getUrlInfo()` call** — Baileys handles this internally. We do not duplicate the fetch logic.
4. **No new npm deps** — purely a content-object flag change.

**Optional: per-instance high-quality preview config:**

The socket creation at `connection.ts:219-227` currently uses `generateHighQualityLinkPreview: false`. Add an optional instance config flag:

```json
{
  "generateHighQualityLinkPreview": true
}
```

When enabled, the socket is created with `generateHighQualityLinkPreview: true`, causing Baileys to fetch higher-resolution thumbnails. This is a per-instance toggle read at connection init time. Most instances leave this off (default).

**Also enhance `reply_message`:**

Apply the same `link_preview` opt-out parameter to `reply_message` (`messaging.ts:140-163`).

### 4.4 Files to Modify

- `src/mcp/tools/messaging.ts:92-125` — add `link_preview` parameter to `send_message`; pass `linkPreview: null` when `'off'`
- `src/mcp/tools/messaging.ts:129-163` — add `link_preview` parameter to `reply_message`, same logic
- `src/config.ts` — add optional `generateHighQualityLinkPreview` boolean config (read at connection init)
- `src/transport/connection.ts:219-227` — read `generateHighQualityLinkPreview` from instance config at socket creation

### 4.5 Success Criteria

1. `send_message` with text containing a URL generates a link preview automatically (Baileys default — no regression)
2. `send_message` with `link_preview: 'off'` sends the URL as bare text (preview suppressed)
3. `reply_message` with `link_preview: 'off'` also suppresses the preview
4. When `generateHighQualityLinkPreview: true` is set in instance config, high-quality thumbnails are generated
5. Messages without URLs are unaffected — no latency regression
6. No new npm dependencies introduced

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

Under the new design, two subdirectories exist under the base media directory:
- `media/tmp/` — all transient scratch writes (current behavior, path unchanged)
- `media/cache/` — new subdirectory for reusable cached files (preview thumbnails, sticker renders)

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
async function runCleanupDir(
  dir: string,
  maxAgeMs: number,
  db: Database,
  result: CleanupResult,
): Promise<void> {
  const now = Date.now();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // directory may not exist yet — skip silently
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(dir, entry.name);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue; // race condition — file deleted between readdir and stat
    }

    const ageMs = now - stat.mtimeMs; // age determined by mtime
    if (ageMs > maxAgeMs) {
      try {
        unlinkSync(fullPath);
        result.bytesFreed += stat.size;
        result.deleted++;

        // Nullify media_path in DB so queries don't reference a ghost file
        db.raw.prepare('UPDATE messages SET media_path = NULL WHERE media_path = ?').run(fullPath);
      } catch {
        result.skipped++; // best-effort — log and continue
      }
    }
  }
}

async function runCleanup(baseMediaDir: string, db: Database, retention: RetentionConfig): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, skipped: 0, bytesFreed: 0 };
  // Each subdirectory has its own retention policy
  await runCleanupDir(join(baseMediaDir, 'tmp'),   retention.tempMaxAgeMs,  db, result);
  await runCleanupDir(join(baseMediaDir, 'cache'), retention.cacheMaxAgeMs, db, result);
  return result;
}
```

**File classification:** Determined by subdirectory, not file extension:

- `media/tmp/` — transient scratch files (downloads, transcodes, voice outputs). Retention: 72 hours.
- `media/cache/` — reusable cached files (preview thumbnails, sticker renders). Retention: 7 days.

The cleanup logic runs independently on each subdirectory with its respective max age. Files are classified by which directory they live in — no extension inspection needed.

**Timer lifecycle:**

```typescript
export class MediaRetentionTimer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** Base media directory — must contain `tmp/` and `cache/` subdirectories */
    private baseMediaDir: string,
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
    return runCleanup(this.baseMediaDir, this.db, this.retention);
  }
}
```

The timer is created and started at `main.ts:566-582` (next to the existing retention loops), after DB initialization. It uses `timer.unref()` so it doesn't prevent graceful shutdown.

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
- `src/main.ts:566-582` — create and start `MediaRetentionTimer` here, next to existing retention loops, after DB init

### 5.6 Success Criteria

1. After 72 hours, files in `media/tmp/` are automatically deleted (age determined by mtime)
2. After 7 days, files in `media/cache/` are automatically deleted (age determined by mtime)
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
| SP5 | None | `autoTyping` in instance config | None | Low — presence updates are best-effort; auto-typing hook in ConnectionManager covers all send paths |
| SP6 | None | Optional `generateHighQualityLinkPreview` in instance config | None | Low — Baileys already generates previews; opt-out passes `linkPreview: null` |
| SP7 | None (uses existing `media_path` column from SP1) | `mediaRetention` in instance config | `media-retention.ts`, `retention.ts` | Medium — file deletion is irreversible; `media/cache/` subdir must be created |

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
3. Text messages with URLs include link previews automatically (Baileys default behavior — no regression)
4. Link preview can be suppressed per-message via `link_preview: 'off'`
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
