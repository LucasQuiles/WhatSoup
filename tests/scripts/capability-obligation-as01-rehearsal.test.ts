/**
 * AS-01 rehearsal harness — the guarantees that make it an artifact, not a
 * loaded gun: commands are read from the OLD release's OWN package.json (never
 * guessed), the target must be a CLONE inside the designated rehearsal sandbox,
 * and it is dry-run by default (executes nothing without --confirm).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  planAs01Rehearsal,
  runAs01RehearsalCli,
  type As01Io,
} from '../../scripts/capability-obligation-as01-rehearsal.ts';

let root: string;
let releaseDir: string;
let rehearsalDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'as01-'));
  releaseDir = join(root, 'release');
  rehearsalDir = join(root, 'rehearsal');
  mkdirSync(releaseDir);
  mkdirSync(rehearsalDir);
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

describe('planAs01Rehearsal', () => {
  it('resolves the command from the RELEASE package.json for a clone inside the sandbox', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    writeFileSync(cloneDb, '');
    const plan = planAs01Rehearsal({ releaseDir, cloneDb, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'WHATSOUP_DB_PATH' });
    expect(plan.ok).toBe(true);
    expect(plan.resolvedCommand).toBe('node scripts/schema-guard.js'); // never guessed — read from the release
  });

  it('REFUSES a clone-db outside the rehearsal sandbox (never touches a live DB)', () => {
    const outside = join(root, 'live-instance.db'); // sibling of rehearsalDir, not inside it
    writeFileSync(outside, '');
    const plan = planAs01Rehearsal({ releaseDir, cloneDb: outside, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'X' });
    expect(plan).toMatchObject({ ok: false, refusedReason: 'clone_outside_rehearsal_dir' });
  });

  it('REFUSES an unknown script name (never invents a command)', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    writeFileSync(cloneDb, '');
    const plan = planAs01Rehearsal({ releaseDir, cloneDb, rehearsalDir, scriptName: 'does:not:exist', dbEnvVar: 'X' });
    expect(plan).toMatchObject({ ok: false, refusedReason: 'unknown_script_name' });
  });

  it('REFUSES when the release package.json is unreadable', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    writeFileSync(cloneDb, '');
    const plan = planAs01Rehearsal({ releaseDir: join(root, 'no-such-release'), cloneDb, rehearsalDir, scriptName: 'schema:guard', dbEnvVar: 'X' });
    expect(plan).toMatchObject({ ok: false, refusedReason: 'release_package_json_unreadable' });
  });
});

describe('runAs01RehearsalCli', () => {
  it('is dry-run by default — prints the plan and executes NOTHING', () => {
    const cloneDb = join(rehearsalDir, 'clone.db');
    writeFileSync(cloneDb, '');
    const cap = capture();
    const code = runAs01RehearsalCli(
      ['--release-dir', releaseDir, '--clone-db', cloneDb, '--rehearsal-dir', rehearsalDir, '--script-name', 'schema:guard'],
      cap.io,
    );
    expect(code).toBe(0);
    const text = cap.out.join('\n');
    expect(text).toContain('node scripts/schema-guard.js');
    expect(text).toContain('DRY-RUN');
    expect(text).not.toContain('exit='); // no execution happened
  });

  it('exits non-zero and refuses on a clone outside the sandbox', () => {
    const outside = join(root, 'live.db');
    writeFileSync(outside, '');
    const cap = capture();
    const code = runAs01RehearsalCli(
      ['--release-dir', releaseDir, '--clone-db', outside, '--rehearsal-dir', rehearsalDir, '--script-name', 'schema:guard'],
      cap.io,
    );
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toContain('clone_outside_rehearsal_dir');
  });
});
