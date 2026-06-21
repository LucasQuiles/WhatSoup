# Scheduled Messages & Groups Management — Implementation Plan

**Status:** completed - scheduled-message and WhatsApp group management surfaces shipped; current API/tool docs are canonical.
**Superseded by:** `docs/tools.md`, `docs/public-surface.md`, `docs/console-guide.md`, and the live source files named below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the SP11 scheduling backend (add recurrence, missing tools) and build rich console UI for both the Scheduled and Groups tabs.

**Architecture:** All operations route through the existing MCP proxy pattern: Console → Fleet API (HTTP) → MCP socket → tool handler → Baileys/DB. The fleet router in `src/fleet/index.ts` uses a typed dispatch map (`RouteParamsByHandler` + `handlers` object + `ROUTES` regex array). New routes need entries in all three locations plus `NAME_ROUTE_HANDLERS`. Backend MCP tools use `ToolRegistry.register()` with Zod schemas. Console uses React 19 + TanStack Query + Tailwind CSS + design system tokens (`c-btn`, `c-card`, `var(--sp-*)`, `var(--color-*)`, `var(--b1)`).

**Tech Stack:** TypeScript, Node.js >=23.10.0, SQLite (better-sqlite3), Baileys, React 19, Vite, TanStack Query, Tailwind CSS 4, lucide-react, vitest

**Spec:** `docs/superpowers/specs/2026-04-06-scheduled-groups-tabs-design.md`

---

## What Already Exists (Do NOT Rebuild)

The following SP11 components are already implemented and tested:

- **Migration 14** (`src/core/database.ts:460-476`): `scheduled_messages` table with `id`, `chat_jid`, `content_type`, `payload`, `scheduled_at`, `status`, `created_at`, `sent_at`, `error`, `retry_count`
- **Migration 16** (`src/core/database.ts:489-491`): `media_blob BLOB` column on `scheduled_messages`
- **`src/core/scheduler.ts`**: `MessageScheduler` class with tick loop, retry (max 3), `recoverStale()`, text + media dispatch via `connection.sendRaw`/`connection.sendMedia`
- **`src/mcp/tools/scheduling.ts`**: 3 tools: `schedule_message` (text + media from file path), `list_scheduled` (with chat-scoped access control), `cancel_scheduled`
- **`src/mcp/register-all.ts:28,60`**: `registerSchedulingTools` already imported and called
- **`src/main.ts:646-652`**: Scheduler started with 60s interval, `recoverStale()` on boot
- **Fleet routes** (`src/fleet/index.ts:211-214`): `GET /scheduled`, `DELETE /scheduled`, `GET /groups`, `GET /contacts/search`
- **Fleet handlers** (`src/fleet/routes/mcp-proxy.ts`): `handleGetScheduled`, `handleCancelScheduled`, `handleGetGroups`, `handleSearchContacts`
- **Console** (`console/src/components/line-detail/ScheduledTab.tsx`): Basic list + cancel UI
- **Console** (`console/src/components/line-detail/GroupsTab.tsx`): Basic read-only group list
- **Tests** (`tests/mcp/tools/scheduling.test.ts`): 7 tests for schedule/list/cancel
- **Tests** (`tests/mcp/tools/groups.test.ts`): Registration + basic call tests for all 17 group tools

## File Structure — New & Modified

### New Files (Backend)
| File | Responsibility |
|------|---------------|
| `src/core/cron.ts` | Lightweight cron parser: `parseCron()`, `nextCronRun()`, `cronToHuman()` |

### New Files (Console)
| File | Responsibility |
|------|---------------|
| `console/src/components/shared/ChatPicker.tsx` | Searchable chat dropdown (single-select) |
| `console/src/components/shared/ContactSearchPicker.tsx` | Multi-select contact picker with chips |
| `console/src/components/line-detail/scheduled-utils.ts` | Status colors, content type icons, cron-to-human display |
| `console/src/components/line-detail/ScheduledMessageRow.tsx` | Single scheduled message row with status badge, type icon, actions |
| `console/src/components/line-detail/ScheduleComposerModal.tsx` | Schedule creation/edit modal with all content types |
| `console/src/components/line-detail/GroupCard.tsx` | Single group card with avatar, role badge |
| `console/src/components/line-detail/GroupDetailModal.tsx` | Tabbed group detail modal (Info/Participants/Settings) |
| `console/src/components/line-detail/CreateGroupModal.tsx` | Group creation modal |
| `console/src/components/line-detail/groups-utils.ts` | Role helpers, setting labels, ephemeral option mapping |

### Modified Files (Backend)
| File | Change |
|------|--------|
| `src/core/database.ts` | Add MIGRATION_17: `recurrence TEXT`, `next_run_at INTEGER`, `run_count INTEGER DEFAULT 0`, `chat_name TEXT` columns |
| `src/core/scheduler.ts` | Import cron helpers; add recurrence query (`next_run_at`); on recurring success recalculate `next_run_at` instead of marking `sent` |
| `src/mcp/tools/scheduling.ts` | Add `recurrence`/`chat_name` to `schedule_message` schema; add `get_scheduled` and `update_scheduled` tools; add location/contact/poll to `buildScheduledPayload` |
| `src/fleet/routes/mcp-proxy.ts` | Add POST/PUT/GET-by-id scheduled handlers; add 11 group management handlers |
| `src/fleet/index.ts` | Add `NameIdRouteParams` type; register ~15 new route entries in `RouteParamsByHandler`, `handlers`, `NAME_ROUTE_HANDLERS`, and `ROUTES` |

### Modified Files (Console)
| File | Change |
|------|--------|
| `console/src/types.ts` | Update `ScheduledMessage`, `GroupInfo`; add `GroupDetail`, `GroupParticipant` |
| `console/src/lib/api.ts` | Add ~15 new API methods (scheduled CRUD + group management) |
| `console/src/components/line-detail/ScheduledTab.tsx` | Rewrite: message list with status/type/recurrence, "New" button → composer modal |
| `console/src/components/line-detail/GroupsTab.tsx` | Rewrite: enhanced cards with click → detail modal, "Create" button |

### New Test Files
| File | Tests |
|------|-------|
| `tests/core/cron.test.ts` | Cron parsing, next-run calculation, human-readable output |
| `tests/core/scheduler-recurrence.test.ts` | Recurring message tick, next_run_at recalculation, cancel stops recurrence |
| `tests/mcp/tools/scheduling-extended.test.ts` | `get_scheduled`, `update_scheduled`, location/contact/poll payloads |

---

## Task 1: Cron Parser Module

**Files:**
- Create: `src/core/cron.ts`
- Create: `tests/core/cron.test.ts`

- [ ] **Step 1: Write failing tests for cron parser**

