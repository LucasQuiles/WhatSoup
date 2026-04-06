# Scheduled Messages & Groups Management — Design Specification

**Date:** 2026-04-06
**Status:** Draft
**Author:** Lucas + Q (brainstorming session)
**Depends on:** Phase 1 spec (SP1-SP4 deployed), Phase 2 spec (SP11 placeholder replaced by this spec)

---

## 1. Problem Statement

The WhatSoup console has two tabs — Scheduled and Groups — that are functional but thin. The Scheduled tab can only list and cancel messages, with no way to create new scheduled messages from the console and no backend scheduling infrastructure (SP11 was a placeholder). The Groups tab is read-only with no management capabilities despite 17 MCP group tools being available on the backend.

This spec delivers three things as a single feature drop:

1. **SP11 backend** — database table, scheduler loop with recurrence support, and 5 MCP tools for scheduled message lifecycle
2. **Scheduled tab** — full composer modal supporting all WhatsApp message types, datetime picker, and recurring schedule configuration
3. **Groups tab** — full admin panel with group detail modal (Info/Participants/Settings tabs), group creation, and participant management

## 2. Architecture

All operations route through the existing MCP proxy pattern:

```
Console UI → Fleet API (HTTP) → MCP socket → Tool handler → Baileys/DB
```

No new architectural patterns introduced. The fleet control-plane adds REST endpoints that proxy to MCP tools, matching every other console feature.

---

## 3. SP11 Backend — Message Scheduling

### 3.1 Database Schema (Migration 14)

```sql
CREATE TABLE scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  chat_name TEXT,
  content_type TEXT NOT NULL DEFAULT 'text',
  payload TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  recurrence TEXT,
  next_run_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  run_count INTEGER DEFAULT 0
);

CREATE INDEX idx_scheduled_pending
  ON scheduled_messages(status, scheduled_at)
  WHERE status = 'pending';

CREATE INDEX idx_scheduled_next_run
  ON scheduled_messages(status, next_run_at)
  WHERE status = 'pending' AND next_run_at IS NOT NULL;
```

**Column semantics:**

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER PK | Auto-increment identifier |
| `chat_jid` | TEXT | Target chat (phone@s.whatsapp.net or group@g.us) |
| `chat_name` | TEXT | Display name cached at creation time |
| `content_type` | TEXT | One of: text, image, video, audio, document, location, contact, poll |
| `payload` | TEXT | JSON envelope — normalized outbound content (see 3.2) |
| `scheduled_at` | INTEGER | Unix timestamp (UTC) for first/only execution |
| `recurrence` | TEXT | NULL for one-shot; cron expression for recurring (e.g., `0 9 * * 1` = Monday 9am) |
| `next_run_at` | INTEGER | Next execution timestamp; recalculated from cron after each run |
| `status` | TEXT | pending, sending, sent, failed, cancelled |
| `created_at` | TEXT | ISO 8601 creation timestamp |
| `sent_at` | TEXT | ISO 8601 timestamp of last successful send |
| `error` | TEXT | Last error message (for failed status) |
| `retry_count` | INTEGER | Attempts so far (max 3 before dead-letter) |
| `run_count` | INTEGER | Total successful sends (meaningful for recurring) |

### 3.2 Payload Envelope

The `payload` column stores a JSON object whose shape depends on `content_type`. Each envelope maps directly to a Baileys `sendMessage` content argument, keeping the scheduler's dispatch logic simple.

```jsonc
// content_type: "text"
{ "text": "Hello world", "mentions": ["jid1@s.whatsapp.net"] }

// content_type: "image"
{ "caption": "Check this out", "mediaPath": "/abs/path/to/file.jpg", "mimetype": "image/jpeg" }

// content_type: "video"
{ "caption": "Watch this", "mediaPath": "/abs/path/to/file.mp4", "mimetype": "video/mp4" }

// content_type: "audio"
{ "mediaPath": "/abs/path/to/file.ogg", "mimetype": "audio/ogg; codecs=opus", "ptt": true }

// content_type: "document"
{ "caption": "Report", "mediaPath": "/abs/path/to/file.pdf", "mimetype": "application/pdf", "fileName": "report.pdf" }

// content_type: "location"
{ "latitude": 40.7128, "longitude": -74.0060, "name": "New York City", "address": "Manhattan, NY" }

// content_type: "contact"
{ "contacts": [{ "displayName": "John Doe", "vcard": "BEGIN:VCARD\nVERSION:3.0\n..." }] }

// content_type: "poll"
{ "pollName": "Lunch?", "pollValues": ["Pizza", "Sushi", "Tacos"], "selectableCount": 1 }
```

