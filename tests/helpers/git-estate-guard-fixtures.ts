import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { trackTmpDirs } from './tmp-dir.ts';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const script = resolve(repoRoot, 'scripts/git-estate-guard.ts');
export const tmp = trackTmpDirs('');
// #3488: the guard's default git budget (5 s) is tighter than vitest's 10 s
// test timeout, so a git starved under host load failed as an exit-2
// assertion. Give every guard subprocess a budget above the test timeout so
// starvation surfaces as a runner timeout. Cases that need a tighter budget
// still override it through `extraEnv`.
const SUITE_GIT_TIMEOUT_MS = '20000';
// #3561: the status-timeout cases shrink the ONE budget every guard git call
// shares (gitTimeoutMs, scripts/git-estate-guard.ts:100-113, used by runGit and
// runGitAsync), so it must still cover each real setup call under gate load.
// 300 ms did not: a setup call died first and the snapshot became scan_failed.
export const STATUS_TIMEOUT_GIT_BUDGET_MS = 3_000;
export const STATUS_PROBE_HANG_SECONDS = 30;
const STATUS_XY_CHARACTERS = ['.', 'M', 'T', 'A', 'D', 'R', 'C'] as const;
export const ALL_TRACKED_XY = STATUS_XY_CHARACTERS.flatMap((indexStatus) =>
  STATUS_XY_CHARACTERS.map((worktreeStatus) => `${indexStatus}${worktreeStatus}`)
);
export const EXPECTED_ORDINARY_XY = new Set([
  '.M', '.T', '.A', '.D',
  'M.', 'MM', 'MT', 'MD',
  'T.', 'TM', 'TT', 'TD',
  'A.', 'AM', 'AT', 'AD',
  'D.',
]);
export const EXPECTED_RENAME_XY = new Set([
  'R.', 'RM', 'RT', 'RD',
  'C.', 'CM', 'CT', 'CD',
  '.R', '.C',
]);
export const EXPECTED_UNMERGED_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
export const INVALID_RENAME_XY = [
  'RR', 'RC', 'CR', 'CC',
  'MR', 'MC', 'TR', 'TC', 'AR', 'AC',
] as const;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface SnapshotDocument {
  schemaVersion: 1;
  command: 'snapshot';
  exitCode: number;
  snapshot: {
    statusScope: 'pusher' | 'repository';
    commonDir: string;
    baselinePath: string;
    snapshotHash: string;
    incomplete: boolean;
    racing: boolean;
    worktrees: Array<{
      path: string;
      head: string | null;
      primary: boolean;
      detached: boolean;
      operationBranch: string | null;
      locked: boolean;
      prunable: boolean;
      status: {
        branchOid: string | null;
        tracked: Array<{ path: string; xy: string }>;
        untracked: string[];
        conflicts: Array<{
          path: string;
          xy: string;
          stageOids: [string, string, string];
        }>;
      } | null;
    }>;
    branches: Array<{
      name: string;
      scopeName: string;
      oid: string;
      upstream: string | null;
      ahead: number;
      behind: number;
      gone: boolean;
    }>;
    stashes: Array<{ oid: string; parents: string[]; branch: string | null }>;
    findings: Array<{ id: string; kind: string; worktree?: string; branch?: string }>;
    errors: Array<{ kind: string; message: string; worktree?: string }>;
  };
}

export interface GuardDocument {
  schemaVersion: 1;
  command: 'guard';
  phase: 'pre-commit' | 'pre-push';
  exitCode: number;
  baseline: { state: 'valid' | 'missing' | 'malformed'; path: string };
  decision: {
    blocked: boolean;
    newConflictIds: string[];
    newCriticalFindingIds: string[];
    blockingFindingIds: string[];
    advisoryFindingIds: string[];
    scopedRacing: boolean;
    scopedRacingWorktrees: string[];
    scopedRacingBranches: string[];
    advisoryRacingWorktrees: string[];
    advisoryRacingBranches: string[];
    reasons: string[];
    blockingReasons: string[];
    advisoryReasons: string[];
    countGrowth: { worktrees: number; branches: number };
    newWorktreeIds: string[];
    newBranchIds: string[];
    exemptedWorktreeIds: string[];
    exemptedBranchIds: string[];
    warningCounts: Record<string, number>;
  };
  snapshot: SnapshotDocument['snapshot'] | null;
}

export interface BaselineWriteDocument {
  schemaVersion: 1;
  command: 'baseline';
  action: 'write';
  exitCode: number;
  baseline: {
    path: string;
    snapshotHash: string;
    findingCount: number;
    worktreeCount: number;
    branchCount: number;
  } | null;
}

export interface BaselineAcceptStashDocument {
  schemaVersion: 1;
  command: 'baseline';
  action: 'accept-stash';
  exitCode: number;
  baseline: BaselineWriteDocument['baseline'];
  acceptedStash?: {
    oid: string;
    findingId: string;
    parentCount: number;
  };
  admission?: {
    reason: string;
    reasonSha256: string;
  };
}

