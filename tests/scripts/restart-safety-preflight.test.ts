import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectRestartSafety,
  runRestartSafetyPreflightCli,
} from '../../scripts/restart-safety-preflight.ts';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-restart-safety-'));
  tempRoots.push(root);
  return root;
}

function createFixtureDb(): { dbPath: string; db: DatabaseSync } {
  const dbPath = path.join(makeTempRoot(), 'bot.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE inbound_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      processing_status TEXT NOT NULL DEFAULT 'pending',
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE outbound_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'pending',
      replay_policy TEXT NOT NULL DEFAULT 'unsafe',
      is_terminal INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { dbPath, db };
}

function insertOutbound(
  db: DatabaseSync,
  status: string,
  replayPolicy: string,
  isTerminal: number,
  createdAt = '2026-01-01 00:00:00',
): void {
  db.prepare(`
    INSERT INTO outbound_ops (status, replay_policy, is_terminal, created_at)
    VALUES (?, ?, ?, ?)
  `).run(status, replayPolicy, isTerminal, createdAt);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('restart-safety preflight', () => {
  it('allows an empty canonical database and emits no path or payload data', () => {
    const { dbPath, db } = createFixtureDb();
    db.close();

    const verdict = inspectRestartSafety(dbPath);

    expect(verdict).toEqual({
      schemaVersion: 1,
      ok: true,
      decision: 'allow',
      reason: 'restart_safe',
      quickCheck: 'ok',
      outbound: {
        maxId: 0,
        safeNonterminal: 0,
        unsafeNonterminal: 0,
        unknownStatus: 0,
        unknownReplayPolicy: 0,
      },
      inbound: {
        processing: 0,
        recent: 0,
      },
    });
    expect(JSON.stringify(verdict)).not.toContain(dbPath);
  });

  it.each([
    ['historical safe', 'safe', '2026-01-01 00:00:00'],
    ['recent safe', 'safe', new Date().toISOString().replace('T', ' ').slice(0, 19)],
    ['historical read-only', 'read_only', '2026-01-01 00:00:00'],
  ])('blocks %s replay-safe nonterminal work regardless of age', (_label, replayPolicy, createdAt) => {
    const { dbPath, db } = createFixtureDb();
    insertOutbound(db, 'maybe_sent', replayPolicy, 0, createdAt);
    db.close();

    expect(inspectRestartSafety(dbPath)).toMatchObject({
      ok: false,
      decision: 'block',
      reason: 'safe_nonterminal_outbound',
      outbound: { safeNonterminal: 1 },
    });
  });

  it.each(['echoed', 'failed_permanent', 'quarantined', 'cancelled'])(
    'allows terminal replay-safe status %s',
    (status) => {
      const { dbPath, db } = createFixtureDb();
      insertOutbound(db, status, 'safe', 1);
      db.close();

      expect(inspectRestartSafety(dbPath)).toMatchObject({
        ok: true,
        decision: 'allow',
        outbound: { safeNonterminal: 0 },
      });
    },
  );

  it('reports unsafe maybe-sent debt without authorizing replay', () => {
    const { dbPath, db } = createFixtureDb();
    insertOutbound(db, 'maybe_sent', 'unsafe', 1);
    db.close();

    expect(inspectRestartSafety(dbPath)).toMatchObject({
      ok: true,
      decision: 'allow',
      reason: 'restart_safe_with_unsafe_debt',
      outbound: { safeNonterminal: 0, unsafeNonterminal: 1 },
    });
  });

  it.each([
    ['unknown status', 'future_status', 'unsafe'],
    ['unknown replay policy', 'echoed', 'future_policy'],
  ])('blocks %s', (_label, status, replayPolicy) => {
    const { dbPath, db } = createFixtureDb();
    insertOutbound(db, status, replayPolicy, 1);
    db.close();

    expect(inspectRestartSafety(dbPath)).toMatchObject({
      ok: false,
      decision: 'block',
      reason: 'unknown_outbound_state',
    });
  });

  it('reports processing and recent inbound counts without identifiers', () => {
    const { dbPath, db } = createFixtureDb();
    db.exec(`
      INSERT INTO inbound_events (processing_status, received_at)
      VALUES ('processing', datetime('now'));
      INSERT INTO inbound_events (processing_status, received_at)
      VALUES ('complete', datetime('now'));
    `);
    db.close();

    expect(inspectRestartSafety(dbPath)).toMatchObject({
      inbound: { processing: 1, recent: 2 },
    });
  });

  it('fails closed for a missing, malformed, or incomplete database', () => {
    const missing = path.join(makeTempRoot(), 'missing.db');
    expect(() => inspectRestartSafety(missing)).toThrow(/existing regular file/i);

    const malformed = path.join(makeTempRoot(), 'malformed.db');
    writeFileSync(malformed, 'not sqlite', 'utf8');
    expect(() => inspectRestartSafety(malformed)).toThrow();

    const incomplete = path.join(makeTempRoot(), 'incomplete.db');
    const db = new DatabaseSync(incomplete);
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    db.close();
    expect(() => inspectRestartSafety(incomplete)).toThrow(/requires table/i);
  });

  it('returns the fail-closed CLI exit code and JSON verdict for blocked work', () => {
    const { dbPath, db } = createFixtureDb();
    insertOutbound(db, 'pending', 'safe', 0);
    db.close();
    let output = '';

    const exitCode = runRestartSafetyPreflightCli(
      ['--db', dbPath, '--json'],
      (chunk) => { output += chunk; },
    );

    expect(exitCode).toBe(3);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      decision: 'block',
      reason: 'safe_nonterminal_outbound',
    });
  });

  it('allows a missing database only with a matching private first-start marker', () => {
    const root = makeTempRoot();
    const dbPath = path.join(root, 'bot.db');
    const markerPath = path.join(root, '.initial-database-create-approved');
    writeFileSync(markerPath, 'new-bot\n', { mode: 0o600 });
    let output = '';

    const exitCode = runRestartSafetyPreflightCli(
      [
        '--db', dbPath,
        '--instance', 'new-bot',
        '--initial-marker', markerPath,
        '--json',
      ],
      (chunk) => { output += chunk; },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      ok: true,
      decision: 'allow',
      reason: 'initial_database_create',
      quickCheck: 'not_applicable',
      outbound: {
        maxId: 0,
        safeNonterminal: 0,
        unsafeNonterminal: 0,
        unknownStatus: 0,
        unknownReplayPolicy: 0,
      },
      inbound: { processing: 0, recent: 0 },
    });
  });

  it.each(['missing', 'wrong-instance', 'world-readable', 'symlink'])(
    'blocks a missing database when the first-start marker is %s',
    (variant) => {
      const root = makeTempRoot();
      const dbPath = path.join(root, 'bot.db');
      const markerPath = path.join(root, '.initial-database-create-approved');
      if (variant === 'wrong-instance') {
        writeFileSync(markerPath, 'another-bot\n', { mode: 0o600 });
      } else if (variant === 'world-readable') {
        writeFileSync(markerPath, 'new-bot\n', { mode: 0o644 });
      } else if (variant === 'symlink') {
        const target = path.join(root, 'marker-target');
        writeFileSync(target, 'new-bot\n', { mode: 0o600 });
        symlinkSync(target, markerPath);
      }
      let output = '';

      const exitCode = runRestartSafetyPreflightCli(
        [
          '--db', dbPath,
          '--instance', 'new-bot',
          '--initial-marker', markerPath,
          '--json',
        ],
        (chunk) => { output += chunk; },
      );

      expect(exitCode).toBe(3);
      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        decision: 'block',
        reason: 'missing_database',
      });
    },
  );
});
