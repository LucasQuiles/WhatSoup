# Durable Inbound and Reply Guarantee Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make accepted inbound messages atomically durable and replayable, ensure queue shedding and shutdown have durable lifecycle outcomes, and make a Reply Guarantee turn terminal only after a tracked visible interruption reaches its configured delivery proof.

**Architecture:** WS-A02 first establishes one SQLite transaction for the message record and inbound admission row, with a lease that distinguishes a live duplicate from reclaimable work. WS-A03 moves capacity gates after durable admission, represents rejected work as `deferred`, and drains it through one bounded replay worker while shutdown stops admission before draining or deferring. WS-A01 then uses a two-stage watchdog: a soft presence signal keeps the inbound open, while the hard interruption travels through `outbound_ops`; the default WhatsApp terminal criterion is the existing echo correlation.

**Tech Stack:** TypeScript ESM, Node.js 24.15.0, npm 11.12.1, `node:sqlite`, Vitest fake timers and fault triggers, Pino, existing `DurabilityEngine`, `Messenger`, and `Runtime` contracts.

## Global Constraints

- Start implementation branches from audited base `7330bafbe77d7a15febce32eb09b304e8778862f` only after a fresh `git fetch origin` confirms the intended base.
- Local branch and commits only; publishing a branch or Draft PR requires explicit user approval.
- Keep WS-A01, WS-A02, and WS-A03 as three independently revertible PRs in that order; do not combine them into a runtime rewrite.
- Typing/presence is soft liveness and never terminal delivery.
- A hard-deadline interruption must use the existing `outbound_ops` journal and must not create a parallel audit store.
- A duplicate delivery may not suppress work when the message exists but its inbound admission is absent or reclaimable.
- Queue shedding must produce a durable lifecycle state and bounded replay; it may not leave a row stranded in `processing`.
- Metrics and logs use low-cardinality reasons only; raw JIDs and message content are never metric labels.
- Preserve the repository engine floor `>=24.0.0 <26` and run every command through `scripts/run-with-pinned-npm.sh` or `scripts/run-with-pinned-node.sh`.
- Before any PR is ready, run the full pinned release command and record all skipped or unavailable live-provider checks as proof gaps.

---

## File Structure

### WS-A02 — atomic inbound admission

- Modify `src/core/database.ts` to add migration 37 (`lease_until`, `replay_after`, `attempt_count`, `deferred_reason`, and the replay index).
- Create `src/core/inbound-admission.ts` as the single transaction boundary for `messages` plus `inbound_events` admission.
- Modify `src/core/durability.ts` to own status transitions after admission (`markInboundProcessing`, `deferInbound`, and route-scoped shutdown deferral).
- Modify `src/core/ingest.ts` to admit before capacity gating and reuse the admitted `seq` in every policy branch.
- Create `tests/core/migration-37-inbound-replay.test.ts` for schema and upgrade proof.
- Create `tests/core/inbound-admission.test.ts` for atomicity, missing-journal repair, leases, and duplicate behavior.
- Modify `tests/core/ingest.test.ts` and `tests/core/ingest-backpressure.test.ts` for the new lifecycle.
- Modify `docs/configuration.md` and `docs/durability.md` to document migration 37 and the admission states.

### WS-A03 — durable queue and shutdown lifecycle

- Create `src/core/inbound-replay.ts` for bounded compare-and-swap claims and runtime dispatch.
- Modify `src/runtimes/chat/queue.ts` and `src/runtimes/chat/runtime.ts` to await queue admission, expose idle/close, and defer rejected rows.
- Modify `src/runtimes/agent/turn-queue.ts` and `src/runtimes/agent/runtime.ts` to arm before queue wait, handle rejection, stop admission, drain, and defer on deadline.
- Modify `src/transport/runtime-connection.ts` and `src/main.ts` so shutdown detaches ingress, stops replay, drains runtime work, and awaits asynchronous transport close.
- Create `tests/core/inbound-replay.test.ts`; modify the focused queue/runtime/shutdown tests.

### WS-A01 — two-stage Reply Guarantee

- Modify `src/core/reply-guarantee.ts` to hold separate soft and hard timers and distinguish `submitted` from `awaiting_echo` proof.
- Modify `src/runtimes/agent/runtime.ts` to wire soft presence and hard `sendTracked` interruption senders.
- Modify `tests/core/reply-guarantee.test.ts` for fake-clock, echo, rate-limit, and durability-failure semantics.
- Modify `docs/reply-guarantee.md` so the shipped-state description matches behavior.

---

### Task 1: Add the replayable-inbound schema (WS-A02, commit 1)

**Files:**
- Modify: `src/core/database.ts:556-737, 884-902`
- Create: `tests/core/migration-37-inbound-replay.test.ts`
- Modify: `docs/configuration.md:1430-1470`

**Interfaces:**
- Consumes: `Database.open(): void` and the existing `MIGRATIONS: Map<number, MigrationFn>`.
- Produces: migration 37 columns `inbound_events.lease_until: INTEGER | NULL`, `replay_after: INTEGER | NULL`, `attempt_count: INTEGER NOT NULL DEFAULT 0`, `deferred_reason: TEXT | NULL`, plus `idx_inbound_events_replay(processing_status, replay_after, seq)`.

- [ ] **Step 1: Write the failing schema and legacy-upgrade tests**

Create `tests/core/migration-37-inbound-replay.test.ts` with this complete content:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

const paths: string[] = [];

function tmpDb(): string {
  const path = join(tmpdir(), `whatsoup-m37-${randomUUID()}.db`);
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) rmSync(path + suffix, { force: true });
    }
  }
});

describe('migration 37 — replayable inbound lifecycle', () => {
  it('creates the lease/defer columns and bounded replay index', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(37);
      const columns = db.raw.prepare("PRAGMA table_info('inbound_events')").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const byName = new Map(columns.map((column) => [column.name, column]));
      expect(byName.get('lease_until')).toMatchObject({ type: 'INTEGER', notnull: 0 });
      expect(byName.get('replay_after')).toMatchObject({ type: 'INTEGER', notnull: 0 });
      expect(byName.get('attempt_count')).toMatchObject({
        type: 'INTEGER',
        notnull: 1,
        dflt_value: '0',
      });
      expect(byName.get('deferred_reason')).toMatchObject({ type: 'TEXT', notnull: 0 });

      const index = db.raw.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_inbound_events_replay'",
      ).get() as { sql: string };
      expect(index.sql).toContain('processing_status, replay_after, seq');
    } finally {
      db.close();
    }
  });

  it('upgrades a version-36 database without changing existing inbound outcomes', () => {
    const path = tmpDb();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE inbound_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        conversation_key TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        routed_to TEXT,
        processing_status TEXT NOT NULL DEFAULT 'pending',
        completed_at TEXT,
        terminal_reason TEXT,
        continuity_candidate_reason TEXT,
        continuity_candidate_source TEXT,
        continuity_candidate_marked_at TEXT,
        failure_class TEXT
      );
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, routed_to,
        processing_status, completed_at, terminal_reason
      ) VALUES ('legacy-complete', 'legacy-key', 'legacy@s.whatsapp.net', 'agent',
                'complete', datetime('now'), 'response_sent');
      INSERT INTO schema_migrations(version)
      VALUES ${Array.from({ length: 36 }, (_, index) => `(${index + 1})`).join(',')};
    `);
    raw.close();

    const migrated = new Database(path);
    migrated.open();
    try {
      const row = migrated.raw.prepare(`
        SELECT processing_status, terminal_reason, attempt_count,
               lease_until, replay_after, deferred_reason
        FROM inbound_events WHERE message_id = 'legacy-complete'
      `).get();
      expect(row).toEqual({
        processing_status: 'complete',
        terminal_reason: 'response_sent',
        attempt_count: 0,
        lease_until: null,
        replay_after: null,
        deferred_reason: null,
      });
      expect(
        migrated.raw.prepare('SELECT version FROM schema_migrations WHERE version = 37').get(),
      ).toEqual({ version: 37 });
    } finally {
      migrated.close();
    }
  });
});
```