Media payloads reference absolute file paths. The scheduler reads the file at send time. If the file no longer exists (e.g., cleaned by media retention), the message fails with a clear error.

### 3.3 Scheduler Loop

New module: `src/core/scheduler.ts`

**Tick interval:** 30 seconds via `setInterval` with `.unref()`.

**Each tick:**

1. Claim due messages atomically:
   ```sql
   UPDATE scheduled_messages
   SET status = 'sending'
   WHERE status = 'pending'
     AND (
       (recurrence IS NULL AND scheduled_at <= ?)
       OR (recurrence IS NOT NULL AND next_run_at <= ?)
     )
   RETURNING *
   ```
   The `sending` status acts as a claim lock preventing double-sends on restart.

2. For each claimed row, dispatch based on `content_type`:
   - `text` → `connection.sendRaw(chatJid, { text, mentions })`
   - `image/video/audio/document` → `connection.sendMedia(chatJid, mediaPath, content)`
   - `location` → `connection.sendRaw(chatJid, { location: payload })`
   - `contact` → `connection.sendRaw(chatJid, { contacts: { contacts: payload.contacts } })`
   - `poll` → `connection.sendRaw(chatJid, { poll: payload })`

3. On success:
   - **One-shot:** `status = 'sent'`, `sent_at = now()`
   - **Recurring:** `run_count++`, `sent_at = now()`, calculate `next_run_at` from cron expression, `status = 'pending'`

4. On failure:
   - `retry_count++`, `error = errorMessage`
   - If `retry_count >= 3`: `status = 'failed'` (dead letter)
   - Otherwise: `status = 'pending'` (will retry next tick)

**Startup recovery:** On process start, reset any rows stuck in `sending` back to `pending` (crashed mid-send):
```sql
UPDATE scheduled_messages SET status = 'pending' WHERE status = 'sending'
```

**Cron parsing:** Use a lightweight cron parser (evaluate `cron-parser` npm package vs. hand-rolled for the 4 common patterns: daily, weekly, monthly, custom). Decision deferred to implementation plan.

### 3.4 MCP Tools (5 new)

All registered in new file `src/mcp/tools/scheduling.ts` using Pattern 1 (options-object).

| Tool | Scope | Params | Returns |
|------|-------|--------|---------|
| `schedule_message` | global | `chat_jid`, `content_type`, `payload` (JSON string), `scheduled_at` (Unix), `recurrence?` (cron string) | `{ id, scheduled_at, recurrence, status }` |
| `list_scheduled` | global | `status?` (filter: pending/sent/failed/cancelled, default: all), `limit?` (default: 50) | `{ scheduled: ScheduledMessage[] }` |
| `get_scheduled` | global | `id` | Full `ScheduledMessage` row |
| `update_scheduled` | global | `id`, plus any updatable fields: `scheduled_at?`, `payload?`, `content_type?`, `recurrence?` | Updated `ScheduledMessage` |
| `cancel_scheduled` | global | `id` | `{ cancelled: true, id }` |

**Validation rules:**
- `schedule_message`: `scheduled_at` must be in the future. `payload` must be valid JSON matching the `content_type` envelope. `recurrence` must be a valid 5-field cron expression.
- `update_scheduled`: only `pending` messages can be updated. Attempting to update sent/failed/cancelled returns an error.
- `cancel_scheduled`: sets status to `cancelled`. Works on `pending` only.

### 3.5 Files to Create

- `src/core/scheduler.ts` — `MessageScheduler` class, tick loop, dispatch logic, cron helpers
- `src/mcp/tools/scheduling.ts` — 5 MCP tools, Zod schemas, Pattern 1 registration

### 3.6 Files to Modify

- `src/core/database.ts` — add MIGRATION_14 for `scheduled_messages` table + indexes
- `src/mcp/register-all.ts` — import and register `registerSchedulingTools`
- `src/main.ts` — create and start `MessageScheduler` after DB init, alongside existing timers

