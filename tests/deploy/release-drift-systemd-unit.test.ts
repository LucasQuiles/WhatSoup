import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const unitPath = path.join(repoRoot, 'deploy/whatsoup-release-drift.service');
const wrapperPath = path.join(repoRoot, 'deploy/scripts/whatsoup-release-drift-linux.sh');
const runnerPath = path.join(repoRoot, 'scripts/run-with-pinned-node.sh');
const schedulerPath = path.join(repoRoot, 'deploy/scripts/run-release-drift-schedule.sh');
const tmp = trackTmpDirs('release-drift-unit-');
const MAIN_GUARD_MARKER = 'fixture-observer-main-guard-ran';

// Exit statuses systemd records as success for this oneshot unit.
function successExitStatuses(): Set<number> {
  const statuses = new Set<number>([0]);
  for (const line of readFileSync(unitPath, 'utf8').split('\n')) {
    const match = /^SuccessExitStatus=(.*)$/.exec(line.trim());
    if (!match) continue;
    for (const token of match[1].split(/\s+/).filter(Boolean)) statuses.add(Number(token));
  }
  return statuses;
}

function fakeRelease(scheduleExit: number): { launcher: string; argsFile: string; logDir: string } {
  const root = tmp.make('release');
  const releaseRoot = path.join(root, 'WhatSoup-release-test');
  mkdirSync(path.join(releaseRoot, 'deploy/scripts'), { recursive: true });
  mkdirSync(path.join(releaseRoot, 'scripts'), { recursive: true });
  writeFileSync(path.join(releaseRoot, 'scripts/live-release-observers.ts'), '');
  writeFileSync(path.join(releaseRoot, 'deploy/whatsoup'), '#!/bin/sh\n');
  const argsFile = path.join(root, 'schedule-args');
  const schedule = path.join(releaseRoot, 'deploy/scripts/run-release-drift-schedule.sh');
  writeFileSync(schedule, `printf '%s\\n' "$@" > '${argsFile}'\nexit ${scheduleExit}\n`);
  chmodSync(schedule, 0o755);
  const launcher = path.join(root, 'whatsoup');
  symlinkSync(path.join(releaseRoot, 'deploy/whatsoup'), launcher);
  return { launcher, argsFile, logDir: path.join(root, 'logs') };
}

function runWrapper(env: Record<string, string>) {
  return spawnSync('bash', [wrapperPath], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp.make('home'), ...env },
  });
}

function actualRelease(observerSource?: string): {
  launcher: string;
  logDir: string;
  releaseRoot: string;
} {
  const root = tmp.make('actual-release');
  const releaseRoot = path.join(root, 'WhatSoup-release-test');
  mkdirSync(path.join(releaseRoot, 'deploy/scripts'), { recursive: true });
  mkdirSync(path.join(releaseRoot, 'scripts'), { recursive: true });
  copyFileSync(runnerPath, path.join(releaseRoot, 'scripts/run-with-pinned-node.sh'));
  copyFileSync(schedulerPath, path.join(releaseRoot, 'deploy/scripts/run-release-drift-schedule.sh'));
  writeFileSync(path.join(releaseRoot, 'deploy/scripts/rotate-release-drift-logs.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(releaseRoot, 'deploy/whatsoup'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(releaseRoot, '.nvmrc'), '24.15.0\n');
  writeFileSync(
    path.join(releaseRoot, 'package.json'),
    JSON.stringify({ name: 'release-drift-fixture', type: 'module', engines: { node: '>=24.0.0 <26' } }),
  );
  if (observerSource !== undefined) {
    writeFileSync(path.join(releaseRoot, 'scripts/live-release-observers.ts'), observerSource);
  }
  for (const script of [
    path.join(releaseRoot, 'scripts/run-with-pinned-node.sh'),
    path.join(releaseRoot, 'deploy/scripts/run-release-drift-schedule.sh'),
    path.join(releaseRoot, 'deploy/scripts/rotate-release-drift-logs.sh'),
    path.join(releaseRoot, 'deploy/whatsoup'),
  ]) chmodSync(script, 0o755);

  const launcher = path.join(root, 'whatsoup');
  symlinkSync(path.join(releaseRoot, 'deploy/whatsoup'), launcher);
  return { launcher, logDir: path.join(root, 'logs'), releaseRoot };
}

function runPinnedRunner(releaseRoot: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [path.join(releaseRoot, 'scripts/run-with-pinned-node.sh'), ...args], {
    encoding: 'utf8',
    cwd: releaseRoot,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: tmp.make('runner-home'),
      WHATSOUP_NODE: process.execPath,
      ...env,
    },
  });
}

