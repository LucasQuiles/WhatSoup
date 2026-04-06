# Phase 3 Implementation Plan — Console Features

## Overview
10 beads across 3 sub-phases. Backend is largely ready — most work is frontend UI + wiring.

---

## Wave 1 (Parallel — No Cross-Dependencies)

### B01: Inline Image Thumbnails
**Files:** `console/src/components/MessageContent.tsx`, `console/src/mock-data.ts`, `src/fleet/routes/data.ts`, `src/fleet/db-reader.ts`

1. **DB Reader** (`db-reader.ts:132-139`): Add `raw_message` to the SELECT in `getMessages()`
2. **Message type** (`mock-data.ts:69-78`): Add `rawMessage?: string` to `Message` interface
3. **API response** (`data.ts:188-195`): Map `row.raw_message` → `rawMessage` in message response
4. **MessageContent.tsx**: For `type === 'image'`, parse `rawMessage`, extract `message.imageMessage.jpegThumbnail`, render as `<img src="data:image/jpeg;base64,${thumb}" />` with `max-height: 200px`, `border-radius: var(--radius-md)`. Click opens full URL in new tab.
5. **Thumbnail fallback**: If no `jpegThumbnail`, keep current `MediaIndicator` with camera icon.

### B02: Audio Message Indicator
**Files:** `console/src/components/MessageContent.tsx`

1. **Extract metadata**: Parse `rawMessage.message.audioMessage` for `seconds` and `ptt` (voice note flag)
2. **Duration display**: Format seconds as `M:SS` — add `formatDuration(s: number)` to `format-time.ts`
3. **Update MediaIndicator**: Show `Voice note · 0:42` or `Audio · 1:23` with waveform placeholder (3 bars SVG)
4. **PTT detection**: `ptt === true` → "Voice note", else → "Audio"

### B03: Document File Card
**Files:** `console/src/components/MessageContent.tsx`, `console/src/lib/text-utils.ts`

1. **Extract metadata**: Parse `rawMessage.message.documentMessage` (or `documentWithCaptionMessage.message.documentMessage`) for `fileName`, `fileLength`, `mimetype`
2. **Add `formatBytes(n: number)`** to `text-utils.ts`: `1024 → '1.0 KB'`, `1048576 → '1.0 MB'`
3. **DocumentCard component**: File icon + name (truncated) + size + extension badge. Caption below if present.
4. **Extension color**: PDF=red, DOCX=blue, XLSX=green, other=gray — use existing status color tokens

### B05: Cursor Pagination
**Files:** `console/src/pages/LineDetail.tsx`, `console/src/hooks/use-fleet.ts`, `console/src/lib/api.ts`

Backend already supports `before_pk` param — this is frontend-only.

1. **API client** (`api.ts`): Add `beforePk?: number` param to `getMessages()`
2. **useMessages hook**: Accept `beforePk` state, pass to API call
3. **LineDetail.tsx** (`line 873`): Replace toast placeholder with actual handler:
   - Track `oldestPk` from current messages (`messages[messages.length - 1]?.pk`)
   - On click: fetch older page, prepend to existing messages in query cache
   - Disable button when returned page is less than limit (no more data)
