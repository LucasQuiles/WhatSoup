# Fleet Charts Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add token consumption and session activity charts to Soup Kitchen alongside existing message volume, surface media as a third series, and add a shared range picker with KPI-driven chart expansion.

**Architecture:** Backend captures token events in a new `agent_token_events` table, adds `ended_at` to `agent_sessions` for session overlap calculation, and extends the hourly metrics collector with 6 new metrics. The db-reader densifies buckets (zero-fill) and the fleet/per-line API routes return three panel datasets. Frontend renders three chart panels in a row with a ChartPanel wrapper handling loading/error/empty/partial states, a range picker, and expansion/collapse driven by KPI card clicks.

**Tech Stack:** TypeScript/Node (native strip-types), SQLite (node:sqlite DatabaseSync), vitest (--pool=forks), React 19, Recharts 3.8, TanStack Query, Tailwind CSS v4

---

## Task 1: Migration 18 — agent_token_events Table + agent_sessions.ended_at

**Files:**
- Modify: `src/core/database.ts`
- Test: `tests/core/database.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/core/database.test.ts`:

```typescript
describe('migration 18 — agent_token_events + ended_at', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records migration version 18 in schema_migrations', () => {
    const row = db.raw
      .prepare('SELECT version FROM schema_migrations WHERE version = 18')
      .get() as { version: number } | undefined;
    expect(row?.version).toBe(18);
  });

  it('creates agent_token_events table with correct columns', () => {
    const cols = db.raw
      .prepare("PRAGMA table_info('agent_token_events')")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));

    expect(colMap['id']).toBeDefined();
    expect(colMap['agent_session_id']).toBeDefined();
    expect(colMap['agent_session_id'].notnull).toBe(1);
    expect(colMap['timestamp']).toBeDefined();
    expect(colMap['timestamp'].type).toBe('INTEGER');
    expect(colMap['timestamp'].notnull).toBe(1);
    expect(colMap['input_tokens']).toBeDefined();
    expect(colMap['input_tokens'].type).toBe('INTEGER');
    expect(colMap['output_tokens']).toBeDefined();
    expect(colMap['output_tokens'].type).toBe('INTEGER');
  });

  it('creates idx_agent_token_events_ts index', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_token_events_ts'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('creates idx_agent_token_events_session_ts index', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_token_events_session_ts'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('adds ended_at column to agent_sessions', () => {
    const cols = db.raw
      .prepare("PRAGMA table_info('agent_sessions')")
      .all() as Array<{ name: string; type: string }>;
    const col = cols.find((c) => c.name === 'ended_at');
    expect(col).toBeDefined();
    expect(col!.type).toBe('TEXT');
  });

  it('creates idx_agent_sessions_started_epoch expression index', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_sessions_started_epoch'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('creates idx_agent_sessions_ended_epoch expression index', () => {
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_sessions_ended_epoch'")
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(1);
  });

  it('backfills ended_at for terminal sessions', () => {
    // Insert sessions with various statuses BEFORE migration runs.
    // Since we're using :memory: and open() already ran, we need to
    // test the backfill logic directly. Insert terminal sessions and
    // verify ended_at was set by the migration backfill.
    //
    // The migration already ran in open(), so insert a terminal session
    // manually and verify the backfill UPDATE pattern works:
    db.raw.prepare(`
      INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, last_message_at, status, ended_at)
      VALUES (1, '/tmp', '2026-04-01T10:00:00.000Z', '2026-04-01T11:00:00.000Z', 'ended', NULL)
    `).run();
    db.raw.prepare(`
      INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, last_message_at, status, ended_at)
      VALUES (2, '/tmp', '2026-04-01T12:00:00.000Z', NULL, 'crashed', NULL)
    `).run();
    db.raw.prepare(`
      INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status, ended_at)
      VALUES (3, '/tmp', '2026-04-01T13:00:00.000Z', 'active', NULL)
    `).run();
    db.raw.prepare(`
      INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, status, ended_at)
      VALUES (4, '/tmp', '2026-04-01T14:00:00.000Z', 'suspended', NULL)
    `).run();

    // Re-run the backfill UPDATE (same as migration does)
    db.raw.prepare(`
      UPDATE agent_sessions SET ended_at = COALESCE(last_message_at, started_at)
      WHERE status IN ('ended', 'completed', 'crashed', 'resume_failed', 'orphaned')
        AND ended_at IS NULL
    `).run();

    // Ended session: ended_at = last_message_at (non-null)
    const ended = db.raw.prepare(
      "SELECT ended_at FROM agent_sessions WHERE claude_pid = 1"
    ).get() as { ended_at: string | null };
    expect(ended.ended_at).toBe('2026-04-01T11:00:00.000Z');

    // Crashed session: ended_at = started_at (last_message_at is NULL)
    const crashed = db.raw.prepare(
      "SELECT ended_at FROM agent_sessions WHERE claude_pid = 2"
    ).get() as { ended_at: string | null };
    expect(crashed.ended_at).toBe('2026-04-01T12:00:00.000Z');

    // Active session: ended_at remains NULL
    const active = db.raw.prepare(
      "SELECT ended_at FROM agent_sessions WHERE claude_pid = 3"
    ).get() as { ended_at: string | null };
    expect(active.ended_at).toBeNull();

    // Suspended session: ended_at remains NULL
    const suspended = db.raw.prepare(
      "SELECT ended_at FROM agent_sessions WHERE claude_pid = 4"
    ).get() as { ended_at: string | null };
    expect(suspended.ended_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run --pool=forks tests/core/database.test.ts`
Expected: FAIL — `agent_token_events` table does not exist, `ended_at` column missing.

- [ ] **Step 3: Write implementation**

In `src/core/database.ts`, add the migration constant and register it in the MIGRATIONS map.

After migration 17 (around line 498), add:

```typescript
// ─── Migration 18: agent_token_events + agent_sessions.ended_at ─────────────

const MIGRATION_18 = `
CREATE TABLE IF NOT EXISTS agent_token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
  timestamp INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_agent_token_events_ts ON agent_token_events(timestamp);
CREATE INDEX idx_agent_token_events_session_ts ON agent_token_events(agent_session_id, timestamp);
`;
```

Add migration 18 to the MIGRATIONS map (inside the `new Map([...])` at line 365):

```typescript
  [18, (db: DatabaseSync) => {
    db.exec(MIGRATION_18);

    // Add ended_at column (idempotency guard)
    const cols = db.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'ended_at')) {
      db.exec('ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT');
    }

    // Expression indexes for unixepoch() predicates in metrics queries
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_epoch ON agent_sessions(unixepoch(started_at))');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_sessions_ended_epoch ON agent_sessions(unixepoch(ended_at))');

    // Backfill ended_at for existing terminal sessions
    db.prepare(`
      UPDATE agent_sessions SET ended_at = COALESCE(last_message_at, started_at)
      WHERE status IN ('ended', 'completed', 'crashed', 'resume_failed', 'orphaned')
        AND ended_at IS NULL
    `).run();
  }],
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run --pool=forks tests/core/database.test.ts`

- [ ] **Step 5: Commit**

`git add src/core/database.ts tests/core/database.test.ts && git commit -m "feat: migration 18 — agent_token_events table + agent_sessions.ended_at"`

---

## Task 2: Token Event Writer + ended_at on Terminal Status

**Files:**
- Modify: `src/runtimes/agent/session-db.ts`
- Modify: `src/core/durability.ts`
- Test: `tests/runtimes/agent/session-db.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/runtimes/agent/session-db.test.ts` (inside the existing `describe('agent session-db', ...)`):

```typescript
  it('insertTokenEvent inserts a row in agent_token_events', () => {
    const id = createSession(db, 80001, '/tmp/token-event');
    insertTokenEvent(db, id, 100, 50);

    const row = db.raw.prepare(
      'SELECT agent_session_id, input_tokens, output_tokens, timestamp FROM agent_token_events WHERE agent_session_id = ?'
    ).get(id) as { agent_session_id: number; input_tokens: number; output_tokens: number; timestamp: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.agent_session_id).toBe(id);
    expect(row!.input_tokens).toBe(100);
    expect(row!.output_tokens).toBe(50);
    expect(row!.timestamp).toBeGreaterThan(0);
  });

  it('accumulateSessionTokens and insertTokenEvent together maintain consistency', () => {
    const id = createSession(db, 80002, '/tmp/token-dual');

    // Simulate 3 token events
    insertTokenEvent(db, id, 100, 50);
    accumulateSessionTokens(db, id, 100, 50);
    insertTokenEvent(db, id, 200, 75);
    accumulateSessionTokens(db, id, 200, 75);
    insertTokenEvent(db, id, 50, 25);
    accumulateSessionTokens(db, id, 50, 25);

    // Sum of events should equal session totals
    const eventSum = db.raw.prepare(
      'SELECT SUM(input_tokens) AS total_in, SUM(output_tokens) AS total_out FROM agent_token_events WHERE agent_session_id = ?'
    ).get(id) as { total_in: number; total_out: number };

    const session = db.raw.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?'
    ).get(id) as { total_input_tokens: number; total_output_tokens: number };

    expect(eventSum.total_in).toBe(session.total_input_tokens);
    expect(eventSum.total_out).toBe(session.total_output_tokens);
    expect(eventSum.total_in).toBe(350);
    expect(eventSum.total_out).toBe(150);
  });

  it('updateSessionStatus sets ended_at for terminal statuses', () => {
    const terminalStatuses = ['ended', 'crashed', 'resume_failed', 'orphaned'];
    for (const status of terminalStatuses) {
      const id = createSession(db, 80010 + terminalStatuses.indexOf(status), `/tmp/terminal-${status}`);
      updateSessionStatus(db, id, status);

      const row = db.raw.prepare(
        'SELECT ended_at, status FROM agent_sessions WHERE id = ?'
      ).get(id) as { ended_at: string | null; status: string };

      expect(row.status).toBe(status);
      expect(row.ended_at).not.toBeNull();
      // ended_at should be a valid ISO string
      expect(new Date(row.ended_at!).toISOString()).toBe(row.ended_at);
    }
  });

  it('updateSessionStatus does NOT set ended_at for suspended status', () => {
    const id = createSession(db, 80020, '/tmp/suspended-no-ended');
    updateSessionStatus(db, id, 'suspended');

    const row = db.raw.prepare(
      'SELECT ended_at, status FROM agent_sessions WHERE id = ?'
    ).get(id) as { ended_at: string | null; status: string };

    expect(row.status).toBe('suspended');
    expect(row.ended_at).toBeNull();
  });

  it('updateSessionStatus does NOT set ended_at for active status', () => {
    const id = createSession(db, 80021, '/tmp/active-no-ended');
    // Re-activate (e.g., after resume)
    updateSessionStatus(db, id, 'active');

    const row = db.raw.prepare(
      'SELECT ended_at, status FROM agent_sessions WHERE id = ?'
    ).get(id) as { ended_at: string | null; status: string };

    expect(row.status).toBe('active');
    expect(row.ended_at).toBeNull();
  });
```

