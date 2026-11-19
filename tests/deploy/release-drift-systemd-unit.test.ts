import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const unitPath = path.join(repoRoot, 'deploy/whatsoup-release-drift.service');
const wrapperPath = path.join(repoRoot, 'deploy/scripts/whatsoup-release-drift-linux.sh');
const runnerPath = path.join(repoRoot, 'scripts/run-with-pinned-node.sh');
const schedulerPath = path.join(repoRoot, 'deploy/scripts/run-release-drift-schedule.sh');
const rendererPath = path.join(repoRoot, 'deploy/scripts/render-release-drift-launchd.sh');
const tmp = trackTmpDirs('release-drift-unit-');
const MAIN_GUARD_MARKER = 'fixture-observer-main-guard-ran';
// The scheduler line that makes the runner report every bootstrap and loading
// failure as 2. A release exported before it ships a scheduler without the line,
// whose runner exits 1 for those failures.
const BOOTSTRAP_CONTRACT_LINE = '  --bootstrap-exit-code 2 \\\n';

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
  writeFileSync(schedule, [
    `printf '%s\\n' "$@" > '${argsFile}'`,
    `exit ${scheduleExit}`,
    // Never reached. The stand-in declares the runner call of the current
    // scheduler, so the wrapper may read its exit 1 as an observer result.
    'exec bash "$repo_root/scripts/run-with-pinned-node.sh" \\',
    `${BOOTSTRAP_CONTRACT_LINE}  "$repo_root/scripts/live-release-observers.ts"`,
    '',
  ].join('\n'));
  chmodSync(schedule, 0o755);
  const launcher = path.join(root, 'whatsoup');
  symlinkSync(path.join(releaseRoot, 'deploy/whatsoup'), launcher);
  return { launcher, argsFile, logDir: path.join(root, 'logs') };
}

const LABEL_KEY = 'WHATSOUP_RELEASE_DRIFT_INSTANCE';

/**
 * Run the wrapper with HOME set to `env.HOME` or a fresh folder. A label in `env`
 * is also written to the dedicated label file in that HOME, as setup writes it,
 * unless `labelFile` says otherwise: null writes no file, a string is the file's
 * whole content.
 */
function runWrapper(env: Record<string, string>, options: { labelFile?: string | null } = {}) {
  const home = env.HOME ?? tmp.make('home');
  const label = env[LABEL_KEY];
  const content = options.labelFile !== undefined
    ? options.labelFile
    : label === undefined ? null : `${LABEL_KEY}=${label}\n`;
  if (content !== null) {
    mkdirSync(path.join(home, '.config/whatsoup'), { recursive: true });
    writeFileSync(path.join(home, '.config/whatsoup/release-drift.env'), content);
  }
  return spawnSync('bash', [wrapperPath], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
  });
}

function observedInstance(argsFile: string): string | undefined {
  const args = readFileSync(argsFile, 'utf8').trim().split('\n');
  return args[args.indexOf('--instance') + 1];
}

