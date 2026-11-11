import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { PendingPollPersistence } from '../../../src/runtimes/agent/pending-poll-persistence.ts';
import { deserializePendingPoll, type PendingPollQuestion } from '../../../src/runtimes/agent/poll-resolution.ts';

import type { SingletonLoggerMock } from '../../helpers/logger-mock.ts';

const logger = vi.hoisted(() => ({} as SingletonLoggerMock));
vi.mock('../../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../../helpers/logger-mock.ts');
  return hoistedLoggerMock(logger);
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('PendingPollPersistence unresolved records', () => {
  const databases: Database[] = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function openDatabase(path = ':memory:'): Database {
    const db = new Database(path);
    db.open();
    databases.push(db);
    return db;
  }

  function pendingPoll(): PendingPollQuestion {
    return {
      questions: [{ question: 'Choose', header: 'Test', options: [{ label: 'A', description: 'First' }], multiSelect: false }],
      toolId: 'tool', chatJid: 'test@g.us', chatJidAliases: new Set(['test@g.us']),
      mode: 'poll', pollMessageIdToQuestionIndex: new Map([['message', 0]]),
      currentQuestionIndex: 0, answersCollected: {}, createdAt: Date.now(),
      resolution: 'first-vote-wins', timeoutMs: 600_000,
      votesByQuestion: new Map(), adminJids: null, source: 'send_poll', sentPollMessageIds: ['message'],
    };
  }

  function retainFailedDelete(db: Database): PendingPollPersistence {
    const persistence = new PendingPollPersistence(db);
    const pending = pendingPoll();
    persistence.save('settled', pending);
    const row = persistence.loadRows()[0]!;
    expect(row.hard_closes_at).toBeGreaterThan(Date.now());
    expect(deserializePendingPoll(JSON.parse(row.payload)).resolvedAt).toBeUndefined();
    db.raw.exec(`CREATE TRIGGER reject_settled_delete BEFORE DELETE ON pending_polls
      WHEN OLD.map_key = 'settled' BEGIN SELECT RAISE(FAIL, 'simulated delete failure'); END`);
    persistence.remove('settled');
    return persistence;
  }

  it.each(['recover', 'exhaust', 'stop', 'replace', 'newer-row'] as const)(
    'awaited poll save: %s settles without releasing an undurable answer', async (outcome) => {
      const db = openDatabase();
      const persistence = new PendingPollPersistence(db);
      const pending = pendingPoll();
      persistence.save('waiting', pending);
      db.raw.exec("CREATE TRIGGER block_save BEFORE INSERT ON pending_polls BEGIN SELECT RAISE(FAIL, 'blocked'); END");
      pending.answersCollected = { 0: 'A' };
      let settled = false;
      const result = persistence.saveAndWait('waiting', pending).then((value) => { settled = true; return value; });
      await Promise.resolve();
      expect(settled).toBe(false);
      if (outcome === 'stop') persistence.stop();
      if (outcome !== 'exhaust') db.raw.exec('DROP TRIGGER block_save');
      if (outcome === 'replace') persistence.save('waiting', { ...pending, createdAt: pending.createdAt + 1, toolId: 'replacement' });
      if (outcome === 'newer-row') db.raw.prepare('UPDATE pending_polls SET created_at = ?, tool_id = ?').run(pending.createdAt + 1, 'replacement');
      await vi.advanceTimersByTimeAsync(outcome === 'exhaust' ? 180_000 : 5_000);
      expect(settled).toBe(true);
      expect((await result).durable).toBe(outcome === 'recover');
      expect(persistence.healthDetails().degraded).toBe(outcome === 'stop' || outcome === 'exhaust');
      if (outcome === 'exhaust') expect(persistence.healthDetails().retry).toMatchObject({ attempts: 5, exhausted: true });
      const row = db.raw.prepare('SELECT payload, tool_id FROM pending_polls WHERE map_key = ?').get('waiting')!;
      if (outcome === 'recover') expect(JSON.parse(row.payload as string).answersCollected).toEqual({ 0: 'A' });
      if (outcome === 'replace' || outcome === 'newer-row') expect(row.tool_id).toBe('replacement');
      persistence.stop();
    },
  );

  it('awaited poll save settles when serialization cannot create a retry', async () => {
    const persistence = new PendingPollPersistence(openDatabase());
    const pending = pendingPoll();
    pending.answersCollected = { 0: 1n as unknown as string };
    let settled = false;
    const result = persistence.saveAndWait('invalid', pending).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(true);
    expect((await result).durable).toBe(false);
    expect(persistence.healthDetails()).toMatchObject({ degraded: true, retry: { pending: false } });
    persistence.stop();
  });

  it('retains corrupt rows as unavailable until the same snapshot can be decoded', () => {
    const db = openDatabase();
    const persistence = new PendingPollPersistence(db);
    const pending = pendingPoll();
    persistence.save('corrupt', pending);
    db.raw.prepare('UPDATE pending_polls SET payload = ? WHERE map_key = ?').run('{private answer', 'corrupt');
    expect(persistence.readRows()).toEqual({ status: 'unavailable' });
    expect(persistence.healthDetails()).toMatchObject({ degraded: true, totalRecoveries: 0 });
    persistence.save('unrelated', pending);
    expect(persistence.healthDetails().degraded).toBe(true);
    expect(persistence.readRows()).toEqual({ status: 'unavailable' });
    expect(persistence.healthDetails().totalRecoveries).toBe(0);
    expect(db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get('corrupt')?.payload).toBe('{private answer');
    persistence.save('corrupt', pending);
    expect(persistence.healthDetails().degraded).toBe(true);
    expect(persistence.readRows().status).toBe('available');
    expect(persistence.healthDetails()).toMatchObject({ degraded: false, totalRecoveries: 1 });
    persistence.stop();
  });

  it.each(['save', 'remove'] as const)('a stale %s cannot cancel a newer pending write or its waiter', async (operation) => {
    const db = openDatabase();
    const persistence = new PendingPollPersistence(db);
    const current = pendingPoll();
    persistence.save('generation', current);
    db.raw.exec("CREATE TRIGGER block_generation BEFORE INSERT ON pending_polls BEGIN SELECT RAISE(FAIL, 'blocked'); END");
    current.answersCollected = { 0: 'A' };
    let settled = false;
    const result = persistence.saveAndWait('generation', current).then((value) => { settled = true; return value; });
    const stale = { ...current, createdAt: current.createdAt - 1, toolId: 'older' };
    persistence[operation]('generation', stale);
    await Promise.resolve();
    expect.soft(settled).toBe(false);
    expect.soft(persistence.healthDetails()).toMatchObject({ degraded: true, retry: { pending: true } });
    db.raw.exec('DROP TRIGGER block_generation');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
    expect(await result).toEqual({ status: 'confirmed', durable: true });
    expect(persistence.healthDetails().degraded).toBe(false);
    const row = db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get('generation')!;
    expect(JSON.parse(row.payload as string).answersCollected).toEqual({ 0: 'A' });
    persistence.stop();
  });

  it('does not expose poll content or identifiers in persistence failure diagnostics', () => {
    const secret = 'private answer private-user@s.whatsapp.net';
    const db = { raw: { prepare: () => { throw new Error(secret); } } } as unknown as Database;
    const persistence = new PendingPollPersistence(db);
    logger.error.mockClear();
    persistence.remove(secret);
    persistence.readRows();
    const observed = JSON.stringify({ health: persistence.healthDetails(), logs: logger.error.mock.calls });
    expect(observed).not.toContain(secret);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(persistence.healthDetails()).toMatchObject({ degraded: true, lastFailureErr: 'pending poll persistence failed' });
  });

  it('does not report recovery when a read succeeds but the failed deletion is unresolved', () => {
    const db = openDatabase();
    const persistence = retainFailedDelete(db);
    persistence.loadRows();

    expect(db.raw.prepare('SELECT count(*) AS n FROM pending_polls').get()?.n).toBe(1);
    expect(persistence.healthDetails().degraded).toBe(true);
    expect(persistence.healthDetails().totalRecoveries).toBe(0);
  });

  it('does not let an unrelated successful deletion clear a failed record', () => {
    const persistence = retainFailedDelete(openDatabase());
    persistence.remove('different-record');

    expect(persistence.healthDetails().degraded).toBe(true);
    expect(persistence.healthDetails().errors).toBe(1);
  });

  it('keeps a settled record out of rehydration after a failed delete and file-backed restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pending-poll-restart-'));
    directories.push(directory);
    const path = join(directory, 'bot.db');
    const db = openDatabase(path);
    retainFailedDelete(db);
    databases.splice(databases.indexOf(db), 1);
    db.close();

    const reopened = openDatabase(path);
    const restored = new PendingPollPersistence(reopened).loadRows();
    expect(restored).toEqual([]);
  });

  it('distinguishes an unavailable read from an empty database', () => {
    const db = openDatabase();
    const persistence = new PendingPollPersistence(db);
    expect(persistence.readRows()).toEqual({ status: 'available', rows: [] });
    db.raw.exec('DROP TABLE pending_polls');
    expect(persistence.readRows()).toEqual({ status: 'unavailable' });
    expect(persistence.healthDetails().degraded).toBe(true);
  });

  it('does not confirm terminal durability when both marking and deletion fail', () => {
    const db = openDatabase();
    const persistence = retainFailedDelete(db);
    db.raw.prepare('UPDATE pending_polls SET hard_closes_at = ?').run(Date.now() + 600_000);
    db.raw.exec("CREATE TRIGGER reject_marker BEFORE UPDATE ON pending_polls BEGIN SELECT RAISE(FAIL, 'simulated write failure'); END");

    expect(persistence.remove('settled')).toEqual({ status: 'pending', durable: false });
    expect(db.raw.prepare('SELECT hard_closes_at FROM pending_polls').get()?.hard_closes_at).toBeGreaterThan(Date.now());
  });

  it('distinguishes a durable terminal marker from completed cleanup', () => {
    const db = openDatabase();
    const persistence = retainFailedDelete(db);

    expect(persistence.remove('settled')).toEqual({ status: 'pending', durable: true });
    expect(persistence.healthDetails().degraded).toBe(true);
    expect(db.raw.prepare('SELECT hard_closes_at FROM pending_polls').get()?.hard_closes_at).toBe(0);
  });

  it('rejects a successful-looking delete whose row remains', () => {
    const db = openDatabase();
    const persistence = retainFailedDelete(db);
    db.raw.exec("DROP TRIGGER reject_settled_delete; CREATE TRIGGER ignore_delete BEFORE DELETE ON pending_polls BEGIN SELECT RAISE(IGNORE); END");

    expect(persistence.remove('settled')).toEqual({ status: 'pending', durable: true });
    expect(persistence.healthDetails().degraded).toBe(true);
    expect(db.raw.prepare('SELECT count(*) AS n FROM pending_polls').get()?.n).toBe(1);
  });

  it('records recovery only after the failed record is actually deleted', () => {
    const db = openDatabase();
    const persistence = retainFailedDelete(db);
    db.raw.exec('DROP TRIGGER reject_settled_delete');
    persistence.remove('settled');

    expect(db.raw.prepare('SELECT count(*) AS n FROM pending_polls').get()?.n).toBe(0);
    expect(persistence.healthDetails()).toMatchObject({ degraded: false, errors: 1, totalRecoveries: 1 });
  });

  it('retries terminal cleanup after a transient delete failure without another caller', () => {
    const db = openDatabase();
    const persistence = retainFailedDelete(db);
    db.raw.exec('DROP TRIGGER reject_settled_delete');

    vi.advanceTimersByTime(5_000);

    expect(db.raw.prepare('SELECT count(*) AS n FROM pending_polls').get()?.n).toBe(0);
    expect(persistence.healthDetails()).toMatchObject({ degraded: false, totalRecoveries: 1 });
  });

  it('preserves a newer generation when an old deletion is retried', () => {
    const db = openDatabase();
    const persistence = retainFailedDelete(db);
    db.raw.exec('DROP TRIGGER reject_settled_delete');
    const old = db.raw.prepare('SELECT created_at FROM pending_polls').get()!;
    db.raw.prepare('UPDATE pending_polls SET created_at = ?, tool_id = ?, hard_closes_at = ?')
      .run(Number(old.created_at) + 1, 'replacement', Date.now() + 600_000);

    vi.advanceTimersByTime(5_000);

    expect(db.raw.prepare('SELECT tool_id FROM pending_polls').get()?.tool_id).toBe('replacement');
    expect(persistence.healthDetails().degraded).toBe(false);
  });

  it('bounds retries and retains unresolved health after exhaustion', () => {
    const persistence = retainFailedDelete(openDatabase());
    vi.advanceTimersByTime(300_000);
    expect(persistence.healthDetails()).toMatchObject({
      degraded: true, retry: { attempts: 5, exhausted: true, pending: false },
    });
    const failures = persistence.errors;
    vi.advanceTimersByTime(300_000);
    expect(persistence.errors).toBe(failures);
  });

  it('cancels retries on shutdown without clearing unresolved health', () => {
    const db = openDatabase();
    const persistence = retainFailedDelete(db);
    persistence.stop();
    db.raw.exec('DROP TRIGGER reject_settled_delete');
    vi.advanceTimersByTime(300_000);
    expect(db.raw.prepare('SELECT count(*) AS n FROM pending_polls').get()?.n).toBe(1);
    expect(persistence.healthDetails()).toMatchObject({ degraded: true, retry: { pending: false, attempts: 0 } });
  });

  it('discovers and retries terminal cleanup after reopening the database', () => {
    const db = openDatabase();
    const first = retainFailedDelete(db);
    first.stop();
    const restarted = new PendingPollPersistence(db);
    expect(restarted.readRows()).toEqual({ status: 'available', rows: [] });
    db.raw.exec('DROP TRIGGER reject_settled_delete');
    vi.advanceTimersByTime(5_000);
    expect(db.raw.prepare('SELECT count(*) AS n FROM pending_polls').get()?.n).toBe(0);
    expect(restarted.healthDetails().degraded).toBe(false);
  });
});

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
        retry: { pending: false, attempts: 0, exhausted: false, nextRetryAt: null },
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
      expect(health.lastFailureErr).toBe('pending poll persistence failed');
      expect(health.totalRecoveries).toBe(0);    // not yet recovered
      // decisive terminal pin of the full current-vs-historical shape
      expect(health).toEqual({
        errors: 2,
        degraded: true,
        consecutiveFailures: 2,
        lastFailureAt: expect.any(Number),
        lastFailureErr: 'pending poll persistence failed',
        totalRecoveries: 0,
        lastRecoveredAt: null,
        retry: { pending: false, attempts: 0, exhausted: false, nextRetryAt: null },
      });
    });

    it('records recovery after verifying the same failed record', () => {
      let shouldFail = true;
      const db = {
        raw: {
          prepare: () => {
            if (shouldFail) throw new Error('transient');
            return { run: () => {}, get: () => undefined };
          },
        },
      } as unknown as Database;
      const persistence = new PendingPollPersistence(db);

      persistence.remove('k1'); // fail (streak=1)
      expect(persistence.healthDetails().degraded).toBe(true);

      shouldFail = false;
      persistence.remove('k1'); // verified deletion of the failed record → recovery
      const health = persistence.healthDetails();

      // [DISCRIMINATING: fails if degradation surface removed] current vs historical:
      expect(health.degraded).toBe(false);            // recovered → no current failure
      expect(health.consecutiveFailures).toBe(0);     // streak cleared
      expect(health.totalRecoveries).toBe(1);         // one historical recovery
      expect(health.lastRecoveredAt).not.toBeNull();
      expect(health.errors).toBe(1);                  // cumulative counter unchanged by the recovery
    });

    it('replaces arbitrary error text with a fixed diagnostic', () => {
      const longMsg = 'x'.repeat(500);
      const db = {
        raw: { prepare: () => { throw new Error(longMsg); } },
      } as unknown as Database;
      const persistence = new PendingPollPersistence(db);
      persistence.remove('k');
      const err = persistence.healthDetails().lastFailureErr ?? '';
      expect(err).toBe('pending poll persistence failed');
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