Also update the import at the top of the test file to include the new function:

```typescript
import {
  ensureAgentSchema,
  createSession,
  getActiveSession,
  updateSessionId,
  updateSessionStatus,
  incrementMessageCount,
  accumulateSessionTokens,
  insertTokenEvent,
  backfillWorkspaceKeys,
  markOrphaned,
  sweepOrphanedSessions,
  getResumableSessionForChat,
} from '../../../src/runtimes/agent/session-db.ts';
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run --pool=forks tests/runtimes/agent/session-db.test.ts`
Expected: FAIL — `insertTokenEvent` is not exported, `ended_at` not set by `updateSessionStatus`.

- [ ] **Step 3: Write implementation**

In `src/runtimes/agent/session-db.ts`, add the `insertTokenEvent` function after `accumulateSessionTokens` (after line 145):

```typescript
/** Record a timestamped token usage event for granular metrics. */
export function insertTokenEvent(
  db: Database,
  agentSessionId: number,
  inputTokens: number,
  outputTokens: number,
): void {
  db.raw
    .prepare(
      `INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
       VALUES (?, unixepoch('now'), ?, ?)`,
    )
    .run(agentSessionId, inputTokens, outputTokens);
}
```

Modify `updateSessionStatus` (line 148-150) to set `ended_at` for terminal statuses:

```typescript
const TERMINAL_STATUSES = new Set(['ended', 'completed', 'crashed', 'resume_failed', 'orphaned']);

/** Update the status of an existing session row to any arbitrary status string. */
export function updateSessionStatus(db: Database, rowId: number, status: string): void {
  if (TERMINAL_STATUSES.has(status)) {
    db.raw.prepare(
      `UPDATE agent_sessions SET status = ?, ended_at = datetime('now') WHERE id = ?`
    ).run(status, rowId);
  } else {
    db.raw.prepare('UPDATE agent_sessions SET status = ? WHERE id = ?').run(status, rowId);
  }
}
```

In `src/core/durability.ts`, add an `insertTokenEvent` prepared statement to the statements object (after `accumulateSessionTokens` around line 218):

```typescript
      insertTokenEvent: prepare(
        `INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
         VALUES (?, unixepoch('now'), ?, ?)`,
      ),
```

Add the statement type to the interface (around line 133):

```typescript
  insertTokenEvent: PreparedStatement;
```

In the `completeTurn` method (around line 369), insert the token event alongside the accumulation:

```typescript
      if (params.sessionTokens) {
        this.statements.accumulateSessionTokens.run(
          params.sessionTokens.inputTokens,
          params.sessionTokens.outputTokens,
          params.sessionTokens.dbRowId,
        );
        this.statements.insertTokenEvent.run(
          params.sessionTokens.dbRowId,
          params.sessionTokens.inputTokens,
          params.sessionTokens.outputTokens,
        );
      }
```

This ensures both writes happen inside the same `BEGIN IMMEDIATE` / `COMMIT` transaction block already present in `completeTurn`.

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run --pool=forks tests/runtimes/agent/session-db.test.ts`

- [ ] **Step 5: Commit**

`git add src/runtimes/agent/session-db.ts src/core/durability.ts tests/runtimes/agent/session-db.test.ts && git commit -m "feat: token event writer + ended_at on terminal session transitions"`

---

## Task 3: Extended Metrics Collector — 6 New Metrics

**Files:**
- Modify: `src/core/metrics-collector.ts`
- Test: `tests/core/metrics-collector.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/core/metrics-collector.test.ts`:

First add a helper to insert agent sessions and token events at the top alongside the existing `insertMessage` helper:

```typescript
function insertAgentSession(db: Database, opts: {
  startedAt: string;
  endedAt?: string | null;
  status?: string;
  lastMessageAt?: string | null;
}): number {
  const result = db.raw.prepare(`
    INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, ended_at, status, last_message_at)
    VALUES (1, '/tmp', ?, ?, ?, ?)
  `).run(
    opts.startedAt,
    opts.endedAt ?? null,
    opts.status ?? 'active',
    opts.lastMessageAt ?? null,
  ) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

function insertTokenEvent(db: Database, sessionId: number, timestamp: number, inputTokens: number, outputTokens: number) {
  db.raw.prepare(`
    INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, timestamp, inputTokens, outputTokens);
}

function insertMessageWithTokens(db: Database, opts: {
  timestamp: number;
  fromMe?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  messageId?: string;
}) {
  db.raw.prepare(`
    INSERT INTO messages (
      chat_jid, conversation_key, sender_jid, sender_name, message_id,
      content, content_type, is_from_me, timestamp, content_text,
      input_tokens, output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'chat@s.whatsapp.net',
    'chat',
    '15550001111@s.whatsapp.net',
    'Tester',
    opts.messageId ?? `msg-${opts.timestamp}-${Math.random()}`,
    'hello',
    'text',
    opts.fromMe ? 1 : 0,
    opts.timestamp,
    'hello',
    opts.inputTokens ?? 0,
    opts.outputTokens ?? 0,
  );
}
```

Then add the new test cases:

```typescript
  it('collects agent_tokens_in and agent_tokens_out from agent_token_events', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';
    const sessionId = insertAgentSession(db, { startedAt: '2026-04-05T15:00:00.000Z', status: 'active' });

    insertTokenEvent(db, sessionId, toUnixSeconds('2026-04-05T15:05:00.000Z'), 100, 50);
    insertTokenEvent(db, sessionId, toUnixSeconds('2026-04-05T15:30:00.000Z'), 200, 75);
    // Outside window — should NOT be counted
    insertTokenEvent(db, sessionId, toUnixSeconds('2026-04-05T14:59:00.000Z'), 999, 999);

    collectHourlyMetrics(db, now);

    const rows = db.raw.prepare(
      "SELECT metric, value FROM metrics_hourly WHERE bucket = ? AND metric LIKE 'agent_tokens_%' ORDER BY metric"
    ).all(bucket) as Array<{ metric: string; value: number }>;

    expect(rows).toEqual([
      { metric: 'agent_tokens_in', value: 300 },
      { metric: 'agent_tokens_out', value: 125 },
    ]);
  });

  it('collects chat_tokens_in and chat_tokens_out from messages table', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';

    insertMessageWithTokens(db, {
      timestamp: toUnixSeconds('2026-04-05T15:05:00.000Z'),
      fromMe: true,
      inputTokens: 80,
      outputTokens: 40,
      messageId: 'chat-tok-1',
    });
    insertMessageWithTokens(db, {
      timestamp: toUnixSeconds('2026-04-05T15:20:00.000Z'),
      fromMe: true,
      inputTokens: 120,
      outputTokens: 60,
      messageId: 'chat-tok-2',
    });
    // Zero-token message — should NOT be counted
    insertMessageWithTokens(db, {
      timestamp: toUnixSeconds('2026-04-05T15:25:00.000Z'),
      fromMe: false,
      inputTokens: 0,
      outputTokens: 0,
      messageId: 'chat-tok-3',
    });

    collectHourlyMetrics(db, now);

    const rows = db.raw.prepare(
      "SELECT metric, value FROM metrics_hourly WHERE bucket = ? AND metric LIKE 'chat_tokens_%' ORDER BY metric"
    ).all(bucket) as Array<{ metric: string; value: number }>;

    expect(rows).toEqual([
      { metric: 'chat_tokens_in', value: 200 },
      { metric: 'chat_tokens_out', value: 100 },
    ]);
  });

  it('collects sessions_active counting overlapping sessions excluding suspended', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';

    // Session spanning the entire hour (started before, still active)
    insertAgentSession(db, {
      startedAt: '2026-04-05T14:00:00.000Z',
      endedAt: null,
      status: 'active',
    });
    // Session that started and ended within the hour
    insertAgentSession(db, {
      startedAt: '2026-04-05T15:10:00.000Z',
      endedAt: '2026-04-05T15:40:00.000Z',
      status: 'ended',
    });
    // Suspended session — should NOT be counted
    insertAgentSession(db, {
      startedAt: '2026-04-05T15:00:00.000Z',
      endedAt: null,
      status: 'suspended',
    });
    // Session that ended before the hour — should NOT be counted
    insertAgentSession(db, {
      startedAt: '2026-04-05T13:00:00.000Z',
      endedAt: '2026-04-05T14:30:00.000Z',
      status: 'ended',
    });

    collectHourlyMetrics(db, now);

    const row = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'sessions_active'"
    ).get(bucket) as { value: number } | undefined;

    expect(row?.value).toBe(2);
  });

  it('collects sessions_started counting only sessions starting in the hour', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';

    // Started inside the hour
    insertAgentSession(db, { startedAt: '2026-04-05T15:05:00.000Z', status: 'active' });
    insertAgentSession(db, { startedAt: '2026-04-05T15:30:00.000Z', status: 'ended', endedAt: '2026-04-05T15:45:00.000Z' });
    // Started outside the hour — should NOT be counted
    insertAgentSession(db, { startedAt: '2026-04-05T14:55:00.000Z', status: 'active' });

    collectHourlyMetrics(db, now);

    const row = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'sessions_started'"
    ).get(bucket) as { value: number } | undefined;

    expect(row?.value).toBe(2);
  });

  it('backfill iterates every hour for session metrics, not just active hours', () => {
    const now = new Date('2026-04-05T18:30:00.000Z');

    // Session spanning hours 15-17 (no messages in hours 16-17)
    insertAgentSession(db, {
      startedAt: '2026-04-05T15:00:00.000Z',
      endedAt: '2026-04-05T17:30:00.000Z',
      status: 'ended',
    });

    // A single message in hour 15 to give the backfill something for message metrics
    insertMessage(db, {
      timestamp: toUnixSeconds('2026-04-05T15:05:00.000Z'),
      fromMe: false,
      contentType: 'text',
      messageId: 'backfill-session-msg',
    });

    backfillMetrics(db, 1, now);

    // sessions_active should appear in hours 15, 16, and 17
    const activeRows = db.raw.prepare(
      "SELECT bucket, value FROM metrics_hourly WHERE metric = 'sessions_active' AND value > 0 ORDER BY bucket"
    ).all() as Array<{ bucket: string; value: number }>;

    expect(activeRows.length).toBeGreaterThanOrEqual(3);
    expect(activeRows.map(r => r.bucket)).toContain('2026-04-05T15:00:00.000Z');
    expect(activeRows.map(r => r.bucket)).toContain('2026-04-05T16:00:00.000Z');
    expect(activeRows.map(r => r.bucket)).toContain('2026-04-05T17:00:00.000Z');
  });
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run --pool=forks tests/core/metrics-collector.test.ts`
Expected: FAIL — new metrics not yet collected, `sessions_active` not found in metrics_hourly.

- [ ] **Step 3: Write implementation**

Replace the contents of `src/core/metrics-collector.ts`:

```typescript
import type { Database } from './database.ts';

