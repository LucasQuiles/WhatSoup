import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const unitPath = path.join(repoRoot, 'deploy/whatsoup-release-drift.service');
const wrapperPath = path.join(repoRoot, 'deploy/scripts/whatsoup-release-drift-linux.sh');
const tmp = trackTmpDirs('release-drift-unit-');

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
});