```typescript
// tests/core/cron.test.ts
import { describe, expect, it } from 'vitest';
import { parseCron, nextCronRun, cronToHuman } from '../../src/core/cron.ts';

describe('cron parser', () => {
  describe('parseCron', () => {
    it('parses a valid 5-field cron expression', () => {
      const parsed = parseCron('30 9 * * 1');
      expect(parsed).toEqual({ minute: [30], hour: [9], dayOfMonth: null, month: null, dayOfWeek: [1] });
    });

    it('parses wildcard fields as null', () => {
      const parsed = parseCron('* * * * *');
      expect(parsed).toEqual({ minute: null, hour: null, dayOfMonth: null, month: null, dayOfWeek: null });
    });

    it('parses comma-separated values', () => {
      const parsed = parseCron('0 9,18 * * *');
      expect(parsed).toEqual({ minute: [0], hour: [9, 18], dayOfMonth: null, month: null, dayOfWeek: null });
    });

    it('parses step values', () => {
      const parsed = parseCron('*/15 * * * *');
      expect(parsed).toEqual({ minute: [0, 15, 30, 45], hour: null, dayOfMonth: null, month: null, dayOfWeek: null });
    });

    it('parses range values', () => {
      const parsed = parseCron('0 9-17 * * *');
      expect(parsed).toEqual({ minute: [0], hour: [9, 10, 11, 12, 13, 14, 15, 16, 17], dayOfMonth: null, month: null, dayOfWeek: null });
    });

    it('throws on invalid cron expression', () => {
      expect(() => parseCron('invalid')).toThrow();
      expect(() => parseCron('1 2 3')).toThrow();
      expect(() => parseCron('60 25 * * *')).toThrow();
    });
  });

  describe('nextCronRun', () => {
    it('returns next Monday 9:30 AM from a Sunday', () => {
      // Sunday 2026-04-05 10:00 UTC
      const from = Math.floor(new Date('2026-04-05T10:00:00Z').getTime() / 1000);
      const next = nextCronRun('30 9 * * 1', from);
      const date = new Date(next * 1000);
      expect(date.getUTCDay()).toBe(1); // Monday
      expect(date.getUTCHours()).toBe(9);
      expect(date.getUTCMinutes()).toBe(30);
    });

    it('returns next day for daily cron', () => {
      // 2026-04-05 18:30 UTC
      const from = Math.floor(new Date('2026-04-05T18:30:00Z').getTime() / 1000);
      const next = nextCronRun('0 18 * * *', from);
      const date = new Date(next * 1000);
      expect(date.getUTCDate()).toBe(6); // next day
      expect(date.getUTCHours()).toBe(18);
      expect(date.getUTCMinutes()).toBe(0);
    });

    it('returns same day later hour if not yet passed', () => {
      // 2026-04-05 08:00 UTC, cron is 18:00 daily
      const from = Math.floor(new Date('2026-04-05T08:00:00Z').getTime() / 1000);
      const next = nextCronRun('0 18 * * *', from);
      const date = new Date(next * 1000);
      expect(date.getUTCDate()).toBe(5); // same day
      expect(date.getUTCHours()).toBe(18);
    });
  });

  describe('cronToHuman', () => {
    it('formats daily cron', () => {
      expect(cronToHuman('0 9 * * *')).toBe('Daily at 09:00');
    });

    it('formats weekly cron', () => {
      expect(cronToHuman('0 9 * * 1')).toBe('Weekly on Monday at 09:00');
    });

    it('formats monthly cron', () => {
      expect(cronToHuman('0 9 1 * *')).toBe('Monthly on day 1 at 09:00');
    });

    it('formats every-15-minutes cron', () => {
      expect(cronToHuman('*/15 * * * *')).toBe('Every 15 minutes');
    });

    it('returns raw expression for complex crons', () => {
      expect(cronToHuman('30 9,18 * * 1,3,5')).toBe('Cron: 30 9,18 * * 1,3,5');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/core/cron.test.ts 2>&1 | tail -5`
Expected: FAIL — module `../../src/core/cron.ts` not found

- [ ] **Step 3: Implement cron parser**

```typescript
// src/core/cron.ts
// Lightweight 5-field cron parser. No npm dependencies.

export interface CronFields {
  minute: number[] | null;  // null = wildcard
  hour: number[] | null;
  dayOfMonth: number[] | null;
  month: number[] | null;
  dayOfWeek: number[] | null;  // 0=Sunday, 1=Monday, ... 6=Saturday
}

const FIELD_RANGES: [number, number][] = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day of month
  [1, 12],   // month
  [0, 6],    // day of week
];

function parseField(field: string, [min, max]: [number, number]): number[] | null {
  if (field === '*') return null;

  // Step: */N or M-N/S
  if (field.includes('/')) {
    const [rangePart, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${field}`);
    const start = rangePart === '*' ? min : parseInt(rangePart, 10);
    const values: number[] = [];
    for (let i = start; i <= max; i += step) values.push(i);
    return values;
  }

  // Comma-separated: 1,3,5
  if (field.includes(',')) {
    return field.split(',').map((v) => {
      const n = parseInt(v.trim(), 10);
      if (isNaN(n) || n < min || n > max) throw new Error(`Value ${v} out of range [${min},${max}]`);
      return n;
    });
  }

  // Range: 9-17
  if (field.includes('-')) {
    const [startStr, endStr] = field.split('-');
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid range: ${field}`);
    }
    const values: number[] = [];
    for (let i = start; i <= end; i++) values.push(i);
    return values;
  }

  // Single value
  const n = parseInt(field, 10);
  if (isNaN(n) || n < min || n > max) throw new Error(`Value ${field} out of range [${min},${max}]`);
  return [n];
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expression}"`);

  return {
    minute: parseField(parts[0], FIELD_RANGES[0]),
    hour: parseField(parts[1], FIELD_RANGES[1]),
    dayOfMonth: parseField(parts[2], FIELD_RANGES[2]),
    month: parseField(parts[3], FIELD_RANGES[3]),
    dayOfWeek: parseField(parts[4], FIELD_RANGES[4]),
  };
}