interface HourWindow {
  bucket: string;
  startSec: number;
  endSec: number;
}

const METRIC_NAMES = [
  'messages_in', 'messages_out', 'messages_media',
  'agent_tokens_in', 'agent_tokens_out',
  'chat_tokens_in', 'chat_tokens_out',
  'sessions_started', 'sessions_active',
] as const;
type MetricName = typeof METRIC_NAMES[number];

function toHourWindow(now: Date): HourWindow {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);

  return {
    bucket: start.toISOString(),
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor((start.getTime() + 60 * 60 * 1000) / 1000),
  };
}

function countMessages(
  db: Database,
  sql: string,
  ...params: Array<number | string>
): number {
  const row = db.raw.prepare(sql).get(...params) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function sumColumn(
  db: Database,
  sql: string,
  ...params: Array<number | string>
): number {
  const row = db.raw.prepare(sql).get(...params) as { total: number | null } | undefined;
  return row?.total ?? 0;
}

function upsertMetric(db: Database, bucket: string, metric: MetricName, value: number): void {
  db.raw.prepare(`
    INSERT INTO metrics_hourly (bucket, metric, value)
    VALUES (?, ?, ?)
    ON CONFLICT(bucket, metric) DO UPDATE SET value = excluded.value
  `).run(bucket, metric, value);
}

function collectMetricsForWindow(db: Database, window: HourWindow): void {
  const { bucket, startSec, endSec } = window;

  // ── Message metrics (existing) ──
  const messagesIn = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ? AND is_from_me = 0`,
    startSec,
    endSec,
  );

  const messagesOut = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ? AND is_from_me = 1`,
    startSec,
    endSec,
  );

  const messagesMedia = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM messages
      WHERE timestamp >= ? AND timestamp < ?
        AND content_type IN ('image', 'audio', 'document', 'video', 'sticker')`,
    startSec,
    endSec,
  );

  upsertMetric(db, bucket, 'messages_in', messagesIn);
  upsertMetric(db, bucket, 'messages_out', messagesOut);
  upsertMetric(db, bucket, 'messages_media', messagesMedia);

  // ── Token metrics ──
  const agentTokensIn = sumColumn(
    db,
    `SELECT SUM(input_tokens) AS total
       FROM agent_token_events
      WHERE timestamp >= ? AND timestamp < ?`,
    startSec,
    endSec,
  );

  const agentTokensOut = sumColumn(
    db,
    `SELECT SUM(output_tokens) AS total
       FROM agent_token_events
      WHERE timestamp >= ? AND timestamp < ?`,
    startSec,
    endSec,
  );

  const chatTokensIn = sumColumn(
    db,
    `SELECT SUM(input_tokens) AS total
       FROM messages
      WHERE timestamp >= ? AND timestamp < ? AND input_tokens > 0`,
    startSec,
    endSec,
  );

  const chatTokensOut = sumColumn(
    db,
    `SELECT SUM(output_tokens) AS total
       FROM messages
      WHERE timestamp >= ? AND timestamp < ? AND output_tokens > 0`,
    startSec,
    endSec,
  );

  upsertMetric(db, bucket, 'agent_tokens_in', agentTokensIn);
  upsertMetric(db, bucket, 'agent_tokens_out', agentTokensOut);
  upsertMetric(db, bucket, 'chat_tokens_in', chatTokensIn);
  upsertMetric(db, bucket, 'chat_tokens_out', chatTokensOut);

  // ── Session metrics ──
  const sessionsStarted = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM agent_sessions
      WHERE unixepoch(started_at) >= ? AND unixepoch(started_at) < ?`,
    startSec,
    endSec,
  );

  const sessionsActive = countMessages(
    db,
    `SELECT COUNT(*) AS cnt
       FROM agent_sessions
      WHERE unixepoch(started_at) < ?
        AND (ended_at IS NULL OR unixepoch(ended_at) > ?)
        AND status != 'suspended'`,
    endSec,
    startSec,
  );

  upsertMetric(db, bucket, 'sessions_started', sessionsStarted);
  upsertMetric(db, bucket, 'sessions_active', sessionsActive);
}

/** Aggregate the current UTC hour and upsert the nine fleet metrics. */
export function collectHourlyMetrics(db: Database, now = new Date()): void {
  collectMetricsForWindow(db, toHourWindow(now));
}

/**
 * Backfill historical hourly buckets for the requested lookback window.
 *
 * Message and token metrics: only hours containing messages are materialized.
 * Session metrics: every hour in the window is iterated (sessions_active is
 * an overlap calculation — a long-running session must appear in every hour).
 */
