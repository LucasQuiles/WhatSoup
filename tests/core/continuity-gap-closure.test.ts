import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../../src/core/database.ts';
import { readContinuityGapHealth } from '../../src/core/continuity-gap-ledger.ts';
import {
  applyContinuityGapClosure,
  continuityGapClosureOperationId,
  ContinuityGapClosureError,
  inspectContinuityGapClosure,
} from '../../src/core/continuity-gap-closure.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  digest,
  gapObservation,
  insertClosureRow,
  recordGaps,
  signedClosure,
  unsignedClosure,
} from './_helpers/continuity-gap-closure.ts';

const tmp = trackTmpDirs('whatsoup-continuity-closure-');

function closureCount(raw: DatabaseSync): number {
  return Number((raw.prepare('SELECT COUNT(*) AS n FROM continuity_gap_closures').get() as { n: number }).n);
}

/** Every identity the health contract promises, asserted on any readable result. */
function expectIdentities(health: ReturnType<typeof readContinuityGapHealth>): void {
  if (!health.readable || health.closure_ledger !== 'present') {
    throw new Error('expected a readable, present closure ledger');
  }
  expect(health.total).toBe(health.open + health.closed);
  expect(health.open).toBe(health.unresolved + health.ambiguous);
  expect(health.closed).toBe(health.addressed + health.declined);
  expect(health.ambiguous).toBeLessThanOrEqual(health.ambiguous_total);
}

// Replace the guarded table with an unguarded copy so a test can plant a row
// the real constraints would refuse. Only a reader test does this.
function replaceWithUnguardedTable(raw: DatabaseSync): void {
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('DROP TABLE continuity_gap_closures');
  raw.exec(`
    CREATE TABLE continuity_gap_closures (
      plan_id TEXT, contract_version TEXT, operation_id TEXT, receipt_fingerprint TEXT,
      original_classification TEXT, original_content_type TEXT, disposition TEXT,
      proof_kind TEXT, evidence_manifest_sha256 TEXT, original_manifest_sha256 TEXT,
      proof_set_sha256 TEXT, linked_inbound_seq INTEGER, linked_message_sha256 TEXT,
      terminal_record_id INTEGER, audio_media_sha256 TEXT, audio_transcript_sha256 TEXT,
      ambiguity_resolution_sha256 TEXT, decision_record_sha256 TEXT, decision_source TEXT,
      policy_sha256 TEXT, policy_version TEXT, actor TEXT, authority TEXT,
      observed_at TEXT, decided_at TEXT, created_at TEXT
    );
    CREATE TRIGGER continuity_gap_closures_append_only_update
    BEFORE UPDATE ON continuity_gap_closures
    BEGIN SELECT RAISE(ABORT, 'continuity_gap_closures: append-only'); END;
    CREATE TRIGGER continuity_gap_closures_append_only_delete
    BEFORE DELETE ON continuity_gap_closures
    BEGIN SELECT RAISE(ABORT, 'continuity_gap_closures: append-only'); END;
    CREATE TRIGGER continuity_gap_closures_validate_insert
    BEFORE INSERT ON continuity_gap_closures WHEN 0
    BEGIN SELECT RAISE(ABORT, 'unreachable'); END;
  `);
}