export function run(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): CliResult {
  const proc = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', script, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NO_COLOR: '1',
        WHATSOUP_GIT_ESTATE_GIT_TIMEOUT_MS: SUITE_GIT_TIMEOUT_MS,
        ...extraEnv,
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}

export function git(cwd: string, args: string[], expectedStatus = 0): string {
  const proc = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Estate Test',
      GIT_AUTHOR_EMAIL: 'estate@example.test',
      GIT_COMMITTER_NAME: 'Estate Test',
      GIT_COMMITTER_EMAIL: 'estate@example.test',
    },
  });
  expect(proc.status, proc.stderr).toBe(expectedStatus);
  return proc.stdout.trim();
}

export function initRepo(objectFormat: 'sha1' | 'sha256' = 'sha1'): { root: string; repo: string } {
  const root = tmp.make('whatsoup-git-estate');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', `--object-format=${objectFormat}`, '--initial-branch=main']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'base']);
  return { root, repo };
}

export function snapshot(repo: string): SnapshotDocument {
  const result = run(repo, ['snapshot', '--json']);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as SnapshotDocument;
}

export function expectOnlyNarrowBaselineFieldsChanged(
  beforeRaw: string,
  afterRaw: string,
  addedFindingId: string,
): void {
  const before = JSON.parse(beforeRaw) as Record<string, unknown>;
  const after = JSON.parse(afterRaw) as Record<string, unknown>;
  const expected = {
    ...before,
    findingIds: [...(before['findingIds'] as string[]), addedFindingId].sort(),
    snapshotHash: after['snapshotHash'],
    payloadHash: after['payloadHash'],
  };
  expect(after).toEqual(expected);
  // The normal writer is canonical, so this also checks literal preservation
  // of every unselected baseline field rather than only semantic equality.
  expect(afterRaw).toBe(`${JSON.stringify(expected)}\n`);
}


export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

// The second topology call follows all first-pass status calls, so mutations
// here exercise real Git captures without scheduling races or production hooks.
export function betweenScansEnvironment(
  root: string,
  change: string,
  statusOverride = '',
): { env: NodeJS.ProcessEnv; marker: string } {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `between-scans-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const first = join(bin, 'first');
  const marker = join(bin, 'changed');
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
set -eu
real_git=${shellQuote(resolvedGit.stdout.trim())}
worktree_path="$3"
is_topology=0
is_status=0
for arg in "$@"; do
  if [ "$arg" = "worktree" ]; then is_topology=1; fi
  if [ "$arg" = "status" ]; then is_status=1; fi
done
if [ "$is_topology" -eq 1 ]; then
  if [ -e ${shellQuote(first)} ] && [ ! -e ${shellQuote(marker)} ]; then
    : > ${shellQuote(marker)}
${change}
  fi
  : > ${shellQuote(first)}
fi
scan_pass=1
if [ -e ${shellQuote(marker)} ]; then scan_pass=2; fi
if [ "$is_status" -eq 1 ]; then
${statusOverride || '  :'}
fi
exec "$real_git" "$@"
`);
  chmodSync(wrapper, 0o755);
  return { env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` }, marker };
}

export function statusRaceEnvironment(
  root: string,
  target: string,
): { env: NodeJS.ProcessEnv; marker: string } {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, 'race-bin');
  const marker = join(root, 'race-triggered');
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
is_status=0
for arg in "$@"; do
  if [ "$arg" = "status" ]; then
    is_status=1
  fi
done
if [ "$is_status" -eq 1 ] && [ ! -e ${shellQuote(marker)} ]; then
  ${shellQuote(resolvedGit.stdout.trim())} "$@"
  result=$?
  printf 'raced\\n' > ${shellQuote(target)}
  : > ${shellQuote(marker)}
  exit "$result"
fi
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return {
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    },
    marker,
  };
}

export function statusOutputEnvironment(
  root: string,
  statusBody: string,
): NodeJS.ProcessEnv {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `status-bin-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
is_status=0
for arg in "$@"; do
  if [ "$arg" = "status" ]; then
    is_status=1
  fi
done
if [ "$is_status" -eq 1 ]; then
${statusBody}
  exit 0
fi
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return {
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  };
}

/**
 * #3561: the guard applies ONE git budget to every subprocess, setup calls
 * included, so a status-timeout case cannot shrink the budget for the status
 * probe alone. Instead the FIRST status probe hangs far past any budget (exec,
 * so the guard's kill reaches the sleeping pid), while every other call is real
 * git. `setupDelaySeconds` delays the single pre-status `--show-toplevel`
 * discovery so a case can prove setup calls get real headroom under the budget.
 */
export function statusProbeHangEnvironment(
  root: string,
  hangSeconds: number,
  setupDelaySeconds = 0,
): { env: NodeJS.ProcessEnv; marker: string } {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `status-hang-bin-${Math.random().toString(16).slice(2)}`);
  const marker = join(root, `status-hang-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
is_status=0
is_toplevel=0
for arg in "$@"; do
  if [ "$arg" = "status" ]; then is_status=1; fi
  if [ "$arg" = "--show-toplevel" ]; then is_toplevel=1; fi
done
if [ "$is_status" -eq 1 ] && [ ! -e ${shellQuote(marker)} ]; then
  : > ${shellQuote(marker)}
  exec sleep ${String(hangSeconds)}
fi
if [ "$is_toplevel" -eq 1 ] && [ ${String(setupDelaySeconds)} -gt 0 ]; then
  sleep ${String(setupDelaySeconds)}
fi
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return { env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` }, marker };
}