export function backfillMetrics(db: Database, days = 30, now = new Date()): void {
  const currentHour = toHourWindow(now);
  const lookbackHours = Math.max(1, Math.floor(days * 24));
  const lookbackStartSec = currentHour.startSec - ((lookbackHours - 1) * 60 * 60);

  // Discover hours with message activity (for message + token metrics)
  const hourRows = db.raw.prepare(`
    SELECT DISTINCT CAST(timestamp / 3600 AS INTEGER) AS hour_bucket
      FROM messages
     WHERE timestamp >= ? AND timestamp < ?
     ORDER BY hour_bucket
  `).all(lookbackStartSec, currentHour.endSec) as Array<{ hour_bucket: number }>;

  // Build set of message-active hours
  const messageHours = new Set(hourRows.map(r => r.hour_bucket));

  // Full-window iteration: every hour for session metrics
  const allHourBuckets: number[] = [];
  for (let sec = lookbackStartSec; sec <= currentHour.startSec; sec += 3600) {
    allHourBuckets.push(Math.floor(sec / 3600));
  }

  if (allHourBuckets.length === 0 && messageHours.size === 0) return;

  db.raw.exec('BEGIN');
  try {
    for (const hourBucket of allHourBuckets) {
      const bucketStartSec = hourBucket * 3600;
      const window: HourWindow = {
        bucket: new Date(bucketStartSec * 1000).toISOString(),
        startSec: bucketStartSec,
        endSec: bucketStartSec + 3600,
      };

      if (messageHours.has(hourBucket)) {
        // Full collection: messages + tokens + sessions
        collectMetricsForWindow(db, window);
      } else {
        // Session metrics only (no messages this hour, but sessions may overlap)
        const sessionsStarted = countMessages(
          db,
          `SELECT COUNT(*) AS cnt
             FROM agent_sessions
            WHERE unixepoch(started_at) >= ? AND unixepoch(started_at) < ?`,
          window.startSec,
          window.endSec,
        );

        const sessionsActive = countMessages(
          db,
          `SELECT COUNT(*) AS cnt
             FROM agent_sessions
            WHERE unixepoch(started_at) < ?
              AND (ended_at IS NULL OR unixepoch(ended_at) > ?)
              AND status != 'suspended'`,
          window.endSec,
          window.startSec,
        );

        upsertMetric(db, window.bucket, 'sessions_started', sessionsStarted);
        upsertMetric(db, window.bucket, 'sessions_active', sessionsActive);
      }
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run --pool=forks tests/core/metrics-collector.test.ts`

- [ ] **Step 5: Commit**

`git add src/core/metrics-collector.ts tests/core/metrics-collector.test.ts && git commit -m "feat: extend hourly collector with token + session metrics, full-window backfill"`

---

## Task 4: Bucket Densification + Extended db-reader

**Files:**
- Modify: `src/fleet/db-reader.ts`
- Create: `tests/fleet/db-reader-metrics.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/fleet/db-reader-metrics.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { FleetDbReader } from '../../src/fleet/db-reader.ts';

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_hourly (
      bucket TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (bucket, metric)
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_hourly_bucket ON metrics_hourly(bucket);

    CREATE TABLE IF NOT EXISTS messages (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      content TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      deleted_at TEXT
    );
  `);
  return db;
}

function insertMetric(db: DatabaseSync, bucket: string, metric: string, value: number) {
  db.prepare(`
    INSERT INTO metrics_hourly (bucket, metric, value) VALUES (?, ?, ?)
    ON CONFLICT(bucket, metric) DO UPDATE SET value = excluded.value
  `).run(bucket, metric, value);
}

describe('FleetDbReader.getMetrics — densification', () => {
  let db: DatabaseSync;
  let reader: FleetDbReader;

  beforeEach(() => {
    db = setupDb();
    reader = new FleetDbReader('self', db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns zero-filled messageVolume for 24h range with sparse data', () => {
    // Insert data for only 2 of 24 hours
    insertMetric(db, '2026-04-05T10:00:00.000Z', 'messages_in', 5);
    insertMetric(db, '2026-04-05T10:00:00.000Z', 'messages_out', 3);
    insertMetric(db, '2026-04-05T10:00:00.000Z', 'messages_media', 1);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'messages_in', 8);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'messages_out', 2);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'messages_media', 0);

    // Mock Date.now to a fixed time
    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have exactly 24 buckets
    expect(result.data.messageVolume).toHaveLength(24);

    // Non-zero buckets should have correct values
    const hour10 = result.data.messageVolume.find(b => b.bucket.includes('T10:00'));
    expect(hour10?.inbound).toBe(5);
    expect(hour10?.outbound).toBe(3);
    expect(hour10?.media).toBe(1);

    // Zero-filled buckets should exist
    const hour12 = result.data.messageVolume.find(b => b.bucket.includes('T12:00'));
    expect(hour12?.inbound).toBe(0);
    expect(hour12?.outbound).toBe(0);
    expect(hour12?.media).toBe(0);
  });

  it('returns tokenUsage and sessionActivity arrays with correct length', () => {
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_in', 100);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'agent_tokens_out', 50);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'chat_tokens_in', 80);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'chat_tokens_out', 40);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_started', 2);
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'sessions_active', 3);

    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.tokenUsage).toHaveLength(24);
    expect(result.data.sessionActivity).toHaveLength(24);

    // Token chart = agent + chat combined
    const tokBucket = result.data.tokenUsage.find(b => b.bucket.includes('T15:00'));
    expect(tokBucket?.input).toBe(180);  // 100 + 80
    expect(tokBucket?.output).toBe(90);  // 50 + 40

    const sesBucket = result.data.sessionActivity.find(b => b.bucket.includes('T15:00'));
    expect(sesBucket?.started).toBe(2);
    expect(sesBucket?.active).toBe(3);
  });

  it('returns hasMessageData/hasTokenData/hasSessionData flags', () => {
    insertMetric(db, '2026-04-05T15:00:00.000Z', 'messages_in', 5);

    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '24h' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.hasMessageData).toBe(true);
    expect(result.data.hasTokenData).toBe(false);
    expect(result.data.hasSessionData).toBe(false);
  });

  it('7d range produces 168 buckets', () => {
    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '7d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.messageVolume).toHaveLength(168);
    expect(result.data.tokenUsage).toHaveLength(168);
    expect(result.data.sessionActivity).toHaveLength(168);
  });

  it('30d range produces 720 buckets', () => {
    const now = new Date('2026-04-05T18:30:00.000Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const result = reader.getMetrics('self', '', { range: '30d' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.messageVolume).toHaveLength(720);
    expect(result.data.tokenUsage).toHaveLength(720);
    expect(result.data.sessionActivity).toHaveLength(720);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run --pool=forks tests/fleet/db-reader-metrics.test.ts`
Expected: FAIL — `getMetrics` return type doesn't include `tokenUsage`, `sessionActivity`, `media`, or `hasMessageData`.

- [ ] **Step 3: Write implementation**

Replace the `getMetrics` method in `src/fleet/db-reader.ts` (lines 269-316). The new return type:

```typescript
  /** Fetch hourly metrics for an instance within a time range. */
  getMetrics(
    name: string,
    dbPath: string,
    opts: { range: '24h' | '7d' | '30d' },
  ): DbResult<{
    messageVolume: { bucket: string; inbound: number; outbound: number; media: number }[];
    tokenUsage: { bucket: string; input: number; output: number }[];
    sessionActivity: { bucket: string; active: number; started: number }[];
    activeHours: number[][];
    hasMessageData: boolean;
    hasTokenData: boolean;
    hasSessionData: boolean;
  }> {
    const rangeHours = opts.range === '24h' ? 24 : opts.range === '7d' ? 168 : 720;
    const cutoff = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();

    return this.query(name, dbPath, (db) => {
      // Read all 9 metrics from metrics_hourly
      const allRows = db.prepare(`
        SELECT bucket, metric, value FROM metrics_hourly
        WHERE bucket >= ? AND metric IN (
          'messages_in', 'messages_out', 'messages_media',
          'agent_tokens_in', 'agent_tokens_out', 'chat_tokens_in', 'chat_tokens_out',
          'sessions_started', 'sessions_active'
        )
        ORDER BY bucket ASC
      `).all(cutoff) as { bucket: string; metric: string; value: number }[];

      // Build a map of bucket -> metric -> value
      const dataMap = new Map<string, Map<string, number>>();
      for (const row of allRows) {
        let metrics = dataMap.get(row.bucket);
        if (!metrics) {
          metrics = new Map();
          dataMap.set(row.bucket, metrics);
        }
        metrics.set(row.metric, row.value);
      }

      // Generate full bucket sequence (densification)
      const nowHour = new Date();
      nowHour.setUTCMinutes(0, 0, 0);
      const bucketSequence: string[] = [];
      for (let i = rangeHours - 1; i >= 0; i--) {
        const t = new Date(nowHour.getTime() - i * 60 * 60 * 1000);
        bucketSequence.push(t.toISOString());
      }

      // Helper to read a metric from the map
      const getVal = (bucket: string, metric: string): number => {
        return dataMap.get(bucket)?.get(metric) ?? 0;
      };

      // Densify into arrays
      let hasMessageData = false;
      let hasTokenData = false;
      let hasSessionData = false;

      const messageVolume = bucketSequence.map(bucket => {
        const inbound = getVal(bucket, 'messages_in');
        const outbound = getVal(bucket, 'messages_out');
        const media = getVal(bucket, 'messages_media');
        if (inbound > 0 || outbound > 0 || media > 0) hasMessageData = true;
        return { bucket, inbound, outbound, media };
      });

      const tokenUsage = bucketSequence.map(bucket => {
        const input = getVal(bucket, 'agent_tokens_in') + getVal(bucket, 'chat_tokens_in');
        const output = getVal(bucket, 'agent_tokens_out') + getVal(bucket, 'chat_tokens_out');
        if (input > 0 || output > 0) hasTokenData = true;
        return { bucket, input, output };
      });

      const sessionActivity = bucketSequence.map(bucket => {
        const active = getVal(bucket, 'sessions_active');
        const started = getVal(bucket, 'sessions_started');
        if (active > 0 || started > 0) hasSessionData = true;
        return { bucket, active, started };
      });

      // Active hours heatmap (7 days x 24 hours) from raw messages
      const heatmapRows = db.prepare(`
        SELECT
          CAST(strftime('%w', timestamp, 'unixepoch') AS INTEGER) AS dow,
          CAST(strftime('%H', timestamp, 'unixepoch') AS INTEGER) AS hour,
          COUNT(*) AS cnt
        FROM messages
        WHERE timestamp >= ? AND deleted_at IS NULL
        GROUP BY dow, hour
      `).all(Math.floor(new Date(cutoff).getTime() / 1000)) as { dow: number; hour: number; cnt: number }[];

      const activeHours: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
      for (const row of heatmapRows) {
        activeHours[row.dow][row.hour] = row.cnt;
      }

      return { messageVolume, tokenUsage, sessionActivity, activeHours, hasMessageData, hasTokenData, hasSessionData };
    });
  }
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run --pool=forks tests/fleet/db-reader-metrics.test.ts`

- [ ] **Step 5: Commit**

`git add src/fleet/db-reader.ts tests/fleet/db-reader-metrics.test.ts && git commit -m "feat: bucket densification + extended db-reader with token/session/media metrics"`

---

## Task 5: Fleet Metrics API — Extended Responses

**Files:**
- Modify: `src/fleet/routes/fleet-metrics.ts`
- Modify: `src/fleet/routes/metrics.ts`
- Create: `tests/fleet/fleet-metrics-extended.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/fleet/fleet-metrics-extended.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGetFleetMetrics, type FleetMetricsDeps } from '../../src/fleet/routes/fleet-metrics.ts';

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function mockRes(): ServerResponse & { _statusCode: number; _body: any } {
  const res = {
    _statusCode: 0,
    _body: null,
    writeHead(code: number) { res._statusCode = code; return res; },
    end(body: string) { res._body = JSON.parse(body); },
    setHeader() {},
  } as unknown as ServerResponse & { _statusCode: number; _body: any };
  return res;
}

function mockReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

describe('handleGetFleetMetrics — extended', () => {
  it('aggregates all 9 metrics across instances with meta flags', () => {
    const deps: FleetMetricsDeps = {
      discovery: {
        getInstances: () => new Map([
          ['inst1', { name: 'inst1', dbPath: '/tmp/1.db' }],
          ['inst2', { name: 'inst2', dbPath: '/tmp/2.db' }],
        ]),
      } as any,
      dbReader: {
        getMetrics: vi.fn()
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [{ bucket: '2026-04-05T15:00:00.000Z', inbound: 5, outbound: 3, media: 1 }],
              tokenUsage: [{ bucket: '2026-04-05T15:00:00.000Z', input: 100, output: 50 }],
              sessionActivity: [{ bucket: '2026-04-05T15:00:00.000Z', active: 2, started: 1 }],
              activeHours: [],
              hasMessageData: true,
              hasTokenData: true,
              hasSessionData: true,
            },
          })
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [{ bucket: '2026-04-05T15:00:00.000Z', inbound: 3, outbound: 2, media: 0 }],
              tokenUsage: [{ bucket: '2026-04-05T15:00:00.000Z', input: 200, output: 75 }],
              sessionActivity: [{ bucket: '2026-04-05T15:00:00.000Z', active: 1, started: 0 }],
              activeHours: [],
              hasMessageData: true,
              hasTokenData: true,
              hasSessionData: true,
            },
          }),
      } as any,
    };

    const res = mockRes();
    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

    expect(res._statusCode).toBe(200);
    expect(res._body.range).toBe('24h');
    expect(res._body.messageVolume).toHaveLength(1);
    expect(res._body.messageVolume[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      inbound: 8,
      outbound: 5,
      media: 1,
    });
    expect(res._body.tokenUsage[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      input: 300,
      output: 125,
    });
    expect(res._body.sessionActivity[0]).toEqual({
      bucket: '2026-04-05T15:00:00.000Z',
      active: 3,
      started: 1,
    });
    expect(res._body.meta.instancesQueried).toBe(2);
    expect(res._body.meta.instancesFailed).toBe(0);
    expect(res._body.meta.hasMessageData).toBe(true);
    expect(res._body.meta.hasTokenData).toBe(true);
    expect(res._body.meta.hasSessionData).toBe(true);
  });

  it('handles partial instance failure with meta.instancesFailed', () => {
    const deps: FleetMetricsDeps = {
      discovery: {
        getInstances: () => new Map([
          ['inst1', { name: 'inst1', dbPath: '/tmp/1.db' }],
          ['inst2', { name: 'inst2', dbPath: '/tmp/2.db' }],
        ]),
      } as any,
      dbReader: {
        getMetrics: vi.fn()
          .mockReturnValueOnce({
            ok: true,
            data: {
              messageVolume: [{ bucket: '2026-04-05T15:00:00.000Z', inbound: 5, outbound: 3, media: 0 }],
              tokenUsage: [{ bucket: '2026-04-05T15:00:00.000Z', input: 100, output: 50 }],
              sessionActivity: [{ bucket: '2026-04-05T15:00:00.000Z', active: 1, started: 1 }],
              activeHours: [],
              hasMessageData: true,
              hasTokenData: true,
              hasSessionData: true,
            },
          })
          .mockReturnValueOnce({ ok: false, error: 'db locked' }),
      } as any,
    };

    const res = mockRes();
    handleGetFleetMetrics(mockReq('/api/metrics?range=24h'), res, deps);

    expect(res._statusCode).toBe(200);
    expect(res._body.meta.instancesQueried).toBe(2);
    expect(res._body.meta.instancesFailed).toBe(1);
    expect(res._body.messageVolume).toHaveLength(1);
    expect(res._body.messageVolume[0].inbound).toBe(5);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run --pool=forks tests/fleet/fleet-metrics-extended.test.ts`
Expected: FAIL — response doesn't include `tokenUsage`, `sessionActivity`, or `meta`.

- [ ] **Step 3: Write implementation**

Replace `src/fleet/routes/fleet-metrics.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, parseQueryString } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface FleetMetricsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

const VALID_RANGES = new Set(['24h', '7d', '30d']);

/**
 * GET /api/metrics?range=24h|7d|30d
 *
 * Aggregate metrics across ALL instances into combined time series.
 * Returns messageVolume, tokenUsage, sessionActivity, and meta.
 */
export function handleGetFleetMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FleetMetricsDeps,
): void {
  const qs = parseQueryString(req.url);
  const range = (qs.range || '24h') as '24h' | '7d' | '30d';
  if (!VALID_RANGES.has(range)) {
    jsonResponse(res, 400, { error: 'range must be one of: 24h, 7d, 30d' });
    return;
  }

  const instances = deps.discovery.getInstances();
  const msgMap = new Map<string, { inbound: number; outbound: number; media: number }>();
  const tokMap = new Map<string, { input: number; output: number }>();
  const sesMap = new Map<string, { active: number; started: number }>();

  let instancesQueried = 0;
  let instancesFailed = 0;
  let hasMessageData = false;
  let hasTokenData = false;
  let hasSessionData = false;

  for (const [, instance] of instances) {
    instancesQueried++;
    const result = deps.dbReader.getMetrics(instance.name, instance.dbPath, { range });
    if (!result.ok) {
      instancesFailed++;
      continue;
    }

    if (result.data.hasMessageData) hasMessageData = true;
    if (result.data.hasTokenData) hasTokenData = true;
    if (result.data.hasSessionData) hasSessionData = true;

    for (const bucket of result.data.messageVolume) {
      const existing = msgMap.get(bucket.bucket) ?? { inbound: 0, outbound: 0, media: 0 };
      existing.inbound += bucket.inbound;
      existing.outbound += bucket.outbound;
      existing.media += bucket.media;
      msgMap.set(bucket.bucket, existing);
    }

    for (const bucket of result.data.tokenUsage) {
      const existing = tokMap.get(bucket.bucket) ?? { input: 0, output: 0 };
      existing.input += bucket.input;
      existing.output += bucket.output;
      tokMap.set(bucket.bucket, existing);
    }

    for (const bucket of result.data.sessionActivity) {
      const existing = sesMap.get(bucket.bucket) ?? { active: 0, started: 0 };
      existing.active += bucket.active;
      existing.started += bucket.started;
      sesMap.set(bucket.bucket, existing);
    }
  }

  const sortEntries = <T>(map: Map<string, T>) =>
    Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b));

  const messageVolume = sortEntries(msgMap).map(([bucket, v]) => ({ bucket, ...v }));
  const tokenUsage = sortEntries(tokMap).map(([bucket, v]) => ({ bucket, ...v }));
  const sessionActivity = sortEntries(sesMap).map(([bucket, v]) => ({ bucket, ...v }));

  jsonResponse(res, 200, {
    range,
    meta: { instancesQueried, instancesFailed, hasMessageData, hasTokenData, hasSessionData },
    messageVolume,
    tokenUsage,
    sessionActivity,
  });
}
```

Extend `src/fleet/routes/metrics.ts` to forward the new fields:

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse, requireInstance, parseQueryString } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface MetricsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
}

const VALID_RANGES = new Set(['24h', '7d', '30d']);

/** GET /api/lines/:name/metrics?range=24h|7d|30d — hourly metrics for a line. */
export function handleGetMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsDeps,
  params: { name: string },
): void {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const qs = parseQueryString(req.url);
  const range = (qs.range || '24h') as '24h' | '7d' | '30d';
  if (!VALID_RANGES.has(range)) {
    jsonResponse(res, 400, { error: 'range must be one of: 24h, 7d, 30d' });
    return;
  }

  const result = deps.dbReader.getMetrics(instance.name, instance.dbPath, { range });
  if (!result.ok) {
    jsonResponse(res, 500, { error: result.error });
    return;
  }

  jsonResponse(res, 200, { range, ...result.data });
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run --pool=forks tests/fleet/fleet-metrics-extended.test.ts`

- [ ] **Step 5: Commit**

`git add src/fleet/routes/fleet-metrics.ts src/fleet/routes/metrics.ts tests/fleet/fleet-metrics-extended.test.ts && git commit -m "feat: extend fleet + per-line metrics API with token, session, media data + meta"`

---

## Task 6: Frontend Types + Chart Utils + Sparklines

**Files:**
- Modify: `console/src/types.ts`
- Modify: `console/src/lib/chart-utils.ts`
- Modify: `console/src/lib/metrics-sparklines.ts`
- Modify: `console/src/hooks/use-metrics.ts`
- Modify: `console/src/lib/api.ts`

- [ ] **Step 1: Update types**

In `console/src/types.ts`, replace the existing `MessageVolumeBucket`, `FleetMetrics`, and `LineMetrics` interfaces and add new ones:

```typescript
export interface MessageVolumeBucket {
  bucket: string;
  inbound: number;
  outbound: number;
  media: number;
}

export interface TokenUsageBucket {
  bucket: string;
  input: number;
  output: number;
}

export interface SessionActivityBucket {
  bucket: string;
  active: number;
  started: number;
}

export interface FleetMetricsMeta {
  instancesQueried: number;
  instancesFailed: number;
  hasMessageData: boolean;
  hasTokenData: boolean;
  hasSessionData: boolean;
}

export interface LineMetrics {
  range: MetricsRange;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];
  sessionActivity: SessionActivityBucket[];
  activeHours: number[][];
  hasMessageData: boolean;
  hasTokenData: boolean;
  hasSessionData: boolean;
}

export interface FleetMetrics {
  range: MetricsRange;
  meta: FleetMetricsMeta;
  messageVolume: MessageVolumeBucket[];
  tokenUsage: TokenUsageBucket[];
  sessionActivity: SessionActivityBucket[];
}
```

- [ ] **Step 2: Extend chart-utils**

Replace `console/src/lib/chart-utils.ts`:

```typescript
/** Shared chart utilities for recharts-based components. */

import type { MetricsRange } from '../types.js';

export const AXIS_TICK = {
  fontSize: 'var(--font-size-xs)',
  fill: 'var(--color-t4)',
};

export const CHART_MARGIN = { top: 4, right: 8, left: -16, bottom: 0 };

export const TOOLTIP_STYLE = {
  background: 'var(--color-d3)',
  borderWidth: 'var(--bw)',
  borderStyle: 'solid' as const,
  borderColor: 'var(--b2)',
  borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-md)',
  fontSize: 'var(--font-size-xs)',
};

