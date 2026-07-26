import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  readContinuityGapHealth,
  recordContinuityGaps,
  type ContinuityGapObservation,
} from '../../src/core/continuity-gap-ledger.ts';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function observation(
  ordinal: number,
  classification: ContinuityGapObservation['classification'],
): ContinuityGapObservation {
  return {
    ordinal,
    classification,
    receiptFingerprint: digest(`receipt-${ordinal}`),
    destinationFingerprint: digest('destination'),
    manifestFingerprint: digest('manifest'),
    evidenceFingerprint: digest('evidence'),
  };
}

describe('continuity gap ledger', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records only unresolved external-history classifications and is idempotent', () => {
    const first = recordContinuityGaps(db.raw, [
      observation(1, 'absent'),
      observation(2, 'observed_not_admitted'),
      observation(3, 'ambiguous'),
    ]);
    const second = recordContinuityGaps(db.raw, [
      observation(1, 'absent'),
      observation(2, 'observed_not_admitted'),
      observation(3, 'ambiguous'),
    ]);

    expect(first).toEqual({
      created: 3,
      existing: 0,
      unresolved: 2,
      ambiguous: 1,
    });
    expect(second).toEqual({
      created: 0,
      existing: 3,
      unresolved: 2,
      ambiguous: 1,
    });
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count
      FROM recovery_plans
      WHERE actor = 'continuity_manifest_recorder'
    `).get()).toEqual({ count: 3 });
    expect(db.raw.prepare(`
      SELECT COUNT(*) AS count
      FROM recovery_runs
      WHERE trigger LIKE 'continuity_gap_%'
    `).get()).toEqual({ count: 3 });
  });

  it('stores fingerprints and bounded taxonomy without raw receipt material', () => {
    const privateValues = [
      'source-message-private',
      'destination-private',
      'manifest-private',
      'evidence-private',
    ];
    recordContinuityGaps(db.raw, [{
      ordinal: 1,
      classification: 'absent',
      receiptFingerprint: digest(privateValues[0]),
      destinationFingerprint: digest(privateValues[1]),
      manifestFingerprint: digest(privateValues[2]),
      evidenceFingerprint: digest(privateValues[3]),
    }]);

    const rows = db.raw.prepare(`
      SELECT plan_id, actor, summary, evidence_ref
      FROM recovery_plans
      WHERE actor = 'continuity_manifest_recorder'
    `).all();
    const serialized = JSON.stringify(rows);
    for (const value of privateValues) expect(serialized).not.toContain(value);
    expect(serialized).toContain('continuity-gap:v1:');
    expect(serialized).toContain('classification=absent');
  });

  it('reports content-free health counts and fails closed on malformed ledger rows', () => {
    recordContinuityGaps(db.raw, [
      observation(1, 'absent'),
      observation(2, 'observed_not_admitted'),
      observation(3, 'ambiguous'),
    ]);

    expect(readContinuityGapHealth(db.raw)).toEqual({
      readable: true,
      open: 3,
      unresolved: 2,
      ambiguous: 1,
    });

    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES ('malformed', 'operator', 'continuity_manifest_recorder',
              'Continuity receipt requires reconciliation', 'invalid')
    `).run();
    db.raw.prepare(`
      INSERT INTO recovery_runs (trigger, recovery_plan_id, status)
      VALUES ('continuity_gap_absent', 'malformed', 'started')
    `).run();

    expect(() => readContinuityGapHealth(db.raw))
      .toThrow('continuity gap ledger contains malformed evidence');
  });

  it('fails closed when a continuity plan has no matching durable run', () => {
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES ('orphan', 'operator', 'continuity_manifest_recorder',
              'Continuity receipt requires reconciliation', 'invalid')
    `).run();

    expect(() => readContinuityGapHealth(db.raw))
      .toThrow('continuity gap ledger contains malformed state');
  });
});