export function worktreeOutputEnvironment(
  root: string,
  worktreeBody: string,
): NodeJS.ProcessEnv {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `worktree-bin-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
is_worktree=0
for arg in "$@"; do
  if [ "$arg" = "worktree" ]; then
    is_worktree=1
  fi
done
if [ "$is_worktree" -eq 1 ]; then
${worktreeBody}
  exit 0
fi
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return {
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  };
}

export function gitCallLogEnvironment(
  root: string,
): { env: NodeJS.ProcessEnv; log: string } {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `call-log-bin-${Math.random().toString(16).slice(2)}`);
  const log = join(root, `git-calls-${Math.random().toString(16).slice(2)}.log`);
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(log)}
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return {
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    },
    log,
  };
}

export function gitInspectionFailureEnvironment(root: string): NodeJS.ProcessEnv {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `inspection-bin-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "cat-file" ]; then
    exit 71
  fi
done
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return { PATH: `${bin}:${process.env['PATH'] ?? ''}` };
}

export function stashChangeEnvironment(root: string): { env: NodeJS.ProcessEnv; marker: string } {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `stash-race-bin-${Math.random().toString(16).slice(2)}`);
  const marker = join(root, `stash-race-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
is_closure=0
for arg in "$@"; do
  if [ "$arg" = "rev-list" ]; then is_closure=1; fi
done
if [ "$is_closure" -eq 1 ] && [ ! -e ${shellQuote(marker)} ]; then
  ${shellQuote(resolvedGit.stdout.trim())} --no-optional-locks -C "$PWD" update-ref refs/stash HEAD
  : > ${shellQuote(marker)}
fi
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return { env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` }, marker };
}

export function baselineChangeEnvironment(
  root: string,
  baselinePath: string,
): { env: NodeJS.ProcessEnv; marker: string } {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `baseline-race-bin-${Math.random().toString(16).slice(2)}`);
  const marker = join(root, `baseline-race-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
is_closure=0
for arg in "$@"; do
  if [ "$arg" = "rev-list" ]; then is_closure=1; fi
done
if [ "$is_closure" -eq 1 ] && [ ! -e ${shellQuote(marker)} ]; then
  printf '\\n' >> ${shellQuote(baselinePath)}
  : > ${shellQuote(marker)}
fi
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return { env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` }, marker };
}

export function finalClosureBaselineChangeEnvironment(
  root: string,
  baselinePath: string,
): { env: NodeJS.ProcessEnv; marker: string } {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, `final-baseline-race-bin-${Math.random().toString(16).slice(2)}`);
  const marker = join(root, `final-baseline-race-${Math.random().toString(16).slice(2)}`);
  const count = join(root, `final-baseline-race-count-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
is_rev_list=0
is_objects=0
for arg in "$@"; do
  if [ "$arg" = "rev-list" ]; then is_rev_list=1; fi
  if [ "$arg" = "--objects" ]; then is_objects=1; fi
done
if [ "$is_rev_list" -eq 1 ] && [ "$is_objects" -eq 1 ]; then
  count=0
  if [ -f ${shellQuote(count)} ]; then count=$(cat ${shellQuote(count)}); fi
  count=$((count + 1))
  printf '%s\\n' "$count" > ${shellQuote(count)}
  if [ "$count" -eq 2 ]; then
    printf '\\n' >> ${shellQuote(baselinePath)}
    : > ${shellQuote(marker)}
  fi
fi
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return { env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` }, marker };
}

export function readGitCalls(log: string): string[] {
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
}

export function statusConcurrencyEnvironment(
  root: string,
): { env: NodeJS.ProcessEnv; counts: string } {
  const resolvedGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  expect(resolvedGit.status, resolvedGit.stderr).toBe(0);
  const bin = join(root, 'concurrency-bin');
  const state = join(root, 'concurrency-state');
  const counts = join(state, 'counts.log');
  mkdirSync(bin);
  mkdirSync(state);
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
is_status=0
for arg in "$@"; do
  if [ "$arg" = "status" ]; then
    is_status=1
  fi
done
if [ "$is_status" -eq 1 ]; then
  marker=${shellQuote(`${state}/active-`)}"$$"
  : > "$marker"
  active_count="$(find ${shellQuote(state)} -name 'active-*' -type f | wc -l | tr -d ' ')"
  printf '%s\\n' "$active_count" >> ${shellQuote(counts)}
  sleep 0.15
  rm -f "$marker"
fi
exec ${shellQuote(resolvedGit.stdout.trim())} "$@"
`);
  chmodSync(wrapper, 0o755);
  return {
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    },
    counts,
  };
}
