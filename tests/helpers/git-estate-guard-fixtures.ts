import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
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