describe('continuity gap health with closures', () => {
  let db: Database;
  let raw: DatabaseSync;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    raw = db.raw;
  });

  afterEach(() => db.close());

  it('empty ledger', () => {
    const health = readContinuityGapHealth(raw);
    expect(health).toEqual({
      readable: true,
      closure_ledger: 'present',
      total: 0,
      open: 0,
      unresolved: 0,
      ambiguous: 0,
      ambiguous_total: 0,
      closed: 0,
      addressed: 0,
      declined: 0,
    });
    expectIdentities(health);
  });

  it('all open', () => {
    recordGaps(raw, [
      gapObservation(1, 'absent'),
      gapObservation(2, 'observed_not_admitted'),
      gapObservation(3, 'ambiguous'),
    ]);
    const health = readContinuityGapHealth(raw);
    expect(health).toMatchObject({
      total: 3, open: 3, unresolved: 2, ambiguous: 1, ambiguous_total: 1,
      closed: 0, addressed: 0, declined: 0,
    });
    expectIdentities(health);
  });

  it('an addressed closure moves exactly one gap from unresolved to addressed', () => {
    const gaps = [gapObservation(1, 'absent'), gapObservation(2, 'absent')];
    recordGaps(raw, gaps);
    insertClosureRow(raw, signedClosure(gaps[0]));
    const health = readContinuityGapHealth(raw);
    expect(health).toMatchObject({
      total: 2, open: 1, unresolved: 1, ambiguous: 0, closed: 1, addressed: 1, declined: 0,
    });
    expectIdentities(health);
  });

  it('a declined closure counts as declined, never addressed', () => {
    const gaps = [gapObservation(1, 'observed_not_admitted')];
    recordGaps(raw, gaps);
    insertClosureRow(raw, signedClosure(gaps[0], { disposition: 'declined' }));
    const health = readContinuityGapHealth(raw);
    expect(health).toMatchObject({
      total: 1, open: 0, unresolved: 0, closed: 1, addressed: 0, declined: 1,
    });
    expectIdentities(health);
  });

  it('an originally ambiguous gap leaves open ambiguous but stays in ambiguous_total', () => {
    const gaps = [gapObservation(1, 'ambiguous'), gapObservation(2, 'ambiguous')];
    recordGaps(raw, gaps);
    insertClosureRow(raw, signedClosure(gaps[0]));
    const health = readContinuityGapHealth(raw);
    expect(health).toMatchObject({
      total: 2, open: 1, unresolved: 0, ambiguous: 1, ambiguous_total: 2,
      closed: 1, addressed: 1,
    });
    expectIdentities(health);
  });

  it('mixed dataset reconciles every bucket', () => {
    const gaps = [
      gapObservation(1, 'absent'),
      gapObservation(2, 'observed_not_admitted'),
      gapObservation(3, 'ambiguous'),
      gapObservation(4, 'absent'),
      gapObservation(5, 'ambiguous'),
    ];
    recordGaps(raw, gaps);
    insertClosureRow(raw, signedClosure(gaps[0]));
    insertClosureRow(raw, signedClosure(gaps[1], { disposition: 'declined' }));
    insertClosureRow(raw, signedClosure(gaps[2], { disposition: 'declined' }));
    const health = readContinuityGapHealth(raw);
    expect(health).toMatchObject({
      total: 5, open: 2, unresolved: 1, ambiguous: 1, ambiguous_total: 2,
      closed: 3, addressed: 1, declined: 2,
    });
    expectIdentities(health);
  });

  it('a database that never ran migration 66 reports an absent closure ledger, not zero debt', () => {
    recordGaps(raw, [gapObservation(1, 'absent'), gapObservation(2, 'ambiguous')]);
    raw.exec('DROP TABLE continuity_gap_closures');
    raw.prepare('DELETE FROM schema_migrations WHERE version = 66').run();
    expect(readContinuityGapHealth(raw)).toEqual({
      readable: true,
      closure_ledger: 'absent',
      total: null,
      open: 2,
      unresolved: 1,
      ambiguous: 1,
      ambiguous_total: 1,
      closed: null,
      addressed: null,
      declined: null,
    });
  });

  it('a missing table after migration 66 was recorded is unreadable', () => {
    raw.exec('DROP TABLE continuity_gap_closures');
    expect(() => readContinuityGapHealth(raw)).toThrow(/closure ledger is missing/);
  });

  it('a closure table without its append-only guards is unreadable', () => {
    raw.exec('DROP TRIGGER continuity_gap_closures_append_only_delete');
    expect(() => readContinuityGapHealth(raw)).toThrow(/closure ledger guards/);
  });

  it('malformed, orphaned and conflicting closure rows are unreadable, not zero', () => {
    const gaps = [gapObservation(1, 'absent')];
    const [planId] = recordGaps(raw, gaps);
    replaceWithUnguardedTable(raw);
    const valid = signedClosure(gaps[0]);

    insertClosureRow(raw, { ...valid, disposition: 'forgotten' as never });
    expect(() => readContinuityGapHealth(raw)).toThrow(/malformed closure/);
    raw.exec('DROP TRIGGER continuity_gap_closures_append_only_delete');
    raw.exec('DELETE FROM continuity_gap_closures');
    raw.exec(`CREATE TRIGGER continuity_gap_closures_append_only_delete
      BEFORE DELETE ON continuity_gap_closures
      BEGIN SELECT RAISE(ABORT, 'continuity_gap_closures: append-only'); END;`);

    const orphan = signedClosure(gapObservation(9, 'absent'));
    insertClosureRow(raw, orphan);
    expect(() => readContinuityGapHealth(raw)).toThrow(/orphaned closure/);
  });

  it('a closure whose receipt fingerprint disagrees with its plan is unreadable', () => {
    const gaps = [gapObservation(1, 'absent')];
    recordGaps(raw, gaps);
    replaceWithUnguardedTable(raw);
    // Re-signed, so only the plan binding (not the operation ID) is wrong.
    insertClosureRow(raw, signedClosure(gaps[0], { receiptFingerprint: digest('forged') }));
    expect(() => readContinuityGapHealth(raw)).toThrow(/conflicting closure/);
  });

  it('a duplicated closure for one plan is unreadable', () => {
    const gaps = [gapObservation(1, 'absent')];
    recordGaps(raw, gaps);
    replaceWithUnguardedTable(raw);
    insertClosureRow(raw, signedClosure(gaps[0]));
    insertClosureRow(raw, signedClosure(gaps[0], { actor: 'operator:second' }));
    expect(() => readContinuityGapHealth(raw)).toThrow(/duplicate closure/);
  });

  it('a closure whose operation ID does not match its content is unreadable', () => {
    const gaps = [gapObservation(1, 'absent')];
    recordGaps(raw, gaps);
    insertClosureRow(raw, { ...signedClosure(gaps[0]), operationId: digest('forged-operation') });
    expect(() => readContinuityGapHealth(raw)).toThrow(/malformed closure/);
  });
});