---

## 4. Fleet API Routes

### 4.1 Scheduled Messages (MCP proxy)

New handlers in `src/fleet/routes/mcp-proxy.ts`:

| Method | Route | MCP Tool | Notes |
|--------|-------|----------|-------|
| `GET` | `/api/lines/:name/scheduled` | `list_scheduled` | Existing — enhanced with `?status=` filter |
| `GET` | `/api/lines/:name/scheduled/:id` | `get_scheduled` | New |
| `POST` | `/api/lines/:name/scheduled` | `schedule_message` | New — body: `{ chatJid, contentType, payload, scheduledAt, recurrence? }` |
| `PUT` | `/api/lines/:name/scheduled/:id` | `update_scheduled` | New — body: partial update fields |
| `DELETE` | `/api/lines/:name/scheduled/:id` | `cancel_scheduled` | Existing — enhanced with path param instead of query |

The existing `DELETE` endpoint uses `?id=` query parameter. Migrate to `:id` path parameter for REST consistency. Keep the old query param as a fallback for backward compatibility.

### 4.2 Groups (MCP proxy)

New handlers in `src/fleet/routes/mcp-proxy.ts`:

| Method | Route | MCP Tool | Notes |
|--------|-------|----------|-------|
| `GET` | `/api/lines/:name/groups` | `list_groups` | Existing |
| `GET` | `/api/lines/:name/groups/:jid` | `get_group_metadata` | New — full metadata with participants |
| `POST` | `/api/lines/:name/groups` | `group_create` | New — body: `{ subject, participants }` |
| `DELETE` | `/api/lines/:name/groups/:jid` | `group_leave` | New |
| `PUT` | `/api/lines/:name/groups/:jid/subject` | `group_update_subject` | New |
| `PUT` | `/api/lines/:name/groups/:jid/description` | `group_update_description` | New |
| `POST` | `/api/lines/:name/groups/:jid/participants` | `group_participants_update` | New — body: `{ participants, action }` |
| `PUT` | `/api/lines/:name/groups/:jid/settings` | `group_settings_update` | New — body: `{ setting }` |
| `GET` | `/api/lines/:name/groups/:jid/invite` | `get_group_invite_link` | New |
| `POST` | `/api/lines/:name/groups/:jid/invite/revoke` | `group_revoke_invite` | New |
| `PUT` | `/api/lines/:name/groups/:jid/ephemeral` | `group_toggle_ephemeral` | New — body: `{ expiration }` |
| `PUT` | `/api/lines/:name/groups/:jid/member-add-mode` | `group_member_add_mode` | New — body: `{ mode }` |
| `PUT` | `/api/lines/:name/groups/:jid/join-approval` | `group_join_approval_mode` | New — body: `{ mode }` |
| `GET` | `/api/lines/:name/groups/:jid/requests` | `group_request_participants_list` | New |
| `POST` | `/api/lines/:name/groups/:jid/requests` | `group_request_participants_update` | New — body: `{ participants, action }` |

All handlers follow the same pattern as existing `handleGetGroups` and `handleGetScheduled`: validate instance exists, check MCP socket, proxy call, return result or error.

---

## 5. Console API Client

### 5.1 New Type Definitions (`console/src/types.ts`)

```typescript
// Enhanced ScheduledMessage (replaces existing)
export interface ScheduledMessage {
  id: number;
  chatJid: string;
  chatName?: string;
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'location' | 'contact' | 'poll';
  payload: string;           // JSON string
  scheduledAt: number;        // Unix timestamp
  recurrence?: string;        // Cron expression
  nextRunAt?: number;         // Unix timestamp
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  createdAt: string;
  sentAt?: string;
  error?: string;
  retryCount: number;
  runCount: number;
}

// Enhanced GroupInfo (replaces existing — list_groups returns this)
export interface GroupInfo {
  jid: string;
  subject: string;
  participants: number;       // Participant count from list_groups
  creation?: number;
  desc?: string;
  owner?: string;
}

export interface GroupParticipant {
  id: string;                 // JID
  admin?: 'admin' | 'superadmin';
}

export interface GroupDetail {
  jid: string;
  subject: string;
  desc?: string;
  owner?: string;
  creation?: number;
  participants: GroupParticipant[];
  announce?: boolean;
  locked?: boolean;
  ephemeralDuration?: number;
  inviteLink?: string;
  memberAddMode?: 'all_member_add' | 'admin_add';
  joinApprovalMode?: 'on' | 'off';
  pendingRequests?: { jid: string; requestedAt?: number }[];
}
```

