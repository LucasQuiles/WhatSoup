/**
 * AS-01 rehearsal harness. Guards: commands read from the OLD release's OWN
 * package.json (never guessed); the target must be a real SQLite CLONE inside
 * the rehearsal sandbox (canonical realpath — a symlink to a live DB is refused).
 * Rehearsal: migrates the clone with integrity + count + TRIGGER + read-only-smoke
 * evidence and HONORS the verdict (F4 — an ok:false migration never proceeds);
 * runs the DECISIVE old-binary schema check whose outcome is classified with a
 * distinguishable exit code (a skipped step is exit 2, never a pass). Write
 * detection and the coupled restore are WAL-AWARE (F1): the file-set hash
 * (main||-wal) makes a write-ahead-log write visible, and the restore removes the
 * clone's -wal/-shm so a stale injected frame cannot survive. The old binary runs
 * via an INJECTED runner in tests (no npm subprocess trees).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_MIGRATION } from '../../src/core/database-schema-version.ts';
import { Database } from '../../src/core/database.ts';
import {
  AS01_EXIT,
  classifyOldBinaryOutcome,
  planAs01Rehearsal,
  rehearseCloneMigration,
  rehearseCoupledRestore,
  runAs01RehearsalCli,
  snapshotDbCoherent,
  type As01Io,
  type OldBinaryObservation,
} from '../../scripts/capability-obligation-as01-rehearsal.ts';

let root: string;
let releaseDir: string;
let rehearsalDir: string;

/** A real, valid SQLite database at the CURRENT schema. */
function makeSqliteClone(path: string): void {
  const db = new Database(path);
  db.open();
  db.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'as01-'));
  releaseDir = join(root, 'release');
  rehearsalDir = join(root, 'rehearsal');
  mkdirSync(releaseDir);
  mkdirSync(rehearsalDir, { mode: 0o700 });
  writeFileSync(join(releaseDir, 'package.json'), JSON.stringify({ scripts: { 'schema:guard': 'node scripts/schema-guard.js' } }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function capture(): { io: As01Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

function setReleaseScript(file: string): void {
  writeFileSync(join(releaseDir, 'package.json'), JSON.stringify({ scripts: { 'schema:guard': `node ${file}` } }));
}

/** Injected runner: spawn the fake directly with node (NO npm subprocess tree). */
function directRunner(): { probeEgress: () => boolean; runOldBinary: (spec: { command: string; scriptName: string; releaseDir: string; env: Record<string, string> }) => OldBinaryObservation } {
  return {
    probeEgress: () => false,
    runOldBinary: (spec) => {
      const file = spec.command.split(/\s+/).pop()!; // "node reject.js" -> "reject.js"
      const r = spawnSync(process.execPath, [join(spec.releaseDir, file)], { cwd: spec.releaseDir, env: spec.env, encoding: 'utf8' });
      return { status: r.status, signal: r.signal ?? null, error: r.error !== undefined, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
}

describe('planAs01Rehearsal — clone guard', () => {
  it('accepts a real SQLite clone inside the sandbox and resolves the release command', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const plan = planAs01Rehearsal({ releaseDir, cloneDb, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'WHATSOUP_DB_PATH' });
    expect(plan.ok).toBe(true);
    expect(plan.resolvedCommand).toBe('node scripts/schema-guard.js');
  });

  it('FALSIFIER: a symlink named clone.db pointing at a live DB is refused', () => {
    const live = join(root, 'live.db');
    makeSqliteClone(live);
    const link = join(rehearsalDir, 'clone.db');
    symlinkSync(live, link);
    const plan = planAs01Rehearsal({ releaseDir, cloneDb: link, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'X' });
    expect(plan).toMatchObject({ ok: false, refusedReason: 'clone_is_symlink' });
  });

  it('refuses a non-regular file, a non-SQLite file, and a clone outside the sandbox', () => {
    const dirClone = join(rehearsalDir, 'clone.db');
    mkdirSync(dirClone);
    expect(planAs01Rehearsal({ releaseDir, cloneDb: dirClone, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'X' }))
      .toMatchObject({ refusedReason: 'clone_not_regular_file' });

    const garbage = join(rehearsalDir, 'garbage.db');
    writeFileSync(garbage, 'not a sqlite database at all');
    expect(planAs01Rehearsal({ releaseDir, cloneDb: garbage, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'X' }))
      .toMatchObject({ refusedReason: 'clone_not_sqlite' });

    const outside = join(root, 'outside.db');
    makeSqliteClone(outside);
    expect(planAs01Rehearsal({ releaseDir, cloneDb: outside, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'X' }))
      .toMatchObject({ refusedReason: 'clone_outside_rehearsal_dir' });
  });

  it('refuses an unknown script name and an unreadable release package.json', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    expect(planAs01Rehearsal({ releaseDir, cloneDb, rehearsalDir, scriptName: 'nope', dbEnvVar: 'X' }))
      .toMatchObject({ refusedReason: 'unknown_script_name' });
    expect(planAs01Rehearsal({ releaseDir: join(root, 'no-release'), cloneDb, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'X' }))
      .toMatchObject({ refusedReason: 'release_package_json_unreadable' });
  });
});

describe('rehearseCloneMigration', () => {
  it('migrates the clone with integrity + counts + triggers + read-only smoke, verdict ok', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const r = rehearseCloneMigration(cloneDb, { startSchema: CURRENT_SCHEMA_MIGRATION });
    expect(r.ok).toBe(true);
    expect(r.targetSchema).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(r.integrityAfter).toBe('ok');
    expect(r.readOnlySmokeOk).toBe(true);
    expect(r.countsPreserved).toBe(true);
    expect(r.triggersPreserved).toBe(true);
    expect(r.triggersAfter.length).toBeGreaterThan(0); // the schema has triggers
    expect(r.migratedCloneHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses when the clone is not at the declared start schema', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const r = rehearseCloneMigration(cloneDb, { startSchema: 44 });
    expect(r.reason).toBe(`clone_schema_${CURRENT_SCHEMA_MIGRATION}_not_start_44`);
    expect(r.ok).toBe(false);
  });
});

describe('rehearseCoupledRestore (F1 — WAL-aware)', () => {
  it('discards a stale clone -wal and restores the byte-exact backup file-set', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const backup = join(rehearsalDir, 'pre.bak');
    copyFileSync(cloneDb, backup);
    // Stale WAL/SHM left by an old process (bytes that would replay on next open).
    writeFileSync(`${cloneDb}-wal`, 'STALE-WAL-FRAMES');
    writeFileSync(`${cloneDb}-shm`, 'STALE-SHM');
    const r = rehearseCoupledRestore(cloneDb, backup);
    // restoredHash is computed over (main||-wal) AFTER the unlink: equality with
    // the backup (which has no -wal) proves the stale -wal was discarded. (The
    // subsequent read-only integrity_check may recreate an EMPTY -shm/-wal — that
    // carries no stale frames, which is why the file-set hash, not file presence,
    // is the assertion.)
    expect(r.ok).toBe(true);
    expect(r.restoredHash).toBe(r.backupHash);
    expect(r.integrityAfter).toBe('ok');
  });

  it('CONTENT PROOF: an injected row that lives ONLY in the -wal is GONE after restore', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    // Baseline table (empty) folded into MAIN, then snapshot the backup.
    {
      const w = new DatabaseSync(cloneDb);
      w.exec('CREATE TABLE injected(x)');
      w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      w.close();
    }
    const backup = join(rehearsalDir, 'pre.bak');
    copyFileSync(cloneDb, backup);
    // Inject a row via WAL and hold a reader open so it CANNOT be checkpointed
    // into main — the row lives only in -wal (main unchanged), the exact case the
    // reviewer reproduced.
    const reader = new DatabaseSync(cloneDb, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM injected').get(); // pin an old snapshot
    const writer = new DatabaseSync(cloneDb);
    writer.exec('PRAGMA wal_autocheckpoint=0');
    writer.exec('INSERT INTO injected VALUES (1)');
    writer.close(); // close cannot checkpoint past the reader → the row stays in -wal
    expect(statSync(`${cloneDb}-wal`).size).toBeGreaterThan(0); // the row is in the WAL, not main
    // Release the reader BEFORE restoring (no open connection during the file swap).
    reader.exec('ROLLBACK');
    reader.close();
    // Restore discards the -wal and restores the empty-table main.
    const r = rehearseCoupledRestore(cloneDb, backup);
    expect(r.ok).toBe(true);
    const check = new DatabaseSync(cloneDb, { readOnly: true });
    const count = Number((check.prepare('SELECT COUNT(*) AS c FROM injected').get() as { c: number }).c);
    check.close();
    expect(count).toBe(0); // the WAL-injected row did NOT survive the restore
  });

  it('F4: the coherent pre-migration snapshot CAPTURES committed WAL content (not just the main file)', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    // Commit a row that stays in the WAL (held reader blocks checkpoint), so a
    // main-only copy would miss it.
    {
      const w = new DatabaseSync(cloneDb);
      w.exec('CREATE TABLE keep(x)');
      w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      w.close();
    }
    const reader = new DatabaseSync(cloneDb, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM keep').get();
    const writer = new DatabaseSync(cloneDb);
    writer.exec('PRAGMA wal_autocheckpoint=0');
    writer.exec('INSERT INTO keep VALUES (42)');
    writer.close();
    reader.exec('ROLLBACK');
    reader.close();
    // A COHERENT snapshot folds the WAL in, so the committed row is captured.
    const backup = join(rehearsalDir, 'coherent.bak');
    snapshotDbCoherent(cloneDb, backup);
    const check = new DatabaseSync(backup, { readOnly: true });
    const count = Number((check.prepare('SELECT COUNT(*) AS c FROM keep').get() as { c: number }).c);
    check.close();
    expect(count).toBe(1); // WAL content survived into the snapshot
  });

  it('F1 FALSIFIER: the coherent snapshot captures committed WAL content even while a reader is PINNED', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    {
      const w = new DatabaseSync(cloneDb);
      w.exec('CREATE TABLE keep(x)');
      w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      w.close();
    }
    // Pin an OLD read snapshot: wal_checkpoint(TRUNCATE) would now return
    // {busy:1, checkpointed:0}, so a checkpoint-then-copy snapshot would SILENTLY
    // drop the committed WAL row. VACUUM INTO reads its own snapshot and must still
    // capture it. The reader is HELD across the snapshot (unlike the test above).
    const reader = new DatabaseSync(cloneDb, { readOnly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM keep').get();
    const writer = new DatabaseSync(cloneDb);
    writer.exec('PRAGMA wal_autocheckpoint=0');
    writer.exec('INSERT INTO keep VALUES (7)');
    writer.close();
    expect(statSync(`${cloneDb}-wal`).size).toBeGreaterThan(0); // the row lives only in -wal
    const backup = join(rehearsalDir, 'pinned.bak');
    snapshotDbCoherent(cloneDb, backup); // reader STILL pinned here
    reader.exec('ROLLBACK');
    reader.close();
    const check = new DatabaseSync(backup, { readOnly: true });
    const count = Number((check.prepare('SELECT COUNT(*) AS c FROM keep').get() as { c: number }).c);
    check.close();
    expect(count).toBe(1); // committed WAL row survived the snapshot despite the pinned reader
  });

  it('F2 FALSIFIER: no restore crash boundary leaves the restored backup main paired with a stale -wal', () => {
    // Layout-independent, deterministic invariant: the forbidden r12 intermediate
    // state is the restored-backup MAIN BYTES sitting next to a stale -wal that
    // would replay the old binary's frames on the next open. Asserted at the file-set
    // level (not via non-deterministic WAL replay, which depends on page layout).
    for (const crashAt of ['temp-written', 'sidecars-unlinked', 'main-renamed'] as const) {
      const cloneDb = join(rehearsalDir, `crash-${crashAt}.db`);
      makeSqliteClone(cloneDb);
      {
        const w = new DatabaseSync(cloneDb);
        w.exec('CREATE TABLE danger(x)');
        w.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        w.close();
      }
      // Coherent pre-migration backup; it becomes the restored main.
      const backup = join(rehearsalDir, `crash-${crashAt}.bak`);
      snapshotDbCoherent(cloneDb, backup);
      // The old binary writes a DANGEROUS row that stays ONLY in the -wal — the exact
      // stale frame that must not survive to replay onto the restored backup.
      const reader = new DatabaseSync(cloneDb, { readOnly: true });
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) AS c FROM danger').get();
      const writer = new DatabaseSync(cloneDb);
      writer.exec('PRAGMA wal_autocheckpoint=0');
      writer.exec('INSERT INTO danger VALUES (1)');
      writer.close();
      reader.exec('ROLLBACK');
      reader.close();
      expect(statSync(`${cloneDb}-wal`).size).toBeGreaterThan(0);
      // Crash the restore at this exact boundary.
      expect(() => rehearseCoupledRestore(cloneDb, backup, {
        onStep: (s) => { if (s === crashAt) throw new Error(`crash@${s}`); },
      })).toThrow(`crash@${crashAt}`);
      // Read the file-set BEFORE any reopen (a reopen could checkpoint away the -wal).
      const mainIsRestoredBackup = readFileSync(cloneDb).equals(readFileSync(backup));
      const staleWal = existsSync(`${cloneDb}-wal`) && statSync(`${cloneDb}-wal`).size > 0;
      // The forbidden r12 state: restored-backup main + a surviving stale -wal.
      expect(mainIsRestoredBackup && staleWal).toBe(false);
      // And every boundary leaves a recoverable file-set (opens + integrity ok).
      let integrity = '';
      try {
        const chk = new DatabaseSync(cloneDb);
        integrity = String((chk.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check);
        chk.close();
      } catch {
        integrity = 'open_failed';
      }
      expect(integrity).toBe('ok');
    }
  });
});

describe('classifyOldBinaryOutcome (F2/r11 — strict rejection contract)', () => {
  const base = { status: 1, signal: null, spawnError: false, stdout: '', stderr: '', wrote: false };
  it('the expected rejection requires the error CLASS and the reason together', () => {
    expect(classifyOldBinaryOutcome({ ...base, status: 1, stderr: 'DatabaseCompatibilityError: schema too new (future_schema)' })).toBe('rejected_no_write');
    expect(classifyOldBinaryOutcome({ ...base, status: 0 })).toBe('accepted');
    expect(classifyOldBinaryOutcome({ ...base, status: 0, wrote: true })).toBe('wrote_dangerous');
    expect(classifyOldBinaryOutcome({ ...base, status: 1, wrote: true, stderr: 'DatabaseCompatibilityError future_schema' })).toBe('wrote_dangerous');
    expect(classifyOldBinaryOutcome({ ...base, status: null, signal: 'SIGKILL' })).toBe('inconclusive');
    expect(classifyOldBinaryOutcome({ ...base, status: null, spawnError: true })).toBe('inconclusive');
  });

  it('FALSIFIER: a tooling error that merely MENTIONS the reason is NOT a rejection', () => {
    // The reviewer's exact falsifier: exit 127, npm missing-script naming future_schema.
    expect(classifyOldBinaryOutcome({ ...base, status: 127, stderr: 'npm ERR! missing script: future_schema' })).toBe('inconclusive');
    // 126/127 tooling codes are never a rejection, whatever the text.
    expect(classifyOldBinaryOutcome({ ...base, status: 127, stderr: 'DatabaseCompatibilityError future_schema' })).toBe('inconclusive');
    // The error class WITHOUT the reason is not the contract.
    expect(classifyOldBinaryOutcome({ ...base, status: 1, stderr: 'DatabaseCompatibilityError: engine_recovery_required' })).toBe('inconclusive');
    // The reason WITHOUT the class is not the contract.
    expect(classifyOldBinaryOutcome({ ...base, status: 1, stderr: 'some future_schema mention' })).toBe('inconclusive');
    // A module-not-found that happens to contain the reason is tooling, not a rejection.
    expect(classifyOldBinaryOutcome({ ...base, status: 1, stderr: 'Cannot find module future_schema.js' })).toBe('inconclusive');
  });
});

describe('runAs01RehearsalCli', () => {
  function cliArgs(extra: string[]): string[] {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    return ['--release-dir', releaseDir, '--clone-db', cloneDb, '--rehearsal-dir', rehearsalDir,
      '--script-name', 'schema:guard', '--start-schema', String(CURRENT_SCHEMA_MIGRATION), ...extra];
  }

  it('dry-run migrates nothing and exits PASS(0)', () => {
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs([]), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.PASS);
    const text = cap.out.join('\n');
    expect(text).toContain('DRY-RUN');
    expect(text).not.toContain('outcome=');
  });

  it('F4: --confirm WITHOUT --network-isolated is INCOMPLETE(2), never a pass', () => {
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm']), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.INCOMPLETE);
    const text = cap.out.join('\n');
    expect(text).toContain('migrated');
    expect(text).toContain('triggers');
    expect(text).toContain('OLD-BINARY STEP INCOMPLETE');
    expect(text).toContain('does NOT pass');
  });

  it('F5: an old binary that REJECTS the future schema with no write PASSES(0) and proves the coupled restore', () => {
    writeFileSync(join(releaseDir, 'reject.js'), "process.stderr.write('DatabaseCompatibilityError: future_schema\\n'); process.exit(1);");
    setReleaseScript('reject.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.PASS);
    const text = cap.out.join('\n');
    expect(text).toContain('outcome=rejected_no_write');
    expect(text).toContain('restore     : ok=true');
    expect(text).toContain('AS-01 PASS');
  });

  it('F1: an old binary that writes through the WAL (main-file unchanged) is still detected as WROTE_DANGEROUS(4)', () => {
    writeFileSync(join(releaseDir, 'wal-writer.js'),
      "const {DatabaseSync}=require('node:sqlite');"
      + "const db=new DatabaseSync(process.env.WHATSOUP_DB_PATH);"
      + "db.exec('PRAGMA wal_autocheckpoint=0');"
      + "db.exec('CREATE TABLE IF NOT EXISTS injected(x)');"
      + "db.exec('INSERT INTO injected VALUES (1)');"
      + "process.stderr.write('DatabaseCompatibilityError: future_schema\\n');"
      + "process.exit(1);");
    setReleaseScript('wal-writer.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.WROTE_DANGEROUS); // NOT rejected_no_write — the WAL write is visible
    expect(cap.out.join('\n')).toContain('outcome=wrote_dangerous');
  });

  it('an old binary that ACCEPTS the new schema (no write) is ACCEPTED(3)', () => {
    writeFileSync(join(releaseDir, 'accept.js'), 'process.exit(0);');
    setReleaseScript('accept.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.ACCEPTED);
    expect(cap.out.join('\n')).toContain('outcome=accepted');
  });

  it('an unrecognized failure (no compat signal) is INCONCLUSIVE(1)', () => {
    setReleaseScript('does-not-exist.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.INCONCLUSIVE);
    expect(cap.out.join('\n')).toContain('outcome=inconclusive');
  });

  it('F2 FALSIFIER: an npm-style tooling error that names the reason string is INCONCLUSIVE, not a rejection', () => {
    writeFileSync(join(releaseDir, 'npm-error.js'),
      "process.stderr.write('npm ERR! missing script: future_schema\\n'); process.exit(127);");
    setReleaseScript('npm-error.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.INCONCLUSIVE); // NOT rejected_no_write
    expect(cap.out.join('\n')).toContain('outcome=inconclusive');
  });

  it('FALSIFIER: a reachable egress under --network-isolated is REFUSED before the old binary runs', () => {
    writeFileSync(join(releaseDir, 'reject.js'), "process.stderr.write('DatabaseCompatibilityError\\n'); process.exit(1);");
    setReleaseScript('reject.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io,
      { probeEgress: () => true, runOldBinary: directRunner().runOldBinary });
    expect(code).toBe(AS01_EXIT.INCONCLUSIVE);
    expect(cap.err.join('\n')).toContain('egress is reachable');
    expect(cap.out.join('\n')).not.toContain('outcome=');
  });

  it('#3231: an unknown --old-binary-contract value is refused with usage', () => {
    const cap = capture();
    expect(() => runAs01RehearsalCli(cliArgs(['--old-binary-contract', 'bogus']), cap.io, directRunner()))
      .toThrow(/--old-binary-contract/);
  });

  it('#3231: under --old-binary-contract check, a future_schema status line at exit 0 is the designed rejection and PASSES', () => {
    writeFileSync(join(releaseDir, 'check.js'),
      "process.stdout.write('database-compatibility: future_schema (db 60 > ceiling 44)\\n'); process.exit(0);");
    setReleaseScript('check.js');
    const cap = capture();
    const code = runAs01RehearsalCli(
      cliArgs(['--confirm', '--network-isolated', '--old-binary-contract', 'check']), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.PASS);
    expect(cap.out.join('\n')).toContain('outcome=rejected_no_write');
  });

  it('#3231 FALSIFIER: under the check contract a silent graceful exit 0 (SIGTERM-drained hold) is INCONCLUSIVE, never accepted', () => {
    writeFileSync(join(releaseDir, 'drain.js'), 'process.exit(0);');
    setReleaseScript('drain.js');
    const cap = capture();
    const code = runAs01RehearsalCli(
      cliArgs(['--confirm', '--network-isolated', '--old-binary-contract', 'check']), cap.io, directRunner());
    expect(code).toBe(AS01_EXIT.INCONCLUSIVE);
    expect(cap.out.join('\n')).toContain('outcome=inconclusive');
  });

  it('#3231: repeated --script-arg values reach the runner spec in order', () => {
    writeFileSync(join(releaseDir, 'reject.js'),
      "process.stderr.write('DatabaseCompatibilityError: future_schema\\n'); process.exit(1);");
    setReleaseScript('reject.js');
    const seen: string[][] = [];
    const stub = directRunner();
    const inner = stub.runOldBinary!;
    const cap = capture();
    const code = runAs01RehearsalCli(
      cliArgs(['--confirm', '--network-isolated', '--script-arg', 'instance-a', '--script-arg', '--check']), cap.io,
      { ...stub, runOldBinary: (spec) => { seen.push([...(spec.scriptArgs ?? [])]); return inner(spec); } });
    expect(code).toBe(AS01_EXIT.PASS);
    expect(seen).toEqual([['instance-a', '--check']]);
  });
});

describe('classifyOldBinaryOutcome — check contract (#3231: deployed release --check mode)', () => {
  const base = {
    status: 0 as number | null, signal: null as string | null,
    spawnError: false, stdout: '', stderr: '', wrote: false,
  };

  it('exit 0 with a future_schema status line is the designed rejection, not accepted', () => {
    expect(classifyOldBinaryOutcome({ ...base, contract: 'check', stdout: 'database-compatibility: future_schema (db 60 > ceiling 44)\n' }))
      .toBe('rejected_no_write');
  });

  it('exit 0 with a ready status line is accepted', () => {
    expect(classifyOldBinaryOutcome({ ...base, contract: 'check', stdout: 'database-compatibility: ready\n' }))
      .toBe('accepted');
  });

  it('FALSIFIER: exit 0 with NEITHER token is inconclusive — a graceful drain exit must never auto-accept', () => {
    expect(classifyOldBinaryOutcome({ ...base, contract: 'check' })).toBe('inconclusive');
  });

  it('FALSIFIER: a tooling error naming the token is not a rejection under the check contract either', () => {
    expect(classifyOldBinaryOutcome({ ...base, contract: 'check', status: 1, stderr: 'npm ERR! missing script: future_schema' }))
      .toBe('inconclusive');
    expect(classifyOldBinaryOutcome({ ...base, contract: 'check', status: 0, stdout: 'npm ERR! future_schema' }))
      .toBe('inconclusive');
  });

  it('a write trumps everything under the check contract too', () => {
    expect(classifyOldBinaryOutcome({ ...base, contract: 'check', stdout: 'future_schema', wrote: true }))
      .toBe('wrote_dangerous');
  });

  it('a nonzero error-class rejection still classifies (the release may throw instead of report)', () => {
    expect(classifyOldBinaryOutcome({ ...base, contract: 'check', status: 1, stderr: 'DatabaseCompatibilityError: future_schema' }))
      .toBe('rejected_no_write');
  });

  it('the legacy error contract is unchanged: exit 0 stays accepted when no contract is named', () => {
    expect(classifyOldBinaryOutcome({ ...base, stdout: 'future_schema status text' })).toBe('accepted');
  });
});