export function formatBucketLabel(bucket: string, range?: MetricsRange): string {
  const d = new Date(bucket);
  if (range === '30d') {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  if (range === '7d') {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleTimeString([], { hour: 'numeric' });
}
```

- [ ] **Step 3: Extend sparklines**

Replace `console/src/lib/metrics-sparklines.ts`:

```typescript
import type { MessageVolumeBucket, SessionActivityBucket } from '../types.js';

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 1);
  return values.map((value) => value / max);
}

export interface FleetMessageSparklines {
  inbound: number[];
  outbound: number[];
  media: number[];
}

export interface FleetSessionSparklines {
  active: number[];
}

export function deriveFleetMessageSparklines(
  messageVolume: MessageVolumeBucket[] | undefined,
): FleetMessageSparklines | undefined {
  if (!messageVolume || messageVolume.length === 0) return undefined;

  const buckets = [...messageVolume].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return {
    inbound: normalize(buckets.map((bucket) => bucket.inbound)),
    outbound: normalize(buckets.map((bucket) => bucket.outbound)),
    media: normalize(buckets.map((bucket) => bucket.media)),
  };
}

export function deriveFleetSessionSparklines(
  sessionActivity: SessionActivityBucket[] | undefined,
): FleetSessionSparklines | undefined {
  if (!sessionActivity || sessionActivity.length === 0) return undefined;

  const buckets = [...sessionActivity].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return {
    active: normalize(buckets.map((bucket) => bucket.active)),
  };
}
```

- [ ] **Step 4: Run typecheck**

Run: `cd /home/q/LAB/WhatSoup/console && npx tsc --noEmit`

Note: There will be type errors in other files that reference the old `MessageVolumeBucket` (no `media` field). Those are expected and will be fixed in subsequent tasks. The typecheck verifies the new types themselves are correct.

- [ ] **Step 5: Commit**

`git add console/src/types.ts console/src/lib/chart-utils.ts console/src/lib/metrics-sparklines.ts && git commit -m "feat: frontend types + chart utils + sparklines for token/session/media data"`

---

## Task 7: ChartPanel Wrapper Component

**Files:**
- Create: `console/src/components/ChartPanel.tsx`
- Create: `tests/console/chart-panel.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/console/chart-panel.test.ts`:

```typescript
import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function getProps(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== 'object') return {};
  return (node as { props?: Record<string, unknown> }).props ?? {};
}

function toChildren(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const children = (node as { props?: { children?: unknown } }).props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function elementName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const type = (node as { type?: string | { displayName?: string; name?: string } }).type;
  if (typeof type === 'string') return type;
  return type?.displayName ?? type?.name;
}

function findByTestId(node: unknown, testId: string): unknown | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const props = getProps(node);
  if (props['data-testid'] === testId) return node;
  for (const child of toChildren(node)) {
    const found = findByTestId(child, testId);
    if (found) return found;
  }
  return undefined;
}

function findByText(node: unknown, text: string): boolean {
  if (!node) return false;
  if (typeof node === 'string') return node.includes(text);
  if (typeof node === 'number') return String(node).includes(text);
  if (typeof node !== 'object') return false;
  const children = toChildren(node);
  return children.some(c => findByText(c, text));
}