/** Calculate the next run time after `afterUnix` (UTC unix seconds). Returns UTC unix seconds. */
export function nextCronRun(expression: string, afterUnix: number): number {
  const fields = parseCron(expression);
  // Start from the next minute after `afterUnix`
  const start = new Date((afterUnix + 60) * 1000);
  start.setUTCSeconds(0, 0);

  // Brute-force search forward, minute by minute, capped at 366 days
  const maxIterations = 366 * 24 * 60;
  const cursor = new Date(start);

  for (let i = 0; i < maxIterations; i++) {
    const minute = cursor.getUTCMinutes();
    const hour = cursor.getUTCHours();
    const dayOfMonth = cursor.getUTCDate();
    const month = cursor.getUTCMonth() + 1; // JS months are 0-based
    const dayOfWeek = cursor.getUTCDay();

    const matchMinute = fields.minute === null || fields.minute.includes(minute);
    const matchHour = fields.hour === null || fields.hour.includes(hour);
    const matchDom = fields.dayOfMonth === null || fields.dayOfMonth.includes(dayOfMonth);
    const matchMonth = fields.month === null || fields.month.includes(month);
    const matchDow = fields.dayOfWeek === null || fields.dayOfWeek.includes(dayOfWeek);

    if (matchMinute && matchHour && matchDom && matchMonth && matchDow) {
      return Math.floor(cursor.getTime() / 1000);
    }

    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  throw new Error(`No matching cron time found within 366 days for: ${expression}`);
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Convert a cron expression to a human-readable string. Best-effort for common patterns. */
export function cronToHuman(expression: string): string {
  const fields = parseCron(expression);
  const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;

  // Every N minutes: */N * * * *
  if (minute !== null && hour === null && dayOfMonth === null && month === null && dayOfWeek === null) {
    if (minute.length > 1 && minute[0] === 0) {
      const step = minute[1] - minute[0];
      const isStep = minute.every((v, i) => v === i * step);
      if (isStep) return `Every ${step} minutes`;
    }
  }

  // Format time part
  const timeStr = (h: number[], m: number[]) => {
    if (h.length === 1 && m.length === 1) {
      return `${String(h[0]).padStart(2, '0')}:${String(m[0]).padStart(2, '0')}`;
    }
    return null;
  };

  if (hour !== null && minute !== null) {
    const time = timeStr(hour, minute);
    if (time) {
      // Daily: 0 9 * * *
      if (dayOfMonth === null && month === null && dayOfWeek === null) {
        return `Daily at ${time}`;
      }
      // Weekly: 0 9 * * 1
      if (dayOfMonth === null && month === null && dayOfWeek !== null && dayOfWeek.length === 1) {
        return `Weekly on ${DAY_NAMES[dayOfWeek[0]]} at ${time}`;
      }
      // Monthly: 0 9 1 * *
      if (dayOfMonth !== null && dayOfMonth.length === 1 && month === null && dayOfWeek === null) {
        return `Monthly on day ${dayOfMonth[0]} at ${time}`;
      }
    }
  }

  // Fallback: show raw
  return `Cron: ${expression}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/core/cron.test.ts 2>&1 | tail -5`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add src/core/cron.ts tests/core/cron.test.ts && git commit -m "feat(scheduler): add lightweight cron parser with next-run calculation"
```

---

## Task 2: Migration 17 — Recurrence Columns

**Files:**
- Modify: `src/core/database.ts:491` (after Migration 16)
- Create: `tests/core/migration-17.test.ts`

- [ ] **Step 1: Write failing test for migration**

```typescript
// tests/core/migration-17.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';

describe('migration 17 — recurrence columns', () => {
  let db: Database;

  afterEach(() => { db.raw.close(); });

  it('adds recurrence, next_run_at, run_count, and chat_name columns', () => {
    db = new Database(':memory:');
    db.open();

    // Insert a row using the new columns
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, recurrence, next_run_at, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'Test Chat', 'text', '{"text":"hi"}', 1700000000, '0 9 * * 1', 1700086400, 0);

    const row = db.raw.prepare('SELECT chat_name, recurrence, next_run_at, run_count FROM scheduled_messages WHERE id = 1').get() as {
      chat_name: string;
      recurrence: string;
      next_run_at: number;
      run_count: number;
    };

    expect(row.chat_name).toBe('Test Chat');
    expect(row.recurrence).toBe('0 9 * * 1');
    expect(row.next_run_at).toBe(1700086400);
    expect(row.run_count).toBe(0);
  });

  it('existing rows have NULL recurrence and next_run_at, 0 run_count', () => {
    db = new Database(':memory:');
    db.open();

    // Row inserted by earlier migration has no recurrence columns populated
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at)
       VALUES (?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"old"}', 1700000000);

    const row = db.raw.prepare('SELECT recurrence, next_run_at, run_count FROM scheduled_messages WHERE id = 1').get() as {
      recurrence: string | null;
      next_run_at: number | null;
      run_count: number;
    };

    expect(row.recurrence).toBeNull();
    expect(row.next_run_at).toBeNull();
    expect(row.run_count).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/core/migration-17.test.ts 2>&1 | tail -5`
Expected: FAIL — columns don't exist yet

- [ ] **Step 3: Add Migration 17 to database.ts**

Insert after line 491 (after Migration 16's closing `]`):

```typescript
  [17, (db: DatabaseSync) => {
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN chat_name TEXT`);
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN recurrence TEXT`);
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN next_run_at INTEGER`);
    db.exec(`ALTER TABLE scheduled_messages ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_next_run ON scheduled_messages(status, next_run_at) WHERE status = 'pending' AND next_run_at IS NOT NULL`);
  }],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/core/migration-17.test.ts 2>&1 | tail -5`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add src/core/database.ts tests/core/migration-17.test.ts && git commit -m "feat(scheduler): migration 17 — add recurrence, next_run_at, run_count, chat_name columns"
```

---

## Task 3: Scheduler Recurrence Support

**Files:**
- Modify: `src/core/scheduler.ts`
- Create: `tests/core/scheduler-recurrence.test.ts`

- [ ] **Step 1: Write failing tests for recurrence**

```typescript
// tests/core/scheduler-recurrence.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { MessageScheduler } from '../../src/core/scheduler.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function mockConnection(): ConnectionManager {
  return {
    sendRaw: vi.fn().mockResolvedValue({ key: { id: 'msg1' } }),
    sendMedia: vi.fn().mockResolvedValue({ key: { id: 'msg2' } }),
  } as unknown as ConnectionManager;
}

describe('scheduler recurrence', () => {
  let db: Database;
  let conn: ConnectionManager;
  let scheduler: MessageScheduler;

  beforeEach(() => {
    db = makeDb();
    conn = mockConnection();
    scheduler = new MessageScheduler(db, conn, { intervalMs: 60_000, maxRetries: 3 });
  });

  afterEach(() => { db.raw.close(); });

  it('recurring message stays pending after send with updated next_run_at and run_count', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, run_count, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"weekly update"}', now - 120, '0 9 * * 1', now - 60, 0, 'pending');

    await scheduler.tick();

    const row = db.raw.prepare('SELECT status, run_count, next_run_at, sent_at FROM scheduled_messages WHERE id = 1').get() as {
      status: string; run_count: number; next_run_at: number; sent_at: number;
    };

    expect(row.status).toBe('pending'); // stays pending for next run
    expect(row.run_count).toBe(1);
    expect(row.next_run_at).toBeGreaterThan(now); // next run in the future
    expect(row.sent_at).toBeGreaterThan(0);
    expect(conn.sendRaw).toHaveBeenCalledWith('123@s.whatsapp.net', { text: 'weekly update' });
  });

  it('one-shot message still transitions to sent', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"once"}', now - 60, 'pending');

    await scheduler.tick();

    const row = db.raw.prepare('SELECT status FROM scheduled_messages WHERE id = 1').get() as { status: string };
    expect(row.status).toBe('sent');
  });

  it('cancelled recurring message does not send', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"nope"}', now - 120, '0 9 * * *', now - 60, 'cancelled');

    await scheduler.tick();

    expect(conn.sendRaw).not.toHaveBeenCalled();
  });

  it('recurring message that fails still retries', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, recurrence, next_run_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('123@s.whatsapp.net', 'text', '{"text":"flaky"}', now - 120, '0 9 * * *', now - 60, 'pending', 0);

    (conn.sendRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'));
    await scheduler.tick();

    const row = db.raw.prepare('SELECT status, retry_count FROM scheduled_messages WHERE id = 1').get() as { status: string; retry_count: number };
    expect(row.status).toBe('pending'); // will retry
    expect(row.retry_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/core/scheduler-recurrence.test.ts 2>&1 | tail -5`
Expected: FAIL — recurring message gets marked `sent` instead of staying `pending`

- [ ] **Step 3: Update scheduler to support recurrence**

In `src/core/scheduler.ts`, add the import at the top:

```typescript
import { nextCronRun } from './cron.ts';
```

Replace the candidate query in `tick()` (around line 69-75) to also check `next_run_at`:

```typescript
    const candidates = this.db.raw
      .prepare(
        `SELECT id, chat_jid, content_type, payload, retry_count, media_blob
         FROM scheduled_messages
         WHERE status = 'pending'
           AND (
             (recurrence IS NULL AND scheduled_at <= ?)
             OR (recurrence IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?)
           )`,
      )
      .all(now, now) as unknown as ScheduledRow[];
```

Add `recurrence` and `run_count` to the `ScheduledRow` interface:

```typescript
interface ScheduledRow {
  id: number;
  chat_jid: string;
  content_type: string;
  payload: string;
  retry_count: number;
  media_blob: Uint8Array | null;
  recurrence: string | null;
  run_count: number;
}
```

Update the candidate SELECT to include the new columns:

```typescript
         FROM scheduled_messages
         WHERE status = 'pending'
```
must select `recurrence, run_count` too. Update both the candidate and re-fetch queries to `SELECT id, chat_jid, content_type, payload, retry_count, media_blob, recurrence, run_count`.

Replace the success handler (around line 101-108) to branch on recurrence:

```typescript
        await this.executeSend(row);
        if (row.recurrence) {
          // Recurring: update next_run_at, increment run_count, stay pending
          const nextRun = nextCronRun(row.recurrence, Math.floor(Date.now() / 1000));
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'pending', sent_at = ?, run_count = ?, next_run_at = ?
               WHERE id = ?`,
            )
            .run(Math.floor(Date.now() / 1000), row.run_count + 1, nextRun, row.id);
          log.info({ id: row.id, chatJid: row.chat_jid, nextRun }, 'scheduler: recurring message sent, next run scheduled');
        } else {
          // One-shot: mark sent
          this.db.raw
            .prepare(
              `UPDATE scheduled_messages
               SET status = 'sent', sent_at = ?
               WHERE id = ?`,
            )
            .run(Math.floor(Date.now() / 1000), row.id);
          log.info({ id: row.id, chatJid: row.chat_jid }, 'scheduler: message sent');
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/core/scheduler-recurrence.test.ts 2>&1 | tail -5`
Expected: All tests PASS

- [ ] **Step 5: Run existing scheduler tests to check for regressions**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/mcp/tools/scheduling.test.ts 2>&1 | tail -5`
Expected: All existing tests PASS

- [ ] **Step 6: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add src/core/scheduler.ts tests/core/scheduler-recurrence.test.ts && git commit -m "feat(scheduler): add recurrence support with cron-based next_run_at calculation"
```

---

## Task 4: Extended MCP Scheduling Tools

**Files:**
- Modify: `src/mcp/tools/scheduling.ts`
- Create: `tests/mcp/tools/scheduling-extended.test.ts`

- [ ] **Step 1: Write failing tests for new tools**

```typescript
// tests/mcp/tools/scheduling-extended.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerSchedulingTools } from '../../../src/mcp/tools/scheduling.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

function makeDb(): Database { const db = new Database(':memory:'); db.open(); return db; }
function globalSession(): SessionContext { return { tier: 'global' }; }

describe('extended scheduling tools', () => {
  let registry: ToolRegistry;
  let db: Database;

  beforeEach(() => {
    registry = new ToolRegistry();
    db = makeDb();
    registerSchedulingTools(registry, { db });
  });

  afterEach(() => { db.raw.close(); });

  describe('get_scheduled', () => {
    it('returns a single scheduled message by ID', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'Test', 'text', '{"text":"hi"}', 1700000000, 'pending');

      const result = await registry.call('get_scheduled', { id: 1 }, globalSession());
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.id).toBe(1);
      expect(body.chatJid).toBe('123@s.whatsapp.net');
      expect(body.chatName).toBe('Test');
    });

    it('returns error for non-existent ID', async () => {
      const result = await registry.call('get_scheduled', { id: 999 }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  describe('update_scheduled', () => {
    it('updates scheduled_at on a pending message', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'text', '{"text":"hi"}', future, 'pending');

      const newTime = future + 3600;
      const result = await registry.call('update_scheduled', { id: 1, scheduled_at: newTime }, globalSession());
      expect(result.isError).toBeUndefined();

      const row = db.raw.prepare('SELECT scheduled_at FROM scheduled_messages WHERE id = 1').get() as { scheduled_at: number };
      expect(row.scheduled_at).toBe(newTime);
    });

    it('rejects update on a sent message', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'text', '{"text":"hi"}', 1700000000, 'sent');

      const result = await registry.call('update_scheduled', { id: 1, scheduled_at: 1800000000 }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('can add recurrence to an existing one-shot message', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'text', '{"text":"hi"}', future, 'pending');

      const result = await registry.call('update_scheduled', { id: 1, recurrence: '0 9 * * *' }, globalSession());
      expect(result.isError).toBeUndefined();

      const row = db.raw.prepare('SELECT recurrence, next_run_at FROM scheduled_messages WHERE id = 1').get() as { recurrence: string; next_run_at: number };
      expect(row.recurrence).toBe('0 9 * * *');
      expect(row.next_run_at).toBeGreaterThan(0);
    });
  });

  describe('schedule_message with recurrence', () => {
    it('creates a recurring scheduled message with next_run_at', async () => {
      const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
      const result = await registry.call(
        'schedule_message',
        { chatJid: '123@s.whatsapp.net', scheduled_at: scheduledAt, text: 'weekly', recurrence: '0 9 * * 1' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      const row = db.raw.prepare('SELECT recurrence, next_run_at FROM scheduled_messages WHERE id = 1').get() as { recurrence: string; next_run_at: number };
      expect(row.recurrence).toBe('0 9 * * 1');
      expect(row.next_run_at).toBe(scheduledAt); // first run = scheduled_at
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/mcp/tools/scheduling-extended.test.ts 2>&1 | tail -5`
Expected: FAIL — `get_scheduled` and `update_scheduled` not registered

- [ ] **Step 3: Add `get_scheduled`, `update_scheduled`, recurrence, and location/contact/poll support to `scheduling.ts`**

**Note:** The existing `buildScheduledPayload()` only handles text + file-based media. The spec requires location, contact, and poll support. Extend the schema and payload builder for these types. For non-media types (location, contact, poll), store the payload directly as JSON — no `media_blob` needed. The scheduler's `executeSend` already calls `connection.sendRaw(chatJid, payload)` for text, which works for any Baileys content object. Add new content_type branches: location stores `{ location: { degreesLatitude, degreesLongitude, name, address } }`, contact stores `{ contacts: { contacts: [...] } }`, poll stores `{ poll: { name, values, selectableCount } }`.

Add to the `ScheduleMessageSchema` (around line 38):

```typescript
  recurrence: z.string().optional().describe('5-field cron expression for recurring messages (e.g., "0 9 * * 1" for Monday 9am)'),
  chatName: z.string().optional().describe('Display name for the target chat (cached for console display)'),
```

Add these schemas after `CancelScheduledSchema`:

```typescript
const GetScheduledSchema = z.object({
  id: z.number().int().positive(),
});

const UpdateScheduledSchema = z.object({
  id: z.number().int().positive(),
  scheduled_at: z.number().int().optional(),
  text: z.string().optional(),
  recurrence: z.string().optional(),
});
```

Update `ScheduledMessageRow` interface to include new columns:

```typescript
interface ScheduledMessageRow {
  id: number;
  chat_jid: string;
  chat_name: string | null;
  content_type: string;
  payload: string;
  scheduled_at: number;
  recurrence: string | null;
  next_run_at: number | null;
  run_count: number;
  status: string;
  created_at: number;
  sent_at: number | null;
  error: string | null;
  retry_count: number;
}
```

Update `rowToScheduledMessage` to include new fields:

```typescript
function rowToScheduledMessage(row: ScheduledMessageRow) {
  return {
    id: row.id,
    chatJid: row.chat_jid,
    chatName: row.chat_name,
    contentType: row.content_type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    scheduledAt: row.scheduled_at,
    recurrence: row.recurrence,
    nextRunAt: row.next_run_at,
    runCount: row.run_count,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    error: row.error,
    retryCount: row.retry_count,
  };
}
```

In the `schedule_message` handler, after the INSERT, add recurrence handling:

```typescript
      const { contentType, payload, mediaBlob } = buildScheduledPayload(parsed, session);
      const nextRunAt = parsed.recurrence ? parsed.scheduled_at : null;
      const result = db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, recurrence, next_run_at, status, media_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(parsed.chatJid, parsed.chatName ?? null, contentType, JSON.stringify(payload), parsed.scheduled_at, parsed.recurrence ?? null, nextRunAt, mediaBlob);
```

Add the two new tool registrations at the end of `registerSchedulingTools`, before the closing `}`:

```typescript
  registry.register({
    name: 'get_scheduled',
    description: 'Get details of a single scheduled message by ID.',
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    schema: GetScheduledSchema,
    handler: async (params, session) => {
      const { id } = GetScheduledSchema.parse(params);
      const row = db.raw.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as ScheduledMessageRow | undefined;
      if (!row) throw new Error(`Scheduled message ${id} not found`);
      assertSessionAccess(row.chat_jid, session);
      return rowToScheduledMessage(row);
    },
  });

  registry.register({
    name: 'update_scheduled',
    description: 'Update a pending scheduled message. Can change time, text, or recurrence.',
    scope: 'chat',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    schema: UpdateScheduledSchema,
    handler: async (params, session) => {
      const { id, scheduled_at, text, recurrence } = UpdateScheduledSchema.parse(params);
      const row = db.raw.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as ScheduledMessageRow | undefined;
      if (!row) throw new Error(`Scheduled message ${id} not found`);
      assertSessionAccess(row.chat_jid, session);
      if (row.status !== 'pending') throw new Error(`Scheduled message ${id} is ${row.status} and cannot be updated`);

      const updates: string[] = [];
      const values: unknown[] = [];

      if (scheduled_at !== undefined) {
        updates.push('scheduled_at = ?');
        values.push(scheduled_at);
      }
      if (text !== undefined) {
        updates.push('payload = ?');
        values.push(JSON.stringify({ text }));
        updates.push("content_type = 'text'");
      }
      if (recurrence !== undefined) {
        // Validate cron by importing parseCron
        const { parseCron, nextCronRun } = await import('../../core/cron.ts');
        parseCron(recurrence); // throws if invalid
        updates.push('recurrence = ?');
        values.push(recurrence);
        const baseTime = scheduled_at ?? row.scheduled_at;
        const nextRun = nextCronRun(recurrence, Math.floor(Date.now() / 1000) - 60);
        updates.push('next_run_at = ?');
        values.push(nextRun);
      }

      if (updates.length === 0) throw new Error('No fields to update');

      values.push(id);
      db.raw.prepare(`UPDATE scheduled_messages SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.raw.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as ScheduledMessageRow;
      return rowToScheduledMessage(updated);
    },
  });
```

- [ ] **Step 4: Run all scheduling tests**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/mcp/tools/scheduling.test.ts tests/mcp/tools/scheduling-extended.test.ts 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add src/mcp/tools/scheduling.ts tests/mcp/tools/scheduling-extended.test.ts && git commit -m "feat(scheduler): add get_scheduled, update_scheduled tools and recurrence support"
```

---

## Task 5: Fleet API — Scheduled Message Routes

**Files:**
- Modify: `src/fleet/routes/mcp-proxy.ts`
- Modify: `src/fleet/index.ts`

- [ ] **Step 1: Add new scheduled message handlers to mcp-proxy.ts**

Add after the existing `handleCancelScheduled` function (around line 72):

```typescript
/** POST /api/lines/:name/scheduled — create a scheduled message. */
export async function handleCreateScheduled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }
  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'schedule_message', parsed);
  if (result.success) { jsonResponse(res, 201, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** GET /api/lines/:name/scheduled/:id — get a single scheduled message. */
export async function handleGetScheduledById(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; id: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }
  const result = await mcpCall(instance.socketPath, 'get_scheduled', { id: parseInt(params.id, 10) });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** PUT /api/lines/:name/scheduled/:id — update a scheduled message. */
export async function handleUpdateScheduled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; id: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }
  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  parsed.id = parseInt(params.id, 10);
  const result = await mcpCall(instance.socketPath, 'update_scheduled', parsed);
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** DELETE /api/lines/:name/scheduled/:id — cancel a scheduled message (path param). */
export async function handleCancelScheduledById(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; id: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }
  const result = await mcpCall(instance.socketPath, 'cancel_scheduled', { id: parseInt(params.id, 10) });
  if (result.success) { jsonResponse(res, 200, { cancelled: true, id: parseInt(params.id, 10) }); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}
```

Add the `readBody` import at the top of `mcp-proxy.ts`:

```typescript
import { jsonResponse, requireInstance, readBody } from '../../lib/http.ts';
```

- [ ] **Step 2: Register routes in fleet/index.ts**

Add a new route params type after `NameRouteParams`:

```typescript
type NameIdRouteParams = { name: string; id: string };
type NameJidRouteParams = { name: string; jid: string };
```

Add to `RouteParamsByHandler`:

```typescript
  createScheduled: NameRouteParams;
  getScheduledById: NameIdRouteParams;
  updateScheduled: NameIdRouteParams;
  cancelScheduledById: NameIdRouteParams;
```

Add to `NAME_ROUTE_HANDLERS`:

```typescript
  'createScheduled',
  'getScheduledById',
  'updateScheduled',
  'cancelScheduledById',
```

Add to `handlers`:

```typescript
  createScheduled:     (req, res, deps, params) => handleCreateScheduled(req, res, deps, params),
  getScheduledById:    (_req, res, deps, params) => handleGetScheduledById(_req, res, deps, params),
  updateScheduled:     (req, res, deps, params) => handleUpdateScheduled(req, res, deps, params),
  cancelScheduledById: (_req, res, deps, params) => handleCancelScheduledById(_req, res, deps, params),
```

Add to `ROUTES` array (before the existing `getScheduled` entry):

```typescript
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled$/, handler: 'createScheduled' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled\/(?<id>\d+)$/, handler: 'getScheduledById' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled\/(?<id>\d+)$/, handler: 'updateScheduled' },
  { method: 'DELETE', path: /^\/api\/lines\/(?<name>[^/]+)\/scheduled\/(?<id>\d+)$/, handler: 'cancelScheduledById' },
```

Import the new handlers at the top of `index.ts`:

```typescript
import { handleGetScheduled, handleCancelScheduled, handleGetGroups, handleSearchContacts, handleCreateScheduled, handleGetScheduledById, handleUpdateScheduled, handleCancelScheduledById } from './routes/mcp-proxy.ts';
```

**Note:** The route dispatcher at line ~360 uses `params.name` for named routes. For routes with `:id` or `:jid`, the regex named groups will produce `{ name, id }` or `{ name, jid }`. The dispatcher needs to pass the full `params` object. Check the dispatch code — if it only passes `{ name: params.name }`, you need to update it to pass all captured groups. The dispatch code at line ~363 is:

```typescript
await handlers[route.handler](req, res, routeDeps, { name: params.name });
```

This must be updated to pass all params:

```typescript
await handlers[route.handler](req, res, routeDeps, params as any);
```

Or more type-safely, update the named-route dispatch to forward the full `match.groups` object.

- [ ] **Step 3: Run TypeScript compilation check**

Run: `cd /home/q/LAB/WhatSoup && npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add src/fleet/routes/mcp-proxy.ts src/fleet/index.ts && git commit -m "feat(fleet): add CRUD routes for scheduled messages"
```

---

## Task 6: Fleet API — Group Management Routes

**Files:**
- Modify: `src/fleet/routes/mcp-proxy.ts`
- Modify: `src/fleet/index.ts`

- [ ] **Step 1: Add group management handlers to mcp-proxy.ts**

Add after the groups section:

```typescript
// ---------------------------------------------------------------------------
// Group management
// ---------------------------------------------------------------------------

/** GET /api/lines/:name/groups/:jid — get group metadata. */
export async function handleGetGroupDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const result = await mcpCall(instance.socketPath, 'get_group_metadata', { jid: decodeURIComponent(params.jid) }, 15_000);
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** POST /api/lines/:name/groups — create a group. */
export async function handleCreateGroup(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_create', parsed);
  if (result.success) { jsonResponse(res, 201, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** DELETE /api/lines/:name/groups/:jid — leave a group. */
export async function handleLeaveGroup(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const result = await mcpCall(instance.socketPath, 'group_leave', { id: decodeURIComponent(params.jid) });
  if (result.success) { jsonResponse(res, 200, { success: true }); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** PUT /api/lines/:name/groups/:jid/subject — update group subject. */
export async function handleUpdateGroupSubject(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: { subject: string };
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_update_subject', { jid: decodeURIComponent(params.jid), subject: parsed.subject });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** PUT /api/lines/:name/groups/:jid/description — update group description. */
export async function handleUpdateGroupDescription(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: { description?: string };
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_update_description', { jid: decodeURIComponent(params.jid), description: parsed.description });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** POST /api/lines/:name/groups/:jid/participants — add/remove/promote/demote. */
export async function handleGroupParticipants(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: { participants: string[]; action: string };
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_participants_update', {
    jid: decodeURIComponent(params.jid), participants: parsed.participants, action: parsed.action,
  });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** PUT /api/lines/:name/groups/:jid/settings — update group settings. */
export async function handleGroupSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: { setting: string };
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_settings_update', { jid: decodeURIComponent(params.jid), setting: parsed.setting });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** GET /api/lines/:name/groups/:jid/invite — get invite link. */
export async function handleGetGroupInvite(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const result = await mcpCall(instance.socketPath, 'get_group_invite_link', { jid: decodeURIComponent(params.jid) });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** POST /api/lines/:name/groups/:jid/invite/revoke — revoke invite link. */
export async function handleRevokeGroupInvite(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const result = await mcpCall(instance.socketPath, 'group_revoke_invite', { jid: decodeURIComponent(params.jid) });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** PUT /api/lines/:name/groups/:jid/ephemeral — toggle disappearing messages. */
export async function handleGroupEphemeral(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: { expiration: number };
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_toggle_ephemeral', { jid: decodeURIComponent(params.jid), expiration: parsed.expiration });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** PUT /api/lines/:name/groups/:jid/member-add-mode — set who can add members. */
export async function handleGroupMemberAddMode(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: { mode: string };
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_member_add_mode', { jid: decodeURIComponent(params.jid), mode: parsed.mode });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** PUT /api/lines/:name/groups/:jid/join-approval — toggle join approval. */
export async function handleGroupJoinApproval(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: { mode: string };
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_join_approval_mode', { jid: decodeURIComponent(params.jid), mode: parsed.mode });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** GET /api/lines/:name/groups/:jid/requests — list pending join requests. */
export async function handleGetGroupRequests(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const result = await mcpCall(instance.socketPath, 'group_request_participants_list', { jid: decodeURIComponent(params.jid) });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}

/** POST /api/lines/:name/groups/:jid/requests — approve/reject join requests. */
export async function handleGroupRequestsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;
  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available' });
    return;
  }
  const body = await readBody(req);
  let parsed: { participants: string[]; action: string };
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }
  const result = await mcpCall(instance.socketPath, 'group_request_participants_update', {
    jid: decodeURIComponent(params.jid), participants: parsed.participants, action: parsed.action,
  });
  if (result.success) { jsonResponse(res, 200, result.result); }
  else { jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' }); }
}
```

- [ ] **Step 2: Register all group routes in fleet/index.ts**

Add to `RouteParamsByHandler`:

```typescript
  getGroupDetail: NameJidRouteParams;
  createGroup: NameRouteParams;
  leaveGroup: NameJidRouteParams;
  updateGroupSubject: NameJidRouteParams;
  updateGroupDescription: NameJidRouteParams;
  groupParticipants: NameJidRouteParams;
  groupSettings: NameJidRouteParams;
  getGroupInvite: NameJidRouteParams;
  revokeGroupInvite: NameJidRouteParams;
  groupEphemeral: NameJidRouteParams;
  groupMemberAddMode: NameJidRouteParams;
  groupJoinApproval: NameJidRouteParams;
  getGroupRequests: NameJidRouteParams;
  groupRequestsUpdate: NameJidRouteParams;
```

Add all to `NAME_ROUTE_HANDLERS`, `handlers`, and `ROUTES` following the same patterns as Task 5.

The `ROUTES` entries for groups use a JID capture group with `@` and `.` characters:

```typescript
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)$/, handler: 'getGroupDetail' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups$/, handler: 'createGroup' },
  { method: 'DELETE', path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)$/, handler: 'leaveGroup' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/subject$/, handler: 'updateGroupSubject' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/description$/, handler: 'updateGroupDescription' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/participants$/, handler: 'groupParticipants' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/settings$/, handler: 'groupSettings' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/invite$/, handler: 'getGroupInvite' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/invite\/revoke$/, handler: 'revokeGroupInvite' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/ephemeral$/, handler: 'groupEphemeral' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/member-add-mode$/, handler: 'groupMemberAddMode' },
  { method: 'PUT',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/join-approval$/, handler: 'groupJoinApproval' },
  { method: 'GET',    path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/requests$/, handler: 'getGroupRequests' },
  { method: 'POST',   path: /^\/api\/lines\/(?<name>[^/]+)\/groups\/(?<jid>[^/]+)\/requests$/, handler: 'groupRequestsUpdate' },
```

**Important:** Place specific group sub-routes (e.g., `/groups/:jid/subject`) BEFORE the generic `/groups/:jid` GET route in the ROUTES array, otherwise the regex for GET `/groups/:jid` will match first.

Import all new handlers at the top of `index.ts`.

- [ ] **Step 3: Run TypeScript compilation check**

Run: `cd /home/q/LAB/WhatSoup && npx tsc --noEmit 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add src/fleet/routes/mcp-proxy.ts src/fleet/index.ts && git commit -m "feat(fleet): add group management and scheduled CRUD API routes"
```

---

## Task 7: Console Types & API Client

**Files:**
- Modify: `console/src/types.ts`
- Modify: `console/src/lib/api.ts`

- [ ] **Step 1: Update ScheduledMessage type**

Replace the existing `ScheduledMessage` interface in `console/src/types.ts` (lines 152-159):

```typescript
export interface ScheduledMessage {
  id: number;
  chatJid: string;
  chatName?: string;
  contentType: string;
  payload: Record<string, unknown>;
  scheduledAt: number;
  recurrence?: string;
  nextRunAt?: number;
  runCount: number;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled';
  createdAt: number;
  sentAt?: number;
  error?: string;
  retryCount: number;
}
```

- [ ] **Step 2: Update GroupInfo and add GroupDetail types**

Replace the existing `GroupInfo` interface (lines 161-167) and add new types:

```typescript
export interface GroupInfo {
  id: string;
  subject: string;
  participants: GroupParticipant[];
  creation?: number;
  desc?: string;
  owner?: string;
  announce?: boolean;
  locked?: boolean;
  ephemeralDuration?: number;
}

export interface GroupParticipant {
  id: string;
  admin?: 'admin' | 'superadmin';
}

export interface GroupDetail extends GroupInfo {
  inviteLink?: string;
  memberAddMode?: 'all_member_add' | 'admin_add';
  joinApprovalMode?: 'on' | 'off';
  pendingRequests?: { jid: string }[];
}
```

- [ ] **Step 3: Add new API methods**

Add to the `api` object in `console/src/lib/api.ts`:

```typescript
  // ── Scheduled messages (enhanced) ──

  createScheduled: (name: string, data: Record<string, unknown>) =>
    apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateScheduled: (name: string, id: number, data: Record<string, unknown>) =>
    apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  getScheduledById: (name: string, id: number) =>
    apiFetch<ScheduledMessage>(`/api/lines/${encodeURIComponent(name)}/scheduled/${id}`),

  // ── Groups (enhanced) ──

  getGroupDetail: (name: string, jid: string) =>
    apiFetch<GroupDetail>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}`, {
      signal: AbortSignal.timeout(15000),
    }),

  createGroup: (name: string, subject: string, participants: string[]) =>
    apiFetch<{ id: string }>(`/api/lines/${encodeURIComponent(name)}/groups`, {
      method: 'POST',
      body: JSON.stringify({ subject, participants }),
    }),

  leaveGroup: (name: string, jid: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}`, {
      method: 'DELETE',
    }),

  updateGroupSubject: (name: string, jid: string, subject: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/subject`, {
      method: 'PUT',
      body: JSON.stringify({ subject }),
    }),

  updateGroupDescription: (name: string, jid: string, description?: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/description`, {
      method: 'PUT',
      body: JSON.stringify({ description }),
    }),

  updateGroupParticipants: (name: string, jid: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote') =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/participants`, {
      method: 'POST',
      body: JSON.stringify({ participants, action }),
    }),

  updateGroupSettings: (name: string, jid: string, setting: string) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ setting }),
    }),

  getGroupInviteLink: (name: string, jid: string) =>
    apiFetch<{ jid: string; inviteCode: string; inviteLink: string }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/invite`),

  revokeGroupInvite: (name: string, jid: string) =>
    apiFetch<{ inviteCode: string }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/invite/revoke`, {
      method: 'POST',
    }),

  updateGroupEphemeral: (name: string, jid: string, expiration: number) =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/ephemeral`, {
      method: 'PUT',
      body: JSON.stringify({ expiration }),
    }),

  updateGroupMemberAddMode: (name: string, jid: string, mode: 'all_member_add' | 'admin_add') =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/member-add-mode`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

  updateGroupJoinApproval: (name: string, jid: string, mode: 'on' | 'off') =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/join-approval`, {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

  getGroupRequests: (name: string, jid: string) =>
    apiFetch<{ jid: string; participants: { jid: string }[] }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/requests`),

  approveRejectRequests: (name: string, jid: string, participants: string[], action: 'approve' | 'reject') =>
    apiFetch<{ success: boolean }>(`/api/lines/${encodeURIComponent(name)}/groups/${encodeURIComponent(jid)}/requests`, {
      method: 'POST',
      body: JSON.stringify({ participants, action }),
    }),