- [ ] **Step 2: Run the migration test and verify the semantic failure**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-37-inbound-replay.test.ts --pool=forks
```

Expected: FAIL because `CURRENT_SCHEMA_MIGRATION` is `36` and the four migration-37 columns are absent. A module-resolution or test-runner failure is inconclusive and must be fixed before continuing.

- [ ] **Step 3: Implement migration 37**

Add this function after `runMigration36` in `src/core/database.ts`:

```ts
function runMigration37(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'")
    .get() as { name: string } | undefined;
  if (!table) return;

  const columns = db
    .prepare("PRAGMA table_info('inbound_events')")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has('lease_until')) {
    db.exec('ALTER TABLE inbound_events ADD COLUMN lease_until INTEGER');
  }
  if (!names.has('replay_after')) {
    db.exec('ALTER TABLE inbound_events ADD COLUMN replay_after INTEGER');
  }
  if (!names.has('attempt_count')) {
    db.exec('ALTER TABLE inbound_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('deferred_reason')) {
    db.exec('ALTER TABLE inbound_events ADD COLUMN deferred_reason TEXT');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inbound_events_replay
      ON inbound_events(processing_status, replay_after, seq)
  `);
}
```

Add this exact map entry after migration 36:

```ts
  [36, runMigration36],
  [37, runMigration37],
```

Add this exact row to the schema-migration table in `docs/configuration.md`:

```markdown
| 37 | Adds inbound admission leases (`lease_until`, `attempt_count`) and durable deferral (`replay_after`, `deferred_reason`) plus `idx_inbound_events_replay`; no message content is duplicated. |
```

- [ ] **Step 4: Run the focused schema and migration safety suites**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-37-inbound-replay.test.ts tests/core/migration-safety.test.ts tests/core/database.test.ts --pool=forks
```

Expected: PASS with all three files green and migration 37 applied once on both fresh and version-36 databases.

- [ ] **Step 5: Commit the schema boundary**

```bash
git add src/core/database.ts tests/core/migration-37-inbound-replay.test.ts docs/configuration.md
git commit -m "feat(durability): add replayable inbound lifecycle schema"
```

### Task 2: Atomically insert the message and admission row (WS-A02, commit 2)

**Files:**
- Create: `src/core/inbound-admission.ts`
- Create: `tests/core/inbound-admission.test.ts`
- Modify: `src/core/messages.ts:105-158` only if test injection requires exporting `toInsertParams`; prefer no change.

**Interfaces:**
- Consumes: `storeMessageIfNew(db: Database, msg: StoreMessageInput): boolean` and `withTransaction<T>(db: Database, fn: () => T): T`.
- Produces: `admitInboundMessage(db: Database, msg: StoreMessageInput, now?: number): InboundAdmissionResult` where `accepted` is true only for a new row, a missing-journal repair, or an expired lease reclaim.

- [ ] **Step 1: Write the atomicity and lease tests**

Create `tests/core/inbound-admission.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { admitInboundMessage } from '../../src/core/inbound-admission.ts';
import { storeMessageIfNew, type StoreMessageInput } from '../../src/core/messages.ts';

function message(messageId: string): StoreMessageInput {
  return {
    chatJid: '15550100001@s.whatsapp.net',
    conversationKey: '15550100001',
    senderJid: '15550100001@s.whatsapp.net',
    senderName: 'Synthetic User',
    messageId,
    content: 'synthetic admission canary',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    timestamp: 1_800_000_000,
    quotedMessageId: null,
    rawMessage: null,
  };
}

describe('admitInboundMessage', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('commits the message and inbound row in one transaction', () => {
    const result = admitInboundMessage(db, message('atomic-new'), 1_800_000_000);
    expect(result).toMatchObject({ accepted: true, state: 'new' });

    expect(db.raw.prepare(
      "SELECT message_id FROM messages WHERE message_id = 'atomic-new'",
    ).get()).toEqual({ message_id: 'atomic-new' });
    expect(db.raw.prepare(`
      SELECT seq, processing_status, attempt_count, lease_until
      FROM inbound_events WHERE message_id = 'atomic-new'
    `).get()).toEqual({
      seq: result.seq,
      processing_status: 'pending',
      attempt_count: 1,
      lease_until: 1_800_000_300,
    });
  });

  it('rolls the message back when the inbound insert fails', () => {
    db.raw.exec(`
      CREATE TRIGGER reject_atomic_inbound
      BEFORE INSERT ON inbound_events
      WHEN NEW.message_id = 'atomic-fault'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic inbound journal fault');
      END
    `);

    expect(() => admitInboundMessage(db, message('atomic-fault'), 1_800_000_000))
      .toThrow(/synthetic inbound journal fault/);
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE message_id = 'atomic-fault'",
    ).get()).toEqual({ count: 0 });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM inbound_events WHERE message_id = 'atomic-fault'",
    ).get()).toEqual({ count: 0 });
  });

  it('repairs a pre-existing message whose inbound row is missing', () => {
    expect(storeMessageIfNew(db, message('missing-journal'))).toBe(true);

    const result = admitInboundMessage(db, message('missing-journal'), 1_800_000_000);

    expect(result).toMatchObject({ accepted: true, state: 'repaired_missing_journal' });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE message_id = 'missing-journal'",
    ).get()).toEqual({ count: 1 });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM inbound_events WHERE message_id = 'missing-journal'",
    ).get()).toEqual({ count: 1 });
  });

  it('suppresses a duplicate while its lease is live and reclaims it after expiry', () => {
    const first = admitInboundMessage(db, message('lease-reclaim'), 1_800_000_000);
    const liveDuplicate = admitInboundMessage(db, message('lease-reclaim'), 1_800_000_100);
    const reclaimed = admitInboundMessage(db, message('lease-reclaim'), 1_800_000_301);

    expect(first.accepted).toBe(true);
    expect(liveDuplicate).toEqual({ accepted: false, seq: first.seq, state: 'duplicate_open' });
    expect(reclaimed).toEqual({ accepted: true, seq: first.seq, state: 'reclaimed_expired_lease' });
    expect(db.raw.prepare(`
      SELECT attempt_count, lease_until FROM inbound_events WHERE seq = ?
    `).get(first.seq)).toEqual({ attempt_count: 2, lease_until: 1_800_000_601 });
  });

  it('never reopens a terminal inbound row on transport redelivery', () => {
    const first = admitInboundMessage(db, message('terminal-duplicate'), 1_800_000_000);
    db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = 'complete', terminal_reason = 'response_sent', completed_at = datetime('now')
      WHERE seq = ?
    `).run(first.seq);

    expect(admitInboundMessage(db, message('terminal-duplicate'), 1_800_001_000)).toEqual({
      accepted: false,
      seq: first.seq,
      state: 'duplicate_terminal',
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify module-not-found is the expected red state**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-admission.test.ts --pool=forks
```

Expected: FAIL because `src/core/inbound-admission.ts` does not exist. No test may be changed to accept a message-only commit.

- [ ] **Step 3: Implement the atomic admission module**

Create `src/core/inbound-admission.ts`:

```ts
import type { Database } from './database.ts';
import { withTransaction } from './db-tx.ts';
import { storeMessageIfNew, type StoreMessageInput } from './messages.ts';

const ADMISSION_LEASE_SECONDS = 5 * 60;
const TERMINAL_STATUSES = new Set(['complete', 'failed', 'skipped']);

export type InboundAdmissionState =
  | 'new'
  | 'repaired_missing_journal'
  | 'reclaimed_expired_lease'
  | 'duplicate_open'
  | 'duplicate_terminal';

export interface InboundAdmissionResult {
  accepted: boolean;
  seq: number;
  state: InboundAdmissionState;
}

interface ExistingAdmission {
  seq: number;
  processing_status: string;
  lease_until: number | null;
  replay_after: number | null;
}

export function admitInboundMessage(
  db: Database,
  msg: StoreMessageInput,
  now: number = Math.floor(Date.now() / 1000),
): InboundAdmissionResult {
  return withTransaction(db, () => {
    const existing = db.raw.prepare(`
      SELECT seq, processing_status, lease_until, replay_after
      FROM inbound_events
      WHERE message_id = ?
    `).get(msg.messageId) as ExistingAdmission | undefined;

    const messageChanged = storeMessageIfNew(db, msg);
    const leaseUntil = now + ADMISSION_LEASE_SECONDS;

    if (!existing) {
      const inserted = db.raw.prepare(`
        INSERT INTO inbound_events (
          message_id, conversation_key, chat_jid, routed_to,
          processing_status, lease_until, attempt_count
        ) VALUES (?, ?, ?, 'ingest', 'pending', ?, 1)
      `).run(msg.messageId, msg.conversationKey, msg.chatJid, leaseUntil);
      return {
        accepted: true,
        seq: Number(inserted.lastInsertRowid),
        state: messageChanged ? 'new' : 'repaired_missing_journal',
      };
    }

    if (TERMINAL_STATUSES.has(existing.processing_status)) {
      return { accepted: false, seq: existing.seq, state: 'duplicate_terminal' };
    }

    const deferredDue = existing.processing_status === 'deferred'
      && (existing.replay_after === null || existing.replay_after <= now);
    const leaseExpired = existing.lease_until === null || existing.lease_until <= now;
    if (deferredDue || leaseExpired) {
      const claimed = db.raw.prepare(`
        UPDATE inbound_events
        SET processing_status = 'pending',
            routed_to = 'ingest',
            completed_at = NULL,
            terminal_reason = NULL,
            failure_class = NULL,
            deferred_reason = NULL,
            replay_after = NULL,
            lease_until = ?,
            attempt_count = attempt_count + 1
        WHERE seq = ?
          AND processing_status NOT IN ('complete', 'failed', 'skipped')
          AND (
            lease_until IS NULL OR lease_until <= ? OR
            (processing_status = 'deferred' AND (replay_after IS NULL OR replay_after <= ?))
          )
      `).run(leaseUntil, existing.seq, now, now);
      if (Number(claimed.changes) === 1) {
        return { accepted: true, seq: existing.seq, state: 'reclaimed_expired_lease' };
      }
    }

    return { accepted: false, seq: existing.seq, state: 'duplicate_open' };
  });
}
```

- [ ] **Step 4: Run the atomicity suite and typecheck**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-admission.test.ts tests/core/decryption-failures.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS. The fault-trigger case must show both table counts at zero; a passing test that only checks the thrown error is insufficient.

- [ ] **Step 5: Commit the transaction boundary**

```bash
git add src/core/inbound-admission.ts tests/core/inbound-admission.test.ts
git commit -m "fix(ingest): atomically admit inbound messages"
```

### Task 3: Route every normal inbound through its admitted row (WS-A02, commit 3)

**Files:**
- Modify: `src/core/durability.ts:139-260, 430-480`
- Modify: `src/core/ingest.ts:115-373`
- Modify: `tests/core/ingest.test.ts:193-360`
- Modify: `tests/core/ingest-backpressure.test.ts:174-430`
- Modify: `docs/durability.md`

**Interfaces:**
- Consumes: `admitInboundMessage(db, StoreMessageInput, now?)` from Task 2.
- Produces: `DurabilityEngine.markInboundProcessing(seq: number, routedTo: string): boolean` and `DurabilityEngine.deferInbound(seq: number, reason: InboundDeferredReason, delaySeconds?: number): boolean`.

- [ ] **Step 1: Add the red ingest regression tests**

Append these tests to the durability-enabled ingest describe in `tests/core/ingest.test.ts`:

```ts
it('persists one pending inbound row before runtime capacity work begins', async () => {
  const db = makeTempDb();
  const messenger = makeMessenger();
  const runtime = makeRuntime();
  const durability = new DurabilityEngine(db);
  const handler = makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability);
  const msg = makeIncomingMessage({ messageId: 'atomic-ingest-visible' });

  vi.mocked(runtime.handleMessage).mockImplementation(async (received) => {
    const row = db.raw.prepare(`
      SELECT processing_status, routed_to FROM inbound_events WHERE message_id = ?
    `).get(received.messageId);
    expect(row).toEqual({ processing_status: 'processing', routed_to: 'object' });
  });

  await runIngest(handler, msg);

  expect(msg.inboundSeq).toEqual(expect.any(Number));
  expect(db.raw.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE message_id = 'atomic-ingest-visible'",
  ).get()).toEqual({ count: 1 });
  expect(db.raw.prepare(
    "SELECT COUNT(*) AS count FROM inbound_events WHERE message_id = 'atomic-ingest-visible'",
  ).get()).toEqual({ count: 1 });
});

it('repairs a message-only crash window on redelivery instead of suppressing work', async () => {
  const db = makeTempDb();
  const messenger = makeMessenger();
  const runtime = makeRuntime();
  const durability = new DurabilityEngine(db);
  const msg = makeIncomingMessage({ messageId: 'redelivery-repair' });
  storeMessageIfNew(db, {
    chatJid: msg.chatJid,
    conversationKey: '15551230008',
    senderJid: msg.senderJid,
    senderName: msg.senderName,
    messageId: msg.messageId,
    content: msg.content,
    contentText: msg.contentText,
    contentType: msg.contentType,
    isFromMe: false,
    timestamp: msg.timestamp,
    quotedMessageId: msg.quotedMessageId,
    rawMessage: null,
  });

  await runIngest(
    makeIngest(db, messenger, runtime, BOT_JID, BOT_LID, durability),
    msg,
  );

  expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  expect(db.raw.prepare(`
    SELECT COUNT(*) AS count FROM inbound_events WHERE message_id = 'redelivery-repair'
  `).get()).toEqual({ count: 1 });
});
```

Add this import beside the existing message imports:

```ts
import { getMessagesBySender, storeMessageIfNew } from '../../src/core/messages.ts';
```

Replace the old overflow-drop assertion in `tests/core/ingest-backpressure.test.ts` with this durability assertion (the test setup must construct and pass a real `DurabilityEngine`):

```ts
const dropped = db.raw.prepare(`
  SELECT processing_status, deferred_reason, replay_after
  FROM inbound_events WHERE message_id = 'msg-B'
`).get() as {
  processing_status: string;
  deferred_reason: string | null;
  replay_after: number | null;
};
expect(dropped.processing_status).toBe('deferred');
expect(dropped.deferred_reason).toBe('ingest_queue_full');
expect(dropped.replay_after).toEqual(expect.any(Number));
```

- [ ] **Step 2: Run the focused tests and confirm the old split fails**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/ingest.test.ts tests/core/ingest-backpressure.test.ts --pool=forks
```

Expected: FAIL because the current ingest path returns on an existing message before repairing the journal, and overflow leaves no durable deferred lifecycle.

- [ ] **Step 3: Add durability status-transition methods**

Extend `DurabilityStatements` and the constructor in `src/core/durability.ts` with these statements:

```ts
  markInboundProcessing: PreparedStatement;
  deferInbound: PreparedStatement;
```

```ts
      markInboundProcessing: prepare(`
        UPDATE inbound_events
        SET processing_status = 'processing', routed_to = ?,
            lease_until = ?, deferred_reason = NULL, replay_after = NULL
        WHERE seq = ? AND processing_status = 'pending'
      `),
      deferInbound: prepare(`
        UPDATE inbound_events
        SET processing_status = 'deferred', deferred_reason = ?, replay_after = ?,
            lease_until = NULL, completed_at = NULL, terminal_reason = NULL,
            failure_class = NULL
        WHERE seq = ?
          AND processing_status IN ('pending', 'processing')
          AND NOT EXISTS (
            SELECT 1 FROM outbound_ops
            WHERE source_inbound_seq = ? AND is_terminal = 1 AND status = 'echoed'
          )
      `),
```

Add these exported types and methods:

```ts
export type InboundDeferredReason =
  | 'ingest_queue_full'
  | 'chat_queue_full'
  | 'agent_queue_full'
  | 'shutdown_deadline'
  | 'crash_recovery';
```

```ts
  markInboundProcessing(seq: number, routedTo: string, now = Math.floor(Date.now() / 1000)): boolean {
    const leaseUntil = now + 5 * 60;
    return Number(this.statements.markInboundProcessing.run(routedTo, leaseUntil, seq).changes) === 1;
  }

  deferInbound(
    seq: number,
    reason: InboundDeferredReason,
    delaySeconds = 5,
    now = Math.floor(Date.now() / 1000),
  ): boolean {
    const replayAfter = now + Math.max(0, Math.floor(delaySeconds));
    return Number(this.statements.deferInbound.run(reason, replayAfter, seq, seq).changes) === 1;
  }
```

- [ ] **Step 4: Rewire the normal ingest path around atomic admission**

Add this import in `src/core/ingest.ts`:

```ts
import { admitInboundMessage } from './inbound-admission.ts';
```

Move the existing control-plane intercept (`src/core/ingest.ts:163-203`) before normal-message admission. Control messages keep their separate `control_messages` storage contract.

Replace the normal store block at current lines 206-238 with this complete block:

```ts
        let conversationKey: string;
        let seq: number | undefined;
        try {
          conversationKey = !msg.isGroup && isLidJid(msg.chatJid)
            ? resolvePhoneFromJid(msg.chatJid, db)
            : toConversationKey(msg.chatJid);

          const storeInput = {
            chatJid: msg.chatJid,
            conversationKey,
            senderJid: msg.senderJid,
            senderName: msg.senderName,
            messageId: msg.messageId,
            content: msg.content,
            contentText: msg.contentText ?? null,
            contentType: msg.contentType,
            isFromMe: msg.isFromMe,
            timestamp: msg.timestamp,
            quotedMessageId: msg.quotedMessageId,
            rawMessage: msg.rawMessage != null ? JSON.stringify(msg.rawMessage) : null,
          };

          if (msg.isFromMe || !durability) {
            const isNew = storeMessageIfNew(db, storeInput);
            if (!isNew) {
              log.debug({ messageId: msg.messageId, reason: 'duplicate' }, 'skipping duplicate message delivery');
              return;
            }
          } else {
            const admission = admitInboundMessage(db, storeInput);
            if (!admission.accepted) {
              log.debug(
                { messageId: msg.messageId, admissionState: admission.state },
                'skipping duplicate message delivery',
              );
              return;
            }
            seq = admission.seq;
            msg.inboundSeq = seq;
          }
        } catch (err) {
          log.error({ err, messageId: msg.messageId }, 'failed to admit inbound message');
          return;
        }

        if (msg.isFromMe) {
          durability?.matchEcho(msg.messageId);
          return;
        }
```

In the paused, passive, admin, and access-denied branches, remove each call to `journalInbound` and use the already admitted `seq`:

```ts
if (durability && seq !== undefined) {
  durability.markInboundSkipped(seq, 'chat_paused');
}
```

Use the existing branch-specific terminal reason (`passive_instance`, `admin_command`, or `access_denied`) in the other three branches.

Replace current lines 343-359 with this capacity-and-dispatch block:

```ts
        const routedTo = runtime.constructor?.name?.toLowerCase() ?? 'runtime';
        if (durability && seq !== undefined) {
          if (!durability.markInboundProcessing(seq, routedTo)) {
            log.warn({ inboundSeq: seq, routedTo }, 'ingest admission lost before runtime dispatch');
            return;
          }
        }

        const proceed = await acquireSlot(msg);
        if (!proceed) {
          if (durability && seq !== undefined) {
            durability.deferInbound(seq, 'ingest_queue_full');
          }
          return;
        }
        slotAcquired = true;

        try {
          await runtime.handleMessage(msg);
        } catch (err) {
          log.error({ err, messageId: msg.messageId }, 'runtime.handleMessage threw');
          if (durability && seq !== undefined) {
            durability.markInboundFailed(seq, classifyErrorForInbound(err));
          }
        }
```

Delete the original capacity gate at lines 158-161 so a message cannot be shed before its atomic admission.

- [ ] **Step 5: Run the ingest semantic probes**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-admission.test.ts tests/core/ingest.test.ts tests/core/ingest-backpressure.test.ts tests/core/ingest-control.test.ts tests/core/ingest-paused-chats.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS. Inspect the overflow test output to confirm the rejected message has one `messages` row and one `inbound_events` row with `processing_status='deferred'`.

- [ ] **Step 6: Document and commit WS-A02**

Add this state table to `docs/durability.md`:

```markdown
| Inbound state | Meaning | Replayable |
|---|---|---|
| `pending` | Message and admission committed atomically; runtime claim not yet won | after lease expiry |
| `processing` | One runtime owns the current lease | after lease expiry or crash recovery |
| `deferred` | Capacity or shutdown deliberately postponed work | when `replay_after` is due |
| `turn_done` | Runtime finished; terminal delivery reconciliation is pending | no blind replay |
| `complete` / `failed` | Terminal lifecycle evidence recorded | no |
```

Then commit:

```bash
git add src/core/durability.ts src/core/ingest.ts tests/core/ingest.test.ts tests/core/ingest-backpressure.test.ts docs/durability.md
git commit -m "fix(ingest): preserve admitted work across redelivery"
```

### Task 4: Add bounded deferred-inbound replay and crash recovery (WS-A03, commit 1)

**Files:**
- Create: `src/core/inbound-replay.ts`
- Create: `tests/core/inbound-replay.test.ts`
- Modify: `src/core/durability.ts:303-390, 672-855, 1084-1095`
- Modify: `tests/core/durability-recovery.test.ts:209-238`

**Interfaces:**
- Consumes: `Runtime.handleMessage(msg: IncomingMessage): Promise<void>` and `DurabilityEngine.deferInbound(...)`.
- Produces: `InboundReplayWorker.start(): void`, `stop(): void`, `tick(): Promise<number>`, and `DurabilityEngine.getHealthStats().deferredInbound`.

- [ ] **Step 1: Write the bounded replay and crash-recovery tests**

Create `tests/core/inbound-replay.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { InboundReplayWorker } from '../../src/core/inbound-replay.ts';
import { admitInboundMessage } from '../../src/core/inbound-admission.ts';
import type { IncomingMessage } from '../../src/core/types.ts';

describe('InboundReplayWorker', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => db.close());

  function admit(id: string, now: number): number {
    return admitInboundMessage(db, {
      chatJid: '15550100001@s.whatsapp.net',
      conversationKey: '15550100001',
      senderJid: '15550100001@s.whatsapp.net',
      senderName: 'Replay User',
      messageId: id,
      content: `body-${id}`,
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      timestamp: now,
      quotedMessageId: null,
      rawMessage: null,
    }, now).seq;
  }

  it('claims at most batchSize due rows in FIFO order and dispatches reconstructed messages', async () => {
    const now = 1_800_000_000;
    const seqs = ['a', 'b', 'c'].map((id) => admit(id, now));
    for (const seq of seqs) durability.deferInbound(seq, 'ingest_queue_full', 0, now);
    const dispatched: IncomingMessage[] = [];
    const worker = new InboundReplayWorker(db, durability, {
      dispatch: async (msg) => { dispatched.push(msg); },
      batchSize: 2,
      intervalMs: 5_000,
      now: () => now,
    });

    expect(await worker.tick()).toBe(2);
    expect(dispatched.map((msg) => msg.messageId)).toEqual(['a', 'b']);
    expect(dispatched.map((msg) => msg.inboundSeq)).toEqual(seqs.slice(0, 2));
    expect(durability.getHealthStats().deferredInbound).toBe(1);
  });

  it('returns a failed dispatch to deferred with bounded backoff', async () => {
    const now = 1_800_000_000;
    const seq = admit('dispatch-fault', now);
    durability.deferInbound(seq, 'chat_queue_full', 0, now);
    const worker = new InboundReplayWorker(db, durability, {
      dispatch: async () => { throw new Error('synthetic runtime rejection'); },
      batchSize: 10,
      intervalMs: 5_000,
      now: () => now,
    });

    expect(await worker.tick()).toBe(0);
    expect(db.raw.prepare(`
      SELECT processing_status, deferred_reason, replay_after
      FROM inbound_events WHERE seq = ?
    `).get(seq)).toEqual({
      processing_status: 'deferred',
      deferred_reason: 'crash_recovery',
      replay_after: now + 30,
    });
  });

  it('never claims a terminal row even when replay_after is due', async () => {
    const now = 1_800_000_000;
    const seq = admit('terminal-no-replay', now);
    db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = 'complete', terminal_reason = 'response_sent', replay_after = ?
      WHERE seq = ?
    `).run(now - 1, seq);
    const dispatch = vi.fn(async () => undefined);
    const worker = new InboundReplayWorker(db, durability, {
      dispatch,
      batchSize: 10,
      intervalMs: 5_000,
      now: () => now,
    });

    expect(await worker.tick()).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
```

Replace the existing crash-recovery assertion in `tests/core/durability-recovery.test.ts` with:

```ts
it('inbound processing with no terminal outbound op is deferred for bounded replay', () => {
  const seq = engine.journalInbound('msg-1', 'k1', 'j1@s.whatsapp.net', 'agent');
  engine.preConnectRecovery();

  const row = getInbound(db, seq);
  expect(row['processing_status']).toBe('deferred');
  expect(row['deferred_reason']).toBe('crash_recovery');
  expect(row['failure_class']).toBeNull();
});
```

- [ ] **Step 2: Run the tests and verify replay is absent**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-replay.test.ts tests/core/durability-recovery.test.ts --pool=forks
```

Expected: FAIL because `InboundReplayWorker` does not exist and pre-connect recovery still marks processing rows failed.

- [ ] **Step 3: Implement the replay worker**

Create `src/core/inbound-replay.ts`:

```ts
import type { Database } from './database.ts';
import type { DurabilityEngine } from './durability.ts';
import type { ContentType, IncomingMessage } from './types.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('inbound-replay');

interface ReplayRow {
  seq: number;
  message_id: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string | null;
  content: string | null;
  content_text: string | null;
  content_type: ContentType;
  timestamp: number;
  quoted_message_id: string | null;
  raw_message: string | null;
}

export interface InboundReplayOptions {
  dispatch: (msg: IncomingMessage) => Promise<void>;
  batchSize?: number;
  intervalMs?: number;
  now?: () => number;
}

export class InboundReplayWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly durability: DurabilityEngine,
    private readonly options: InboundReplayOptions,
  ) {
    this.batchSize = Math.max(1, Math.min(100, options.batchSize ?? 10));
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 5_000);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.error({ err }, 'inbound replay tick failed'));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<number> {
    const now = this.now();
    const candidates = this.db.raw.prepare(`
      SELECT e.seq, m.message_id, m.chat_jid, m.sender_jid, m.sender_name,
             m.content, m.content_text, m.content_type, m.timestamp,
             m.quoted_message_id, m.raw_message
      FROM inbound_events e
      JOIN messages m ON m.message_id = e.message_id
      WHERE e.processing_status = 'deferred'
        AND (e.replay_after IS NULL OR e.replay_after <= ?)
        AND m.deleted_at IS NULL
      ORDER BY e.seq ASC
      LIMIT ?
    `).all(now, this.batchSize) as unknown as ReplayRow[];

    let dispatched = 0;
    for (const row of candidates) {
      const claimed = this.db.raw.prepare(`
        UPDATE inbound_events
        SET processing_status = 'processing', routed_to = 'replay',
            lease_until = ?, replay_after = NULL, deferred_reason = NULL,
            attempt_count = attempt_count + 1
        WHERE seq = ? AND processing_status = 'deferred'
          AND (replay_after IS NULL OR replay_after <= ?)
      `).run(now + 5 * 60, row.seq, now);
      if (Number(claimed.changes) !== 1) continue;

      let rawMessage: unknown;
      try {
        rawMessage = row.raw_message === null ? undefined : JSON.parse(row.raw_message);
      } catch {
        rawMessage = undefined;
      }
      const msg: IncomingMessage = {
        messageId: row.message_id,
        chatJid: row.chat_jid,
        senderJid: row.sender_jid,
        senderName: row.sender_name,
        content: row.content,
        contentText: row.content_text,
        contentType: row.content_type,
        isFromMe: false,
        isGroup: row.chat_jid.endsWith('@g.us'),
        mentionedJids: [],
        timestamp: row.timestamp,
        quotedMessageId: row.quoted_message_id,
        isResponseWorthy: true,
        rawMessage,
        inboundSeq: row.seq,
      };

      try {
        await this.options.dispatch(msg);
        dispatched += 1;
      } catch (err) {
        this.durability.deferInbound(row.seq, 'crash_recovery', 30, now);
        log.warn({ err, inboundSeq: row.seq }, 'deferred inbound dispatch failed');
      }
    }
    return dispatched;
  }
}
```

- [ ] **Step 4: Change crash recovery from terminal failure to durable deferral**

Replace the no-terminal-op branch at `src/core/durability.ts:786-792` with:

```ts
        if (!terminalOp) {
          this.markContinuityCandidate(
            ev.seq,
            'crash_reclaim_no_terminal_outbound',
            'pre_connect_recovery',
          );
          if (this.deferInbound(ev.seq, 'crash_recovery', 0)) {
            stats.inboundReplayed += 1;
          }
          log.info(
            { inboundSeq: ev.seq },
            'preConnectRecovery: inbound processing deferred for replay',
          );
```

Extend `getHealthStats` with this exact query and field:

```ts
const deferred = this.db.raw.prepare(
  "SELECT COUNT(*) AS count FROM inbound_events WHERE processing_status = 'deferred'",
).get() as { count: number };
```

```ts
getHealthStats(): {
  pendingOutbound: number;
  quarantinedOutbound: number;
  deferredInbound: number;
  lastRecoveryAt: string | null;
}
```

```ts
deferredInbound: deferred.count,
```

- [ ] **Step 5: Run replay, recovery, and durability suites**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-replay.test.ts tests/core/durability-recovery.test.ts tests/core/durability-stuck-inbound-sweep.test.ts tests/core/durability.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS. No test may preserve the old `processing -> failed/crash_recovery` assertion for an inbound row that still has a message record and no terminal outbound proof.

- [ ] **Step 6: Commit the recovery consumer**

```bash
git add src/core/inbound-replay.ts src/core/durability.ts tests/core/inbound-replay.test.ts tests/core/durability-recovery.test.ts
git commit -m "fix(durability): replay deferred inbound work"
```

### Task 5: Make chat and agent queue admission durable (WS-A03, commit 2)

**Files:**
- Modify: `src/runtimes/chat/queue.ts:17-135`
- Modify: `src/runtimes/chat/runtime.ts:73-165`
- Modify: `src/runtimes/agent/turn-queue.ts:19-103`
- Modify: `src/runtimes/agent/runtime.ts:1874-1881, 3351-3371, 3421-3457`
- Modify: `tests/runtimes/chat/queue.test.ts`
- Modify: `tests/runtimes/chat/runtime.test.ts`
- Modify: `tests/runtimes/agent/turn-queue.test.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`

**Interfaces:**
- Consumes: `DurabilityEngine.deferInbound(seq, reason, delaySeconds?)` from Task 3.
- Produces: `ChatQueue.close(): void`, `ChatQueue.idle(): Promise<void>`, `TurnQueue.close(): void`; both reject new work after close without discarding admitted work.

- [ ] **Step 1: Add queue close/idle and durable-rejection tests**

Append this test to `tests/runtimes/chat/queue.test.ts`:

```ts
it('close rejects new work while idle waits for already admitted chains', async () => {
  const queue = new ChatQueue(1, 2);
  const held = deferred();
  expect(await queue.enqueue('chat-A', () => held.promise)).toBe(true);
  queue.close();
  expect(await queue.enqueue('chat-B', async () => undefined)).toBe(false);

  let idle = false;
  void queue.idle().then(() => { idle = true; });
  await Promise.resolve();
  expect(idle).toBe(false);
  held.resolve();
  await queue.idle();
  expect(idle).toBe(true);
});
```

Append this test to `tests/runtimes/agent/turn-queue.test.ts`:

```ts
it('close rejects later turns but drains turns admitted before close', async () => {
  const processed: string[] = [];
  const queue = new TurnQueue({ maxDepth: 2 });
  queue.enqueue(makeTurn({ text: 'admitted' }));
  queue.close();
  expect(queue.enqueue(makeTurn({ text: 'late' }))).toBe(false);
  queue.setProcessor(async (turn) => { processed.push(turn.text); });
  await queue.idle();
  expect(processed).toEqual(['admitted']);
});
```

Add this focused ChatRuntime test using a `ChatQueue(1, 0)` injected through a narrow test-only constructor option or private-field assignment already used by the suite:

```ts
it('marks an inbound deferred when the per-chat queue rejects admission', async () => {
  const { handler } = makeHandler();
  const deferInbound = vi.fn(() => true);
  handler.setDurability({ deferInbound } as unknown as DurabilityEngine);
  (handler as unknown as { chatQueue: ChatQueue }).chatQueue = new ChatQueue(1, 0);

  await handler.handleMessage(makeIncomingMessage({ inboundSeq: 77 }));

  expect(deferInbound).toHaveBeenCalledWith(77, 'chat_queue_full');
});
```

Add imports for `DurabilityEngine` and `ChatQueue` at the top of that test file.

- [ ] **Step 2: Run the queue tests and verify the close APIs are absent**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/runtime.test.ts --pool=forks
```

Expected: FAIL because neither queue has `close`, ChatQueue has no `idle`, and both runtimes ignore the rejection result.

- [ ] **Step 3: Add close and idle to ChatQueue**

Add these fields and methods to `ChatQueue`:

```ts
  private accepting = true;
  private idleWaiters: Array<() => void> = [];

  close(): void {
    this.accepting = false;
    this.resolveIdleIfNeeded();
  }

  async idle(): Promise<void> {
    if (this.pendingByChat.size === 0 && this.activeChats === 0 && this.waiting.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private resolveIdleIfNeeded(): void {
    if (this.pendingByChat.size !== 0 || this.activeChats !== 0 || this.waiting.length !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
```

Make the first branch in `enqueue` reject closed admission:

```ts
    if (!this.accepting) {
      this.dropped += 1;
      return false;
    }
```

Call `this.resolveIdleIfNeeded()` after the pending count and chain cleanup in the existing `finally` block.

Update ChatRuntime admission and shutdown to:

```ts
  async shutdown(): Promise<void> {
    this.chatQueue.close();
    await this.chatQueue.idle();
    this.enrichmentPoller?.stop();
    log.info('ChatRuntime shutdown complete');
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const traceId = randomBytes(4).toString('hex');
    const startTime = Date.now();
    const admitted = await this.chatQueue.enqueue(
      msg.chatJid,
      () => this.processMessage(msg, traceId, startTime),
    );
    if (!admitted && this.durability && msg.inboundSeq !== undefined) {
      this.durability.deferInbound(msg.inboundSeq, 'chat_queue_full');
    }
  }
```

- [ ] **Step 4: Add close to TurnQueue and handle agent rejection before dequeue**

Add this field and method to `TurnQueue`:

```ts
  private accepting = true;

  close(): void {
    this.accepting = false;
  }
```

Make `enqueue` reject when closed:

```ts
    if (!this.accepting || this.queue.length >= this.maxDepth) {
      log.warn(
        { chatJid: turn.chatJid, maxDepth: this.maxDepth, pending: this.queue.length },
        'turn rejected — queue unavailable',
      );
      this.onReject?.(turn);
      return false;
    }
```

Replace the shared-mode enqueue block at `src/runtimes/agent/runtime.ts:3356-3371` with:

```ts
    if (this.shared) {
      this.currentTurnInboundContentType = msg.contentType;
      this.currentTurnAssistantText = '';
      this.currentTurnAssistantItemText.clear();
      this.replyGuarantee?.arm({ inboundSeq: msg.inboundSeq, chatJid });
      const admitted = this.turnQueue.enqueue({
        chatJid,
        senderJid: msg.senderJid,
        senderName: msg.senderName ?? null,
        text,
        isGroup: msg.isGroup,
        groupName: msg.isGroup ? chatJid : undefined,
        inboundSeq: msg.inboundSeq,
      });
      if (!admitted && msg.inboundSeq !== undefined) {
        this.replyGuarantee?.disarm(msg.inboundSeq);
        this.durability?.deferInbound(msg.inboundSeq, 'agent_queue_full');
      }
```

Delete the later shared-mode arm at current `src/runtimes/agent/runtime.ts:3454`; per-chat arms remain unchanged.

- [ ] **Step 5: Run queue, runtime, and reply-guarantee regression suites**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/runtime.test.ts tests/core/reply-guarantee.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS. The agent test must observe `replyGuarantee.arm` before the queue processor starts and `deferInbound(..., 'agent_queue_full')` when admission is false.

- [ ] **Step 6: Commit durable queue outcomes**

```bash
git add src/runtimes/chat/queue.ts src/runtimes/chat/runtime.ts src/runtimes/agent/turn-queue.ts src/runtimes/agent/runtime.ts tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/runtime.test.ts
git commit -m "fix(runtime): make queue rejection a durable outcome"
```

### Task 6: Quiesce ingress, replay, runtimes, and transport on shutdown (WS-A03, commit 3)

**Files:**
- Modify: `src/transport/runtime-connection.ts:18-43`
- Modify: `src/transport/twilio/connection-bridge.ts:210-227`
- Modify: `src/main.ts:385-393, 777-799, 972-1015`
- Modify: `src/runtimes/agent/runtime.ts:5511-5567`
- Create: `tests/core/inbound-shutdown-lifecycle.test.ts`
- Modify: `tests/transport/twilio/connection-bridge.test.ts:190-240`

**Interfaces:**
- Consumes: `InboundReplayWorker` from Task 4 and queue `close()/idle()` from Task 5.
- Produces: `RuntimeConnection.shutdown(): Promise<void>` and a shutdown order of detach ingress → stop replay → drain/defer runtime → await transport → close DB.

- [ ] **Step 1: Write a shutdown-order source-and-behavior test**

Create `tests/core/inbound-shutdown-lifecycle.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TurnQueue } from '../../src/runtimes/agent/turn-queue.ts';

describe('inbound shutdown lifecycle', () => {
  it('drains an admitted turn after admission closes', async () => {
    const release = vi.fn();
    const queue = new TurnQueue();
    queue.enqueue({
      chatJid: 'shutdown@s.whatsapp.net',
      senderJid: 'sender@s.whatsapp.net',
      senderName: 'Shutdown User',
      text: 'finish me',
      isGroup: false,
      inboundSeq: 9,
    });
    queue.close();
    queue.setProcessor(async () => { release(); });
    await queue.idle();
    expect(release).toHaveBeenCalledOnce();
  });

  it('detaches ingress and awaits runtime plus transport before database close', () => {
    const source = readFileSync(resolve('src/main.ts'), 'utf8');
    const detach = source.indexOf('connectionManager.onMessage = null');
    const runtime = source.indexOf('await runtime.shutdown()', detach);
    const transport = source.indexOf('await connectionManager.shutdown()', runtime);
    const close = source.indexOf('db.close()', transport);
    expect(detach).toBeGreaterThan(-1);
    expect(runtime).toBeGreaterThan(detach);
    expect(transport).toBeGreaterThan(runtime);
    expect(close).toBeGreaterThan(transport);
  });
});
```

- [ ] **Step 2: Run the shutdown tests and verify transport close is currently unawaited**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-shutdown-lifecycle.test.ts tests/transport/twilio/connection-bridge.test.ts --pool=forks
```

Expected: FAIL because `main.ts` calls `connectionManager.shutdown()` without `await` and does not detach `onMessage` before runtime shutdown.

- [ ] **Step 3: Make asynchronous shutdown part of the transport contract**

Change the `RuntimeConnection` signature to:

```ts
  shutdown(): Promise<void>;
```

`TwilioConnection.shutdown()` already matches this contract. Change `ConnectionManager.shutdown()` to remain `async shutdown(): Promise<void>` (or return `Promise.resolve()` after its synchronous teardown) and update any test fakes to `shutdown: vi.fn().mockResolvedValue(undefined)`.

- [ ] **Step 4: Wire and order the replay worker in main**

After assigning `connectionManager.onMessage`, create the worker with the same runtime dispatch seam:

```ts
const inboundReplayWorker = new InboundReplayWorker(db, durability, {
  dispatch: (msg) => runtime.handleMessage(msg),
  batchSize: 10,
  intervalMs: 5_000,
});
inboundReplayWorker.start();
```

Add this import:

```ts
import { InboundReplayWorker } from './core/inbound-replay.ts';
```

At the start of the shutdown `try` block, before clearing background timers, add:

```ts
    connectionManager.onMessage = null;
    inboundReplayWorker.stop();
```

Replace the runtime/transport shutdown calls with:

```ts
    await runtime.shutdown();
    await connectionManager.shutdown();
```

At the start of `AgentRuntime.shutdown()`, before session teardown, add:

```ts
    this.turnQueue.close();
    await this.turnQueue.idle();
```

The existing process-level 10-second deadline remains the hard ceiling. If it fires, startup `preConnectRecovery()` converts any still-open leased inbound to `deferred`; do not add a second process-exit path.

- [ ] **Step 5: Run shutdown, transport, runtime, and main wiring tests**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-shutdown-lifecycle.test.ts tests/transport/twilio/connection-bridge.test.ts tests/transport/reconnect.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/runtime.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS. The Twilio webhook/adapter close test must finish before the DB-close source position; a test that only checks the method exists is insufficient.

- [ ] **Step 6: Commit shutdown durability**

```bash
git add src/transport/runtime-connection.ts src/transport/twilio/connection-bridge.ts src/main.ts src/runtimes/agent/runtime.ts tests/core/inbound-shutdown-lifecycle.test.ts tests/transport/twilio/connection-bridge.test.ts
git commit -m "fix(runtime): drain inbound work before transport shutdown"
```

### Task 7: Implement the two-stage Reply Guarantee watchdog (WS-A01, commit 1)

**Files:**
- Modify: `src/core/reply-guarantee.ts:7-220`
- Modify: `tests/core/reply-guarantee.test.ts:1-408`

**Interfaces:**
- Consumes: `ReplyGuaranteeDurability.getInboundStatus` and `completeTurn`.
- Produces: `ReplyGuaranteeSoftSender`, `ReplyGuaranteeTerminalSender`, and `ReplyGuaranteeTerminalResult { proof: 'submitted' | 'awaiting_echo'; terminalReason: string }`.

- [ ] **Step 1: Replace unsafe typing-terminal tests with the two-stage contract**

Replace the first two manager tests and the old `createReplyGuaranteeLivenessSender` describe with these tests:

```ts
it('soft deadline sends presence but keeps the inbound armed and incomplete', async () => {
  const durability = makeDurability('processing');
  const sendSoftLiveness = vi.fn(async () => undefined);
  const sendTerminalNotice = vi.fn(async () => ({
    proof: 'awaiting_echo' as const,
    terminalReason: 'rgp_interruption_sent',
  }));
  const manager = new ReplyGuaranteeManager({
    durability,
    sendSoftLiveness,
    sendTerminalNotice,
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
    rateLimitMs: 1_000,
  });

  manager.arm({ inboundSeq: 7, chatJid: '15550100001@s.whatsapp.net' });
  await vi.advanceTimersByTimeAsync(100);

  expect(sendSoftLiveness).toHaveBeenCalledOnce();
  expect(sendTerminalNotice).not.toHaveBeenCalled();
  expect(durability.completeTurn).not.toHaveBeenCalled();
  expect(manager.isArmed(7)).toBe(true);
});

it('hard deadline sends a tracked notice and waits for echo proof', async () => {
  const durability = makeDurability('processing');
  const sendTerminalNotice = vi.fn(async () => ({
    proof: 'awaiting_echo' as const,
    terminalReason: 'rgp_interruption_sent',
  }));
  const manager = new ReplyGuaranteeManager({
    durability,
    sendSoftLiveness: vi.fn(async () => undefined),
    sendTerminalNotice,
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
    rateLimitMs: 1_000,
  });

  manager.arm({ inboundSeq: 8, chatJid: '15550100002@s.whatsapp.net' });
  await vi.advanceTimersByTimeAsync(300);

  expect(sendTerminalNotice).toHaveBeenCalledWith({
    inboundSeq: 8,
    chatJid: '15550100002@s.whatsapp.net',
    text: DEFAULT_REPLY_GUARANTEE_TEXT,
  });
  expect(durability.completeTurn).not.toHaveBeenCalled();
  expect(manager.isArmed(8)).toBe(false);
});

it('completes immediately only when the configured sender returns submitted proof', async () => {
  const durability = makeDurability('processing');
  const manager = new ReplyGuaranteeManager({
    durability,
    sendSoftLiveness: vi.fn(async () => undefined),
    sendTerminalNotice: vi.fn(async () => ({
      proof: 'submitted' as const,
      terminalReason: 'rgp_interruption_submitted',
    })),
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
  });
  manager.arm({ inboundSeq: 9, chatJid: 'sms:+15550100009' });
  await vi.advanceTimersByTimeAsync(300);
  expect(durability.completeTurn).toHaveBeenCalledWith({
    inbound: { seq: 9, terminalReason: 'rgp_interruption_submitted' },
  });
});

it('keeps the inbound open and permits a later retry when the hard send fails', async () => {
  const durability = makeDurability('processing');
  const sendTerminalNotice = vi.fn(async () => {
    throw new Error('synthetic transport outage');
  });
  const manager = new ReplyGuaranteeManager({
    durability,
    sendSoftLiveness: vi.fn(async () => undefined),
    sendTerminalNotice,
    softTimeoutMs: 100,
    hardTimeoutMs: 200,
    rateLimitMs: 10_000,
  });
  manager.arm({ inboundSeq: 10, chatJid: 'retry@s.whatsapp.net' });
  await vi.advanceTimersByTimeAsync(300);
  expect(durability.completeTurn).not.toHaveBeenCalled();

  manager.arm({ inboundSeq: 11, chatJid: 'retry@s.whatsapp.net' });
  await vi.advanceTimersByTimeAsync(300);
  expect(sendTerminalNotice).toHaveBeenCalledTimes(2);
});
```

Retain and adapt the existing duplicate timer, disarm, activity reset, closed-status, rate-limit, finalize-failure, and shutdown tests. Every constructor must now pass both senders and use `softTimeoutMs`/`hardTimeoutMs`; do not delete those behavioral cases.

- [ ] **Step 2: Run the Reply Guarantee suite and confirm typing currently finalizes**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/reply-guarantee.test.ts --pool=forks
```

Expected: FAIL because the current manager has one `timeoutMs`, one `sendFallback`, and calls `completeTurn` after the typing-only sender.

- [ ] **Step 3: Implement two timers and explicit proof handling**

Replace the option and armed-turn types in `src/core/reply-guarantee.ts` with:

```ts
export const DEFAULT_REPLY_GUARANTEE_SOFT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REPLY_GUARANTEE_HARD_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS = DEFAULT_REPLY_GUARANTEE_SOFT_TIMEOUT_MS;

export type ReplyGuaranteeSoftSender = (
  input: ReplyGuaranteeFallbackInput,
) => Promise<void>;

export interface ReplyGuaranteeTerminalResult {
  proof: 'submitted' | 'awaiting_echo';
  terminalReason: string;
}

export type ReplyGuaranteeTerminalSender = (
  input: ReplyGuaranteeFallbackInput,
) => Promise<ReplyGuaranteeTerminalResult>;

export interface ReplyGuaranteeManagerOptions {
  durability: ReplyGuaranteeDurability | undefined;
  sendSoftLiveness: ReplyGuaranteeSoftSender;
  sendTerminalNotice: ReplyGuaranteeTerminalSender;
  softTimeoutMs?: number;
  hardTimeoutMs?: number;
  rateLimitMs?: number;
  fallbackText?: string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
}

interface ArmedTurn {
  inboundSeq: number;
  chatJid: string;
  stage: 'soft' | 'hard';
  timer: ReturnType<typeof setTimeout>;
}
```

Replace the manager's timeout fields and timer functions with:

```ts
  private readonly sendSoftLiveness: ReplyGuaranteeSoftSender;
  private readonly sendTerminalNotice: ReplyGuaranteeTerminalSender;
  private readonly softTimeoutMs: number;
  private readonly hardTimeoutMs: number;

  private armTimer(
    inboundSeq: number,
    chatJid: string,
    stage: 'soft' | 'hard',
  ): ReturnType<typeof setTimeout> {
    const delay = stage === 'soft' ? this.softTimeoutMs : this.hardTimeoutMs;
    const timer = this.setTimer(() => {
      void (stage === 'soft'
        ? this.onSoftTimeout(inboundSeq, chatJid)
        : this.onHardTimeout(inboundSeq, chatJid));
    }, delay);
    timer.unref?.();
    return timer;
  }
```

Initialize those fields in the constructor:

```ts
    this.sendSoftLiveness = opts.sendSoftLiveness;
    this.sendTerminalNotice = opts.sendTerminalNotice;
    this.softTimeoutMs = normalizePositiveMs(
      opts.softTimeoutMs,
      DEFAULT_REPLY_GUARANTEE_SOFT_TIMEOUT_MS,
    );
    this.hardTimeoutMs = normalizePositiveMs(
      opts.hardTimeoutMs,
      DEFAULT_REPLY_GUARANTEE_HARD_TIMEOUT_MS,
    );
```

Create the armed entry with `stage: 'soft'`. Replace `onTimeout` with:

```ts
  private async onSoftTimeout(inboundSeq: number, chatJid: string): Promise<void> {
    const active = this.armed.get(inboundSeq);
    if (!active || !this.durability) return;
    const status = this.durability.getInboundStatus(inboundSeq);
    if (!isOpenInboundStatus(status)) {
      this.armed.delete(inboundSeq);
      return;
    }

    try {
      await this.sendSoftLiveness({ inboundSeq, chatJid, text: this.fallbackText });
    } catch (err) {
      log.warn({ err, inboundSeq }, 'reply guarantee soft liveness failed');
    }
    active.stage = 'hard';
    active.timer = this.armTimer(inboundSeq, chatJid, 'hard');
  }

  private async onHardTimeout(inboundSeq: number, chatJid: string): Promise<void> {
    this.armed.delete(inboundSeq);
    if (!this.durability) return;
    const status = this.durability.getInboundStatus(inboundSeq);
    if (!isOpenInboundStatus(status)) return;

    const now = this.now();
    const lastTerminalAt = this.lastFallbackByChat.get(chatJid);
    if (lastTerminalAt !== undefined && now - lastTerminalAt < this.rateLimitMs) {
      log.warn({ inboundSeq, status }, 'reply guarantee terminal notice rate-limited');
      return;
    }
    this.lastFallbackByChat.set(chatJid, now);

    let sendSucceeded = false;
    try {
      const result = await this.sendTerminalNotice({
        inboundSeq,
        chatJid,
        text: this.fallbackText,
      });
      sendSucceeded = true;
      if (result.proof === 'submitted') {
        this.durability.completeTurn({
          inbound: { seq: inboundSeq, terminalReason: result.terminalReason },
        });
      }
    } catch (err) {
      if (!sendSucceeded && this.lastFallbackByChat.get(chatJid) === now) {
        this.lastFallbackByChat.delete(chatJid);
      }
      log.warn({ err, inboundSeq }, 'reply guarantee terminal notice failed');
    }
  }
```

Update `notifyActivity` to reset the current stage rather than always returning to soft:

```ts
      armed.timer = this.armTimer(armed.inboundSeq, armed.chatJid, armed.stage);
```

- [ ] **Step 4: Run the manager suite and inspect the fake-clock stage boundary**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/reply-guarantee.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS. At exactly the soft deadline, the test must observe no terminal sender and no `completeTurn`; at soft plus hard deadline, it must observe one tracked terminal sender.

- [ ] **Step 5: Commit the watchdog state machine**

```bash
git add src/core/reply-guarantee.ts tests/core/reply-guarantee.test.ts
git commit -m "fix(durability): split reply guarantee soft and hard deadlines"
```

### Task 8: Send the hard interruption through outbound durability and echo proof (WS-A01, commit 2)

**Files:**
- Modify: `src/core/reply-guarantee.ts:189-211`
- Modify: `src/runtimes/agent/runtime.ts:1951-1961`
- Modify: `tests/core/reply-guarantee.test.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts:1660-1795`
- Modify: `docs/reply-guarantee.md:1-86`

**Interfaces:**
- Consumes: `sendTracked(messenger, chatJid, text, durability, { replayPolicy, isTerminal, sourceInboundSeq })` and `DurabilityEngine.matchEcho(waMessageId)`.
- Produces: `createReplyGuaranteeSoftSender({ messenger })` and `createReplyGuaranteeTrackedSender({ messenger, durability })`.

- [ ] **Step 1: Add a real-DB tracked-interruption test**

Add this describe to `tests/core/reply-guarantee.test.ts`:

```ts
describe('tracked Reply Guarantee terminal sender', () => {
  it('journals the interruption and completes only after the transport echo', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const inboundSeq = durability.journalInbound(
        'rgp-source',
        '15550100021',
        '15550100021@s.whatsapp.net',
        'agent',
      );
      const messenger: Messenger = {
        sendMessage: vi.fn(async () => ({ waMessageId: 'wamid.rgp.tracked' })),
        setTyping: vi.fn(async () => undefined),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };
      const sender = createReplyGuaranteeTrackedSender({ messenger, durability });

      const result = await sender({
        inboundSeq,
        chatJid: '15550100021@s.whatsapp.net',
        text: DEFAULT_REPLY_GUARANTEE_TEXT,
      });

      expect(result).toEqual({
        proof: 'awaiting_echo',
        terminalReason: 'rgp_interruption_echoed',
      });
      expect(db.raw.prepare(`
        SELECT status, source_inbound_seq, is_terminal, replay_policy, wa_message_id
        FROM outbound_ops WHERE source_inbound_seq = ?
      `).get(inboundSeq)).toEqual({
        status: 'submitted',
        source_inbound_seq: inboundSeq,
        is_terminal: 1,
        replay_policy: 'unsafe',
        wa_message_id: 'wamid.rgp.tracked',
      });
      expect(durability.getInboundStatus(inboundSeq)).toBe('processing');

      expect(durability.matchEcho('wamid.rgp.tracked')).toBe(true);
      expect(durability.getInboundStatus(inboundSeq)).toBe('complete');
    } finally {
      db.close();
    }
  });

  it('does not finalize when the outbound journal insert fails before transport', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const inboundSeq = durability.journalInbound('rgp-fault', 'k', 'j@s.whatsapp.net', 'agent');
      db.raw.exec(`
        CREATE TRIGGER reject_rgp_outbound
        BEFORE INSERT ON outbound_ops
        BEGIN SELECT RAISE(ABORT, 'synthetic outbound journal failure'); END
      `);
      const messenger: Messenger = {
        sendMessage: vi.fn(async () => ({ waMessageId: 'must-not-send' })),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };
      const sender = createReplyGuaranteeTrackedSender({ messenger, durability });

      await expect(sender({
        inboundSeq,
        chatJid: 'j@s.whatsapp.net',
        text: DEFAULT_REPLY_GUARANTEE_TEXT,
      })).rejects.toThrow(/synthetic outbound journal failure/);
      expect(messenger.sendMessage).not.toHaveBeenCalled();
      expect(durability.getInboundStatus(inboundSeq)).toBe('processing');
    } finally {
      db.close();
    }
  });
});
```

Add imports for `DurabilityEngine`, `Messenger`, and `createReplyGuaranteeTrackedSender`.

- [ ] **Step 2: Run the tracked sender test and verify it is absent**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/reply-guarantee.test.ts --pool=forks
```

Expected: FAIL because the tracked sender export does not exist.

- [ ] **Step 3: Implement soft and tracked sender factories**

Replace `createReplyGuaranteeLivenessSender` with:

```ts
export function createReplyGuaranteeSoftSender({
  messenger,
}: {
  messenger: Messenger;
}): ReplyGuaranteeSoftSender {
  return async ({ chatJid }) => {
    await messenger.setTyping?.(chatJid, 'composing').catch(() => undefined);
  };
}

export function createReplyGuaranteeTrackedSender({
  messenger,
  durability,
}: {
  messenger: Messenger;
  durability: DurabilityEngine;
}): ReplyGuaranteeTerminalSender {
  return async ({ inboundSeq, chatJid, text }) => {
    await sendTracked(messenger, chatJid, text, durability, {
      replayPolicy: 'unsafe',
      isTerminal: true,
      sourceInboundSeq: inboundSeq,
    });
    return {
      proof: 'awaiting_echo',
      terminalReason: 'rgp_interruption_echoed',
    };
  };
}
```

Add these imports:

```ts
import { sendTracked, type DurabilityEngine, type CompleteTurnParams } from './durability.ts';
```

- [ ] **Step 4: Wire both stages in AgentRuntime**

Replace the Reply Guarantee imports and `setDurability` construction with:

```ts
import {
  createReplyGuaranteeSoftSender,
  createReplyGuaranteeTrackedSender,
  DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS,
  ReplyGuaranteeManager,
} from '../../core/reply-guarantee.ts';
```

```ts
    this.replyGuarantee = new ReplyGuaranteeManager({
      durability: engine,
      softTimeoutMs: this.replyGuaranteeTimeoutMs,
      sendSoftLiveness: createReplyGuaranteeSoftSender({ messenger: this.messenger }),
      sendTerminalNotice: createReplyGuaranteeTrackedSender({
        messenger: this.messenger,
        durability: engine,
      }),
    });
```

Update runtime tests so the soft deadline asserts `setTyping` only, then the hard deadline asserts one `sendMessage` call and one `outbound_ops` row linked to the inbound sequence.

- [ ] **Step 5: Update the shipped-state documentation**

Replace the runtime-watchdog paragraph in `docs/reply-guarantee.md` with:

```markdown
5. Runtime watchdog (two-stage).
   The runtime-owned manager arms when an inbound turn is admitted. Its soft
   deadline emits best-effort typing/presence and leaves the inbound open. Its
   hard deadline creates an unsafe terminal `outbound_ops` text operation linked
   by `source_inbound_seq`, submits the explicit interruption notice, and waits
   for the normal transport echo before `inbound_events` becomes complete.
   Submission without echo remains observable and recoverable; typing alone is
   never a terminal reason.
```

Change the rate-limit note to state that the in-process throttle applies to the hard interruption, not the soft presence signal.

- [ ] **Step 6: Run the full WS-A01 focused matrix**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/reply-guarantee.test.ts tests/core/durability.test.ts tests/core/durability-echoed-terminal-recovery.test.ts tests/runtimes/agent/runtime.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS. Query assertions must show `outbound_ops.status='submitted'` while the inbound remains open, followed by `complete` only after `matchEcho`.

- [ ] **Step 7: Commit tracked Reply Guarantee delivery**

```bash
git add src/core/reply-guarantee.ts src/runtimes/agent/runtime.ts tests/core/reply-guarantee.test.ts tests/runtimes/agent/runtime.test.ts docs/reply-guarantee.md
git commit -m "fix(durability): track reply guarantee interruptions"
```

### Task 9: Verify each PR boundary and the combined train

**Files:**
- Verify only; no product file changes unless a failing semantic assertion identifies a real defect.

**Interfaces:**
- Consumes: all interfaces produced by Tasks 1-8.
- Produces: three clean verification receipts and explicit proof gaps for staging-only behavior.

- [ ] **Step 1: Verify WS-A02 at its branch tip**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-37-inbound-replay.test.ts tests/core/inbound-admission.test.ts tests/core/ingest.test.ts tests/core/ingest-backpressure.test.ts tests/core/ingest-control.test.ts tests/core/ingest-paused-chats.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:lint:src
```

Expected: all commands exit 0. Capture the test totals and note that real process crash timing is not proven by an in-memory SQLite test.

- [ ] **Step 2: Verify WS-A03 at its branch tip**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/inbound-replay.test.ts tests/core/durability-recovery.test.ts tests/core/inbound-shutdown-lifecycle.test.ts tests/runtimes/chat/queue.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/agent/turn-queue.test.ts tests/runtimes/agent/runtime.test.ts tests/transport/twilio/connection-bridge.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: exit 0. A forced process exit, Docker restart, systemd stop deadline, and live Twilio close remain staging drills rather than unit-test proof.

- [ ] **Step 3: Verify WS-A01 at its branch tip**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/reply-guarantee.test.ts tests/core/durability.test.ts tests/core/durability-echoed-terminal-recovery.test.ts tests/runtimes/agent/runtime.test.ts --pool=forks
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: exit 0 with fake-clock proof of soft/hard ordering and SQLite proof of echo-gated completion.

- [ ] **Step 4: Run the full pinned release gate on the integrated train**

Run:

```bash
bash scripts/run-with-pinned-npm.sh run verify:release
```

Expected: exit 0. Any skipped transcription/provider test, missing browser executable, masked shell failure, or unavailable ARC sibling verification is an explicit gap and cannot be described as clean.

- [ ] **Step 5: Record staging drills without publishing**

Record these exact residual checks in the PR briefs; do not perform them against a live account without explicit approval:

```text
1. Kill the process after messages INSERT but before inbound dispatch; restart and observe deferred -> processing -> terminal.
2. Saturate ingest, ChatQueue, and TurnQueue independently; observe one durable deferred row per shed message and bounded FIFO replay.
3. SIGTERM with queued turns; observe ingress detach, queue drain/defer, awaited transport close, then DB close.
4. Delay a Reply Guarantee transport echo past the hard send; observe submitted/open before echo and complete after echo.
5. Drop the outbound journal write before the hard send; observe no transport call and an open inbound row.
```

## Self-Review Notes

- **Spec coverage:** WS-A01 maps to Tasks 7-8, WS-A02 to Tasks 1-3, and WS-A03 to Tasks 4-6. Task 9 covers the required focused and full verification receipts. The plan explicitly covers atomic write boundaries, redelivery repair, bounded replay, queue admission, shutdown ordering, soft/hard deadlines, normal outbound journaling, and echo-gated terminal proof.
- **Deferred-step scan:** Every code-changing step includes concrete TypeScript, SQL, Markdown, or exact replacement blocks; no unspecified implementation instruction remains.
- **Type consistency:** `InboundDeferredReason` values used by ingest, replay, chat, agent, and recovery match the union defined in Task 3. `ReplyGuaranteeTerminalResult.proof` is consistently `'submitted' | 'awaiting_echo'`. `RuntimeConnection.shutdown` is consistently `Promise<void>`.
- **Sequencing uncertainty:** WS-A01 is listed first in the audit PR train, but this plan executes WS-A02/WS-A03 foundations before the final WS-A01 wiring because the tracked hard notice depends on truthful admission and shutdown semantics. If maintainers require the published PR order to remain A01→A02→A03, implement the Reply Guarantee manager state machine first and rebase its runtime wiring after A02/A03; do not duplicate the durability interfaces.
- **Known proof gaps:** Reconstructed replay messages intentionally derive `isGroup` from `@g.us` and do not reconstruct mention metadata. Before implementation, verify runtime consumers do not need `mentionedJids` after ingest; if they do, extend migration 37 with metadata-only `mentioned_jids` rather than persisting a second content payload. Live WhatsApp echo timing, Twilio shutdown, and forced process crash behavior require staging drills.