### 5.2 New API Methods (`console/src/lib/api.ts`)

```typescript
// ── Scheduled messages (enhanced) ──

createScheduled: (name: string, data: {
  chatJid: string;
  contentType: string;
  payload: string;
  scheduledAt: number;
  recurrence?: string;
}) =>
  apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),

updateScheduled: (name: string, id: number, data: Partial<{
  scheduledAt: number;
  payload: string;
  contentType: string;
  recurrence: string;
}>) =>
  apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),

getScheduledDetail: (name: string, id: number) =>
  apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled/${id}`),

// ── Groups (new) ──

getGroupDetail: (name: string, jid: string) =>
  apiFetch<GroupDetail>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}`, {
    signal: AbortSignal.timeout(15000),
  }),

createGroup: (name: string, subject: string, participants: string[]) =>
  apiFetch<{ id: string; gid: string }>(`/api/lines/${encodeURIComponent(name)}/groups`, {
    method: 'POST',
    body: JSON.stringify({ subject, participants }),
  }),

leaveGroup: (name: string, jid: string) =>
  apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}`, {
    method: 'DELETE',
  }),

updateGroupSubject: (name: string, jid: string, subject: string) =>
  apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}/subject`, {
    method: 'PUT',
    body: JSON.stringify({ subject }),
  }),

updateGroupDescription: (name: string, jid: string, description?: string) =>
  apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}/description`, {
    method: 'PUT',
    body: JSON.stringify({ description }),
  }),

updateGroupParticipants: (name: string, jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') =>
  apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}/participants`, {
    method: 'POST',
    body: JSON.stringify({ participants, action }),
  }),

updateGroupSettings: (name: string, jid: string, setting: string) =>
  apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}/settings`, {
    method: 'PUT',
    body: JSON.stringify({ setting }),
  }),

getGroupInviteLink: (name: string, jid: string) =>
  apiFetch<{ inviteLink: string; inviteCode: string }>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}/invite`),

revokeGroupInvite: (name: string, jid: string) =>
  apiFetch<{ inviteCode: string }>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}/invite/revoke`, {
    method: 'POST',
  }),

updateGroupEphemeral: (name: string, jid: string, expiration: number) =>
  apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${enc(jid)}/ephemeral`, {
    method: 'PUT',
    body: JSON.stringify({ expiration }),
  }),
```

---

## 6. Console UI — Scheduled Tab

### 6.1 Enhanced Message List

Replace the current flat list with a richer layout:

- **Status badge** per row: pending (yellow), sent (green), failed (red), cancelled (gray)
- **Recurrence indicator**: clock-repeat icon + human-readable schedule ("Every Monday 9am", "Daily at 6pm")
- **Content type icon**: text (MessageSquare), image (Image), video (Film), audio (Mic), document (FileText), location (MapPin), contact (UserPlus), poll (BarChart3)
- **Next run time** for recurring messages
- **Run count** badge for recurring (e.g., "Sent 12 times")
- **Row actions**: Cancel (existing), Edit, Duplicate

Sorting: pending first (by scheduled_at ASC), then sent/failed/cancelled by most recent.

### 6.2 Composer Modal — "New Scheduled Message"

Triggered by a primary action button at the top of the Scheduled tab.

**Modal layout (vertical stack):**

1. **Chat picker** — searchable dropdown. Fetches chat list from `useChats` (existing hook). Shows DMs and groups with name, phone/JID, and group icon differentiation. Supports type-ahead filtering.

2. **Content type selector** — horizontal tab bar: Text | Image | Video | Audio | Document | Location | Contact | Poll. Selecting a type changes the composer form below.