describe('whatsoup-release-drift systemd unit', () => {
  it('treats only clean (0) and alerted drift (1) as success; inconclusive (2) fails the unit', () => {
    // Exit 1 is the documented "drifted, alert emitted through BOT ERRORS" outcome.
    // Exit 2 covers wrapper errors, observer crashes and emit-failed, where no
    // outbox alert exists, so the unit result is the only visible signal.
    expect([...successExitStatuses()].sort()).toEqual([0, 1]);
  });

  it('a wrapper configuration error fails the unit visibly', () => {
    const missingInstance = runWrapper({ WHATSOUP_LAUNCHER: '/nonexistent/whatsoup' });
    expect(missingInstance.stderr).toContain('WHATSOUP_INSTANCE is not set');
    expect(successExitStatuses().has(missingInstance.status ?? -1)).toBe(false);

    const badLauncher = runWrapper({ WHATSOUP_INSTANCE: 'test', WHATSOUP_LAUNCHER: tmp.make('not-a-release') });
    expect(badLauncher.stderr).toContain('launcher target has unexpected shape');
    expect(successExitStatuses().has(badLauncher.status ?? -1)).toBe(false);
  });

  it('maps observer exit codes to the unit result (0, 1 succeed; 2 fails)', () => {
    const outcomes = [0, 1, 2].map((code) => {
      const release = fakeRelease(code);
      const result = runWrapper({
        WHATSOUP_INSTANCE: 'test',
        WHATSOUP_LAUNCHER: release.launcher,
        WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      });
      expect(result.status).toBe(code);
      const args = readFileSync(release.argsFile, 'utf8').trim().split('\n');
      expect(args).toEqual(expect.arrayContaining(['--instance', 'test', '--clear-on-ok']));
      return successExitStatuses().has(code);
    });
    expect(outcomes).toEqual([true, true, false]);
  });

  it('rejects a release with a scheduler but no observer before systemd can accept exit 1', () => {
    const release = actualRelease();
    const result = runWrapper({
      WHATSOUP_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: process.execPath,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('release root missing observer entrypoints');
    expect(successExitStatuses().has(result.status ?? -1)).toBe(false);
  });

  it('classifies runner bootstrap failure as inconclusive through the real wrapper, scheduler, and pinned runner', () => {
    const release = actualRelease('process.exitCode = 0;\n');
    const result = runWrapper({
      WHATSOUP_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: path.join(release.releaseRoot, 'missing-node'),
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('FATAL: node not found');
    expect(successExitStatuses().has(result.status ?? -1)).toBe(false);
  });

  it('preserves a completed observer exit 1 through the real wrapper, scheduler, and runner', () => {
    const release = actualRelease("process.stdout.write('fixture-observer-completed\\n');\nprocess.exitCode = 1;\n");
    const result = runWrapper({
      WHATSOUP_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: process.execPath,
    });

    expect(result.stdout).toContain('fixture-observer-completed');
    expect(result.status).toBe(1);
    expect(successExitStatuses().has(result.status ?? -1)).toBe(true);
  });

  it('keeps the runner default bootstrap exit and rejects unsupported bootstrap classifications', () => {
    const release = actualRelease('process.exitCode = 0;\n');
    const defaultFailure = runPinnedRunner(release.releaseRoot, ['scripts/missing-observer.ts']);
    expect(defaultFailure.status).toBe(1);

    const unsupported = runPinnedRunner(release.releaseRoot, [
      '--bootstrap-exit-code',
      '7',
      'scripts/missing-observer.ts',
    ]);
    expect(unsupported.status).toBe(64);
  });

  it('classifies malformed observer syntax as inconclusive after the shell bootstrap succeeds', () => {
    const release = actualRelease('export const malformed = ;\n');
    const result = runWrapper({
      WHATSOUP_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: process.execPath,
    });

    expect(result.status).toBe(2);
    expect(successExitStatuses().has(result.status ?? -1)).toBe(false);
  });

  it('classifies an observer static-import failure as inconclusive after the shell bootstrap succeeds', () => {
    const release = actualRelease("import './missing-observer-dependency.ts';\n");
    const result = runWrapper({
      WHATSOUP_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: process.execPath,
    });

    expect(result.status).toBe(2);
    expect(successExitStatuses().has(result.status ?? -1)).toBe(false);
  });

  it('preserves the observer main-module argv guard while classifying observer loading', () => {
    const release = actualRelease([
      "import { pathToFileURL } from 'node:url';",
      '',
      'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {',
      `  process.stdout.write('${MAIN_GUARD_MARKER}\\n');`,
      '  process.exitCode = 1;',
      '}',
      '',
    ].join('\n'));
    const result = runWrapper({
      WHATSOUP_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: process.execPath,
    });

    expect(result.stdout).toContain(MAIN_GUARD_MARKER);
    expect(result.status).toBe(1);
    expect(successExitStatuses().has(result.status ?? -1)).toBe(true);
  });
});