```

Add the new type imports at the top of `api.ts`:

```typescript
import type { GroupDetail, GroupParticipant } from '../types.js';
```

- [ ] **Step 4: Run TypeScript compilation check**

Run: `cd /home/q/LAB/WhatSoup && cd console && npx tsc --noEmit 2>&1 | tail -20`
Expected: Possible type errors from ScheduledTab.tsx and GroupsTab.tsx referencing old types — these will be fixed in Tasks 9 and 10.

- [ ] **Step 5: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add console/src/types.ts console/src/lib/api.ts && git commit -m "feat(console): update types and API client for scheduled CRUD and group management"
```

---

## Task 8: Console Shared Components

**Files:**
- Create: `console/src/components/shared/ChatPicker.tsx`
- Create: `console/src/components/shared/ContactSearchPicker.tsx`

- [ ] **Step 1: Create ChatPicker component**

```typescript
// console/src/components/shared/ChatPicker.tsx
import { useState, useMemo, useRef, useEffect } from 'react'
import { Search, MessageSquare, Users, X } from 'lucide-react'
import type { ChatItem } from '../../types.js'

interface ChatPickerProps {
  chats: ChatItem[]
  selected: ChatItem | null
  onSelect: (chat: ChatItem) => void
  onClear: () => void
  placeholder?: string
}

export function ChatPicker({ chats, selected, onSelect, onClear, placeholder = 'Search chats...' }: ChatPickerProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const filtered = useMemo(() => {
    if (!query) return chats
    const q = query.toLowerCase()
    return chats.filter((c) =>
      c.name.toLowerCase().includes(q) || c.conversationKey.toLowerCase().includes(q),
    )
  }, [chats, query])

  if (selected) {
    return (
      <div className="flex items-center gap-2" style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--color-d1)', borderRadius: 'var(--radius-md)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
        {selected.isGroup ? <Users size={14} className="text-t4" /> : <MessageSquare size={14} className="text-t4" />}
        <span className="font-mono text-t2 flex-1 truncate" style={{ fontSize: 'var(--font-size-data)' }}>{selected.name}</span>
        <button type="button" onClick={onClear} className="c-btn c-btn-ghost c-btn-sm" aria-label="Clear selection">
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-2" style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--color-d1)', borderRadius: 'var(--radius-md)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
        <Search size={14} className="text-t4" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="flex-1 bg-transparent border-none outline-none font-mono text-t2"
          style={{ fontSize: 'var(--font-size-data)' }}
        />
      </div>
      {open && filtered.length > 0 && (
        <div
          className="absolute left-0 right-0 z-50 overflow-y-auto"
          style={{ top: '100%', marginTop: 'var(--sp-1)', maxHeight: '240px', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)' }}
        >
          {filtered.map((chat) => (
            <button
              key={chat.conversationKey}
              type="button"
              className="w-full flex items-center gap-2 c-hover text-left"
              style={{ padding: 'var(--sp-2) var(--sp-3)' }}
              onClick={() => { onSelect(chat); setOpen(false); setQuery(''); }}
            >
              {chat.isGroup ? <Users size={14} className="text-t4" /> : <MessageSquare size={14} className="text-t4" />}
              <span className="font-mono text-t2 truncate" style={{ fontSize: 'var(--font-size-data)' }}>{chat.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create ContactSearchPicker component**

```typescript
// console/src/components/shared/ContactSearchPicker.tsx
import { useState, useCallback, useRef } from 'react'
import { Search, X, UserPlus } from 'lucide-react'
import { api } from '../../lib/api.js'
import type { ContactResult } from '../../types.js'