3. **Composer form** (per content type):
   - **Text**: textarea with mention support (@ triggers contact search)
   - **Image/Video/Audio/Document**: server file path input + optional caption textarea. The console runs on the same machine as WhatSoup instances, so the user enters an absolute path to a file already on disk (e.g., `/home/user/media/photo.jpg`). Browser-based file upload is out of scope for v1.
   - **Location**: latitude/longitude number inputs + name/address text fields. Future: map picker widget (out of scope for v1, text inputs sufficient).
   - **Contact**: display name + vcard textarea. Future: contact picker from address book.
   - **Poll**: poll question input + dynamic list of option inputs (add/remove) + selectable count number input.

4. **DateTime picker** — date input + time input. Displays local timezone with conversion to UTC. Validates that the selected time is in the future.

5. **Recurrence toggle** — switch between one-shot and recurring:
   - **One-shot**: no additional config
   - **Recurring**: preset buttons (Daily, Weekly, Monthly) + custom cron expression input for power users. Preset selection auto-fills the cron field. Human-readable preview of the cron expression shown below the input.

6. **Action buttons**: "Schedule" (primary, creates the message) and "Cancel" (secondary, closes modal). Schedule button disabled until all required fields are filled.

**Validation:**
- Chat selection required
- Content type payload must be valid (non-empty text, valid file for media, valid coordinates for location, at least 2 poll options)
- DateTime must be in the future
- Cron expression must be valid 5-field format

### 6.3 Edit Modal

Same layout as the composer, pre-filled with existing message data. Only available for `pending` messages. Calls `PUT /api/lines/:name/scheduled/:id`.

### 6.4 Component Structure

```
ScheduledTab.tsx (enhanced)
├── ScheduledMessageList.tsx        — sorted/filtered message rows
│   └── ScheduledMessageRow.tsx     — single row with status badge, type icon, actions
├── ScheduleComposerModal.tsx       — the creation/edit modal
│   ├── ChatPicker.tsx              — searchable chat dropdown (shared component candidate)
│   ├── ContentTypeSelector.tsx     — horizontal tab bar
│   ├── TextComposer.tsx            — textarea with mentions
│   ├── MediaComposer.tsx           — file input + caption
│   ├── LocationComposer.tsx        — lat/lng/name/address fields
│   ├── ContactComposer.tsx         — displayName + vcard
│   ├── PollComposer.tsx            — question + dynamic options
│   ├── DateTimePicker.tsx          — date + time inputs with UTC conversion
│   └── RecurrenceConfig.tsx        — one-shot/recurring toggle + cron builder
└── scheduled-utils.ts              — cron-to-human-readable, status colors, type icons
```

---

## 7. Console UI — Groups Tab

### 7.1 Enhanced Group List

Replace the current minimal list with:

- **Group avatar placeholder** (colored circle with initials, matching design system)
- **Subject** (group name)
- **Participant count** with Users icon
- **Your role badge**: Admin (shield icon, accent color) or Member (no badge)
- **Description preview** (truncated, 100 chars)
- **Last activity indicator** (if available from chat data)
- **Click handler** → opens Group Detail Modal

Top-level actions:
- **"Create Group" button** → opens creation modal (subject + description + participant picker)

### 7.2 Group Detail Modal

Full-screen-ish modal (max-width 640px, max-height 80vh) with 3 tabs:

**Info Tab:**
- Group subject (editable inline if admin — click to edit, Enter to save)
- Group description (editable inline if admin — textarea, auto-save on blur)
- Creation date (formatted)
- Group owner JID/name
- Invite link section: display link + Copy button + Revoke button (with confirmation)
- Group JID (small, muted — for debugging)

**Participants Tab:**
- Searchable participant list
- Each row: name/JID, role badge (superadmin/admin/member)
- Action buttons per participant (visible if current user is admin):
  - Remove (with confirmation dialog)
  - Promote to admin / Demote from admin (toggle based on current role)
- "Add Participant" button at top → opens contact search picker (reuses `searchContacts` API)
- Pending join requests section (if join approval is on): list with Approve/Reject buttons

**Settings Tab:**
- **Who can send messages**: toggle between "All participants" and "Only admins" (`announcement` / `not_announcement`)
- **Who can edit group info**: toggle between "All participants" and "Only admins" (`locked` / `unlocked`)
- **Who can add members**: toggle between "All participants" and "Only admins" (`all_member_add` / `admin_add`)
- **Join approval**: toggle on/off
- **Disappearing messages**: dropdown — Off, 24 hours, 7 days, 90 days (maps to 0, 86400, 604800, 7776000 seconds)
- **Leave group**: danger button at bottom with confirmation dialog

