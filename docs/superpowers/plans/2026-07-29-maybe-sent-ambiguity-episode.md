# Maybe-Sent Ambiguity Episode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live `maybe_sent` reconciliation and durability health age the current ambiguity episode rather than queue creation time.

**Architecture:** Migration 52 adds nullable `outbound_ops.ambiguity_at` and backfills existing ambiguous rows conservatively. `markMaybeSent()` becomes the sole writer for a new episode. A shared SQL expression selects a parseable active episode time, then legacy timestamps, and otherwise a bounded stale value for both live reconciliation and health.

**Tech Stack:** TypeScript, Node SQLite, Vitest, repository migration registry and documentation guards.

## Global Constraints

- Keep `submitted_at` exclusively for a recorded provider submission receipt.
- Use the pinned Node 24.15.0 toolchain through `bash scripts/run-with-pinned-npm.sh`.
- Run CPU-heavy test commands through `loadgate`.
- Preserve existing post-connect history reconciliation; only the live dwell-gated selector and health-age selector change.
- Keep health and alert evidence bounded; do not expose destinations, message content, transport IDs, paths, commands, or raw errors.
- Use `apply_patch` for source and documentation edits, and regenerate canonical audit/index files with their repository scripts.

---

### Task 1: Add the durable episode timestamp migration

**Files:**

- Create: `src/core/database-migration-52.ts`
- Modify: `src/core/database.ts:45,796,1000-1040`
- Modify: `src/core/database-schema-version.ts:5`
- Modify: `tests/core/database-migration-52.test.ts`
- Modify: `tests/core/migration-safety.test.ts:45`
- Modify: `tests/core/database-migration-41.test.ts`, `tests/core/database-migration-43.test.ts`, `tests/core/database-migration-47.test.ts`, `tests/core/database-migration-49.test.ts`, `tests/core/database-migration-50.test.ts`, `tests/core/database-migration-51.test.ts`, `tests/core/database-migration-provenance.test.ts`, `tests/core/migration-turn-lifecycle.test.ts`

**Interfaces:**

- Consumes: the existing `MIGRATIONS` map and SQLite transaction opened by `Database.open()`.
- Produces: nullable `outbound_ops.ambiguity_at` on every current database and migration version `52`.

- [ ] **Step 1: Write migration tests before the migration exists.**

```ts
it('backfills only legacy maybe_sent rows from submitted_at then created_at', () => {
  raw.exec(`CREATE TABLE outbound_ops (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    submitted_at TEXT
  )`);
  raw.exec(`INSERT INTO outbound_ops VALUES
    (1, 'maybe_sent', '2026-07-01 00:00:00', '2026-07-01 00:01:00'),
    (2, 'maybe_sent', '2026-07-02 00:00:00', NULL),
    (3, 'pending', '2026-07-03 00:00:00', NULL)`);

  runMigration52(raw);

  expect(raw.prepare('SELECT id, ambiguity_at FROM outbound_ops ORDER BY id').all()).toEqual([
    { id: 1, ambiguity_at: '2026-07-01 00:01:00' },
    { id: 2, ambiguity_at: '2026-07-02 00:00:00' },
    { id: 3, ambiguity_at: null },
  ]);
});
```

- [ ] **Step 2: Run the focused migration test and confirm it fails because `runMigration52` is unavailable.**

Run: `loadgate --label ambiguity-52-red -- bash scripts/run-with-pinned-npm.sh test -- tests/core/database-migration-52.test.ts --pool=forks`

Expected: FAIL with a missing module/export or missing `ambiguity_at` column.

- [ ] **Step 3: Implement the idempotent migration and register it.**

```ts
// src/core/database-migration-52.ts
export function runMigration52(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info('outbound_ops')").all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (!columns.some(({ name }) => name === 'ambiguity_at')) {
    db.exec('ALTER TABLE outbound_ops ADD COLUMN ambiguity_at TEXT');
  }
  db.exec(`
    UPDATE outbound_ops
    SET ambiguity_at = COALESCE(submitted_at, created_at)
    WHERE status = 'maybe_sent' AND ambiguity_at IS NULL
  `);
}
```

Add the `runMigration52` import, a thin registry wrapper, and `[52, runMigration52]` after migration 51. Set `CURRENT_SCHEMA_MIGRATION` to `52`; update every test asserting the current migration and change `ALL_MIGRATION_VERSIONS` to length `52`.

- [ ] **Step 4: Add direct idempotence and transaction rollback tests.**

```ts
it('is idempotent and can be rolled back by its caller transaction', () => {
  raw.exec('BEGIN');
  runMigration52(raw);
  raw.exec('ROLLBACK');
  expect(raw.prepare("PRAGMA table_info('outbound_ops')").all()
    .map((column: { name: string }) => column.name)).not.toContain('ambiguity_at');

  runMigration52(raw);
  runMigration52(raw);
  expect(raw.prepare("PRAGMA table_info('outbound_ops')").all()
    .filter((column: { name: string }) => column.name === 'ambiguity_at')).toHaveLength(1);
});
```