describe('continuity gap closure operation ID', () => {
  it('is deterministic and changes with every bound field', () => {
    const base = unsignedClosure(gapObservation(1, 'absent'));
    const id = continuityGapClosureOperationId(base);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(continuityGapClosureOperationId({ ...base })).toBe(id);
    for (const [field, value] of Object.entries({
      disposition: 'declined',
      evidenceManifestSha256: digest('x'),
      proofSetSha256: digest('y'),
      linkedMessageSha256: digest('z'),
      audioTranscriptSha256: digest('t'),
      actor: 'operator:other',
      decidedAt: '2026-09-25T00:06:00.000Z',
    })) {
      expect(continuityGapClosureOperationId({ ...base, [field]: value }), field).not.toBe(id);
    }
  });
});

describe('applyContinuityGapClosure', () => {
  let db: Database;
  let raw: DatabaseSync;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    raw = db.raw;
  });

  afterEach(() => db.close());

  it('appends one closure and reports it; the original plan and run are untouched', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    const before = raw.prepare(`
      SELECT p.*, r.trigger, r.status, r.completed_at FROM recovery_plans p
      JOIN recovery_runs r ON r.recovery_plan_id = p.plan_id
    `).all();
    const record = signedClosure(gap);
    const result = applyContinuityGapClosure(raw, () => record);
    expect(result).toEqual({ inserted: true, idempotent: false, record });
    expect(closureCount(raw)).toBe(1);
    expect(raw.prepare(`
      SELECT p.*, r.trigger, r.status, r.completed_at FROM recovery_plans p
      JOIN recovery_runs r ON r.recovery_plan_id = p.plan_id
    `).all()).toEqual(before);
  });

  it('returns the recorded outcome for the same operation', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    const record = signedClosure(gap);
    applyContinuityGapClosure(raw, () => record);
    expect(applyContinuityGapClosure(raw, () => ({ ...record })))
      .toEqual({ inserted: false, idempotent: true, record });
    expect(inspectContinuityGapClosure(raw, record)).toEqual({ state: 'already_closed' });
    expect(closureCount(raw)).toBe(1);
  });

  it('rejects a conflicting retry atomically with CLOSURE_PROOF_CONFLICT', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    applyContinuityGapClosure(raw, () => signedClosure(gap));
    let thrown: unknown;
    try {
      applyContinuityGapClosure(raw, () => signedClosure(gap, { disposition: 'declined' }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContinuityGapClosureError);
    expect(thrown).toMatchObject({ kind: 'conflict', condition: 'closure_changed' });
    expect(closureCount(raw)).toBe(1);
    expect(raw.isTransaction).toBe(false);
  });

  it('refuses a record whose operation ID does not match its content', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    expect(() => applyContinuityGapClosure(raw, () => ({
      ...signedClosure(gap),
      operationId: digest('stale'),
    }))).toThrow(expect.objectContaining({ kind: 'conflict', condition: 'operation_id_mismatch' }));
    expect(closureCount(raw)).toBe(0);
  });

  it('is Blocked when the plan is not a recorded continuity gap', () => {
    const gap = gapObservation(1, 'absent');
    expect(() => applyContinuityGapClosure(raw, () => signedClosure(gap)))
      .toThrow(expect.objectContaining({ kind: 'blocked', condition: 'gap_not_recorded' }));
    expect(closureCount(raw)).toBe(0);
  });

  it('runs the evidence builder inside the writer reservation and writes nothing when it fails', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    let sawTransaction = false;
    expect(() => applyContinuityGapClosure(raw, (inner) => {
      sawTransaction = inner.isTransaction;
      throw new ContinuityGapClosureError('conflict', 'transcript_changed', 'transcript changed');
    })).toThrow(expect.objectContaining({ condition: 'transcript_changed' }));
    expect(sawTransaction).toBe(true);
    expect(raw.isTransaction).toBe(false);
    expect(closureCount(raw)).toBe(0);
  });

  it('a concurrent closer on a second connection sees the first closure and conflicts', () => {
    const dir = tmp.make('concurrent');
    const dbPath = join(dir, 'bot.db');
    const fileDb = new Database(dbPath);
    fileDb.open();
    const gap = gapObservation(1, 'absent');
    recordGaps(fileDb.raw, [gap]);
    fileDb.close();

    const first = new DatabaseSync(dbPath);
    const second = new DatabaseSync(dbPath, { timeout: 0 });
    try {
      first.exec('PRAGMA foreign_keys = ON');
      second.exec('PRAGMA foreign_keys = ON');
      // While the first closer holds the writer reservation, the second
      // cannot start its own; it fails without writing.
      expect(() => applyContinuityGapClosure(first, () => {
        expect(() => applyContinuityGapClosure(second, () => signedClosure(gap, {
          disposition: 'declined',
        }))).toThrow(/locked|busy/i);
        return signedClosure(gap);
      })).not.toThrow();
      expect(() => applyContinuityGapClosure(second, () => signedClosure(gap, {
        disposition: 'declined',
      }))).toThrow(expect.objectContaining({ kind: 'conflict' }));
      expect(closureCount(second)).toBe(1);
    } finally {
      first.close();
      second.close();
    }
  });
});
