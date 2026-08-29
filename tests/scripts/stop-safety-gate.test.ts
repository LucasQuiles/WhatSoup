// Pre-STOP safety gate (2026-08-29 q DM loss). The existing restart-safety
// preflight is an ExecStart gate: the launch wrapper runs it when the service
// STARTS. Systemd order on 2026-08-29 proves it cannot protect in-flight work —
// 00:30:41 Stopping, 00:30:42 Started, 00:30:44 preflight verdict. By the time
// it spoke, three journaled turns (two owner DMs) had already been finalized
// `failed` by the shutdown, with no replay.
//
// This gate answers the OTHER question — "is it safe to stop right now?" — for
// callers that issue the stop (deploy scripts, operators, agents deploying
// their own runtime). It is deliberately a separate entry point: making the
// START gate stricter would only refuse to start, leaving an instance DOWN.
//
// The predicate is recency-scoped ON PURPOSE. q currently holds 11 wedged
// `processing` rows from 2026-07-13..08-12; a bare `processing > 0` block would
// mean the instance could never be restarted again — including the restart that
// clears a wedge. Liveness uses the SAME 15-minute threshold the reply-guarantee
// observer already uses to call an open inbound stale (DEFAULT_STALE_SECONDS),
// read from the other side: within the window is live work, beyond it is debt.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIVE_TURN_WINDOW_SECONDS,
  inspectStopSafety,
  runRestartSafetyPreflightCli,
} from '../../scripts/restart-safety-preflight.ts';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-stop-safety-'));
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

/** Insert one inbound row `agoSeconds` in the past. */
function insertInbound(db: DatabaseSync, status: string, agoSeconds: number): void {
  db.prepare(`
    INSERT INTO inbound_events (processing_status, received_at)
    VALUES (?, datetime('now', ?))
  `).run(status, `-${agoSeconds} seconds`);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('stop-safety gate', () => {
  it('allows a stop when nothing is in flight', () => {
    const { dbPath, db } = createFixtureDb();
    db.close();

    const verdict = inspectStopSafety(dbPath);

    expect(verdict.decision).toBe('allow');
    expect(verdict.reason).toBe('stop_safe');
    expect(verdict.ok).toBe(true);
    expect(verdict.liveTurns.inFlight).toBe(0);
  });

  it('BLOCKS a stop while a turn received inside the window is still open', () => {
    const { dbPath, db } = createFixtureDb();
    // The shape that cost the owner two DMs: journaled, still processing,
    // ~6 minutes old when the restart landed.
    insertInbound(db, 'processing', 377);
    db.close();

    const verdict = inspectStopSafety(dbPath);

    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('live_turns_in_flight');
    expect(verdict.ok).toBe(false);
    expect(verdict.liveTurns.inFlight).toBe(1);
    expect(verdict.liveTurns.staleIgnored).toBe(0);
  });

  it('does NOT block on stale wedged rows — a wedged instance stays restartable', () => {
    const { dbPath, db } = createFixtureDb();
    // q's real debt: 11 `processing` rows from weeks ago. Blocking on these
    // would make the wedge unrecoverable by restart.
    for (const ago of [86_400, 172_800, 1_209_600]) insertInbound(db, 'processing', ago);
    db.close();

    const verdict = inspectStopSafety(dbPath);

    expect(verdict.decision).toBe('allow');
    expect(verdict.reason).toBe('stop_safe');
    expect(verdict.liveTurns.inFlight).toBe(0);
    expect(verdict.liveTurns.staleIgnored).toBe(3);
  });

  it('counts every open disposition as live, not just processing', () => {
    const { dbPath, db } = createFixtureDb();
    insertInbound(db, 'pending', 10);
    insertInbound(db, 'turn_done', 20);
    insertInbound(db, 'complete', 30);
    insertInbound(db, 'failed', 40);
    db.close();

    const verdict = inspectStopSafety(dbPath);

    expect(verdict.liveTurns.inFlight).toBe(2);
    expect(verdict.decision).toBe('block');
  });

  it('reports the window it applied so a receipt can record the predicate', () => {
    const { dbPath, db } = createFixtureDb();
    db.close();

    expect(inspectStopSafety(dbPath).liveTurns.windowSeconds).toBe(LIVE_TURN_WINDOW_SECONDS);
    expect(inspectStopSafety(dbPath, { liveWindowSeconds: 60 }).liveTurns.windowSeconds).toBe(60);
  });

  it('honours a custom window on both sides of the boundary', () => {
    const { dbPath, db } = createFixtureDb();
    insertInbound(db, 'processing', 120);
    db.close();

    expect(inspectStopSafety(dbPath, { liveWindowSeconds: 300 }).decision).toBe('block');
    expect(inspectStopSafety(dbPath, { liveWindowSeconds: 60 }).decision).toBe('allow');
  });

  it('treats a missing database as safe to stop (nothing can be in flight)', () => {
    const verdict = inspectStopSafety(path.join(makeTempRoot(), 'absent.db'));

    expect(verdict.decision).toBe('allow');
    expect(verdict.reason).toBe('missing_database');
    expect(verdict.quickCheck).toBe('not_applicable');
  });
});

describe('stop-safety CLI', () => {
  it('--mode stop exits 3 and emits the verdict when a turn is live', () => {
    const { dbPath, db } = createFixtureDb();
    insertInbound(db, 'processing', 30);
    db.close();
    let out = '';

    const code = runRestartSafetyPreflightCli(
      ['--db', dbPath, '--json', '--mode', 'stop'],
      (chunk) => { out += chunk; },
    );

    expect(code).toBe(3);
    const verdict = JSON.parse(out) as { decision: string; reason: string };
    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('live_turns_in_flight');
  });

  it('--mode stop exits 0 on a quiet instance', () => {
    const { dbPath, db } = createFixtureDb();
    db.close();
    let out = '';

    expect(runRestartSafetyPreflightCli(
      ['--db', dbPath, '--json', '--mode', 'stop'],
      (chunk) => { out += chunk; },
    )).toBe(0);
    expect((JSON.parse(out) as { decision: string }).decision).toBe('allow');
  });

  it('defaults to the START gate so the launch wrapper is unchanged', () => {
    const { dbPath, db } = createFixtureDb();
    // Live turn: would block a STOP, must NOT block a START.
    insertInbound(db, 'processing', 30);
    db.close();
    let bare = '';
    let explicit = '';

    const bareCode = runRestartSafetyPreflightCli(
      ['--db', dbPath, '--json'],
      (chunk) => { bare += chunk; },
    );
    const explicitCode = runRestartSafetyPreflightCli(
      ['--db', dbPath, '--json', '--mode', 'start'],
      (chunk) => { explicit += chunk; },
    );

    expect(bareCode).toBe(0);
    expect(bareCode).toBe(explicitCode);
    expect(bare).toBe(explicit);
    expect((JSON.parse(bare) as { decision: string }).decision).toBe('allow');
  });

  it('rejects an unknown mode rather than silently choosing one', () => {
    const { dbPath, db } = createFixtureDb();
    db.close();

    expect(() => runRestartSafetyPreflightCli(
      ['--db', dbPath, '--json', '--mode', 'sideways'],
      () => {},
    )).toThrow(/mode/);
  });

  it('rejects a duplicate --mode', () => {
    const { dbPath, db } = createFixtureDb();
    db.close();

    expect(() => runRestartSafetyPreflightCli(
      ['--db', dbPath, '--json', '--mode', 'stop', '--mode', 'stop'],
      () => {},
    )).toThrow(/Duplicate argument: --mode/);
  });
});
