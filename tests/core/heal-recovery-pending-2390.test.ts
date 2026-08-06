/**
 * Tests for #2390: contributorRecoveryPending flag prevents stale auto-close.
 *
 * fails-before:  reconcileStaleHealReports auto-closes recovery-pending incidents
 *                (no fresh source events) — age > stale threshold closes them.
 * passes-after:  contributorRecoveryPending in context prevents stale close —
 *                incident stays open until explicit recovery clear.
 * no-regression: Normal (non-pending) reports still auto-close when stale.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';

import {
  type HealReportRow,
  reconcileStaleHealReports,
} from '../../src/core/heal.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  // Create the heal_reports table for this test
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS heal_reports (
      report_id TEXT PRIMARY KEY,
      error_class TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertRow(
  db: Database,
  overrides: Partial<HealReportRow> & { report_id: string; error_class: string },
): void {
  const context = overrides.context ?? '{}';
  db.raw
    .prepare(
      `INSERT INTO heal_reports (report_id, error_class, state, context, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.report_id,
      overrides.error_class,
      overrides.state ?? 'queued',
      context,
      overrides.created_at ?? new Date(0).toISOString(),
    );
}

describe('contributorRecoveryPending (#2390)', () => {
  it('skips stale close when contributorRecoveryPending is true', () => {
    const db = makeDb();

    // Insert a recovery-pending incident that IS older than the stale threshold
    insertRow(db, {
      report_id: 'recovery-pending-001',
      error_class: 'fallback_recovery_stalled',
      state: 'escalated',
      context: JSON.stringify({ contributorRecoveryPending: true }),
      created_at: new Date(Date.now() - 86_400_000).toISOString(), // 24h old
    });

    // Insert a normal incident that is also old
    insertRow(db, {
      report_id: 'normal-001',
      error_class: 'some_error',
      state: 'escalated',
      context: '{}',
      created_at: new Date(Date.now() - 86_400_000).toISOString(), // 24h old
    });

    const result = reconcileStaleHealReports(db, {
      staleMs: 3_600_000, // 1 hour
    });

    // The normal incident should be expired
    expect(result.expiredReportIds).toContain('normal-001');

    // The recovery-pending incident should NOT be expired
    expect(result.expiredReportIds).not.toContain('recovery-pending-001');

    // Verify DB state matches
    const pendingRow = db.raw
      .prepare("SELECT state FROM heal_reports WHERE report_id = 'recovery-pending-001'")
      .get() as { state: string };
    expect(pendingRow.state).toBe('escalated'); // NOT stale_expired

    const normalRow = db.raw
      .prepare("SELECT state FROM heal_reports WHERE report_id = 'normal-001'")
      .get() as { state: string };
    expect(normalRow.state).toBe('stale_expired');
  });

  it('does not skip stale close when contributorRecoveryPending is false', () => {
    const db = makeDb();

    insertRow(db, {
      report_id: 'pending-false-001',
      error_class: 'some_error',
      state: 'escalated',
      context: JSON.stringify({ contributorRecoveryPending: false }),
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const result = reconcileStaleHealReports(db, { staleMs: 3_600_000 });
    expect(result.expiredReportIds).toContain('pending-false-001');
  });

  it('does not skip stale close when context has no contributorRecoveryPending field', () => {
    const db = makeDb();

    insertRow(db, {
      report_id: 'no-flag-001',
      error_class: 'some_error',
      state: 'escalated',
      context: '{"other": "data"}',
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const result = reconcileStaleHealReports(db, { staleMs: 3_600_000 });
    expect(result.expiredReportIds).toContain('no-flag-001');
  });

  it('does not skip stale close when context is empty', () => {
    const db = makeDb();

    insertRow(db, {
      report_id: 'empty-ctx-001',
      error_class: 'some_error',
      state: 'escalated',
      context: '',
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const result = reconcileStaleHealReports(db, { staleMs: 3_600_000 });
    expect(result.expiredReportIds).toContain('empty-ctx-001');
  });
});