interface ContactSearchPickerProps {
  lineName: string
  selected: ContactResult[]
  onAdd: (contact: ContactResult) => void
  onRemove: (jid: string) => void
  placeholder?: string
}

export function ContactSearchPicker({ lineName, selected, onAdd, onRemove, placeholder = 'Search contacts...' }: ContactSearchPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContactResult[]>([])
  const [searching, setSearching] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doSearch = useCallback((q: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (q.length < 2) { setResults([]); return; }
    timerRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await api.searchContacts(lineName, q)
        setResults((res as { contacts?: ContactResult[] }).contacts ?? [])
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 300)
  }, [lineName])

  const selectedJids = new Set(selected.map((c) => c.jid))

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((c) => (
            <span key={c.jid} className="inline-flex items-center gap-1 font-mono" style={{ fontSize: 'var(--font-size-xs)', padding: 'var(--sp-1) var(--sp-2)', background: 'var(--color-d1)', borderRadius: 'var(--radius-sm)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
              {c.name ?? c.notify ?? c.jid}
              <button type="button" onClick={() => onRemove(c.jid)} className="c-btn c-btn-ghost" style={{ padding: 0 }} aria-label={`Remove ${c.name ?? c.jid}`}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <div className="flex items-center gap-2" style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--color-d1)', borderRadius: 'var(--radius-md)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
          <Search size={14} className="text-t4" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); doSearch(e.target.value); }}
            placeholder={placeholder}
            className="flex-1 bg-transparent border-none outline-none font-mono text-t2"
            style={{ fontSize: 'var(--font-size-data)' }}
          />
          {searching && <span className="text-t4 font-mono" style={{ fontSize: 'var(--font-size-xs)' }}>...</span>}
        </div>
        {results.length > 0 && (
          <div
            className="absolute left-0 right-0 z-50 overflow-y-auto"
            style={{ top: '100%', marginTop: 'var(--sp-1)', maxHeight: '200px', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)' }}
          >
            {results.filter((r) => !selectedJids.has(r.jid)).map((contact) => (
              <button
                key={contact.jid}
                type="button"
                className="w-full flex items-center gap-2 c-hover text-left"
                style={{ padding: 'var(--sp-2) var(--sp-3)' }}
                onClick={() => { onAdd(contact); setQuery(''); setResults([]); }}
              >
                <UserPlus size={14} className="text-t4" />
                <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{contact.name ?? contact.notify ?? contact.jid}</span>
                {contact.number && <span className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>{contact.number}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add console/src/components/shared/ChatPicker.tsx console/src/components/shared/ContactSearchPicker.tsx && git commit -m "feat(console): add ChatPicker and ContactSearchPicker shared components"
```

---

## Task 9: Console — Enhanced Scheduled Tab

**Files:**
- Create: `console/src/components/line-detail/scheduled-utils.ts`
- Create: `console/src/components/line-detail/ScheduledMessageRow.tsx`
- Create: `console/src/components/line-detail/ScheduleComposerModal.tsx`
- Modify: `console/src/components/line-detail/ScheduledTab.tsx`

This is a large task. The subagent should implement it as a cohesive unit — utils first, then the row component, then the composer modal, then rewire ScheduledTab.tsx to use them.

**Key design decisions for the implementer:**
- `scheduled-utils.ts` exports: `statusColor(status)`, `statusLabel(status)`, `contentTypeIcon(type)`, `cronToHuman(expr)` (thin wrapper calling the backend cron module's logic, reimplemented client-side since the cron.ts is backend-only)
- `ScheduledMessageRow` receives a `ScheduledMessage` prop + callbacks for cancel/edit/duplicate
- `ScheduleComposerModal` is a controlled modal (`open: boolean, onClose, onCreated`). It uses `ChatPicker` for target selection, radio buttons for content type (Text is the default and most common), `DateTimePicker` built with native `<input type="datetime-local">`, and a recurrence toggle (one-shot vs presets: Daily/Weekly/Monthly + custom cron input)
- Content type composers: Start with Text only for the modal's first render. Media composer takes a file path string input (not file upload). Location/Contact/Poll composers are simple form fields matching the payload envelope shapes from the spec.
- The modal calls `api.createScheduled()` on submit, invalidates the `['scheduled', lineName]` query, and shows a success toast
- `ScheduledTab.tsx` is rewritten to render: header with count + "New Scheduled Message" button, then `ScheduledMessageRow` for each message, sorted pending-first

- [ ] **Step 1: Create scheduled-utils.ts**
- [ ] **Step 2: Create ScheduledMessageRow.tsx**
- [ ] **Step 3: Create ScheduleComposerModal.tsx with all content type sub-forms inline** (no separate files for each composer — keep it in one file with switch/case, each case is a small form section)
- [ ] **Step 4: Rewrite ScheduledTab.tsx to use the new components**
- [ ] **Step 5: Run console build to verify no errors**

Run: `cd /home/q/LAB/WhatSoup/console && npx vite build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add console/src/components/line-detail/scheduled-utils.ts console/src/components/line-detail/ScheduledMessageRow.tsx console/src/components/line-detail/ScheduleComposerModal.tsx console/src/components/line-detail/ScheduledTab.tsx && git commit -m "feat(console): enhanced Scheduled tab with composer modal and recurrence support"
```

---

## Task 10: Console — Enhanced Groups Tab

**Files:**
- Create: `console/src/components/line-detail/groups-utils.ts`
- Create: `console/src/components/line-detail/GroupCard.tsx`
- Create: `console/src/components/line-detail/GroupDetailModal.tsx`
- Create: `console/src/components/line-detail/CreateGroupModal.tsx`
- Modify: `console/src/components/line-detail/GroupsTab.tsx`

Same approach as Task 9 — implement as a cohesive unit.

**Key design decisions for the implementer:**
- `groups-utils.ts` exports: `roleLabel(admin?)`, `roleBadgeClass(admin?)`, `settingLabel(setting)`, `ephemeralOptions` (array of { label, seconds } for the dropdown)
- `GroupCard` renders: colored circle with first 2 letters of subject, subject text, participant count, role badge (Shield icon if admin), description preview. Click handler calls `onSelect(group)`.
- `GroupDetailModal` is a tabbed modal with 3 tabs (Info / Participants / Settings). It fetches full `GroupDetail` via `api.getGroupDetail()` on open. Uses `useState` for active tab.
  - **Info tab**: Editable subject (contentEditable or input that appears on click), editable description (textarea on click), creation date, owner JID, invite link with Copy + Revoke buttons. Uses `ConfirmDialog` (existing component at `console/src/components/ConfirmDialog.tsx`) for revoke confirmation.
  - **Participants tab**: Searchable list of `GroupParticipant[]`. Each row: JID, role badge, action buttons (Remove, Promote/Demote). "Add Participant" button opens `ContactSearchPicker`. Uses `ConfirmDialog` for remove confirmation.
  - **Settings tab**: Toggle switches for announcement/locked/memberAddMode/joinApproval. Dropdown for ephemeral duration. "Leave Group" danger button at bottom with `ConfirmDialog`.
- `CreateGroupModal`: Subject input + description textarea + `ContactSearchPicker` for participants. Create button calls `api.createGroup()`.
- `GroupsTab.tsx` rewritten: header with count + "Create Group" button, grid of `GroupCard` components, `GroupDetailModal` controlled by `selectedGroup` state, `CreateGroupModal` controlled by `showCreate` state.

- [ ] **Step 1: Create groups-utils.ts**
- [ ] **Step 2: Create GroupCard.tsx**
- [ ] **Step 3: Create GroupDetailModal.tsx with all 3 tabs inline**
- [ ] **Step 4: Create CreateGroupModal.tsx**
- [ ] **Step 5: Rewrite GroupsTab.tsx to use the new components**
- [ ] **Step 6: Run console build to verify no errors**

Run: `cd /home/q/LAB/WhatSoup/console && npx vite build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
cd /home/q/LAB/WhatSoup && git add console/src/components/line-detail/groups-utils.ts console/src/components/line-detail/GroupCard.tsx console/src/components/line-detail/GroupDetailModal.tsx console/src/components/line-detail/CreateGroupModal.tsx console/src/components/line-detail/GroupsTab.tsx && git commit -m "feat(console): enhanced Groups tab with detail modal and full management panel"
```

---

## Task 11: Full Test Suite & Final Verification

**Files:**
- All test files created in previous tasks
- Verify full test suite passes

- [ ] **Step 1: Run all new tests**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/core/cron.test.ts tests/core/migration-17.test.ts tests/core/scheduler-recurrence.test.ts tests/mcp/tools/scheduling-extended.test.ts 2>&1 | tail -10`
Expected: All PASS

- [ ] **Step 2: Run existing test suite for regressions**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run 2>&1 | tail -10`
Expected: All tests PASS (including all pre-existing tests)

- [ ] **Step 3: Run TypeScript compilation for both backend and console**

Run: `cd /home/q/LAB/WhatSoup && npx tsc --noEmit 2>&1 | tail -5 && cd console && npx tsc --noEmit 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 4: Run console production build**

Run: `cd /home/q/LAB/WhatSoup/console && npx vite build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
cd /home/q/LAB/WhatSoup && git add -A && git commit -m "test: full verification pass for scheduled + groups feature drop"
```