- [ ] **Step 5: Run migration and registry coverage.**

Run: `loadgate --label ambiguity-52-green -- bash scripts/run-with-pinned-npm.sh test -- tests/core/database-migration-52.test.ts tests/core/migration-safety.test.ts tests/core/database-migration-41.test.ts tests/core/database-migration-43.test.ts tests/core/database-migration-47.test.ts tests/core/database-migration-49.test.ts tests/core/database-migration-50.test.ts tests/core/database-migration-51.test.ts tests/core/database-migration-provenance.test.ts tests/core/migration-turn-lifecycle.test.ts --pool=forks`

Expected: PASS with migration 52 recorded once and all historical migrations retained.

- [ ] **Step 6: Commit the migration slice.**

```bash
git add src/core/database-migration-52.ts src/core/database.ts src/core/database-schema-version.ts \
  tests/core/database-migration-52.test.ts tests/core/migration-safety.test.ts \
  tests/core/database-migration-41.test.ts tests/core/database-migration-43.test.ts \
  tests/core/database-migration-47.test.ts tests/core/database-migration-49.test.ts \
  tests/core/database-migration-50.test.ts tests/core/database-migration-51.test.ts \
  tests/core/database-migration-provenance.test.ts tests/core/migration-turn-lifecycle.test.ts
git commit -m "feat(durability): persist ambiguity episodes"
```

### Task 2: Age live ambiguity from the current episode

**Files:**

- Modify: `src/core/durability.ts:162-180,470-505,650-690,830-850`
- Modify: `tests/core/durability-recovery.test.ts:443-486`
- Modify: `tests/core/durability.test.ts:227-324`
- Modify: `tests/core/health.test.ts:380-396`

**Interfaces:**

- Consumes: `outbound_ops.ambiguity_at` from migration 52.
- Produces: `OutboundOpRow.ambiguity_at`, an atomic episode-entry transition, and one effective-dwell SQL expression used by live reconciliation and health.

- [ ] **Step 1: Add an old-queue/fresh-episode regression test.**

```ts
it('keeps an old pending unsafe op in its fresh maybe_sent episode until grace expires', () => {
  const opId = engine.createOutboundOp({
    conversationKey: 'k1', chatJid: 'j1', opType: 'text', payload: '{}', replayPolicy: 'unsafe',
  });
  db.raw.prepare("UPDATE outbound_ops SET created_at = datetime('now', '-3600 seconds') WHERE id = ?").run(opId);
  engine.markSending(opId);
  engine.markMaybeSent(opId, 'pre-receipt failure');

  expect(engine.reconcileLiveMaybeSent().outboundReconciled).toBe(0);
  expect(getOutbound(db, opId)).toMatchObject({ status: 'maybe_sent' });
  expect(engine.getHealthStats().oldestMaybeSentAt).not.toBe(
    db.raw.prepare('SELECT created_at FROM outbound_ops WHERE id = ?').get(opId).created_at,
  );
});
```

- [ ] **Step 2: Run the single regression and confirm the old queue time makes it fail.**

Run: `loadgate --label ambiguity-episode-red -- bash scripts/run-with-pinned-npm.sh test -- tests/core/durability-recovery.test.ts -t "keeps an old pending unsafe op" --pool=forks`

Expected: FAIL because the unsafe row is reconciled and quarantined immediately.

- [ ] **Step 3: Implement the shared effective-dwell expression and atomic transition.**

```ts
function maybeSentDwellAtSql(prefix = ''): string {
  const column = (name: string) => `${prefix}${name}`;
  const stale = "datetime('now', '-31 minutes')";
  return `CASE
    WHEN ${column('ambiguity_at')} IS NOT NULL AND datetime(${column('ambiguity_at')}) IS NOT NULL THEN datetime(${column('ambiguity_at')})
    WHEN ${column('ambiguity_at')} IS NOT NULL THEN ${stale}
    WHEN ${column('submitted_at')} IS NOT NULL AND datetime(${column('submitted_at')}) IS NOT NULL THEN datetime(${column('submitted_at')})
    WHEN ${column('submitted_at')} IS NOT NULL THEN ${stale}
    WHEN datetime(${column('created_at')}) IS NOT NULL THEN datetime(${column('created_at')})
    ELSE ${stale}
  END`;
}
```

Use `maybeSentDwellAtSql('o.')` in `getLiveReconcileMaybeSent` and `maybeSentDwellAtSql()` in `getOldestMaybeSentSubmittedAt`. Add `ambiguity_at` to both selected row shapes and to `OutboundOpRow`. Change the prepared `markMaybeSent` statement to:

```sql
SET status = 'maybe_sent',
    ambiguity_at = CASE
      WHEN status = 'maybe_sent' THEN ambiguity_at
      ELSE datetime('now')
    END,
    error = ?, wa_message_id = COALESCE(?, wa_message_id),
    retry_count = MAX(retry_count, ?)
```

- [ ] **Step 4: Add re-entry, threshold, late-echo, and malformed-chronology tests.**

```ts
// Re-entry must overwrite the previous episode clock after a safe reset.
db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = '2000-01-01 00:00:00' WHERE id = ?").run(opId);
engine.reconcileLiveMaybeSent();
engine.markSending(opId);
engine.markMaybeSent(opId, 'second ambiguous attempt');
expect(getOutbound(db, opId).ambiguity_at).not.toBe('2000-01-01 00:00:00');

// The current episode becomes eligible only after the established threshold.
db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = datetime('now', '-31 seconds') WHERE id = ?").run(opId);
expect(engine.reconcileLiveMaybeSent().outboundReconciled).toBe(1);

// Corrupt or future chronology is deliberately stale, never fresh.
db.raw.prepare("UPDATE outbound_ops SET ambiguity_at = 'not-a-timestamp' WHERE id = ?").run(opId);
expect(engine.reconcileLiveMaybeSent().outboundReconciled).toBe(1);
```

Test an echo inside the fresh grace by creating an old queued submitted row, entering `maybe_sent`, recording the normal message-table echo, and asserting `matchEcho()` yields `echoed` without a replay or quarantine.

- [ ] **Step 5: Run the direct durability and HTTP health regression suite.**

Run: `loadgate --label ambiguity-episode-green -- bash scripts/run-with-pinned-npm.sh test -- tests/core/durability.test.ts tests/core/durability-recovery.test.ts tests/core/health.test.ts --pool=forks`

Expected: PASS. The old pending row has a fresh episode age, the old ambiguity threshold reconciles under existing policy, and malformed or future values cannot keep health green.

- [ ] **Step 6: Commit the behavior slice.**

```bash
git add src/core/durability.ts tests/core/durability.test.ts tests/core/durability-recovery.test.ts tests/core/health.test.ts
git commit -m "fix(durability): age current ambiguity episode"
```

### Task 3: Document the operational clock and validate the draft

**Files:**

- Modify: `docs/durability.md:33-55,236-260,300-340`
- Modify: `docs/runbook.md:698-707,860-872,1134-1139`
- Create: `docs/superpowers/plans/2026-07-29-maybe-sent-ambiguity-episode.md`
- Modify: `docs/publication-audit.md`
- Modify: `docs/work-index.json`
- Modify: `docs/work-index.md`

**Interfaces:**

- Consumes: the migration and live-dwell behavior from Tasks 1 and 2.
- Produces: operator documentation distinguishing queue creation, submission receipt, and the current ambiguity episode.

- [ ] **Step 1: Update the durable-state and operator descriptions.**

Add `ambiguity_at` to the outbound-journal explanation and state that the live ten-second loop reconciles a row only after 30 seconds from the current episode, not from queue creation. In runbook SQL include `ambiguity_at` beside `submitted_at`, and tell operators to inspect it without directly mutating the database.

- [ ] **Step 2: Regenerate canonical internal-document metadata.**

Run: `bash scripts/run-with-pinned-npm.sh run guard:publication:write`

Run: `bash scripts/run-with-pinned-npm.sh run work-index:regen`

Expected: the plan is classified `PRIVATE-ARCHIVE`; the generated work index reflects the current plan without hand-editing counters.

- [ ] **Step 3: Run the final scoped validation.**

Run: `loadgate --label ambiguity-episode-final -- bash scripts/run-with-pinned-npm.sh test -- tests/core/database-migration-52.test.ts tests/core/migration-safety.test.ts tests/core/durability.test.ts tests/core/durability-recovery.test.ts tests/core/health.test.ts tests/scripts/publication-guard.test.ts tests/scripts/work-index.test.ts --pool=forks`

Run: `loadgate --label ambiguity-episode-typecheck -- bash scripts/run-with-pinned-npm.sh run typecheck`

Run: `bash scripts/run-with-pinned-npm.sh run guard:publication:all`

Expected: every command exits 0. If a suite reports skipped, masked, or unavailable checks, report that gap instead of treating it as green.

- [ ] **Step 4: Commit documentation and generated metadata.**

```bash
git add docs/durability.md docs/runbook.md docs/superpowers/plans/2026-07-29-maybe-sent-ambiguity-episode.md \
  docs/publication-audit.md docs/work-index.json docs/work-index.md
git commit -m "docs: explain ambiguity episode timing"
```