All settings changes call the corresponding fleet API endpoint and show toast feedback.

### 7.3 Create Group Modal

Simpler modal:
- Subject input (required)
- Description textarea (optional)
- Participant picker: searchable contact list with checkboxes, selected participants shown as chips above. Uses `searchContacts` API.
- Create button (disabled until subject + at least 1 participant)

### 7.4 Component Structure

```
GroupsTab.tsx (enhanced)
├── GroupList.tsx                    — enhanced group cards with click handler
│   └── GroupCard.tsx               — single group row with avatar, role badge
├── GroupDetailModal.tsx            — tabbed modal container
│   ├── GroupInfoTab.tsx            — editable subject/description, invite link
│   ├── GroupParticipantsTab.tsx    — participant list with admin actions
│   │   └── ParticipantRow.tsx      — single participant with action buttons
│   ├── GroupSettingsTab.tsx        — toggles for all group settings
│   └── GroupLeaveConfirm.tsx      — confirmation dialog for leaving
├── CreateGroupModal.tsx            — subject + description + participant picker
└── groups-utils.ts                 — role helpers, setting labels, ephemeral options
```

---

## 8. Shared Components

Two components are used by both tabs and should be extracted to `console/src/components/shared/`:

### 8.1 ChatPicker

Searchable dropdown for selecting a chat (DM or group). Used by the schedule composer.

- Fetches from `useChats` hook (existing)
- Type-ahead filtering by name, phone, or JID
- Group/DM differentiation with icons
- Single-select mode

### 8.2 ContactSearchPicker

Searchable contact picker with multi-select. Used by Create Group modal and Add Participant flow.

- Fetches from `api.searchContacts` on input change (debounced 300ms)
- Multi-select with chip display
- Shows contact name + phone number

---

## 9. Files to Create

### Backend
| File | Purpose |
|------|---------|
| `src/core/scheduler.ts` | `MessageScheduler` class — tick loop, dispatch, cron helpers, startup recovery |
| `src/mcp/tools/scheduling.ts` | 5 MCP tools: schedule_message, list_scheduled, get_scheduled, update_scheduled, cancel_scheduled |

### Console
| File | Purpose |
|------|---------|
| `console/src/components/line-detail/ScheduledMessageList.tsx` | Enhanced message list with status badges and type icons |
| `console/src/components/line-detail/ScheduledMessageRow.tsx` | Single scheduled message row |
| `console/src/components/line-detail/ScheduleComposerModal.tsx` | Creation/edit modal — orchestrates sub-components |
| `console/src/components/line-detail/schedule-composers/TextComposer.tsx` | Text message composer |
| `console/src/components/line-detail/schedule-composers/MediaComposer.tsx` | Media upload + caption |
| `console/src/components/line-detail/schedule-composers/LocationComposer.tsx` | Location fields |
| `console/src/components/line-detail/schedule-composers/ContactComposer.tsx` | Contact vcard composer |
| `console/src/components/line-detail/schedule-composers/PollComposer.tsx` | Poll question + options |
| `console/src/components/line-detail/schedule-composers/ContentTypeSelector.tsx` | Horizontal type tabs |
| `console/src/components/line-detail/schedule-composers/DateTimePicker.tsx` | Date + time with UTC conversion |
| `console/src/components/line-detail/schedule-composers/RecurrenceConfig.tsx` | Cron builder |
| `console/src/components/line-detail/scheduled-utils.ts` | Cron parsing, status colors, type icons |
| `console/src/components/line-detail/GroupList.tsx` | Enhanced group cards |
| `console/src/components/line-detail/GroupCard.tsx` | Single group row |
| `console/src/components/line-detail/GroupDetailModal.tsx` | Tabbed detail modal |
| `console/src/components/line-detail/GroupInfoTab.tsx` | Info tab (editable subject/desc, invite link) |
| `console/src/components/line-detail/GroupParticipantsTab.tsx` | Participant list with actions |
| `console/src/components/line-detail/ParticipantRow.tsx` | Single participant row |
| `console/src/components/line-detail/GroupSettingsTab.tsx` | Group settings toggles |
| `console/src/components/line-detail/CreateGroupModal.tsx` | Group creation modal |
| `console/src/components/line-detail/groups-utils.ts` | Role helpers, setting labels |
| `console/src/components/shared/ChatPicker.tsx` | Searchable chat dropdown |
| `console/src/components/shared/ContactSearchPicker.tsx` | Multi-select contact picker |

