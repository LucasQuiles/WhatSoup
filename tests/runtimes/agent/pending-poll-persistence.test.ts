import { describe, expect, it } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { PendingPollPersistence } from '../../../src/runtimes/agent/pending-poll-persistence.ts';

/**
 * PendingPollPersistence characterization.
 *
 * Covers the swallowed-error counter (pre-car baseline) AND the CAR-20 (#2539)
 * current-vs-historical failure surface: a failure marks degraded=true with a
 * streak; a subsequent success marks a recovery (lastRecoveredAt / totalRecoveries)
 * and clears degraded. The bare `errors` counter is preserved for back-compat.
 */
describe('PendingPollPersistence', () => {
  it('increments errors when loadRows cannot read pending_polls', () => {
    const db = {
      raw: {
        prepare: () => {
          throw new Error('select failed');
        },
      },
    } as unknown as Database;

    const persistence = new PendingPollPersistence(db);

    expect(persistence.loadRows()).toEqual([]);
    expect(persistence.errors).toBe(1);
  });

  describe('CAR-20 (#2539): current-vs-historical failure surface', () => {
    it('reports a healthy baseline (no failures, no recoveries)', () => {
      const db = {
        raw: { prepare: () => { throw new Error('unused'); } },
      } as unknown as Database;
      const persistence = new PendingPollPersistence(db);
      expect(persistence.healthDetails()).toEqual({
        errors: 0,
        degraded: false,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastFailureErr: null,
        lastRecoveredAt: null,
        totalRecoveries: 0,
      });
    });

    it('marks degraded=true on a failure and exposes the streak + sanitized error', () => {
      const db = {
        raw: { prepare: () => { throw new Error('boom'); } },
      } as unknown as Database;
      const persistence = new PendingPollPersistence(db);

      persistence.remove('k1'); // fails
      persistence.remove('k2'); // fails again — streak grows

      const health = persistence.healthDetails();
      expect(health.errors).toBe(2);            // cumulative (back-compat)
      expect(health.degraded).toBe(true);        // CURRENT active failure
      expect(health.consecutiveFailures).toBe(2);
      expect(health.lastFailureAt).not.toBeNull();
      expect(health.lastFailureErr).toBe('boom');
      expect(health.totalRecoveries).toBe(0);    // not yet recovered
      // decisive terminal pin of the full current-vs-historical shape
      expect(health).toEqual({
        errors: 2,
        degraded: true,
        consecutiveFailures: 2,
        lastFailureAt: expect.any(Number),
        lastFailureErr: 'boom',
        totalRecoveries: 0,
        lastRecoveredAt: null,
      });
    });

    it('records a recovery (historical) on the first success after a failure streak', () => {
      let shouldFail = true;
      const db = {
        raw: {
          prepare: () => {
            if (shouldFail) throw new Error('transient');
            return { run: () => {} };
          },
        },
      } as unknown as Database;
      const persistence = new PendingPollPersistence(db);

      persistence.remove('k1'); // fail (streak=1)
      expect(persistence.healthDetails().degraded).toBe(true);

      shouldFail = false;
      persistence.remove('k2'); // success → recovery
      const health = persistence.healthDetails();

      // [DISCRIMINATING: fails if degradation surface removed] current vs historical:
      expect(health.degraded).toBe(false);            // recovered → no current failure
      expect(health.consecutiveFailures).toBe(0);     // streak cleared
      expect(health.totalRecoveries).toBe(1);         // one historical recovery
      expect(health.lastRecoveredAt).not.toBeNull();
      expect(health.errors).toBe(1);                  // cumulative counter unchanged by the recovery
    });

    it('truncates a long error message to a bounded, log-safe string', () => {
      const longMsg = 'x'.repeat(500);
      const db = {
        raw: { prepare: () => { throw new Error(longMsg); } },
      } as unknown as Database;
      const persistence = new PendingPollPersistence(db);
      persistence.remove('k');
      const err = persistence.healthDetails().lastFailureErr ?? '';
      expect(err.length).toBeLessThanOrEqual(200);
      expect(err.endsWith('...')).toBe(true);
    });

    it('does not accumulate a recovery on success-when-already-healthy (real DB)', () => {
      const db = new Database(':memory:');
      db.open();
      db.raw.exec(`
        CREATE TABLE IF NOT EXISTS pending_polls (
          map_key TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, tool_id TEXT NOT NULL,
          source TEXT NOT NULL, resolution TEXT NOT NULL, payload TEXT NOT NULL,
          created_at INTEGER NOT NULL, closes_at INTEGER, hard_closes_at INTEGER
        );
      `);
      const persistence = new PendingPollPersistence(db);
      // Two consecutive successes with no prior failure:
      persistence.remove('never-existed-1');
      persistence.remove('never-existed-2');
      const health = persistence.healthDetails();
      expect(health.totalRecoveries).toBe(0);
      expect(health.degraded).toBe(false);
    });
  });
});