function actualRelease(observerSource?: string, options: { olderScheduler?: boolean } = {}): {
  launcher: string;
  logDir: string;
  releaseRoot: string;
} {
  const root = tmp.make('actual-release');
  const releaseRoot = path.join(root, 'WhatSoup-release-test');
  const releaseScheduler = path.join(releaseRoot, 'deploy/scripts/run-release-drift-schedule.sh');
  mkdirSync(path.join(releaseRoot, 'deploy/scripts'), { recursive: true });
  mkdirSync(path.join(releaseRoot, 'scripts'), { recursive: true });
  copyFileSync(runnerPath, path.join(releaseRoot, 'scripts/run-with-pinned-node.sh'));
  if (options.olderScheduler) {
    // The scheduler as releases exported before the bootstrap exit contract ship
    // it. Called without the option, the runner exits 1 when Node is missing, as
    // the runner of those releases does.
    const scheduler = readFileSync(schedulerPath, 'utf8');
    expect(scheduler).toContain(BOOTSTRAP_CONTRACT_LINE);
    writeFileSync(releaseScheduler, scheduler.replace(BOOTSTRAP_CONTRACT_LINE, ''));
  } else {
    copyFileSync(schedulerPath, releaseScheduler);
  }
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
    releaseScheduler,
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
    // Exit 2 covers inconclusive runs: a configuration, runner or observer failure,
    // an inconclusive currency check, a failed emit, or an exit 1 the wrapper
    // cannot attribute to the observer. The unit result is their common signal.
    expect([...successExitStatuses()].sort()).toEqual([0, 1]);
  });

  it('reads the instance label from its own optional file, loaded after the shared BOT ERRORS file', () => {
    const environmentFiles = readFileSync(unitPath, 'utf8').split('\n')
      .map((line) => /^EnvironmentFile=(.*)$/.exec(line.trim())?.[1])
      .filter((file): file is string => file !== undefined);
    // Every BOT ERRORS unit loads bot-errors.env, so the label lives elsewhere. A later
    // file overrides an earlier one, and "-" lets a missing file reach the wrapper,
    // whose exit 2 fails the unit with a readable message.
    expect(environmentFiles).toEqual([
      '%h/.config/whatsoup/bot-errors.env',
      '-%h/.config/whatsoup/release-drift.env',
    ]);
  });

  it('a wrapper configuration error fails the unit visibly', () => {
    const missingInstance = runWrapper({ WHATSOUP_LAUNCHER: '/nonexistent/whatsoup' });
    expect(missingInstance.stderr).toContain('WHATSOUP_RELEASE_DRIFT_INSTANCE is not set');
    expect(successExitStatuses().has(missingInstance.status ?? -1)).toBe(false);

    const badLauncher = runWrapper({ WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test', WHATSOUP_LAUNCHER: tmp.make('not-a-release') });
    expect(badLauncher.stderr).toContain('launcher target has unexpected shape');
    expect(successExitStatuses().has(badLauncher.status ?? -1)).toBe(false);
  });

  it('never takes the label from WHATSOUP_INSTANCE: without the dedicated label the unit fails before observing', () => {
    // bot-errors.env, the user manager or a drop-in can set WHATSOUP_INSTANCE for
    // another purpose; it must not label this host's release alerts and clears.
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_INSTANCE: 'bot-b',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('WHATSOUP_RELEASE_DRIFT_INSTANCE is not set');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it('takes no label from its environment: a label set only there, as bot-errors.env sets it, fails the unit before observing', () => {
    // The unit loads bot-errors.env, which every BOT ERRORS unit loads, before the
    // optional label file, so a line there reaches this environment when the file
    // is absent. It must not label this host's release alerts and clears.
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-b',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: null });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('WHATSOUP_RELEASE_DRIFT_INSTANCE is not set');
    expect(result.stderr).toContain('release-drift.env');
    expect(result.stderr).toContain('environment is ignored');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it('takes the label from the dedicated file when its environment holds another one', () => {
    // Under systemd the label file is loaded last, so its value is also the one in
    // the environment; a mismatch can only come from a direct run.
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-b',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a\n' });

    expect(result.status, result.stderr).toBe(0);
    expect(observedInstance(release.argsFile)).toBe('bot-a');
  });

  it('reads the label from the dedicated file alone', () => {
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a\n' });

    expect(result.status, result.stderr).toBe(0);
    expect(observedInstance(release.argsFile)).toBe('bot-a');
  });

  it('reads the last label assignment in the file and skips comment lines, as systemd does', () => {
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, {
      labelFile: [
        'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-x',
        'OTHER_KEY=1',
        '# WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-y',
        'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a',
      ].join('\n'),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(observedInstance(release.argsFile)).toBe('bot-a');
  });

  it('fails closed before observing when the label path is not a readable file', () => {
    const release = fakeRelease(0);
    const home = tmp.make('home');
    mkdirSync(path.join(home, '.config/whatsoup/release-drift.env'), { recursive: true });
    const result = runWrapper({
      HOME: home,
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot read');
    expect(result.stderr).toContain('release-drift.env');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it('refuses a label the observer would read as an option before running the release', () => {
    // The scheduler answers --help with its usage and exit 0: a clean unit run
    // without any observation.
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: '--help',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsafe WHATSOUP_RELEASE_DRIFT_INSTANCE');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it('maps observer exit codes to the unit result (0, 1 succeed; 2 fails)', () => {
    const outcomes = [0, 1, 2].map((code) => {
      const release = fakeRelease(code);
      const result = runWrapper({
        WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
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

  it('defaults the currency target to the HTTPS URL the macOS renderer uses, and passes a set one through', () => {
    // A systemd user unit has no SSH agent socket, so an SSH default is
    // inconclusive on every host without a usable key.
    const rendererDefault = /^target_url="\$\{WHATSOUP_RELEASE_TARGET_URL:-([^}]+)\}"$/m
      .exec(readFileSync(rendererPath, 'utf8'))?.[1];
    expect(rendererDefault).toMatch(/^https:\/\//);
    const targetUrl = (env: Record<string, string>): string | undefined => {
      const release = fakeRelease(0);
      const result = runWrapper({
        WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
        WHATSOUP_LAUNCHER: release.launcher,
        WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
        ...env,
      });
      expect(result.status, result.stderr).toBe(0);
      const args = readFileSync(release.argsFile, 'utf8').trim().split('\n');
      return args[args.indexOf('--target-url') + 1];
    };

    expect(targetUrl({})).toBe(rendererDefault);
    const ssh = 'ssh://git@example.invalid/owner/repo.git';
    expect(targetUrl({ WHATSOUP_RELEASE_TARGET_URL: ssh })).toBe(ssh);
  });

  it('rejects a release with a scheduler but no observer before systemd can accept exit 1', () => {
    const release = actualRelease();
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
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
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: path.join(release.releaseRoot, 'missing-node'),
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('FATAL: node not found');
    expect(successExitStatuses().has(result.status ?? -1)).toBe(false);
  });

  it('reports exit 1 from a release older than the bootstrap exit contract as inconclusive when its runner finds no Node', () => {
    const release = actualRelease('process.exitCode = 0;\n', { olderScheduler: true });
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: path.join(release.releaseRoot, 'missing-node'),
    });

    // The older runner exits 1 here, which systemd would record as alerted drift
    // although no observer ran and no alert exists.
    expect(result.stderr).toContain('FATAL: node not found');
    expect(result.status).toBe(2);
    expect(successExitStatuses().has(result.status ?? -1)).toBe(false);
  });

  it('preserves a completed observer exit 1 through the real wrapper, scheduler, and runner', () => {
    const release = actualRelease("process.stdout.write('fixture-observer-completed\\n');\nprocess.exitCode = 1;\n");
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: process.execPath,
    });

    expect(result.stdout).toContain('fixture-observer-completed');
    expect(result.status).toBe(1);
    expect(successExitStatuses().has(result.status ?? -1)).toBe(true);
  });

  it('runs the selected release runner and returns its observer status when an inherited WHATSOUP_REPO_ROOT names another tree', () => {
    // bot-errors.env, the user manager or a drop-in can set WHATSOUP_REPO_ROOT,
    // for example to the previous release. The scheduler takes its runner from
    // that root. A runner from before --bootstrap-exit-code reads the option as
    // its script path and exits 1 without starting the observer, which systemd
    // would record as alerted drift.
    const release = actualRelease("process.stdout.write('fixture-selected-observer-ran\\n');\nprocess.exitCode = 0;\n");
    const inheritedRoot = tmp.make('inherited-root');
    mkdirSync(path.join(inheritedRoot, 'scripts'), { recursive: true });
    writeFileSync(path.join(inheritedRoot, 'scripts/run-with-pinned-node.sh'), [
      '#!/usr/bin/env bash',
      "echo 'fixture-inherited-runner-ran' >&2",
      'echo "FATAL: script not found: $1" >&2',
      'exit 1',
      '',
    ].join('\n'));
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: process.execPath,
      WHATSOUP_REPO_ROOT: inheritedRoot,
    });

    expect(result.stdout).toContain('fixture-selected-observer-ran');
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('fixture-inherited-runner-ran');
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
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
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
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
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
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'test',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
      WHATSOUP_NODE: process.execPath,
    });

    expect(result.stdout).toContain(MAIN_GUARD_MARKER);
    expect(result.status).toBe(1);
    expect(successExitStatuses().has(result.status ?? -1)).toBe(true);
  });
});