## 10. Files to Modify

### Backend
| File | Change |
|------|--------|
| `src/core/database.ts` | Add MIGRATION_14 — `scheduled_messages` table + indexes |
| `src/mcp/register-all.ts` | Import and register `registerSchedulingTools` |
| `src/main.ts` | Create and start `MessageScheduler` after DB init |
| `src/fleet/routes/mcp-proxy.ts` | Add 15 new route handlers (4 scheduled, 11 groups) |
| `src/fleet/routes/index.ts` (or router file) | Register new routes in the HTTP router |

### Console
| File | Change |
|------|--------|
| `console/src/types.ts` | Update `ScheduledMessage` and `GroupInfo` interfaces; add `GroupDetail`, `GroupParticipant` |
| `console/src/lib/api.ts` | Add ~12 new API methods for scheduled CRUD and group management |
| `console/src/components/line-detail/ScheduledTab.tsx` | Rewrite to use `ScheduledMessageList` + composer modal trigger |
| `console/src/components/line-detail/GroupsTab.tsx` | Rewrite to use `GroupList` + detail modal + create button |

---

## 11. Testing Strategy

### Backend Tests
- **Scheduler unit tests**: tick logic, retry/dead-letter, recurring recalculation, startup recovery, cron parsing
- **MCP tool tests**: schedule_message validation (future time, valid payload), update/cancel only pending, list with status filter
- **Migration test**: MIGRATION_14 applies cleanly, indexes created

### Console Tests
- **Component tests**: modal open/close, form validation, chat picker filtering, content type switching
- **API integration**: mock fleet responses for each new endpoint

### Manual Verification
- Schedule a text message 1 minute in the future → verify it sends
- Schedule a recurring daily message → verify it fires and recalculates next_run_at
- Cancel a pending message → verify it does not send
- Create a group → verify it appears in WhatsApp
- Manage participants → verify changes reflect in WhatsApp
- Toggle group settings → verify changes persist

---

## 12. Success Criteria

1. Users can create scheduled messages from the console with any WhatsApp content type
2. Messages send at the scheduled time with <= 30 second delay (tick interval)
3. Recurring messages fire on schedule and recalculate the next run
4. Failed messages retry 3 times before dead-lettering with a visible error
5. Users can view, edit, duplicate, and cancel scheduled messages
6. Users can view all groups with participant counts and their admin role
7. Users can create new groups with subject, description, and initial participants
8. Users can manage group participants (add, remove, promote, demote) from the console
9. Users can modify group settings (announcement, locked, ephemeral, member-add, join-approval)
10. Users can view and manage invite links (copy, revoke)
11. Users can leave groups with confirmation
12. All operations go through the MCP proxy pattern — no new architectural patterns
13. All new MCP tools follow existing WhatSoup patterns (Zod schema, scope, replay policy)
14. Only MIGRATION_14 added — no other schema changes
15. No new npm dependencies in the core WhatSoup package (cron parser decision deferred to plan)

---

## 13. Dependencies

- **Phase 1 (SP1-SP4):** Must be deployed — migrations 12-13 provide the `media_path` column referenced by media payload scheduling
- **Existing MCP tools:** All 17 group tools in `src/mcp/tools/groups.ts` are already implemented and tested
- **Existing console infrastructure:** `useChats`, `searchContacts` API, toast system, modal patterns, design system classes

## 14. Out of Scope

- **Media upload from browser to instance** — v1 uses absolute file paths already on the server. Browser-initiated media upload is a separate feature.
- **Map picker widget** — location composer uses text inputs for coordinates. Interactive map deferred.
- **Contact picker from address book** — contact composer uses manual vcard input. Address book integration deferred.
- **WebSocket push** — remains a Phase 4 candidate. Scheduled tab uses polling (30s) for status updates.
- **Bulk scheduling** — no CSV import or batch schedule. One message at a time.
- **Group analytics** — no message volume or activity stats per group. Read-only from WhatsApp metadata.
