/**
 * AS-01 rehearsal harness. Guards: commands read from the OLD release's OWN
 * package.json (never guessed); the target must be a real SQLite CLONE inside
 * the rehearsal sandbox — a SYMLINK to a live DB, a non-regular file, or a
 * non-SQLite file are refused (canonical realpath, not lexical). Rehearsal:
 * migrates the clone forward with integrity + count + read-only-smoke evidence,
 * and (only under operator-attested network isolation) runs the old-binary
 * schema check with a before/after write-delta proof.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_MIGRATION } from '../../src/core/database-schema-version.ts';
import { Database } from '../../src/core/database.ts';
import {
  planAs01Rehearsal,
  rehearseCloneMigration,
  runAs01RehearsalCli,
  type As01Io,
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
  // The Database security check refuses a DB whose parent grants group/other
  // access — the rehearsal sandbox (which holds the clone) must be 0700.
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
    symlinkSync(live, link); // lexically inside the sandbox, really points outside
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
  it('migrates the clone with integrity + counts + read-only smoke (start == current is a no-op forward)', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const r = rehearseCloneMigration(cloneDb, { startSchema: CURRENT_SCHEMA_MIGRATION });
    expect(r.ok).toBe(true);
    expect(r.targetSchema).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(r.integrityAfter).toBe('ok');
    expect(r.readOnlySmokeOk).toBe(true);
    expect(r.countsAfter['messages']).toBe(0);
    expect(r.migratedCloneHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses when the clone is not at the declared start schema', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb); // at CURRENT
    const r = rehearseCloneMigration(cloneDb, { startSchema: 44 });
    expect(r.reason).toBe(`clone_schema_${CURRENT_SCHEMA_MIGRATION}_not_start_44`);
    expect(r.ok).toBe(false);
  });
});

describe('runAs01RehearsalCli', () => {
  it('dry-run migrates nothing', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const cap = capture();
    const code = runAs01RehearsalCli(
      ['--release-dir', releaseDir, '--clone-db', cloneDb, '--rehearsal-dir', rehearsalDir, '--script-name', 'schema:guard', '--start-schema', String(CURRENT_SCHEMA_MIGRATION)],
      cap.io,
    );
    expect(code).toBe(0);
    const text = cap.out.join('\n');
    expect(text).toContain('DRY-RUN');
    expect(text).not.toContain('smoke(ro)'); // migration-result marker — absent in dry-run
  });

  it('--confirm migrates + skips the old-binary step without --network-isolated', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const cap = capture();
    const code = runAs01RehearsalCli(
      ['--release-dir', releaseDir, '--clone-db', cloneDb, '--rehearsal-dir', rehearsalDir, '--script-name', 'schema:guard', '--start-schema', String(CURRENT_SCHEMA_MIGRATION), '--confirm'],
      cap.io,
    );
    expect(code).toBe(0);
    const text = cap.out.join('\n');
    expect(text).toContain('migrated');
    expect(text).toContain('integrity');
    expect(text).toContain('OLD-BINARY STEP SKIPPED');
  });

  it('--network-isolated runs the old-binary check and proves a write-delta', () => {
    // Release script that WRITES to the clone (a bad old binary): write-delta true.
    writeFileSync(join(releaseDir, 'package.json'), JSON.stringify({ scripts: { 'schema:guard': 'node writer.js' } }));
    writeFileSync(join(releaseDir, 'writer.js'), "require('fs').appendFileSync(process.env.WHATSOUP_DB_PATH, 'MUT');");
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const cap = capture();
    const code = runAs01RehearsalCli(
      ['--release-dir', releaseDir, '--clone-db', cloneDb, '--rehearsal-dir', rehearsalDir, '--script-name', 'schema:guard', '--start-schema', String(CURRENT_SCHEMA_MIGRATION), '--confirm', '--network-isolated'],
      cap.io,
    );
    const text = cap.out.join('\n');
    expect(text).toContain('old-binary');
    expect(text).toContain('wrote=true'); // the write-delta was detected
    expect(code).toBe(1); // a write by the old binary fails the rehearsal
  }, 30_000);
});