describe('ChartPanel', () => {
  it('renders loading shimmer when isLoading is true', async () => {
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const element = ChartPanel({
      title: 'Test Chart',
      chartKey: 'messages',
      isLoading: true,
      isError: false,
      hasData: false,
      instancesFailed: 0,
      children: null,
    });

    expect(findByText(element, 'Test Chart')).toBe(true);
    // Should have shimmer animation class
    const shimmer = findByTestId(element, 'chart-shimmer');
    expect(shimmer).toBeDefined();
  });

  it('renders error state with retry button', async () => {
    const onRetry = vi.fn();
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const element = ChartPanel({
      title: 'Test Chart',
      chartKey: 'tokens',
      isLoading: false,
      isError: true,
      hasData: false,
      instancesFailed: 0,
      onRetry,
      children: null,
    });

    expect(findByText(element, 'Failed to load')).toBe(true);
  });

  it('renders empty state when hasData is false', async () => {
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const element = ChartPanel({
      title: 'Test Chart',
      chartKey: 'sessions',
      isLoading: false,
      isError: false,
      hasData: false,
      instancesFailed: 0,
      children: null,
    });

    expect(findByText(element, 'No data yet')).toBe(true);
  });

  it('renders children when hasData is true', async () => {
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const child = { type: 'div', props: { children: 'Chart content' }, key: null };
    const element = ChartPanel({
      title: 'Test Chart',
      chartKey: 'messages',
      isLoading: false,
      isError: false,
      hasData: true,
      instancesFailed: 0,
      children: child,
    });

    expect(findByText(element, 'Chart content')).toBe(true);
  });

  it('shows warning pill when instancesFailed > 0', async () => {
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const child = { type: 'div', props: { children: 'Chart content' }, key: null };
    const element = ChartPanel({
      title: 'Test Chart',
      chartKey: 'messages',
      isLoading: false,
      isError: false,
      hasData: true,
      instancesFailed: 2,
      children: child,
    });

    expect(findByText(element, '2 instance(s) unavailable')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

Run: `npx vitest run --pool=forks tests/console/chart-panel.test.ts`
Expected: FAIL — `ChartPanel` module doesn't exist.

- [ ] **Step 3: Write implementation**

Create `console/src/components/ChartPanel.tsx`:

```tsx
import { type FC, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, BarChart3 } from 'lucide-react';

export type ChartKey = 'messages' | 'tokens' | 'sessions';

interface ChartPanelProps {
  title: string;
  chartKey: ChartKey;
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
  instancesFailed: number;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onRetry?: () => void;
  children: ReactNode;
}

export const ChartPanel: FC<ChartPanelProps> = ({
  title,
  chartKey,
  isLoading,
  isError,
  hasData,
  instancesFailed,
  expanded = false,
  onToggleExpand,
  onRetry,
  children,
}) => {
  const height = expanded ? 200 : 120;

  return (
    <section className="c-card font-mono flex-shrink-0 p-[var(--sp-4)] bg-d2">
      {/* Header */}
      <div className="flex items-center justify-between mb-[var(--sp-3)]">
        <button
          type="button"
          className="font-mono text-t4 uppercase tracking-[var(--tracking-label)] cursor-pointer hover:text-t2 flex items-center gap-[var(--sp-1)]"
          style={{ fontSize: 'var(--font-size-xs)' }}
          onClick={onToggleExpand}
        >
          {title}
          {onToggleExpand && (expanded
            ? <ChevronUp size={12} strokeWidth={1.75} />
            : <ChevronDown size={12} strokeWidth={1.75} />
          )}
        </button>
        {instancesFailed > 0 && (
          <span
            className="font-mono rounded-sm px-[var(--sp-1h)] py-[var(--sp-half)]"
            style={{
              fontSize: 'var(--font-size-label)',
              color: 'var(--color-s-warn)',
              backgroundColor: 'var(--s-warn-wash)',
              border: 'var(--bw) solid var(--color-s-warn)',
            }}
          >
            {instancesFailed} instance(s) unavailable
          </span>
        )}
      </div>

      {/* Body */}
      {isLoading ? (
        <div
          data-testid="chart-shimmer"
          className="animate-shimmer rounded-md bg-d3"
          style={{ height }}
        />
      ) : isError ? (
        <div
          className="flex flex-col items-center justify-center text-center"
          style={{ height }}
        >
          <span className="text-s-crit font-sans" style={{ fontSize: 'var(--font-size-sm)' }}>
            Failed to load
          </span>
          {onRetry && (
            <button
              type="button"
              className="c-btn c-btn-sm c-btn-ghost mt-[var(--sp-2)]"
              onClick={onRetry}
            >
              Retry
            </button>
          )}
        </div>
      ) : !hasData ? (
        <div
          className="flex flex-col items-center justify-center text-center text-t5"
          style={{ height }}
        >
          <BarChart3 size={24} strokeWidth={1.25} className="mb-[var(--sp-2)]" />
          <span className="font-sans" style={{ fontSize: 'var(--font-size-sm)' }}>
            No data yet
          </span>
        </div>
      ) : (
        <div style={{ height }}>
          {children}
        </div>
      )}
    </section>
  );
};
```

- [ ] **Step 4: Run test, verify pass**

Run: `npx vitest run --pool=forks tests/console/chart-panel.test.ts`

- [ ] **Step 5: Commit**

`git add console/src/components/ChartPanel.tsx tests/console/chart-panel.test.ts && git commit -m "feat: ChartPanel wrapper with loading/error/empty/partial states"`

---

## Task 8: FleetMetricsChart Modification — Add Media Series

**Files:**
- Modify: `console/src/components/FleetMetricsChart.tsx`

- [ ] **Step 1: Update FleetMetricsChart**

Replace `console/src/components/FleetMetricsChart.tsx`:

```tsx
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MessageVolumeBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, TOOLTIP_STYLE, formatBucketLabel } from '../lib/chart-utils.js';

interface FleetMetricsChartProps {
  data: MessageVolumeBucket[];
  range?: MetricsRange;
}

/** Stacked area chart showing fleet-wide inbound/outbound/media message volume. */
export function FleetMetricsChart({ data, range = '24h' }: FleetMetricsChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      {/* eslint-disable-next-line no-restricted-syntax -- recharts margin uses raw numbers (px offsets), not CSS tokens; expires 2026-12-31 */}
      <AreaChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke="var(--b1)" vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--b1)' }}
          minTickGap={40}
          tickFormatter={(v) => formatBucketLabel(v, range)}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={28}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => new Date(String(v)).toLocaleString()}
        />
        <Area
          type="monotone"
          dataKey="inbound"
          name="Inbound"
          stackId="msgs"
          stroke="var(--color-m-pas)"
          fill="var(--color-m-pas)"
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="outbound"
          name="Outbound"
          stackId="msgs"
          stroke="var(--color-m-cht)"
          fill="var(--color-m-cht)"
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="media"
          name="Media"
          stackId="msgs"
          stroke="var(--color-s-warn)"
          fill="var(--color-s-warn)"
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /home/q/LAB/WhatSoup/console && npx tsc --noEmit`

- [ ] **Step 3: Commit**

`git add console/src/components/FleetMetricsChart.tsx && git commit -m "feat: add media series (amber) to FleetMetricsChart"`

---

## Task 9: FleetTokenChart — New Component

**Files:**
- Create: `console/src/components/FleetTokenChart.tsx`

- [ ] **Step 1: Create component**

Create `console/src/components/FleetTokenChart.tsx`:

```tsx
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TokenUsageBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, TOOLTIP_STYLE, formatBucketLabel } from '../lib/chart-utils.js';

interface FleetTokenChartProps {
  data: TokenUsageBucket[];
  range?: MetricsRange;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

/** Area chart showing fleet-wide token consumption (input + output). */
export function FleetTokenChart({ data, range = '24h' }: FleetTokenChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke="var(--b1)" vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--b1)' }}
          minTickGap={40}
          tickFormatter={(v) => formatBucketLabel(v, range)}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={36}
          allowDecimals={false}
          tickFormatter={formatTokenCount}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => new Date(String(v)).toLocaleString()}
          formatter={(value: number, name: string) => [
            value.toLocaleString(),
            name,
          ]}
        />
        <Area
          type="monotone"
          dataKey="output"
          name="Output Tokens"
          stroke="var(--color-m-agt)"
          fill="var(--color-m-agt)"
          fillOpacity={0.3}
        />
        <Area
          type="monotone"
          dataKey="input"
          name="Input Tokens"
          stroke="var(--color-m-agt)"
          strokeDasharray="4 2"
          fill="var(--color-m-agt)"
          fillOpacity={0.15}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /home/q/LAB/WhatSoup/console && npx tsc --noEmit`

- [ ] **Step 3: Commit**

`git add console/src/components/FleetTokenChart.tsx && git commit -m "feat: FleetTokenChart component — violet area chart for token consumption"`

---

## Task 10: FleetSessionChart — New Component

**Files:**
- Create: `console/src/components/FleetSessionChart.tsx`

- [ ] **Step 1: Create component**

Create `console/src/components/FleetSessionChart.tsx`:

```tsx
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SessionActivityBucket, MetricsRange } from '../types';
import { AXIS_TICK, CHART_MARGIN, TOOLTIP_STYLE, formatBucketLabel } from '../lib/chart-utils.js';

interface FleetSessionChartProps {
  data: SessionActivityBucket[];
  range?: MetricsRange;
}

/** Composed chart with area (active sessions) + bar (sessions started). */
export function FleetSessionChart({ data, range = '24h' }: FleetSessionChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke="var(--b1)" vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--b1)' }}
          minTickGap={40}
          tickFormatter={(v) => formatBucketLabel(v, range)}
        />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={28}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => new Date(String(v)).toLocaleString()}
        />
        <Area
          type="monotone"
          dataKey="active"
          name="Active Sessions"
          stroke="var(--color-s-ok)"
          fill="var(--color-s-ok)"
          fillOpacity={0.3}
        />
        <Bar
          dataKey="started"
          name="Sessions Started"
          fill="var(--color-s-ok)"
          fillOpacity={0.6}
          barSize={4}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /home/q/LAB/WhatSoup/console && npx tsc --noEmit`

- [ ] **Step 3: Commit**

`git add console/src/components/FleetSessionChart.tsx && git commit -m "feat: FleetSessionChart component — composed chart with active area + started bars"`

---

## Task 11: SoupKitchen Integration — Range Picker, 3-Up Charts, Expansion, Sparklines

**Files:**
- Modify: `console/src/pages/SoupKitchen.tsx`

- [ ] **Step 1: Update SoupKitchen page**

Replace the entire `console/src/pages/SoupKitchen.tsx` file. Key changes:

1. Add `chartRange` state (MetricsRange, default `'24h'`).
2. Add `expandedChart` state (`ChartKey | null`, default `null`), separate from `activeKpi`.
3. Pass `chartRange` to `useFleetMetrics(chartRange)`.
4. Add range picker row with FilterPill for `24h`, `7d`, `30d`.
5. Replace the single `FleetMetricsChart` with three `ChartPanel`-wrapped charts.
6. Wire sparklines: `messageSparklines.media` to Media Processed KPI, `sessionSparklines.active` to Agent Sessions KPI.
7. KPI click mapping: Messages Sent/Received/Media -> `expandedChart: 'messages'`; Agent Sessions -> `expandedChart: 'sessions'`.

```tsx
import { type FC, useState, useMemo, useCallback, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, ChevronUp, ChevronDown } from "lucide-react";
const AddLineWizard = lazy(() => import("../components/AddLineWizard"));
import { motion } from "framer-motion";
import { useLines, useFeed } from "../hooks/use-fleet";
import { useFleetMetrics } from "../hooks/use-metrics";
import { computeKpis } from "../lib/compute-kpis";
import { deriveFleetMessageSparklines, deriveFleetSessionSparklines } from "../lib/metrics-sparklines";
import type { Mode, MetricsRange } from "../types";
import type { ChartKey } from "../components/ChartPanel";
import KpiCard from "../components/KpiCard";
import AlertBanner from "../components/AlertBanner";
import ActivityFeed from "../components/ActivityFeed";
import ModeBadge from "../components/ModeBadge";
import FilterPill from "../components/FilterPill";
import { ChartPanel } from "../components/ChartPanel";
import { FleetMetricsChart } from "../components/FleetMetricsChart";
import { FleetTokenChart } from "../components/FleetTokenChart";
import { FleetSessionChart } from "../components/FleetSessionChart";
import LineTags from "../components/LineTags";
import { formatRelative } from "../lib/format-time";
import { formatPhone, displayInstanceName, formatCompact } from "../lib/text-utils";


const ease = [0.22, 1, 0.36, 1] as const;

type KpiFilter = "connected" | "attention" | "unread" | "agent" | "messages" | null;
type SortKey = "mode" | "name" | "chats" | "groups" | "unread" | "sent" | "recv" | "tokens" | "sessions" | "active" | null;
type SortDir = "asc" | "desc";

const COLUMNS: { label: string; widthClass?: string; center: boolean; sortKey: SortKey }[] = [
  { label: "Mode", widthClass: "w-[var(--sk-col-mode)]", center: false, sortKey: "mode" },
  { label: "Line", center: false, sortKey: "name" },
  { label: "Chats", widthClass: "w-[var(--sk-col-chats)]", center: true, sortKey: "chats" },
  { label: "Groups", widthClass: "w-[var(--sk-col-count)]", center: true, sortKey: "groups" },
  { label: "Unread", widthClass: "w-[var(--sk-col-count)]", center: true, sortKey: "unread" },
  { label: "Sent", widthClass: "w-[var(--sk-col-msg)]", center: true, sortKey: "sent" },
  { label: "Recv", widthClass: "w-[var(--sk-col-msg)]", center: true, sortKey: "recv" },
  { label: "Tokens", widthClass: "w-[var(--sk-col-tokens)]", center: true, sortKey: "tokens" },
  { label: "Sessions", widthClass: "w-[var(--sk-col-sessions)]", center: true, sortKey: "sessions" },
  { label: "Tags", center: false, sortKey: null },
  { label: "Active", widthClass: "w-[var(--sk-col-tokens)]", center: true, sortKey: "active" },
];

const modeFilterOptions: (Mode | "all")[] = ["all", "passive", "chat", "agent"];

const modeTextClass: Record<Mode, string> = {
  passive: "text-m-pas",
  chat: "text-m-cht",
  agent: "text-m-agt",
};

const RANGE_OPTIONS: MetricsRange[] = ['24h', '7d', '30d'];

const SoupKitchen: FC = () => {
  const { data: lines = [] } = useLines();
  const { data: feed = [] } = useFeed();
  const navigate = useNavigate();

  const [activeKpi, setActiveKpi] = useState<KpiFilter>(null);
  const [expandedChart, setExpandedChart] = useState<ChartKey | null>(null);
  const [chartRange, setChartRange] = useState<MetricsRange>("24h");
  const [modeFilter, setModeFilter] = useState<Mode | "all">("all");
  const [search, setSearch] = useState("");
  const [showAddWizard, setShowAddWizard] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = useCallback((key: SortKey) => {
    if (!key) return;
    setSortKey(prev => {
      if (prev === key) {
        setSortDir(d => d === "asc" ? "desc" : "asc");
        return key;
      }
      setSortDir("desc");
      return key;
    });
  }, []);

  const kpis = useMemo(() => computeKpis(lines), [lines]);
  const { data: fleetMetrics, isLoading: metricsLoading, isError: metricsError, refetch: metricsRefetch } = useFleetMetrics(chartRange);
  const messageSparklines = useMemo(
    () => deriveFleetMessageSparklines(fleetMetrics?.messageVolume),
    [fleetMetrics?.messageVolume],
  );
  const sessionSparklines = useMemo(
    () => deriveFleetSessionSparklines(fleetMetrics?.sessionActivity),
    [fleetMetrics?.sessionActivity],
  );

  const toggleExpand = useCallback((key: ChartKey) => {
    setExpandedChart(prev => prev === key ? null : key);
  }, []);

  // KPI click: sets both activeKpi (table filter) and expandedChart (chart zoom)
  function toggleKpiWithChart(kpiKey: KpiFilter, chartKey: ChartKey | null) {
    setActiveKpi((prev) => (prev === kpiKey ? null : kpiKey));
    if (chartKey) {
      setExpandedChart((prev) => (prev === chartKey ? null : chartKey));
    }
  }

  function toggleKpi(key: KpiFilter) {
    setActiveKpi((prev) => (prev === key ? null : key));
  }

  // Derive alerts from lines
  const alerts = useMemo(
    () =>
      lines
        .filter((l) => l.status === "unreachable" || l.status === "degraded")
        .map((l) => ({
          line: l.name,
          message:
            l.status === "unreachable"
              ? l.lastSessionStatus === "auth_expired" ? "auth expired" : "connection lost"
              : "degraded",
        })),
    [lines]
  );

  // Mode counts
  const modeCounts = useMemo(() => {
    const counts: Record<Mode | "all", number> = {
      all: lines.length,
      passive: 0,
      chat: 0,
      agent: 0,
    };
    for (const l of lines) counts[l.mode]++;
    return counts;
  }, [lines]);

  // Filter lines
  const filtered = useMemo(() => {
    let result = lines;

    // KPI filter
    if (activeKpi === "connected")
      result = result.filter((l) => l.status === "online");
    else if (activeKpi === "attention")
      result = result.filter(
        (l) => l.status === "unreachable" || l.status === "degraded"
      );
    else if (activeKpi === "unread")
      result = result.filter((l) => (l.unread ?? 0) > 0);
    else if (activeKpi === "agent")
      result = result.filter((l) => l.mode === "agent");
    else if (activeKpi === "messages")
      result = result.filter((l) => (l.messagesToday ?? 0) > 0);

    // Mode filter
    if (modeFilter !== "all")
      result = result.filter((l) => l.mode === modeFilter);

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          (l.phone ?? "").toLowerCase().includes(q)
      );
    }

    // Sort
    if (sortKey) {
      const dir = sortDir === "asc" ? 1 : -1;
      result = [...result].sort((a, b) => {
        let av: number | string = 0;
        let bv: number | string = 0;
        switch (sortKey) {
          case "mode": av = a.mode; bv = b.mode; break;
          case "name": av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
          case "chats": av = a.chatCounts?.chats ?? 0; bv = b.chatCounts?.chats ?? 0; break;
          case "groups": av = a.chatCounts?.groups ?? 0; bv = b.chatCounts?.groups ?? 0; break;
          case "unread": av = a.unread ?? 0; bv = b.unread ?? 0; break;
          case "sent": av = a.messageStats?.sent ?? 0; bv = b.messageStats?.sent ?? 0; break;
          case "recv": av = a.messageStats?.received ?? 0; bv = b.messageStats?.received ?? 0; break;
          case "tokens": av = (a.tokenUsage?.input ?? 0) + (a.tokenUsage?.output ?? 0); bv = (b.tokenUsage?.input ?? 0) + (b.tokenUsage?.output ?? 0); break;
          case "sessions": av = a.totalSessions ?? 0; bv = b.totalSessions ?? 0; break;
          case "active": av = a.lastActive ?? ""; bv = b.lastActive ?? ""; break;
        }
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }

    return result;
  }, [lines, activeKpi, modeFilter, search, sortKey, sortDir]);

  const meta = fleetMetrics?.meta;
  const instancesFailed = meta?.instancesFailed ?? 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden p-[var(--sp-4)] gap-[var(--sp-3)]">
      {/* KPI Strip */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease }}
        className="c-card flex-shrink-0 grid grid-cols-7 gap-[var(--sp-2)] p-[var(--sp-2)]"
      >
        <KpiCard
          value={kpis.connected}
          label="Lines Connected"
          color="text-s-ok"
          onClick={() => toggleKpi("connected")}
          active={activeKpi === "connected"}
        />
        <KpiCard
          value={kpis.needAttention}
          label="Need Attention"
          color="text-s-crit"
          onClick={() => toggleKpi("attention")}
          active={activeKpi === "attention"}
        />
        <KpiCard
          value={kpis.totalSent.toLocaleString()}
          label="Messages Sent"
          color="text-m-cht"
          onClick={() => toggleKpiWithChart("messages", "messages")}
          active={activeKpi === "messages"}
          sparkData={messageSparklines?.outbound}
        />
        <KpiCard
          value={kpis.totalReceived.toLocaleString()}
          label="Messages Received"
          color="text-t2"
          onClick={() => toggleKpiWithChart("messages", "messages")}
          active={activeKpi === "messages"}
          sparkData={messageSparklines?.inbound}
        />
        <KpiCard
          value={kpis.agentSessions}
          label="Agent Sessions"
          color="text-m-agt"
          onClick={() => toggleKpiWithChart("agent", "sessions")}
          active={activeKpi === "agent"}
          sparkData={sessionSparklines?.active}
        />
        <KpiCard
          value={kpis.unread}
          label="Unread"
          color="text-s-warn"
          onClick={() => toggleKpi("unread")}
          active={activeKpi === "unread"}
        />
        <KpiCard
          value={kpis.totalMedia.toLocaleString()}
          label="Media Processed"
          color="text-s-ok"
          onClick={() => toggleKpiWithChart("messages", "messages")}
          active={activeKpi === "messages"}
          sparkData={messageSparklines?.media}
        />
      </motion.div>

      {/* Range Picker */}
      <div className="flex items-center gap-[var(--sp-2)] flex-shrink-0">
        <span className="c-section-label">Range</span>
        {RANGE_OPTIONS.map((r) => (
          <FilterPill
            key={r}
            label={r}
            isActive={chartRange === r}
            onClick={() => setChartRange(r)}
          />
        ))}
      </div>

      {/* Chart Row — 3-up with expansion */}
      <div className="flex gap-[var(--sp-3)] flex-shrink-0">
        <div
          className="transition-all duration-300 ease-out overflow-hidden"
          style={{
            flex: expandedChart === null ? 1 : expandedChart === 'messages' ? 1 : 0,
            opacity: expandedChart === null || expandedChart === 'messages' ? 1 : 0,
            minWidth: expandedChart === null || expandedChart === 'messages' ? undefined : 0,
          }}
        >
          <ChartPanel
            title={`Message Volume (${chartRange})`}
            chartKey="messages"
            isLoading={metricsLoading}
            isError={metricsError}
            hasData={meta?.hasMessageData ?? false}
            instancesFailed={instancesFailed}
            expanded={expandedChart === 'messages'}
            onToggleExpand={() => toggleExpand('messages')}
            onRetry={() => metricsRefetch()}
          >
            {fleetMetrics?.messageVolume && (
              <FleetMetricsChart data={fleetMetrics.messageVolume} range={chartRange} />
            )}
          </ChartPanel>
        </div>

        <div
          className="transition-all duration-300 ease-out overflow-hidden"
          style={{
            flex: expandedChart === null ? 1 : expandedChart === 'tokens' ? 1 : 0,
            opacity: expandedChart === null || expandedChart === 'tokens' ? 1 : 0,
            minWidth: expandedChart === null || expandedChart === 'tokens' ? undefined : 0,
          }}
        >
          <ChartPanel
            title={`Token Usage (${chartRange})`}
            chartKey="tokens"
            isLoading={metricsLoading}
            isError={metricsError}
            hasData={meta?.hasTokenData ?? false}
            instancesFailed={instancesFailed}
            expanded={expandedChart === 'tokens'}
            onToggleExpand={() => toggleExpand('tokens')}
            onRetry={() => metricsRefetch()}
          >
            {fleetMetrics?.tokenUsage && (
              <FleetTokenChart data={fleetMetrics.tokenUsage} range={chartRange} />
            )}
          </ChartPanel>
        </div>

        <div
          className="transition-all duration-300 ease-out overflow-hidden"
          style={{
            flex: expandedChart === null ? 1 : expandedChart === 'sessions' ? 1 : 0,
            opacity: expandedChart === null || expandedChart === 'sessions' ? 1 : 0,
            minWidth: expandedChart === null || expandedChart === 'sessions' ? undefined : 0,
          }}
        >
          <ChartPanel
            title={`Session Activity (${chartRange})`}
            chartKey="sessions"
            isLoading={metricsLoading}
            isError={metricsError}
            hasData={meta?.hasSessionData ?? false}
            instancesFailed={instancesFailed}
            expanded={expandedChart === 'sessions'}
            onToggleExpand={() => toggleExpand('sessions')}
            onRetry={() => metricsRefetch()}
          >
            {fleetMetrics?.sessionActivity && (
              <FleetSessionChart data={fleetMetrics.sessionActivity} range={chartRange} />
            )}
          </ChartPanel>
        </div>
      </div>

      {/* Alert Banner */}
      <AlertBanner alerts={alerts} />

      {/* Main area */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1, ease }}
        className="flex flex-1 min-h-0 gap-[var(--sp-3)]"
      >
        {/* Connection Table */}
        <div className="c-card flex flex-col min-h-0 overflow-hidden basis-0 grow-[3]">
          {/* Toolbar */}
          <div className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar c-border-b">
            <div className="flex items-center gap-4">
              <h2
                className="c-heading-lg"
              >
                Instances
              </h2>

              {/* Mode filter pills */}
              <div className="flex gap-[var(--sp-1h)]">
                {modeFilterOptions.map((m) => (
                  <FilterPill
                    key={m}
                    label={m === "all" ? "All" : m}
                    isActive={modeFilter === m}
                    activeColor={m === "all" ? "text-t2" : modeTextClass[m]}
                    activeBorder={
                      modeFilter === m
                        ? `var(--bw) solid ${m === "passive" ? "var(--color-m-pas)" : m === "chat" ? "var(--color-m-cht)" : m === "agent" ? "var(--color-m-agt)" : "var(--b4)"}`
                        : undefined
                    }
                    onClick={() => setModeFilter(m)}
                    count={modeCounts[m]}
                  />
                ))}
              </div>
            </div>

            {/* Search */}
            <div className="relative flex-1 ml-[var(--sp-4)]">
              <Search
                size={13}
                strokeWidth={1.75}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-t5 pointer-events-none"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search lines..."
                aria-label="Search lines"
                className="c-input c-input-search"
              />
            </div>

            <button
              type="button"
              className="c-btn c-btn-add flex-shrink-0 ml-[var(--sp-3)]"
              onClick={() => setShowAddWizard(true)}
            >
              <Plus size={16} strokeWidth={1.75} />
              <span className="c-btn-add-label">Add Line</span>
            </button>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-y-auto scrollbar-hide">
            <table className="w-full border-collapse">
              <thead>
                <tr className="sticky top-0 bg-d3 z-10 c-border-b-b2">
                  {COLUMNS.map((h) => (
                    <th
                      key={h.label}
                      className={`c-col-header c-cell ${h.widthClass ?? ""} ${h.center ? "text-center" : "text-left"} ${h.sortKey ? "cursor-pointer select-none" : ""}`}
                      onClick={h.sortKey ? () => toggleSort(h.sortKey) : undefined}
                      aria-sort={sortKey === h.sortKey ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      <span className={`inline-flex items-center gap-[var(--sp-1)] ${h.center ? "justify-center" : ""}`}>
                        {h.label}
                        {sortKey === h.sortKey && (
                          sortDir === "asc"
                            ? <ChevronUp size={12} strokeWidth={1.75} className="text-t3" />
                            : <ChevronDown size={12} strokeWidth={1.75} className="text-t3" />
                        )}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((line) => {
                  const isError = line.status === "unreachable";
                  const isDegraded = line.status === "degraded";
                  const sent = line.messageStats?.sent ?? 0;
                  const recv = line.messageStats?.received ?? 0;
                  return (
                    <tr
                      key={line.name}
                      onClick={() => navigate(`/lines/${line.name}`)}
                      className={`cursor-pointer c-row-hover c-border-b ${isError ? "bg-[var(--s-crit-wash)]" : isDegraded ? "bg-[var(--s-warn-wash)]" : ""}`}
                    >
                      {/* Mode */}
                      <td className="c-cell">
                        <ModeBadge mode={line.mode} />
                      </td>

                      {/* Line name + phone */}
                      <td className="c-cell">
                        <div className="flex flex-col">
                          <span
                            className="font-sans font-medium text-t1 text-[var(--font-size-body)]"
                          >
                            {displayInstanceName(line.name)}
                          </span>
                          <span className="c-label">
                            {formatPhone(line.phone)}
                          </span>
                        </div>
                      </td>

                      {/* Chats */}
                      <td className="c-cell text-center">
                        <span className="c-data text-t2">{line.chatCounts?.chats ?? 0}</span>
                      </td>

                      {/* Groups */}
                      <td className="c-cell text-center">
                        <span className="c-data text-t4">{line.chatCounts?.groups ?? 0}</span>
                      </td>

                      {/* Unread */}
                      <td className="c-cell text-center">
                        {(line.unread ?? 0) > 0 ? (
                          <span className="c-data text-s-warn font-medium">
                            {line.unread}
                          </span>
                        ) : (
                          <span className="c-data text-t5">0</span>
                        )}
                      </td>

                      {/* Sent (today) */}
                      <td className="c-cell text-center">
                        <span className="c-data text-s-ok">{String.fromCharCode(0x2191)}{sent}</span>
                      </td>

                      {/* Received (today) */}
                      <td className="c-cell text-center">
                        <span className="c-data text-m-cht">{String.fromCharCode(0x2193)}{recv}</span>
                      </td>

                      {/* Tokens (lifetime) */}
                      <td className="c-cell text-center">
                        {(line.tokenUsage?.input ?? 0) > 0 ? (
                          <span className="c-data text-t2" title={`${(line.tokenUsage?.input ?? 0).toLocaleString()} in / ${(line.tokenUsage?.output ?? 0).toLocaleString()} out`}>
                            {formatCompact((line.tokenUsage?.input ?? 0) + (line.tokenUsage?.output ?? 0))}
                          </span>
                        ) : (
                          <span className="c-data text-t5">{String.fromCharCode(0x2014)}</span>
                        )}
                      </td>

                      {/* Sessions (lifetime, agent lines only) */}
                      <td className="c-cell text-center">
                        {line.mode === 'agent' ? (
                          <span className="c-data text-m-agt font-medium">
                            {line.totalSessions ?? 0}
                          </span>
                        ) : (
                          <span className="c-data text-t5">{String.fromCharCode(0x2014)}</span>
                        )}
                      </td>

                      {/* Tags */}
                      <td className="c-cell">
                        <LineTags line={line} />
                      </td>

                      {/* Last Active */}
                      <td className="c-cell text-center">
                        <span
                          className={`c-data whitespace-nowrap ${isError ? "text-s-crit" : "text-t4"}`}
                        >
                          {line.lastActive ? formatRelative(line.lastActive) : String.fromCharCode(0x2014)}
                        </span>
                      </td>
                    </tr>
                  );
                })}

                {filtered.length === 0 && (
                  <tr>
                    <td
                      colSpan={11}
                      className="text-center text-t5 font-sans py-12 text-[var(--font-size-data)]"
                    >
                      No instances match the current filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Activity Feed */}
        <div className="c-card flex flex-col min-h-0 overflow-hidden basis-0 flex-1 min-w-[var(--feed-min-w)]">
          <ActivityFeed events={feed} />
        </div>
      </motion.div>

      <Suspense fallback={null}>
        {showAddWizard && <AddLineWizard onClose={() => setShowAddWizard(false)} />}
      </Suspense>
    </div>
  );
};

export default SoupKitchen;
```

- [ ] **Step 2: Run typecheck**

Run: `cd /home/q/LAB/WhatSoup/console && npx tsc --noEmit`

Fix any type errors that appear (likely in `FleetMetricsChart` prop changes since it no longer wraps itself in a `<section>`).

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run --pool=forks`

Verify all existing tests still pass and no regressions.

- [ ] **Step 4: Commit**

`git add console/src/pages/SoupKitchen.tsx && git commit -m "feat: SoupKitchen — range picker, 3-up chart row, expansion, sparkline wiring"`
