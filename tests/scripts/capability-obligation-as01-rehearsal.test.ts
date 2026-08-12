/**
 * AS-01 rehearsal harness. Guards: commands read from the OLD release's OWN
 * package.json (never guessed); the target must be a real SQLite CLONE inside
 * the rehearsal sandbox — a SYMLINK to a live DB, a non-regular file, or a
 * non-SQLite file are refused (canonical realpath, not lexical). Rehearsal:
 * migrates the clone forward with integrity + count + read-only-smoke evidence,
 * then runs the DECISIVE old-binary schema check whose outcome is classified
 * (rejected_no_write / accepted / wrote_dangerous / inconclusive) with a
 * distinguishable exit code — a skipped decisive step is exit 2, never a pass
 * (F4/F5). The expected rejection additionally proves the coupled byte-exact
 * restore. Network isolation is a fail-closed egress probe, not an assertion.
 */
import { appendFileSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Point the release's schema:guard script at a specific behavior file. */
function setReleaseScript(file: string): void {
  writeFileSync(join(releaseDir, 'package.json'), JSON.stringify({ scripts: { 'schema:guard': `node ${file}` } }));
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

describe('rehearseCoupledRestore', () => {
  it('restores byte-exact pre-migration bytes with integrity after a mutation', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const backup = join(rehearsalDir, 'pre.bak');
    // Snapshot the good bytes, then CORRUPT the clone.
    copyFileSync(cloneDb, backup);
    appendFileSync(cloneDb, 'CORRUPTION');
    const r = rehearseCoupledRestore(cloneDb, backup);
    expect(r.ok).toBe(true);
    expect(r.restoredHash).toBe(r.backupHash);
    expect(r.integrityAfter).toBe('ok');
  });

  it('FALSIFIER: a non-SQLite backup restores to a DB that fails integrity → not ok', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    const garbageBackup = join(rehearsalDir, 'garbage.bak');
    writeFileSync(garbageBackup, 'not sqlite at all');
    const r = rehearseCoupledRestore(cloneDb, garbageBackup);
    expect(r.ok).toBe(false);
    expect(r.integrityAfter).toBe('unreadable');
  });
});

describe('classifyOldBinaryOutcome', () => {
  const base = { status: 1, signal: null, spawnError: false, stdout: '', stderr: '', wrote: false };
  it('classifies each outcome distinctly', () => {
    expect(classifyOldBinaryOutcome({ ...base, status: 1, stderr: 'DatabaseCompatibilityError: future_schema' })).toBe('rejected_no_write');
    expect(classifyOldBinaryOutcome({ ...base, status: 0 })).toBe('accepted');
    expect(classifyOldBinaryOutcome({ ...base, status: 0, wrote: true })).toBe('wrote_dangerous');
    expect(classifyOldBinaryOutcome({ ...base, status: 1, wrote: true, stderr: 'DatabaseCompatibilityError' })).toBe('wrote_dangerous');
    expect(classifyOldBinaryOutcome({ ...base, status: 127, stderr: 'command not found' })).toBe('inconclusive');
    expect(classifyOldBinaryOutcome({ ...base, status: null, signal: 'SIGKILL' })).toBe('inconclusive');
    expect(classifyOldBinaryOutcome({ ...base, status: null, spawnError: true })).toBe('inconclusive');
  });
});

describe('runAs01RehearsalCli', () => {
  const noEgress = { probeEgress: () => false };

  function cliArgs(extra: string[]): string[] {
    const cloneDb = join(rehearsalDir, 'clone.db');
    makeSqliteClone(cloneDb);
    return ['--release-dir', releaseDir, '--clone-db', cloneDb, '--rehearsal-dir', rehearsalDir,
      '--script-name', 'schema:guard', '--start-schema', String(CURRENT_SCHEMA_MIGRATION), ...extra];
  }

  it('dry-run migrates nothing and exits PASS(0)', () => {
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs([]), cap.io, noEgress);
    expect(code).toBe(AS01_EXIT.PASS);
    const text = cap.out.join('\n');
    expect(text).toContain('DRY-RUN');
    expect(text).not.toContain('outcome='); // old-binary marker — absent in dry-run
  });

  it('F4: --confirm WITHOUT --network-isolated is INCOMPLETE(2), never a pass', () => {
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm']), cap.io, noEgress);
    expect(code).toBe(AS01_EXIT.INCOMPLETE);
    const text = cap.out.join('\n');
    expect(text).toContain('migrated');
    expect(text).toContain('OLD-BINARY STEP INCOMPLETE');
    expect(text).toContain('does NOT pass');
  });

  it('F5: an old binary that REJECTS the future schema with no write PASSES(0) and proves the coupled restore', () => {
    writeFileSync(join(releaseDir, 'reject.js'), "process.stderr.write('DatabaseCompatibilityError: future_schema\\n'); process.exit(1);");
    setReleaseScript('reject.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, noEgress);
    expect(code).toBe(AS01_EXIT.PASS);
    const text = cap.out.join('\n');
    expect(text).toContain('outcome=rejected_no_write');
    expect(text).toContain('restore     : ok=true');
    expect(text).toContain('AS-01 PASS');
  }, 30_000);

  it('an old binary that ACCEPTS the new schema (no write) is ACCEPTED(3) — owner decision', () => {
    writeFileSync(join(releaseDir, 'accept.js'), 'process.exit(0);');
    setReleaseScript('accept.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, noEgress);
    expect(code).toBe(AS01_EXIT.ACCEPTED);
    expect(cap.out.join('\n')).toContain('outcome=accepted');
  }, 30_000);

  it('an old binary that WRITES to the clone is WROTE_DANGEROUS(4)', () => {
    writeFileSync(join(releaseDir, 'writer.js'), "require('fs').appendFileSync(process.env.WHATSOUP_DB_PATH, 'MUT'); process.exit(1);");
    setReleaseScript('writer.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, noEgress);
    expect(code).toBe(AS01_EXIT.WROTE_DANGEROUS);
    expect(cap.out.join('\n')).toContain('outcome=wrote_dangerous');
  }, 30_000);

  it('an unrecognized failure (no compat signal) is INCONCLUSIVE(1)', () => {
    setReleaseScript('does-not-exist.js'); // node cannot find module — non-zero, no compat signal
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, noEgress);
    expect(code).toBe(AS01_EXIT.INCONCLUSIVE);
    expect(cap.out.join('\n')).toContain('outcome=inconclusive');
  }, 30_000);

  it('FALSIFIER: a reachable egress under --network-isolated is REFUSED before the old binary runs', () => {
    writeFileSync(join(releaseDir, 'reject.js'), "process.stderr.write('DatabaseCompatibilityError\\n'); process.exit(1);");
    setReleaseScript('reject.js');
    const cap = capture();
    const code = runAs01RehearsalCli(cliArgs(['--confirm', '--network-isolated']), cap.io, { probeEgress: () => true });
    expect(code).toBe(AS01_EXIT.INCONCLUSIVE);
    expect(cap.err.join('\n')).toContain('egress is reachable');
    expect(cap.out.join('\n')).not.toContain('outcome='); // never reached the old binary
  });
});
