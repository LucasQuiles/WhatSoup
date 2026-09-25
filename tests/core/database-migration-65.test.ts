/**
 * Migration 65: the append-only `continuity_gap_closures` table. Closure is a
 * separate row keyed to the recorded continuity plan; the original plan and
 * its `started` run are never changed.
 */
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_MIGRATION,
  Database,
  DatabaseCompatibilityError,
} from '../../src/core/database.ts';
import { runMigration65 } from '../../src/core/database-migration-65.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  digest,
  gapObservation,
  insertClosureRow,
  recordGaps,
  signedClosure,
} from './_helpers/continuity-gap-closure.ts';

const tmp = trackTmpDirs('whatsoup-migration-65-');

function objectNames(raw: DatabaseSync, type: 'table' | 'trigger'): string[] {
  return (raw.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = ? AND (name = 'continuity_gap_closures' OR tbl_name = 'continuity_gap_closures')
    ORDER BY name
  `).all(type) as Array<{ name: string }>).map((row) => row.name);
}

function ledgerVersions(raw: DatabaseSync): number[] {
  return (raw.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>).map((row) => Number(row.version));
}

describe('migration 65 through the registry', () => {
  it('a fresh database opens at schema 65 with the closure table and its guards', () => {
    expect(CURRENT_SCHEMA_MIGRATION).toBe(65);
    const db = new Database(':memory:');
    db.open();
    try {
      const raw = db.raw;
      expect(ledgerVersions(raw)).toEqual(Array.from({ length: 65 }, (_, i) => i + 1));
      expect(objectNames(raw, 'table')).toEqual(['continuity_gap_closures']);
      expect(objectNames(raw, 'trigger')).toEqual([
        'continuity_gap_closures_append_only_delete',
        'continuity_gap_closures_append_only_update',
        'continuity_gap_closures_validate_insert',
      ]);
    } finally {
      db.close();
    }
  });

  it('upgrades a schema-64 file in place and preserves recorded continuity gaps', () => {
    const dir = tmp.make('upgrade');
    const dbPath = join(dir, 'bot.db');
    const first = new Database(dbPath);
    first.open();
    const planIds = recordGaps(first.raw, [
      gapObservation(1, 'absent'),
      gapObservation(2, 'ambiguous'),
    ]);
    // Emulate a schema-64 file: remove exactly what migration 65 adds.
    first.raw.exec('DROP TABLE continuity_gap_closures');
    first.raw.prepare('DELETE FROM schema_migrations WHERE version = 65').run();
    first.close();

    const upgraded = new Database(dbPath);
    upgraded.open();
    try {
      const raw = upgraded.raw;
      expect(ledgerVersions(raw)).toEqual(Array.from({ length: 65 }, (_, i) => i + 1));
      expect(objectNames(raw, 'table')).toEqual(['continuity_gap_closures']);
      const plans = (raw.prepare(`
        SELECT plan_id FROM recovery_plans WHERE actor = 'continuity_manifest_recorder'
        ORDER BY plan_id
      `).all() as Array<{ plan_id: string }>).map((row) => row.plan_id);
      expect(plans).toEqual([...planIds].sort());
      expect(raw.prepare(`
        SELECT COUNT(*) AS n FROM recovery_runs
        WHERE trigger LIKE 'continuity_gap_%' AND status = 'started' AND completed_at IS NULL
      `).get()).toEqual({ n: 2 });
    } finally {
      upgraded.close();
    }
  });

  it('a binary at the previous ceiling refuses the migrated file as future_schema', () => {
    // A schema-64 binary compares the ledger maximum with its own ceiling.
    // Recording one version above this binary's ceiling exercises the same
    // comparison a 64 binary performs against a 65 file.
    const dir = tmp.make('future');
    const dbPath = join(dir, 'bot.db');
    const db = new Database(dbPath);
    db.open();
    db.close();
    const copy = join(dir, 'copy.db');
    copyFileSync(dbPath, copy);
    const raw = new DatabaseSync(copy);
    raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(CURRENT_SCHEMA_MIGRATION + 1);
    raw.close();

    const newer = new Database(copy);
    let thrown: unknown;
    try {
      newer.open();
    } catch (error) {
      thrown = error;
    } finally {
      newer.close();
    }
    expect(thrown).toBeInstanceOf(DatabaseCompatibilityError);
    expect((thrown as DatabaseCompatibilityError).reason).toBe('future_schema');
  });
});

describe('continuity_gap_closures constraints', () => {
  let db: Database;
  let raw: DatabaseSync;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    raw = db.raw;
  });

  afterEach(() => db.close());

  it('re-runs idempotently', () => {
    runMigration65(raw);
    runMigration65(raw);
    expect(objectNames(raw, 'trigger')).toHaveLength(3);
  });

  it('accepts one valid closure per open continuity plan', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    insertClosureRow(raw, signedClosure(gap));
    expect(raw.prepare('SELECT COUNT(*) AS n FROM continuity_gap_closures').get()).toEqual({ n: 1 });
    expect(() => insertClosureRow(raw, signedClosure(gap, { actor: 'operator:second' })))
      .toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it('rejects UPDATE and DELETE', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    insertClosureRow(raw, signedClosure(gap));
    expect(() => raw.prepare("UPDATE continuity_gap_closures SET actor = 'operator:other'").run())
      .toThrow(/append-only/);
    expect(() => raw.prepare('DELETE FROM continuity_gap_closures').run())
      .toThrow(/append-only/);
  });

  it('rejects a closure whose parent is not an open, recorder-owned continuity plan', () => {
    const gap = gapObservation(1, 'absent');
    // No recorded gap: the FK or the validation trigger must refuse it.
    expect(() => insertClosureRow(raw, signedClosure(gap))).toThrow();

    raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES (?, 'operator', 'other_recovery_owner', 'Unrelated recovery work', NULL)
    `).run(signedClosure(gap).planId);
    expect(() => insertClosureRow(raw, signedClosure(gap)))
      .toThrow(/not an open continuity gap/);
  });

  it('rejects a receipt fingerprint or classification that differs from the plan', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    expect(() => insertClosureRow(raw, signedClosure(gap, { receiptFingerprint: digest('other') })))
      .toThrow(/not an open continuity gap/);
    expect(() => insertClosureRow(raw, signedClosure(gap, {
      originalClassification: 'observed_not_admitted',
    }))).toThrow(/not an open continuity gap/);
  });

  it('enforces digest, disposition and proof-shape CHECKs', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    const bad: Array<Parameters<typeof signedClosure>[1]> = [
      { evidenceManifestSha256: 'short' },
      { proofSetSha256: 'A'.repeat(64) },
      { disposition: 'declined', proofKind: 'live_reissue' },
      { disposition: 'addressed', proofKind: 'owner_declined' },
      { terminalRecordId: null },
      { originalContentType: 'audio' },
      { originalContentType: 'audio', audioMediaSha256: digest('media') },
      { audioTranscriptSha256: digest('transcript') },
      { ambiguityResolutionSha256: digest('resolution') },
      { decisionRecordSha256: digest('decision') },
      { policySha256: digest('policy') },
      { observedAt: '2026-09-25 00:10:00' },
      { decidedAt: '2026-09-25T00:20:00.000Z' },
      { actor: ' ' },
    ];
    for (const overrides of bad) {
      expect(() => insertClosureRow(raw, signedClosure(gap, overrides)), JSON.stringify(overrides))
        .toThrow(/CHECK/i);
    }
    insertClosureRow(raw, signedClosure(gap, {
      originalContentType: 'audio',
      audioMediaSha256: digest('media'),
      audioTranscriptSha256: digest('transcript'),
    }));
  });

  it('shapes a declined closure: policy and decision required, no transcript or terminal', () => {
    const gap = gapObservation(1, 'absent');
    recordGaps(raw, [gap]);
    const declined = { disposition: 'declined' as const };
    for (const overrides of [
      { ...declined, policySha256: null },
      { ...declined, policyVersion: null },
      { ...declined, decisionRecordSha256: null },
      { ...declined, decisionSource: null },
      { ...declined, terminalRecordId: 1 },
      { ...declined, originalContentType: 'audio', audioTranscriptSha256: digest('t') },
    ]) {
      expect(() => insertClosureRow(raw, signedClosure(gap, overrides)), JSON.stringify(overrides))
        .toThrow(/CHECK/i);
    }
    // A decline may bind the original media identity without any transcript.
    insertClosureRow(raw, signedClosure(gap, {
      ...declined,
      originalContentType: 'audio',
      audioMediaSha256: digest('media'),
    }));
  });

  it('requires an ambiguity resolution exactly for originally ambiguous gaps', () => {
    const gap = gapObservation(1, 'ambiguous');
    recordGaps(raw, [gap]);
    expect(() => insertClosureRow(raw, signedClosure(gap, { ambiguityResolutionSha256: null })))
      .toThrow(/CHECK/i);
    insertClosureRow(raw, signedClosure(gap));
  });
});