4. **Loading state**: Show spinner while fetching older messages
5. **Scroll preservation**: After prepending, maintain scroll position (don't jump to top)

### B06: Contact Management
**Files:** `console/src/components/MessageBubble.tsx`, `console/src/pages/LineDetail.tsx`, `src/fleet/routes/ops.ts`, `src/fleet/index.ts`, `console/src/lib/api.ts`

MCP tool `add_or_edit_contact` exists with schema: `{ jid, firstName?, lastName?, company?, phone? }`

1. **Fleet endpoint**: Add `POST /api/lines/:name/tool` to ops.ts — generic MCP tool proxy. Accepts `{ toolName, params }`, routes via MCP socket or HTTP.
2. **API route** (`index.ts`): Register `{ method: 'POST', path: /tool$/, handler: 'toolCall' }`
3. **API client** (`api.ts`): Add `toolCall(lineName, toolName, params)`
4. **SaveContactDialog component**: Modal with firstName, lastName, phone inputs. Pre-populate from sender JID.
5. **Wire in MessageBubble**: Replace `toast.info('Save contact')` with dialog open

### B10: Stop Instance
**Files:** `src/fleet/routes/ops.ts`, `src/fleet/index.ts`, `console/src/lib/api.ts`, `console/src/pages/LineDetail.tsx`

Modeled after `handleRestart` — same pattern, different systemctl command.

1. **Handler** (`ops.ts`): Add `handleStop` — `execFile('systemctl', ['--user', 'stop', 'whatsoup@${name}'])`
2. **Route** (`index.ts`): `{ method: 'POST', path: /stop$/, handler: 'stop' }`
3. **API client** (`api.ts`): Add `stopInstance(name)`
4. **LineDetail.tsx** (`line 478`): Enable the disabled Stop button, wire to `api.stopInstance()` with ConfirmDialog

---

## Wave 2 (After B01)

### B04: Video Thumbnail
**Files:** `console/src/components/MessageContent.tsx`

Reuses the image thumbnail pattern from B01.

1. **Fix icon**: Change `video` icon from `Image` to `Film` (lucide-react)
2. **Extract thumbnail**: Parse `rawMessage.message.videoMessage.jpegThumbnail` — same base64 pattern as images
3. **Duration overlay**: Extract `videoMessage.seconds`, render as `formatDuration()` badge over thumbnail
4. **Play icon overlay**: Semi-transparent play triangle centered on thumbnail
5. **GIF detection**: If `videoMessage.gifPlayback === true`, label as "GIF" instead of "Video"

---

## Wave 3 (After B06 tool proxy)

### B08: Config Editor
**Files:** `console/src/pages/LineDetail.tsx`, `console/src/lib/api.ts`

Backend `PATCH /api/lines/:name/config` already exists and merges patches.

1. **ConfigEditDialog component**: Modal form generated from `buildConfigEntries()` output
2. **Field types**: String→input, Number→input[type=number], Boolean→checkbox, Enum (accessMode/toolUpdateMode)→select
3. **Exclude keys**: Use existing `CONFIG_EXCLUDE_KEYS` set (name, type, adminPhones, paths, healthPort)
4. **systemPrompt**: Textarea with monospace font, larger
5. **Save handler**: `api.updateConfig(lineName, patch)` → toast success → invalidate line query
6. **Restart warning**: Yellow banner: "Changes take effect after restart"
7. **Wire**: Replace `toast.info('Edit mode coming in Phase 2')` on line 408

### B09: Mode Switching (After B08)
**Files:** `console/src/pages/LineDetail.tsx`

Uses config editor infrastructure — mode is just `{ type: 'passive' | 'chat' | 'agent' }`.

1. **ModeSwitchDialog**: Three buttons (passive/chat/agent), current highlighted, others clickable
2. **Mode descriptions**: Passive="Listen & Store", Chat="Conversation Bot", Agent="Claude Agent"
3. **Confirm flow**: ConfirmDialog with restart warning — "This will restart the instance"
4. **Handler**: `api.updateConfig(name, { type: newMode })` then `api.restart(name)`
5. **Wire**: Replace `toast.info('Mode switching coming in Phase 2')` on line 467

---

## Wave 4 (After B05 pagination)

### B07: Message Search
**Files:** `src/fleet/routes/data.ts`, `src/fleet/index.ts`, `src/fleet/db-reader.ts`, `console/src/pages/LineDetail.tsx`, `console/src/hooks/use-fleet.ts`, `console/src/lib/api.ts`

FTS5 `messages_fts` table already exists with auto-sync triggers.

1. **DB Reader**: Add `searchMessages(name, dbPath, { query, conversationKey?, limit })` using FTS5 MATCH
2. **Fleet endpoint**: `GET /api/lines/:name/search?q=...&conversation_key=...`
3. **API client**: `searchMessages(lineName, query, conversationKey?)`
4. **useSearch hook**: Debounced query (300ms), enabled when query.length >= 2
5. **Search UI**: Input field above message list in HistoryTab. Results replace message list with highlighted matches. Click result scrolls to message in full list.
6. **Highlight**: Wrap matched terms in `<mark>` tags with `background: var(--m-cht-wash)`

---

## Tech Debt (Address in Wave 1)

### TD1: Centralize Timestamp Utility
**Files:** `src/fleet/routes/data.ts`, `src/fleet/routes/feed.ts`, `src/fleet/routes/lines.ts`

1. Add to `src/fleet/log-utils.ts` or new `src/fleet/time-utils.ts`:
   ```typescript
   export function toIsoFromUnix(ts: number): string {
     return new Date(ts > 1e12 ? ts : ts * 1000).toISOString()
   }
   ```
2. Replace all 4 instances of the `> 1e12` guard across routes

### TD2: Split mock-data.ts
**Files:** `console/src/mock-data.ts`

1. Extract `Message`, `ChatItem`, `LineInstance`, `AccessEntry`, `LogEntry`, `Mode`, `Status` interfaces → `console/src/types.ts`
2. Keep mock data generators in `mock-data.ts`, import types from `types.ts`
3. Update all imports across 15+ files

---

## Execution Order

```
Session 1: Wave 1 (B01, B02, B03, B05, B06, B10) + TD1 + TD2
Session 2: Wave 2 (B04) + Wave 3 (B08, B09)
Session 3: Wave 4 (B07) + integration testing + review
```

## Verification Checklist
- [ ] tsc --noEmit: exit 0
- [ ] eslint src/ --max-warnings 0: exit 0
- [ ] vite build: exit 0
- [ ] Each bead: visual verification in browser
- [ ] Auto-scroll still works after changes
- [ ] Send still works after changes
- [ ] Group names still resolve after changes
