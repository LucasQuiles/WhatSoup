import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { writeGetentShim } from '../helpers/user-database-shim.ts';

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

function labelFilePath(home: string): string {
  return path.join(home, '.config/whatsoup/release-drift.env');
}

function writeLabelFile(home: string, content: string): void {
  mkdirSync(path.dirname(labelFilePath(home)), { recursive: true });
  writeFileSync(labelFilePath(home), content);
}

/**
 * Run the wrapper as the unit runs it: `--label-file` and the label file path,
 * %h's .config/whatsoup/release-drift.env. HOME is `env.HOME` or
 * a fresh folder, and is unset with `unsetHome`. The label file sits under
 * `labelHome` (default: that HOME), standing in for %h. A label in `env` is also
 * written to that file, as systemd would have loaded it from there, unless
 * `labelFile` says otherwise: null writes no file, a string is the file's whole
 * content. `args` replaces the argument list.
 */
function runWrapper(
  env: Record<string, string>,
  options: { labelFile?: string | null; labelHome?: string; unsetHome?: boolean; args?: string[] } = {},
) {
  const home = env.HOME ?? tmp.make('home');
  const labelHome = options.labelHome ?? home;
  const label = env[LABEL_KEY];
  const content = options.labelFile !== undefined
    ? options.labelFile
    : label === undefined ? null : `${LABEL_KEY}=${label}\n`;
  if (content !== null) writeLabelFile(labelHome, content);
  const runEnv: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env };
  if (options.unsetHome) delete runEnv.HOME;
  return spawnSync('bash', [wrapperPath, ...(options.args ?? ['--label-file', labelFilePath(labelHome)])], {
    encoding: 'utf8',
    env: runEnv,
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

  it('passes the wrapper, with --label-file, the path its EnvironmentFile line loads, character for character, with substitution off', () => {
    // systemd resolves the one specifier for both lines, so the wrapper reads the
    // file systemd loaded; bot-errors.env can change HOME or PATH but not an
    // argument. The ":" prefix turns off the "$" substitution systemd applies to
    // ExecStart arguments and not to EnvironmentFile paths.
    const unit = readFileSync(unitPath, 'utf8');
    const labelFile = /^EnvironmentFile=-(.*\/release-drift\.env)$/m.exec(unit)?.[1];
    expect(labelFile).toBe('%h/.config/whatsoup/release-drift.env');
    const execStart = /^ExecStart=(.*)$/m.exec(unit)?.[1].split(/\s+/) ?? [];
    expect(execStart).toEqual([':%h/.local/bin/whatsoup-release-drift-linux.sh', '--label-file', labelFile]);
    expect(execStart[2] === labelFile).toBe(true);
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

  it('refuses when the environment and the dedicated file name different instances', () => {
    // systemd loads the label file last, so a different value in the environment
    // means systemd did not take it from that file as the wrapper reads it.
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-b',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a\n' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not match');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it('refuses a label in the dedicated file that systemd did not hand over in the environment', () => {
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a\n' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not match');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it('accepts the environment label when the last assignment in the file names it, past # and ; comment lines', () => {
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-a',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, {
      labelFile: [
        'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-x',
        'OTHER_KEY=1',
        'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a',
        '# WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-y',
        '; WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-z',
      ].join('\n'),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(observedInstance(release.argsFile)).toBe('bot-a');
  });

  // Each value is one systemd hands over as bot-a: it removes one pair of
  // matching quotes and the whitespace after an unquoted value.
  it.each([
    ['double quotes', 'WHATSOUP_RELEASE_DRIFT_INSTANCE="bot-a"\n'],
    ['single quotes', "WHATSOUP_RELEASE_DRIFT_INSTANCE='bot-a'\n"],
    ['trailing spaces', 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a  \n'],
    ['a CRLF line end', 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a\r\n'],
  ])('accepts a label written with %s, as systemd reads it', (_name, labelFile) => {
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-a',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile });

    expect(result.status, result.stderr).toBe(0);
    expect(observedInstance(release.argsFile)).toBe('bot-a');
  });

  it('reads an indented later assignment, as systemd does', () => {
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-b',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a\n  WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-b\n' });

    expect(result.status, result.stderr).toBe(0);
    expect(observedInstance(release.argsFile)).toBe('bot-b');
  });

  it('refuses a label line inside a multi-line quoted value, which systemd reads as part of that value', () => {
    // systemd sets only NOTE from this file, so the environment holds no label.
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: "NOTE='example configuration\nWHATSOUP_RELEASE_DRIFT_INSTANCE=bot-b\nend'\n" });

    expect(result.status).toBe(2);
    expect(existsSync(release.argsFile)).toBe(false);
  });

  // A later assignment that this reader takes differently from systemd must end
  // in a refusal or in agreement, never in the superseded label. The environment
  // value is what systemd hands over in each case.
  it.each([
    ['spaces around "=" (systemd sets bot-c; this reader keeps bot-a)', 'WHATSOUP_RELEASE_DRIFT_INSTANCE = bot-c\n', 'bot-c', null],
    ['spaces around "=", if systemd skipped that line', 'WHATSOUP_RELEASE_DRIFT_INSTANCE = bot-c\n', 'bot-a', 'bot-a'],
    ['an indented line (both read bot-c)', '  WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-c\n', 'bot-c', 'bot-c'],
    ['an indented line, against an environment holding the earlier value', '  WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-c\n', 'bot-a', null],
  ])('a later assignment with %s exits 2 unless both readings agree', (_name, laterLine, environmentLabel, observed) => {
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: environmentLabel,
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: `WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-a\n${laterLine}` });

    if (observed === null) {
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('does not match');
      expect(existsSync(release.argsFile)).toBe(false);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(observedInstance(release.argsFile)).toBe(observed);
    }
  });

  it('reads the label file its argument names, not one under HOME', () => {
    // The unit passes %h's file, the one its EnvironmentFile line loads; HOME here
    // can come from bot-errors.env or a drop-in.
    const release = fakeRelease(0);
    const home = tmp.make('home');
    writeLabelFile(home, 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-b\n');
    const result = runWrapper({
      HOME: home,
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-a',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelHome: tmp.make('unit-home') });

    expect(result.status, result.stderr).toBe(0);
    expect(observedInstance(release.argsFile)).toBe('bot-a');
  });

  it('refuses when only the folder HOME names holds a label file', () => {
    const release = fakeRelease(0);
    const home = tmp.make('home');
    writeLabelFile(home, 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-b\n');
    const result = runWrapper({
      HOME: home,
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-b',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelHome: tmp.make('unit-home'), labelFile: null });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('WHATSOUP_RELEASE_DRIFT_INSTANCE is not set');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it('reads the --label-file path whatever PATH holds: a getent there naming another home changes nothing', () => {
    // The wrapper looks nothing up; this getent would name a home whose label file
    // agrees with the environment while the named file does not.
    const release = fakeRelease(0);
    const otherHome = tmp.make('other-home');
    writeLabelFile(otherHome, 'WHATSOUP_RELEASE_DRIFT_INSTANCE=bot-b\n');
    const shims = tmp.make('shims');
    writeGetentShim(shims, otherHome);
    const result = runWrapper({
      PATH: `${shims}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-b',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { labelFile: '' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('WHATSOUP_RELEASE_DRIFT_INSTANCE is not set');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it.each([
    ['no argument', []],
    ['the path without --label-file', ['/nonexistent/release-drift.env']],
    ['--label-file without a path', ['--label-file']],
    ['a relative path', ['--label-file', '.config/whatsoup/release-drift.env']],
    ['an extra argument', ['--label-file', '/nonexistent/a', '/nonexistent/b']],
  ])('fails closed with %s for the label file, and never falls back to HOME', (_name, args) => {
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-a',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { args });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--label-file');
    expect(existsSync(release.argsFile)).toBe(false);
  });

  it('fails closed with exit 2, not a shell abort, when HOME is unset', () => {
    // The launcher and log folder are set, so no default needs HOME.
    const release = fakeRelease(0);
    const result = runWrapper({
      WHATSOUP_RELEASE_DRIFT_INSTANCE: 'bot-a',
      WHATSOUP_LAUNCHER: release.launcher,
      WHATSOUP_RELEASE_DRIFT_LOG_DIR: release.logDir,
    }, { unsetHome: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('HOME is not set');
    expect(existsSync(release.argsFile)).toBe(false);
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
    // A systemd user unit has no SSH agent socket by default, so an SSH default
    // is inconclusive on a host without a key the unit can use.
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
