import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReleaseSnapshotPlan } from '../../scripts/release-snapshot-plan.ts';

const DEPLOYED = '1111111111111111111111111111111111111111';
let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

function fixture(drift = false): { releasePath: string; fakeBin: string; fakeGit: string } {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-release-observers-'));
  const sourceRoot = path.join(tmpRoot, 'source');
  const releaseRoot = path.join(tmpRoot, 'releases');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, 'file.txt'), 'reviewed\n');
  const plan = createReleaseSnapshotPlan({
    sourceRoot,
    sourceRef: 'approved-release',
    sourceCommit: DEPLOYED,
    releaseRoot,
    buildTime: '2026-08-15T12:00:00.000Z',
    trackedFiles: ['file.txt'],
  });
  mkdirSync(plan.manifest.release.path, { recursive: true });
  writeFileSync(path.join(plan.manifest.release.path, 'file.txt'), drift ? 'changed\n' : 'reviewed\n');
  writeFileSync(
    path.join(plan.manifest.release.path, '.whatsoup-release-manifest.json'),
    `${JSON.stringify(plan.manifest)}\n`,
  );
  const fakeBin = path.join(tmpRoot, 'bin');
  mkdirSync(fakeBin);
  const fakeGit = path.join(fakeBin, 'git');
  return { releasePath: plan.manifest.release.path, fakeBin, fakeGit };
}

function runObserver(releasePath: string, fakeBin: string, fakeGit: string, targetSha: string, fakeExit = '0') {
  writeFileSync(fakeGit, `#!/bin/bash\nif [[ "${fakeExit}" != 0 ]]; then exit "${fakeExit}"; fi\nprintf "%s\\t%s\\n" "${targetSha}" "\${@: -1}"\n`);
  chmodSync(fakeGit, 0o755);
  const scriptPath = path.join(process.cwd(), 'scripts/live-release-observers.ts');
  return spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    scriptPath,
    '--release', releasePath,
    '--target-url', 'https://github.com/LucasQuiles/WhatSoup.git',
    '--no-emit',
    '--json',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
  });
}

describe('live release observers', () => {
  it('rejects another flag where --target-url requires a value', () => {
    const { releasePath } = fixture();
    const scriptPath = path.join(process.cwd(), 'scripts/live-release-observers.ts');
    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--release', releasePath,
      '--target-url', '--json',
      '--no-emit',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain('the next argument is another flag (--json)');
  });

  it('reports integrity and exact currency as two independent green observations', () => {
    const { releasePath, fakeBin, fakeGit } = fixture();
    const proc = runObserver(releasePath, fakeBin, fakeGit, DEPLOYED);

    expect(proc.status, proc.stderr || proc.stdout).toBe(0);
    const result = JSON.parse(proc.stdout) as any;
    expect(result.drift).toMatchObject({ ok: true, check: 'live-release-drift-alert' });
    expect(result.currency).toMatchObject({ state: 'current', healthImpact: 'none' });
  });

  it('returns advisory exit 1 for a different target while integrity remains green', () => {
    const { releasePath, fakeBin, fakeGit } = fixture();
    const proc = runObserver(releasePath, fakeBin, fakeGit, '2222222222222222222222222222222222222222');

    expect(proc.status).toBe(1);
    const result = JSON.parse(proc.stdout) as any;
    expect(result.drift.ok).toBe(true);
    expect(result.currency.state).toBe('target-differs');
  });

  it('still runs currency when drift fails and gives inconclusive precedence', () => {
    const { releasePath, fakeBin, fakeGit } = fixture(true);
    const proc = runObserver(releasePath, fakeBin, fakeGit, DEPLOYED, '2');

    expect(proc.status).toBe(2);
    const result = JSON.parse(proc.stdout) as any;
    expect(result.drift.ok).toBe(false);
    expect(result.currency.state).toBe('inconclusive');
  });
});
