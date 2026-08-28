import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

const SCRIPT = 'deploy/scripts/whatsoup-db-snapshot.py';

function runTool(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('python3', [SCRIPT, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function makeFixtureDb(dbPath: string): void {
  execFileSync('python3', ['-c', `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE messages (pk INTEGER PRIMARY KEY, body TEXT)")
conn.execute("CREATE TABLE inbound_events (seq INTEGER PRIMARY KEY, processing_status TEXT)")
for i in range(3):
    conn.execute("INSERT INTO messages (body) VALUES (?)", (f"m{i}",))
for i in range(2):
    conn.execute("INSERT INTO inbound_events (processing_status) VALUES ('complete')")
conn.commit()
conn.close()
`, dbPath], { cwd: process.cwd(), encoding: 'utf8' });
}

describe('whatsoup-db-snapshot (FLOS Stage 0 S0.4)', () => {
  it('creates a coherent snapshot with an integrity and row-count receipt at mode 0600', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-db-snapshot-'));
    const db = join(tmpRoot, 'bot.db');
    makeFixtureDb(db);

    const receipt = JSON.parse(runTool(
      ['snapshot', '--db', db, '--out-root', join(tmpRoot, 'snaps')],
      { BOT_ERRORS_DRY_NOW: '1787900000' },
    )) as { snapshot: string; integrity: string; tables: Record<string, number> };

    expect(receipt.integrity).toBe('ok');
    expect(receipt.tables).toEqual({ inbound_events: 2, messages: 3 });
    const snapshotPath = join(tmpRoot, 'snaps', receipt.snapshot);
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
  });

  it('restore rehearsal round-trips the row counts', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-db-snapshot-'));
    const db = join(tmpRoot, 'bot.db');
    makeFixtureDb(db);
    const snapReceipt = JSON.parse(runTool(
      ['snapshot', '--db', db, '--out-root', join(tmpRoot, 'snaps')],
      { BOT_ERRORS_DRY_NOW: '1787900000' },
    )) as { snapshot: string; tables: Record<string, number> };

    const rehearsal = JSON.parse(runTool(
      ['rehearse', '--snapshot', join(tmpRoot, 'snaps', snapReceipt.snapshot)],
    )) as { integrity: string; tables: Record<string, number> };

    expect(rehearsal.integrity).toBe('ok');
    expect(rehearsal.tables).toEqual(snapReceipt.tables);
    expect(rehearsal.tables).toEqual({ inbound_events: 2, messages: 3 });
  });

  it('prunes old snapshots beyond the retention count', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-db-snapshot-'));
    const db = join(tmpRoot, 'bot.db');
    makeFixtureDb(db);
    const snaps = join(tmpRoot, 'snaps');
    let lastReceipt: { pruned: string[] } | null = null;
    for (const epoch of ['1787900000', '1787900100', '1787900200']) {
      lastReceipt = JSON.parse(runTool(['snapshot', '--db', db, '--out-root', snaps, '--retain', '2'], {
        BOT_ERRORS_DRY_NOW: epoch,
      })) as { pruned: string[] };
    }

    expect(lastReceipt!.pruned).toHaveLength(1);
    const remaining = readdirSync(snaps).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain(lastReceipt!.pruned[0]);
  });

  it('rehearsal fails on a corrupted snapshot', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-db-snapshot-'));
    const garbage = join(tmpRoot, 'broken.snapshot.sqlite3');
    writeFileSync(garbage, 'SQLite format 3\0garbage-not-a-real-database');

    let status = 0;
    try {
      runTool(['rehearse', '--snapshot', garbage]);
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
    }
    expect(status).not.toBe(0);
  });
});
