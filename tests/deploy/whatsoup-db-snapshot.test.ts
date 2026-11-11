import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';
let liveWriter: DatabaseSync | null = null;

afterEach(() => {
  liveWriter?.close();
  liveWriter = null;
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

  describe('live WAL source (writer connection held open)', () => {
    // A production instance database runs in WAL mode with the runtime's
    // connection open, so committed rows sit in the -wal file and the source
    // has -wal and -shm sidecars while the snapshot runs.
    function liveWalSnapshot(): { snaps: string; snapshot: string; tables: Record<string, number> } {
      tmpRoot = mkdtempSync(join(tmpdir(), 'whatsoup-db-snapshot-'));
      const db = join(tmpRoot, 'bot.db');
      liveWriter = new DatabaseSync(db);
      liveWriter.exec('PRAGMA journal_mode=WAL');
      liveWriter.exec('CREATE TABLE messages (pk INTEGER PRIMARY KEY, body TEXT)');
      liveWriter.exec('CREATE TABLE inbound_events (seq INTEGER PRIMARY KEY, processing_status TEXT)');
      for (let i = 0; i < 3; i++) liveWriter.prepare('INSERT INTO messages (body) VALUES (?)').run(`m${i}`);
      for (let i = 0; i < 2; i++) liveWriter.exec("INSERT INTO inbound_events (processing_status) VALUES ('complete')");
      expect(readdirSync(tmpRoot).sort()).toEqual(['bot.db', 'bot.db-shm', 'bot.db-wal']);
      const snaps = join(tmpRoot, 'snaps');
      const receipt = JSON.parse(runTool(
        ['snapshot', '--db', db, '--out-root', snaps],
        { BOT_ERRORS_DRY_NOW: '1787900000' },
      )) as { snapshot: string; integrity: string; tables: Record<string, number> };
      expect(receipt.integrity).toBe('ok');
      expect(receipt.tables).toEqual({ inbound_events: 2, messages: 3 });
      return { snaps, snapshot: receipt.snapshot, tables: receipt.tables };
    }

    it('restore rehearsal of the snapshot exits 0 with matching row counts', () => {
      const { snaps, snapshot, tables } = liveWalSnapshot();
      const rehearsal = spawnSync('python3', [SCRIPT, 'rehearse', '--snapshot', join(snaps, snapshot)], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect({ status: rehearsal.status, stdout: rehearsal.stdout.trim() })
        .toEqual({ status: 0, stdout: expect.stringContaining('"integrity": "ok"') });
      const receipt = JSON.parse(rehearsal.stdout) as { integrity: string; tables: Record<string, number> };
      expect(receipt.integrity).toBe('ok');
      expect(receipt.tables).toEqual(tables);
    });

    it('leaves only the snapshot in out-root: no -wal, -shm or pending files', () => {
      const { snaps, snapshot } = liveWalSnapshot();
      expect(readdirSync(snaps)).toEqual([snapshot]);
      spawnSync('python3', [SCRIPT, 'rehearse', '--snapshot', join(snaps, snapshot)], { cwd: process.cwd() });
      expect(readdirSync(snaps)).toEqual([snapshot]);
    });

    // Root ignores directory permissions: chmod 0o500 would not make the
    // directory read-only and the test would pass without exercising the case.
    // Skip as root (reported as skipped, never as a pass).
    const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    // @skip-env: root bypasses directory permissions, so the case cannot be exercised.
    it.skipIf(runningAsRoot)('rehearses where the reader cannot create sidecars (read-only snapshot directory; skipped as root, which bypasses directory permissions)', () => {
      // A read-only reader of a WAL-format file must find or create -wal and
      // -shm; where it cannot, SQLite refuses with "unable to open database
      // file". A self-contained snapshot needs neither.
      const { snaps, snapshot, tables } = liveWalSnapshot();
      chmodSync(snaps, 0o500);
      try {
        const rehearsal = spawnSync('python3', [SCRIPT, 'rehearse', '--snapshot', join(snaps, snapshot)], {
          cwd: process.cwd(),
          encoding: 'utf8',
        });
        // Both fields asserted so a failure shows the tool's own error text.
        expect({ status: rehearsal.status, stdout: rehearsal.stdout.trim() })
          .toEqual({ status: 0, stdout: expect.stringContaining('"integrity": "ok"') });
        expect((JSON.parse(rehearsal.stdout) as { tables: Record<string, number> }).tables).toEqual(tables);
      } finally {
        chmodSync(snaps, 0o700);
      }
    });

    it('writes a self-contained rollback-journal file (header format bytes 18-19 are 1)', () => {
      const { snaps, snapshot } = liveWalSnapshot();
      const header = Buffer.alloc(20);
      const fd = openSync(join(snaps, snapshot), 'r');
      try {
        readSync(fd, header, 0, 20, 0);
      } finally {
        closeSync(fd);
      }
      // 2 = WAL format (a reader must find or create -wal/-shm); 1 = legacy.
      expect([header[18], header[19]]).toEqual([1, 1]);
    });
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
