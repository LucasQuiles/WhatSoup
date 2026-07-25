import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isFullObjectId,
  main as runGitEstateGuard,
  parseBranches,
  parseStashes,
  parseStatus,
  parseWorktreePorcelain,
} from '../../scripts/git-estate-guard.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(repoRoot, 'scripts/git-estate-guard.ts');
const scratchRoots: string[] = [];
const STATUS_XY_CHARACTERS = ['.', 'M', 'T', 'A', 'D', 'R', 'C'] as const;
const ALL_TRACKED_XY = STATUS_XY_CHARACTERS.flatMap((indexStatus) =>
  STATUS_XY_CHARACTERS.map((worktreeStatus) => `${indexStatus}${worktreeStatus}`)
);
const ORDINARY_XY = new Set([
  '.M', '.T', '.A', '.D',
  'M.', 'MM', 'MT', 'MD',
  'T.', 'TM', 'TT', 'TD',
  'A.', 'AM', 'AT', 'AD',
  'D.',
]);
const RENAME_XY = new Set([
  'R.', 'RM', 'RT', 'RD', 'RR', 'RC',
  'C.', 'CM', 'CT', 'CD', 'CR', 'CC',
  '.R', '.C', 'MR', 'MC', 'TR', 'TC', 'AR', 'AC',
]);
const UNMERGED_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface SnapshotDocument {
  schemaVersion: 1;
  command: 'snapshot';
  exitCode: number;
  snapshot: {
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
      oid: string;
      upstream: string | null;
      ahead: number;
      behind: number;
      gone: boolean;
    }>;
    stashes: Array<{ oid: string; parents: string[] }>;
    findings: Array<{ id: string; kind: string }>;
    errors: Array<{ kind: string; message: string }>;
  };
}

interface GuardDocument {
  schemaVersion: 1;
  command: 'guard';
  phase: 'pre-commit' | 'pre-push';
  exitCode: number;
  baseline: { state: 'valid' | 'missing' | 'malformed'; path: string };
  decision: {
    blocked: boolean;
    newConflictIds: string[];
    newCriticalFindingIds: string[];
    countGrowth: { worktrees: number; branches: number };
    newWorktreeIds: string[];
    newBranchIds: string[];
    exemptedWorktreeIds: string[];
    exemptedBranchIds: string[];
    warningCounts: Record<string, number>;
  };
  snapshot: SnapshotDocument['snapshot'] | null;
}

interface BaselineWriteDocument {
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

function run(
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
      env: { ...process.env, NO_COLOR: '1', ...extraEnv },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function statusRaceEnvironment(
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

function statusOutputEnvironment(
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

function worktreeOutputEnvironment(
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

function gitCallLogEnvironment(
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

function readGitCalls(log: string): string[] {
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
}

function statusConcurrencyEnvironment(
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

function git(cwd: string, args: string[], expectedStatus = 0): string {
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

function initRepo(objectFormat: 'sha1' | 'sha256' = 'sha1'): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-git-estate-'));
  scratchRoots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', `--object-format=${objectFormat}`, '--initial-branch=main']);
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'base']);
  return { root, repo };
}

function snapshot(repo: string): SnapshotDocument {
  const result = run(repo, ['snapshot', '--json']);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as SnapshotDocument;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('git-estate guard', () => {
  it('exposes the exact guard entrypoint for in-process harnesses', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runGitEstateGuard(['--help'], repoRoot)).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('git-estate-guard snapshot'));
      expect(await runGitEstateGuard(
        ['guard', '--phase', 'later', '--json'],
        repoRoot,
      )).toBe(64);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('pre-commit|pre-push'));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('snapshots every worktree with canonical stable hashing and filename-safe human output', () => {
    const { root, repo } = initRepo();
    const linked = join(root, 'linked');
    git(repo, ['worktree', 'add', '-b', 'feature/linked', linked]);
    writeFileSync(join(linked, 'tracked  two-spaces.txt'), 'clean\n');
    git(linked, ['add', 'tracked  two-spaces.txt']);
    git(linked, ['commit', '-m', 'add unusual tracked path']);
    writeFileSync(join(linked, 'tracked.txt'), 'dirty\n');
    writeFileSync(join(linked, 'tracked  two-spaces.txt'), 'dirty\n');
    writeFileSync(join(linked, 'secret-payroll-plan.txt'), 'untracked\n');

    const first = snapshot(repo);
    const second = snapshot(repo);
    expect(first.snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.snapshot.snapshotHash).toBe(first.snapshot.snapshotHash);
    expect(first.snapshot.worktrees).toHaveLength(2);
    const linkedState = first.snapshot.worktrees.find(({ path }) => path === linked);
    expect(linkedState?.status?.tracked).toEqual([
      expect.objectContaining({ path: 'tracked  two-spaces.txt', xy: '.M' }),
      expect.objectContaining({ path: 'tracked.txt', xy: '.M' }),
    ]);
    expect(linkedState?.status?.untracked).toEqual(['secret-payroll-plan.txt']);

    const human = run(repo, ['snapshot']);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('dirty=2');
    expect(human.stdout).toContain('untracked=1');
    expect(human.stdout).not.toContain('secret-payroll-plan.txt');
    expect(human.stdout).not.toContain('tracked.txt');
  });

  it.each([
    ['empty output', '  :'],
    [
      'missing branch.head',
      `  printf '\\043 branch.oid ${'a'.repeat(40)}\\000'`,
    ],
    [
      'truncated ordinary record',
      `  printf '\\043 branch.oid ${'a'.repeat(40)}\\000\\043 branch.head main\\0001 .M\\000'`,
    ],
    [
      'ordinary record with an empty fixed field',
      `  printf '\\043 branch.oid ${'a'.repeat(40)}\\000\\043 branch.head main\\0001 .M N... 100644 100644 100644 ${'b'.repeat(40)}  tracked.txt\\000'`,
    ],
  ])('fails closed on exit-zero %s from porcelain-v2 status', (_label, statusBody) => {
    const { root, repo } = initRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'dirty\n');
    const result = run(
      repo,
      ['snapshot', '--json'],
      statusOutputEnvironment(root, statusBody),
    );

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout) as SnapshotDocument).toMatchObject({
      exitCode: 2,
      snapshot: {
        incomplete: true,
        errors: [expect.objectContaining({ kind: 'worktree_status_failed' })],
      },
    });
  });

  it.each(Array.from({ length: 23 }, (_, index) => index + 41))(
    'rejects a %i-character object ID between the supported widths',
    (width) => {
      expect(isFullObjectId('a'.repeat(width))).toBe(false);
      expect(() => parseStatus(
        `# branch.oid ${'a'.repeat(width)}\0# branch.head main\0`,
      )).toThrow(/branch\.oid/);
    },
  );

  it.each([40, 64])('accepts an exact %i-character object ID', (width) => {
    expect(isFullObjectId('a'.repeat(width))).toBe(true);
  });

  it('accepts real Git SHA-256 output across worktree, status, branch, and stash scans', () => {
    const { repo } = initRepo('sha256');
    writeFileSync(join(repo, 'tracked.txt'), 'dirty\n');

    const dirty = snapshot(repo);
    expect(dirty.snapshot.worktrees[0]).toMatchObject({
      head: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: {
        branchOid: expect.stringMatching(/^[0-9a-f]{64}$/),
        tracked: [expect.objectContaining({ path: 'tracked.txt', xy: '.M' })],
      },
    });
    expect(dirty.snapshot.branches).toEqual([
      expect.objectContaining({
        name: 'main',
        oid: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);

    git(repo, ['stash', 'push', '-m', 'sha256 fixture']);
    const stashed = snapshot(repo);
    expect(stashed.snapshot.stashes).toEqual([
      {
        oid: expect.stringMatching(/^[0-9a-f]{64}$/),
        parents: expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{64}$/)]),
      },
    ]);
  });

  it.each([
    [
      'ordinary XY',
      `1 ZZ N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} tracked.txt`,
    ],
    [
      'ordinary submodule state',
      `1 .M SXYZ 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} tracked.txt`,
    ],
    [
      'ordinary mode',
      `1 .M N... 100648 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} tracked.txt`,
    ],
    [
      'ordinary object ID',
      `1 .M N... 100644 100644 100644 ${'a'.repeat(41)} ${'b'.repeat(40)} tracked.txt`,
    ],
    [
      'rename XY',
      `2 ZZ N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} R100 renamed.txt\\000original.txt`,
    ],
    [
      'rename submodule state',
      `2 R. SXYZ 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} R100 renamed.txt\\000original.txt`,
    ],
    [
      'rename mode',
      `2 R. N... 100644 100644 888888 ${'a'.repeat(40)} ${'b'.repeat(40)} R100 renamed.txt\\000original.txt`,
    ],
    [
      'rename object ID',
      `2 R. N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(63)} R100 renamed.txt\\000original.txt`,
    ],
    [
      'rename score kind',
      `2 R. N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} X100 renamed.txt\\000original.txt`,
    ],
    [
      'rename score range',
      `2 R. N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} R101 renamed.txt\\000original.txt`,
    ],
    [
      'rename score/XY mismatch',
      `2 R. N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} C75 renamed.txt\\000original.txt`,
    ],
    [
      'unmerged XY',
      `u ZZ N... 100644 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)} conflicted.txt`,
    ],
    [
      'unmerged submodule state',
      `u UU SXYZ 100644 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)} conflicted.txt`,
    ],
    [
      'unmerged mode',
      `u UU N... 100644 100644 100649 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)} conflicted.txt`,
    ],
    [
      'unmerged object ID',
      `u UU N... 100644 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(52)} ${'c'.repeat(40)} conflicted.txt`,
    ],
  ])('fails closed on nonempty garbage in the %s field', (_label, record) => {
    expect(() => parseStatus(
      `# branch.oid ${'d'.repeat(40)}\0# branch.head main\0${record.replace('\\000', '\0')}\0`,
    )).toThrow(/status record|stage identities/);
  });

  it.each(ALL_TRACKED_XY)(
    'enforces the exhaustive ordinary-record XY matrix for %s',
    (xy) => {
      const oid = 'a'.repeat(40);
      const parse = () => parseStatus(
        `# branch.oid ${oid}\0# branch.head main\0`
        + `1 ${xy} N... 100644 100644 100644 ${oid} ${oid} tracked.txt\0`,
      );

      if (ORDINARY_XY.has(xy)) expect(parse).not.toThrow();
      else expect(parse).toThrow(/ordinary status record/);
    },
  );

  it.each(ALL_TRACKED_XY)(
    'enforces the exhaustive rename/copy-record XY matrix for %s',
    (xy) => {
      const oid = 'a'.repeat(40);
      const scoreKind = xy.match(/[RC]/)?.[0] ?? 'R';
      const parse = () => parseStatus(
        `# branch.oid ${oid}\0# branch.head main\0`
        + `2 ${xy} N... 100644 100644 100644 ${oid} ${oid} `
        + `${scoreKind}100 renamed.txt\0original.txt\0`,
      );

      if (RENAME_XY.has(xy)) expect(parse).not.toThrow();
      else expect(parse).toThrow(/rename\/copy status record/);
    },
  );

  it.each(ALL_TRACKED_XY)(
    'enforces the exhaustive unmerged-record XY matrix for %s',
    (xy) => {
      const oid = 'a'.repeat(40);
      const parse = () => parseStatus(
        `# branch.oid ${oid}\0# branch.head main\0`
        + `u ${xy} N... 100644 100644 100644 100644 `
        + `${oid} ${oid} ${oid} conflicted.txt\0`,
      );

      if (UNMERGED_XY.has(xy)) expect(parse).not.toThrow();
      else expect(parse).toThrow(/unmerged stage identities/);
    },
  );

  it.each([40, 64])(
    'accepts exact %i-character object IDs in every porcelain-v2 tracked record',
    (width) => {
      const oid = 'a'.repeat(width);
      const records = [
        `1 .M N... 100644 100644 100644 ${oid} ${oid} tracked path.txt`,
        `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 renamed path.txt\0original path.txt`,
        `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflicted path.txt`,
      ];

      for (const record of records) {
        expect(() => parseStatus(
          `# branch.oid ${oid}\0# branch.head main\0${record}\0`,
        )).not.toThrow();
      }
    },
  );

  it.each([
    ['unknown XY', 'ZZ'],
    ['unmerged AA disguised as ordinary', 'AA'],
    ['unmerged DD disguised as ordinary', 'DD'],
  ])('fails closed end-to-end on %s', (_label, xy) => {
    const { root, repo } = initRepo();
    const result = run(
      repo,
      ['snapshot', '--json'],
      statusOutputEnvironment(
        root,
        `  printf '\\043 branch.oid ${'a'.repeat(40)}\\000\\043 branch.head main\\0001 ${xy} N... 100644 100644 100644 ${'b'.repeat(40)} ${'c'.repeat(40)} tracked.txt\\000'`,
      ),
    );

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout) as SnapshotDocument).toMatchObject({
      exitCode: 2,
      snapshot: {
        incomplete: true,
        errors: [expect.objectContaining({ kind: 'worktree_status_failed' })],
      },
    });
  });

  it('preserves NUL-delimited paths and ignores valid ignored records', () => {
    const status = parseStatus(
      `# branch.oid ${'a'.repeat(40)}\0# branch.head main\0`
      + '? untracked path.txt\0! ignored path.txt\0'
      + `2 R. N... 100644 100644 100644 ${'b'.repeat(40)} ${'c'.repeat(40)} `
      + 'R100 renamed path.txt\0original path.txt\0',
    );

    expect(status.untracked).toEqual(['untracked path.txt']);
    expect(status.tracked).toContainEqual(expect.objectContaining({
      path: 'renamed path.txt',
      originalPath: 'original path.txt',
    }));
  });

  it.each([41, 52, 63])(
    'fails closed on a %i-character worktree HEAD object ID',
    (width) => {
      expect(() => parseWorktreePorcelain(
        `worktree /repo\0HEAD ${'a'.repeat(width)}\0branch refs/heads/main\0\0`,
      )).toThrow(/HEAD identity/);
    },
  );

  it.each([40, 64])('accepts an exact %i-character worktree HEAD object ID', (width) => {
    expect(parseWorktreePorcelain(
      `worktree /repo\0HEAD ${'a'.repeat(width)}\0branch refs/heads/main\0\0`,
    )).toEqual([
      expect.objectContaining({ path: '/repo', head: 'a'.repeat(width), branch: 'main' }),
    ]);
  });

  it('accepts canonical branch, detached, bare, locked, and prunable worktree records', () => {
    const oid = 'a'.repeat(40);
    expect(parseWorktreePorcelain(
      `worktree /branch path\0HEAD ${oid}\0branch refs/heads/main\0locked reason\nline\0\0`
      + `worktree /detached\0HEAD ${oid}\0detached\0prunable missing gitdir\0\0`
      + 'worktree /bare\0bare\0\0',
    )).toEqual([
      expect.objectContaining({
        path: '/branch path',
        head: oid,
        branch: 'main',
        detached: false,
        locked: true,
        lockReason: 'reason\nline',
        prunable: false,
      }),
      expect.objectContaining({
        path: '/detached',
        head: oid,
        branch: null,
        detached: true,
        locked: false,
        prunable: true,
        pruneReason: 'missing gitdir',
      }),
      expect.objectContaining({
        path: '/bare',
        head: null,
        branch: null,
        detached: false,
      }),
    ]);
  });

  it.each([
    [
      'attribute before worktree',
      `HEAD ${'a'.repeat(40)}\0worktree /repo\0branch refs/heads/main\0\0`,
    ],
    [
      'implicit record boundary',
      `worktree /one\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0`
      + `worktree /two\0HEAD ${'a'.repeat(40)}\0detached\0\0`,
    ],
    [
      'missing final record terminator',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0`,
    ],
    ['empty worktree path', 'worktree \0bare\0\0'],
    ['non-bare record without HEAD', 'worktree /repo\0branch refs/heads/main\0\0'],
    [
      'HEAD without branch or detached',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0\0`,
    ],
    [
      'bare record with HEAD',
      `worktree /repo\0bare\0HEAD ${'a'.repeat(40)}\0\0`,
    ],
    [
      'noncanonical branch ref',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0branch main\0\0`,
    ],
    [
      'branch and detached states',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0detached\0\0`,
    ],
    [
      'valued detached marker',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0detached reason\0\0`,
    ],
    ['valued bare marker', 'worktree /repo\0bare reason\0\0'],
    ['locked bare record', 'worktree /repo\0bare\0locked\0\0'],
    ['prunable bare record', 'worktree /repo\0bare\0prunable missing gitdir\0\0'],
    [
      'locked before checkout state',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0locked\0branch refs/heads/main\0\0`,
    ],
    [
      'prunable marker without reason',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0detached\0prunable\0\0`,
    ],
    [
      'duplicate locked marker',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0detached\0locked\0locked\0\0`,
    ],
    [
      'locked and prunable markers',
      `worktree /repo\0HEAD ${'a'.repeat(40)}\0detached\0locked\0`
      + 'prunable missing gitdir\0\0',
    ],
    ['extra empty record', 'worktree /repo\0bare\0\0\0'],
  ])('rejects canonical worktree grammar violation: %s', (_label, raw) => {
    expect(() => parseWorktreePorcelain(raw)).toThrow(/worktree/);
  });

  it('fails closed end-to-end when worktree porcelain begins out of record order', () => {
    const { root, repo } = initRepo();
    const oid = 'a'.repeat(40);
    const result = run(
      repo,
      ['snapshot', '--json'],
      worktreeOutputEnvironment(
        root,
        `  printf 'HEAD ${oid}\\000worktree ${repo}\\000branch refs/heads/main\\000\\000'`,
      ),
    );

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      exitCode: 2,
      snapshot: null,
      error: { kind: 'scan_failed' },
    });
  });

  it.each([41, 52, 63])(
    'fails closed on a %i-character local branch object ID',
    (width) => {
      expect(() => parseBranches(
        `main\0${'a'.repeat(width)}\0\0\0\n`,
      )).toThrow(/local branch record/);
    },
  );

  it.each([40, 64])('accepts an exact %i-character local branch object ID', (width) => {
    expect(parseBranches(
      `main\0${'a'.repeat(width)}\0\0\0\n`,
    )).toEqual([
      expect.objectContaining({ name: 'main', oid: 'a'.repeat(width) }),
    ]);
  });

  it.each([
    ['stash object ID', 41, 40],
    ['stash parent object ID', 40, 63],
  ])('fails closed on an unsupported-width %s', (_label, oidWidth, parentWidth) => {
    expect(() => parseStashes(
      `${'a'.repeat(oidWidth)}\0${'b'.repeat(parentWidth)}\0\n`,
    )).toThrow(/stash .* identity/);
  });

  it.each([40, 64])(
    'accepts exact %i-character stash and parent object IDs',
    (width) => {
      expect(parseStashes(
        `${'a'.repeat(width)}\0${'b'.repeat(width)}\0\n`,
      )).toEqual([
        {
          oid: 'a'.repeat(width),
          parents: ['b'.repeat(width)],
        },
      ]);
    },
  );

  it('enumerates detached, locked, prunable, no-upstream, gone, ahead, and behind state', () => {
    const { root, repo } = initRepo();
    const remote = join(root, 'remote.git');
    mkdirSync(remote);
    git(remote, ['init', '--bare']);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-u', 'origin', 'main']);

    git(repo, ['branch', 'no-upstream']);
    git(repo, ['branch', 'gone']);
    git(repo, ['push', '-u', 'origin', 'gone']);
    git(remote, ['update-ref', '-d', 'refs/heads/gone']);
    git(repo, ['fetch', '--prune']);

    const peer = join(root, 'peer');
    git(root, ['clone', remote, peer]);
    writeFileSync(join(peer, 'remote-only.txt'), 'remote\n');
    git(peer, ['add', 'remote-only.txt']);
    git(peer, ['commit', '-m', 'remote']);
    git(peer, ['push', 'origin', 'main']);
    writeFileSync(join(repo, 'local-only.txt'), 'local\n');
    git(repo, ['add', 'local-only.txt']);
    git(repo, ['commit', '-m', 'local']);
    git(repo, ['fetch', 'origin']);

    const detached = join(root, 'detached');
    git(repo, ['worktree', 'add', '--detach', detached, 'HEAD']);
    git(repo, ['worktree', 'lock', '--reason', 'test lock', detached]);
    const prunable = join(root, 'prunable');
    git(repo, ['worktree', 'add', '-b', 'prunable-branch', prunable]);
    rmSync(prunable, { recursive: true, force: true });

    const result = run(repo, ['snapshot', '--json']);
    expect(result.status).toBe(2);
    const doc = JSON.parse(result.stdout) as SnapshotDocument;
    expect(doc.snapshot.incomplete).toBe(true);
    expect(doc.snapshot.worktrees.find(({ path }) => path === detached)).toMatchObject({
      detached: true,
      locked: true,
    });
    expect(doc.snapshot.worktrees.find(({ path }) => path === prunable)?.prunable).toBe(true);
    expect(doc.snapshot.branches.find(({ name }) => name === 'no-upstream')?.upstream).toBeNull();
    expect(doc.snapshot.branches.find(({ name }) => name === 'gone')?.gone).toBe(true);
    expect(doc.snapshot.branches.find(({ name }) => name === 'main')).toMatchObject({
      ahead: 1,
      behind: 1,
      gone: false,
    });
  });

  it('enumerates stash object identity without leaking stash subjects or content', () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'PRIVATE-CONTENT\n');
    git(repo, ['stash', 'push', '-m', 'PRIVATE-STASH-SUBJECT']);

    const result = run(repo, ['snapshot', '--json']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('PRIVATE-STASH-SUBJECT');
    expect(result.stdout).not.toContain('PRIVATE-CONTENT');
    const doc = JSON.parse(result.stdout) as SnapshotDocument;
    expect(doc.snapshot.stashes).toEqual([
      {
        oid: expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        parents: expect.arrayContaining([
          expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        ]),
      },
    ]);
  });

  it('warns in pre-commit but blocks pre-push when the baseline is missing or malformed', () => {
    const { repo } = initRepo();
    const preCommit = run(repo, ['guard', '--phase', 'pre-commit', '--json']);
    expect(preCommit.status).toBe(0);
    expect(JSON.parse(preCommit.stdout) as GuardDocument).toMatchObject({
      exitCode: 0,
      baseline: { state: 'missing' },
      decision: { blocked: false },
    });

    const prePush = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(prePush.status).toBe(2);
    const missing = JSON.parse(prePush.stdout) as GuardDocument;
    expect(missing).toMatchObject({
      exitCode: 2,
      baseline: { state: 'missing' },
      decision: { blocked: true },
    });

    mkdirSync(dirname(missing.baseline.path), { recursive: true });
    writeFileSync(missing.baseline.path, '{"schemaVersion":1}\n');
    const malformed = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(malformed.status).toBe(2);
    expect(JSON.parse(malformed.stdout) as GuardDocument).toMatchObject({
      baseline: { state: 'malformed' },
      decision: { blocked: true },
    });
  });

  it('uses one estate capture for pre-commit while preserving two for pre-push', () => {
    const { root, repo } = initRepo();
    const prePushCalls = gitCallLogEnvironment(root);
    const prePush = run(
      repo,
      ['guard', '--phase', 'pre-push', '--json'],
      prePushCalls.env,
    );
    expect(prePush.status).toBe(2);
    const prePushLog = readGitCalls(prePushCalls.log);
    expect(prePushLog).toHaveLength(13);
    expect(prePushLog.filter((call) =>
      call.includes(' worktree list --porcelain -z')
    )).toHaveLength(2);
    expect(prePushLog.filter((call) =>
      call.includes(' status --porcelain=v2 --branch -z --untracked-files=all')
    )).toHaveLength(2);

    const preCommitCalls = gitCallLogEnvironment(root);
    const preCommit = run(
      repo,
      ['guard', '--phase', 'pre-commit', '--json'],
      preCommitCalls.env,
    );
    expect(preCommit.status).toBe(0);
    const preCommitLog = readGitCalls(preCommitCalls.log);
    expect(preCommitLog).toHaveLength(7);
    expect(preCommitLog.filter((call) =>
      call.includes(' worktree list --porcelain -z')
    )).toHaveLength(1);
    expect(preCommitLog.filter((call) =>
      call.includes(' status --porcelain=v2 --branch -z --untracked-files=all')
    )).toHaveLength(1);
  });

  it('keeps the same incomplete status advisory in pre-commit and blocking in pre-push', () => {
    const { root, repo } = initRepo();
    const env = statusOutputEnvironment(
      root,
      `  printf '\\043 branch.oid ${'a'.repeat(40)}\\000'`,
    );

    const preCommit = run(repo, ['guard', '--phase', 'pre-commit', '--json'], env);
    expect(preCommit.status).toBe(0);
    expect(preCommit.stderr).toContain('pre-commit warnings:');
    expect(preCommit.stderr).toContain('scan_incomplete');
    expect(JSON.parse(preCommit.stdout) as GuardDocument).toMatchObject({
      exitCode: 0,
      decision: { blocked: false },
      snapshot: {
        incomplete: true,
        errors: [expect.objectContaining({ kind: 'worktree_status_failed' })],
      },
    });

    const prePush = run(repo, ['guard', '--phase', 'pre-push', '--json'], env);
    expect(prePush.status).toBe(2);
    expect(prePush.stderr).toContain('pre-push warnings:');
    expect(prePush.stderr).toContain('scan_incomplete');
    expect(JSON.parse(prePush.stdout) as GuardDocument).toMatchObject({
      exitCode: 2,
      decision: { blocked: true },
      snapshot: {
        incomplete: true,
        errors: [expect.objectContaining({ kind: 'worktree_status_failed' })],
      },
    });
  });

  it('atomically accepts a complete snapshot as the supported baseline initializer', () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, 'tracked.txt'), 'accepted dirty state\n');
    writeFileSync(join(repo, 'accepted-untracked.txt'), 'accepted\n');

    const accepted = run(repo, ['baseline', 'write', '--json']);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout.trim().split('\n')).toHaveLength(1);
    const receipt = JSON.parse(accepted.stdout) as BaselineWriteDocument;
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      command: 'baseline',
      action: 'write',
      exitCode: 0,
      baseline: {
        snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        findingCount: 3,
        worktreeCount: 1,
        branchCount: 1,
      },
    });
    expect(receipt.baseline).not.toBeNull();
    const baselinePath = receipt.baseline!.path;
    const stored = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      schemaVersion: number;
      commonDir: string;
      snapshotHash: string;
      findingIds: string[];
      worktreeCount: number;
      branchCount: number;
      worktreeIds: string[];
      branchIds: string[];
      payloadHash: string;
    };
    expect(stored).toEqual({
      schemaVersion: 2,
      commonDir: dirname(dirname(baselinePath)),
      snapshotHash: receipt.baseline!.snapshotHash,
      findingIds: [...stored.findingIds].sort(),
      worktreeCount: 1,
      branchCount: 1,
      worktreeIds: [expect.stringMatching(/^worktree:[0-9a-f]{24}$/)],
      branchIds: [expect.stringMatching(/^branch:[0-9a-f]{24}$/)],
      payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(readdirSync(dirname(baselinePath)).filter((name) => name.includes('.tmp-'))).toEqual([]);

    const prePush = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(prePush.status, prePush.stderr).toBe(0);
    expect(JSON.parse(prePush.stdout) as GuardDocument).toMatchObject({
      baseline: { state: 'valid', path: baselinePath },
      decision: { blocked: false, newConflictIds: [] },
    });
  });

  it('rejects canonical baseline payload tampering, unsafe integers, invalid IDs, and unknown fields', () => {
    const { repo } = initRepo();
    const accepted = run(repo, ['baseline', 'write', '--json']);
    expect(accepted.status, accepted.stderr).toBe(0);
    const receipt = JSON.parse(accepted.stdout) as BaselineWriteDocument;
    expect(receipt.baseline).not.toBeNull();
    const baselinePath = receipt.baseline!.path;
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, unknown>;
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['snapshot hash without payload rebind', { ...baseline, snapshotHash: 'f'.repeat(64) }],
      ['count without payload rebind', { ...baseline, worktreeCount: 2 }],
      ['unsafe integer', { ...baseline, branchCount: Number.MAX_SAFE_INTEGER + 1 }],
      ['invalid finding identity', { ...baseline, findingIds: ['not-a-finding-id'] }],
      ['unknown schema field', { ...baseline, unexpected: true }],
    ];

    for (const [label, mutation] of mutations) {
      writeFileSync(baselinePath, `${JSON.stringify(mutation)}\n`);
      const guarded = run(repo, ['guard', '--phase', 'pre-push', '--json']);
      expect(guarded.status, label).toBe(2);
      expect(JSON.parse(guarded.stdout) as GuardDocument, label).toMatchObject({
        baseline: { state: 'malformed' },
        decision: { blocked: true },
      });
    }
  });

  it('uses stage identity so edits preserve an inherited conflict but a later same-path conflict blocks', () => {
    const { repo } = initRepo();
    git(repo, ['branch', 'side']);
    writeFileSync(join(repo, 'tracked.txt'), 'main\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'main change']);
    git(repo, ['switch', 'side']);
    writeFileSync(join(repo, 'tracked.txt'), 'side\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'side change']);
    git(repo, ['switch', 'main']);

    const cleanBaseline = snapshot(repo);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['merge', 'side'], 1);
    const conflict = snapshot(repo);
    const conflictIds = conflict.snapshot.findings
      .filter(({ kind }) => kind === 'conflict')
      .map(({ id }) => id);
    expect(conflictIds).toHaveLength(1);
    expect(conflict.snapshot.worktrees[0]?.status?.conflicts[0]?.stageOids).toEqual([
      expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    ]);

    const newConflict = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(newConflict.status).toBe(2);
    expect((JSON.parse(newConflict.stdout) as GuardDocument).decision.newConflictIds)
      .toEqual(conflictIds);

    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const sameConflict = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(sameConflict.status).toBe(0);
    expect((JSON.parse(sameConflict.stdout) as GuardDocument).decision.newConflictIds)
      .toEqual([]);

    writeFileSync(join(repo, 'tracked.txt'), 'unresolved working edit\n');
    const editedInherited = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(editedInherited.status).toBe(0);
    expect((JSON.parse(editedInherited.stdout) as GuardDocument).decision.newConflictIds)
      .toEqual([]);

    writeFileSync(join(repo, 'tracked.txt'), 'first resolution\n');
    git(repo, ['add', 'tracked.txt']);
    const resolved = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(resolved.status).toBe(0);
    expect((JSON.parse(resolved.stdout) as GuardDocument).decision.newConflictIds)
      .toEqual([]);
    git(repo, ['commit', '-m', 'resolve first conflict']);

    git(repo, ['switch', 'side']);
    writeFileSync(join(repo, 'tracked.txt'), 'side second change\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'side second change']);
    git(repo, ['switch', 'main']);
    writeFileSync(join(repo, 'tracked.txt'), 'main second change\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'main second change']);
    git(repo, ['merge', 'side'], 1);

    const laterConflict = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(laterConflict.status).toBe(2);
    const laterDecision = (JSON.parse(laterConflict.stdout) as GuardDocument).decision;
    expect(laterDecision.newConflictIds).toHaveLength(1);
    expect(laterDecision.newConflictIds).not.toEqual(conflictIds);
  });

  it('keeps one conflict operation stable but blocks an exact abort-and-replay instance', () => {
    const { repo } = initRepo();
    git(repo, ['branch', 'side']);
    writeFileSync(join(repo, 'tracked.txt'), 'main\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'main change']);
    git(repo, ['switch', 'side']);
    writeFileSync(join(repo, 'tracked.txt'), 'side\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'side change']);
    git(repo, ['switch', 'main']);
    git(repo, ['merge', 'side'], 1);

    const first = snapshot(repo);
    const firstConflictId = first.snapshot.findings.find(({ kind }) => kind === 'conflict')?.id;
    expect(firstConflictId).toMatch(/^conflict:/);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);

    writeFileSync(join(repo, 'tracked.txt'), 'unresolved edit in the same operation\n');
    const edited = snapshot(repo);
    expect(edited.snapshot.findings.find(({ kind }) => kind === 'conflict')?.id)
      .toBe(firstConflictId);

    git(repo, ['merge', '--abort']);
    git(repo, ['merge', 'side'], 1);
    const replayed = snapshot(repo);
    const replayedConflictId = replayed.snapshot.findings
      .find(({ kind }) => kind === 'conflict')?.id;
    expect(replayedConflictId).toMatch(/^conflict:/);
    expect(replayedConflictId).not.toBe(firstConflictId);

    const guarded = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(guarded.status).toBe(2);
    expect((JSON.parse(guarded.stdout) as GuardDocument).decision.newConflictIds)
      .toEqual([replayedConflictId]);
  });

  it('conservatively blocks a conflict when no active operation marker is available', () => {
    const { repo } = initRepo();
    git(repo, ['branch', 'side']);
    writeFileSync(join(repo, 'tracked.txt'), 'main\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'main change']);
    git(repo, ['switch', 'side']);
    writeFileSync(join(repo, 'tracked.txt'), 'side\n');
    git(repo, ['add', 'tracked.txt']);
    git(repo, ['commit', '-m', 'side change']);
    git(repo, ['switch', 'main']);
    git(repo, ['merge', 'side'], 1);
    rmSync(join(repo, '.git', 'MERGE_HEAD'));

    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const guarded = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(guarded.status).toBe(2);
    expect((JSON.parse(guarded.stdout) as GuardDocument).decision.newConflictIds)
      .toEqual([expect.stringMatching(/^conflict:/)]);
  });

  it('detects worktree status changes during snapshot, guard, and baseline acceptance', () => {
    const { root, repo } = initRepo();
    const clean = snapshot(repo);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const race = statusRaceEnvironment(root, join(repo, 'tracked.txt'));

    const racedSnapshot = run(repo, ['snapshot', '--json'], race.env);
    expect(racedSnapshot.status).toBe(2);
    expect(JSON.parse(racedSnapshot.stdout) as SnapshotDocument).toMatchObject({
      exitCode: 2,
      snapshot: { incomplete: true, racing: true },
    });

    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    rmSync(race.marker);
    const racedGuard = run(repo, ['guard', '--phase', 'pre-push', '--json'], race.env);
    expect(racedGuard.status).toBe(2);
    expect(JSON.parse(racedGuard.stdout) as GuardDocument).toMatchObject({
      exitCode: 2,
      decision: { blocked: true },
      snapshot: { incomplete: true, racing: true },
    });

    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    rmSync(race.marker);
    const baselineBefore = readFileSync(clean.snapshot.baselinePath, 'utf8');
    const refusedBaseline = run(repo, ['baseline', 'write', '--json'], race.env);
    expect(refusedBaseline.status).toBe(2);
    expect(JSON.parse(refusedBaseline.stdout) as BaselineWriteDocument).toMatchObject({
      exitCode: 2,
      baseline: null,
    });
    expect(readFileSync(clean.snapshot.baselinePath, 'utf8')).toBe(baselineBefore);
  });

  it('bounds every Git subprocess and fails closed when a status probe times out', () => {
    const { root, repo } = initRepo();
    const env = statusOutputEnvironment(
      root,
      '  exec sleep 2',
    );
    const startedAt = Date.now();
    const result = run(repo, ['snapshot', '--json'], {
      ...env,
      WHATSOUP_GIT_ESTATE_GIT_TIMEOUT_MS: '300',
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_500);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout) as SnapshotDocument).toMatchObject({
      exitCode: 2,
      snapshot: {
        incomplete: true,
        errors: [expect.objectContaining({ kind: 'worktree_status_failed' })],
      },
    });
  });

  it('scans worktree statuses with a small bounded concurrency pool', () => {
    const { root, repo } = initRepo();
    for (let index = 0; index < 7; index++) {
      git(repo, [
        'worktree',
        'add',
        '-b',
        `lane/concurrency-${index}`,
        join(root, `lane-${index}`),
      ]);
    }
    const concurrency = statusConcurrencyEnvironment(root);
    const result = run(repo, ['snapshot', '--json'], concurrency.env);

    expect(result.status, result.stderr).toBe(0);
    const activeCounts = readFileSync(concurrency.counts, 'utf8')
      .trim()
      .split('\n')
      .map(Number);
    expect(Math.max(...activeCounts)).toBeGreaterThan(1);
    expect(Math.max(...activeCounts)).toBeLessThanOrEqual(4);
  });

  it('ratchets identities, blocks unrelated replacement, and exempts only the pushed lane', () => {
    const { root, repo } = initRepo();
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);

    const firstLane = join(root, 'first-lane');
    git(repo, ['worktree', 'add', '-b', 'lane/first', firstLane]);
    const growth = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(growth.status).toBe(2);
    expect(JSON.parse(growth.stdout) as GuardDocument).toMatchObject({
      decision: {
        blocked: true,
        countGrowth: { worktrees: 1, branches: 1 },
        newCriticalFindingIds: [],
        newWorktreeIds: [expect.stringMatching(/^worktree:/)],
        newBranchIds: [expect.stringMatching(/^branch:/)],
        exemptedWorktreeIds: [],
        exemptedBranchIds: [],
      },
    });

    const expectedFirstLane = run(firstLane, [
      'guard',
      '--phase',
      'pre-push',
      '--push-local-ref',
      'refs/heads/lane/first',
      '--json',
    ]);
    expect(expectedFirstLane.status, expectedFirstLane.stderr).toBe(0);
    expect(JSON.parse(expectedFirstLane.stdout) as GuardDocument).toMatchObject({
      decision: {
        blocked: false,
        countGrowth: { worktrees: 0, branches: 0 },
        exemptedWorktreeIds: [expect.stringMatching(/^worktree:/)],
        exemptedBranchIds: [expect.stringMatching(/^branch:/)],
      },
    });

    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['worktree', 'remove', firstLane]);
    git(repo, ['branch', '-d', 'lane/first']);
    const replacement = join(root, 'replacement-lane');
    git(repo, ['worktree', 'add', '-b', 'lane/replacement', replacement]);

    const neutral = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(neutral.status, neutral.stderr).toBe(2);
    expect(JSON.parse(neutral.stdout) as GuardDocument).toMatchObject({
      decision: {
        blocked: true,
        countGrowth: { worktrees: 1, branches: 1 },
        newCriticalFindingIds: [],
      },
    });

    const expectedReplacement = run(replacement, [
      'guard',
      '--phase',
      'pre-push',
      '--push-local-ref',
      'refs/heads/lane/replacement',
      '--json',
    ]);
    expect(expectedReplacement.status, expectedReplacement.stderr).toBe(0);
    expect(JSON.parse(expectedReplacement.stdout) as GuardDocument).toMatchObject({
      decision: {
        blocked: false,
        countGrowth: { worktrees: 0, branches: 0 },
        exemptedWorktreeIds: [expect.stringMatching(/^worktree:/)],
        exemptedBranchIds: [expect.stringMatching(/^branch:/)],
      },
    });

    const wrongRef = run(replacement, [
      'guard',
      '--phase',
      'pre-push',
      '--push-local-ref',
      'refs/heads/lane/other',
      '--json',
    ]);
    expect(wrongRef.status).toBe(2);
  });

  it('keeps estate growth advisory in pre-commit and blocking in pre-push', () => {
    const { root, repo } = initRepo();
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['worktree', 'add', '-b', 'lane/growth', join(root, 'growth-lane')]);

    const preCommit = run(repo, ['guard', '--phase', 'pre-commit', '--json']);
    expect(preCommit.status).toBe(0);
    expect(preCommit.stderr).toContain('estate_count_growth');
    expect(JSON.parse(preCommit.stdout) as GuardDocument).toMatchObject({
      exitCode: 0,
      decision: {
        blocked: false,
        countGrowth: { worktrees: 1, branches: 1 },
      },
    });

    const prePush = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(prePush.status).toBe(2);
    expect(JSON.parse(prePush.stdout) as GuardDocument).toMatchObject({
      exitCode: 2,
      decision: {
        blocked: true,
        countGrowth: { worktrees: 1, branches: 1 },
      },
    });
  });

  it('independently exempts a new invoking worktree for an exact pushed branch already in the baseline', () => {
    const { root, repo } = initRepo();
    git(repo, ['branch', 'lane/existing']);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);

    const lane = join(root, 'existing-branch-lane');
    git(repo, ['worktree', 'add', lane, 'lane/existing']);
    const guarded = run(lane, [
      'guard',
      '--phase',
      'pre-push',
      '--push-local-ref',
      'refs/heads/lane/existing',
      '--json',
    ]);

    expect(guarded.status, guarded.stderr).toBe(0);
    expect(JSON.parse(guarded.stdout) as GuardDocument).toMatchObject({
      decision: {
        blocked: false,
        countGrowth: { worktrees: 0, branches: 0 },
        newWorktreeIds: [expect.stringMatching(/^worktree:/)],
        newBranchIds: [],
        exemptedWorktreeIds: [expect.stringMatching(/^worktree:/)],
        exemptedBranchIds: [],
      },
    });
  });

  it('independently exempts a new exact pushed branch in a baselined invoking worktree', () => {
    const { repo } = initRepo();
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['switch', '-c', 'lane/new-branch']);

    const guarded = run(repo, [
      'guard',
      '--phase',
      'pre-push',
      '--push-local-ref',
      'refs/heads/lane/new-branch',
      '--json',
    ]);

    expect(guarded.status, guarded.stderr).toBe(0);
    expect(JSON.parse(guarded.stdout) as GuardDocument).toMatchObject({
      decision: {
        blocked: false,
        countGrowth: { worktrees: 0, branches: 0 },
        newWorktreeIds: [],
        newBranchIds: [expect.stringMatching(/^branch:/)],
        exemptedWorktreeIds: [],
        exemptedBranchIds: [expect.stringMatching(/^branch:/)],
      },
    });
  });

  it('blocks earlier unaccepted lane identities while exempting a later exact pushed lane', () => {
    const { root, repo } = initRepo();
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    git(repo, ['worktree', 'add', '-b', 'lane/earlier', join(root, 'earlier-lane')]);
    const laterLane = join(root, 'later-lane');
    git(repo, ['worktree', 'add', '-b', 'lane/later', laterLane]);

    const guarded = run(laterLane, [
      'guard',
      '--phase',
      'pre-push',
      '--push-local-ref',
      'refs/heads/lane/later',
      '--json',
    ]);

    expect(guarded.status, guarded.stderr).toBe(2);
    expect(JSON.parse(guarded.stdout) as GuardDocument).toMatchObject({
      decision: {
        blocked: true,
        countGrowth: { worktrees: 1, branches: 1 },
        newWorktreeIds: [
          expect.stringMatching(/^worktree:/),
          expect.stringMatching(/^worktree:/),
        ],
        newBranchIds: [
          expect.stringMatching(/^branch:/),
          expect.stringMatching(/^branch:/),
        ],
        exemptedWorktreeIds: [expect.stringMatching(/^worktree:/)],
        exemptedBranchIds: [expect.stringMatching(/^branch:/)],
      },
    });
  });

  it('blocks new critical debt, permits inherited or resolved debt, and keeps pre-commit advisory', () => {
    const { root, repo } = initRepo();
    const lane = join(root, 'accepted-lane');
    git(repo, ['worktree', 'add', '-b', 'lane/accepted', lane]);
    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);

    git(repo, ['worktree', 'lock', '--reason', 'fixture debt', lane]);
    const blocked = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(blocked.status).toBe(2);
    const blockedDoc = JSON.parse(blocked.stdout) as GuardDocument;
    expect(blockedDoc.decision.countGrowth).toEqual({ worktrees: 0, branches: 0 });
    expect(blockedDoc.decision.newCriticalFindingIds).toHaveLength(1);

    const advisory = run(repo, ['guard', '--phase', 'pre-commit', '--json']);
    expect(advisory.status).toBe(0);
    expect(JSON.parse(advisory.stdout) as GuardDocument).toMatchObject({
      decision: {
        blocked: false,
        countGrowth: { worktrees: 0, branches: 0 },
        newCriticalFindingIds: blockedDoc.decision.newCriticalFindingIds,
      },
    });

    expect(run(repo, ['baseline', 'write', '--json']).status).toBe(0);
    const inherited = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(inherited.status).toBe(0);
    expect((JSON.parse(inherited.stdout) as GuardDocument).decision.newCriticalFindingIds)
      .toEqual([]);

    git(repo, ['worktree', 'unlock', lane]);
    const resolved = run(repo, ['guard', '--phase', 'pre-push', '--json']);
    expect(resolved.status).toBe(0);
    expect((JSON.parse(resolved.stdout) as GuardDocument).decision.newCriticalFindingIds)
      .toEqual([]);
  });

  it('treats an unreadable prunable worktree as incomplete but keeps pre-commit fail-open-with-warning', () => {
    const { root, repo } = initRepo();
    const missing = join(root, 'missing-worktree');
    git(repo, ['worktree', 'add', '-b', 'missing-worktree', missing]);
    rmSync(missing, { recursive: true, force: true });

    const snap = run(repo, ['snapshot', '--json']);
    expect(snap.status).toBe(2);
    expect(JSON.parse(snap.stdout) as SnapshotDocument).toMatchObject({
      exitCode: 2,
      snapshot: {
        incomplete: true,
        errors: [expect.objectContaining({ kind: 'worktree_status_failed' })],
      },
    });

    const preCommit = run(repo, ['guard', '--phase', 'pre-commit', '--json']);
    expect(preCommit.status).toBe(0);
    expect(JSON.parse(preCommit.stdout) as GuardDocument).toMatchObject({
      exitCode: 0,
      decision: { blocked: false },
      snapshot: { incomplete: true },
    });

    const refused = run(repo, ['baseline', 'write', '--json']);
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stdout) as BaselineWriteDocument).toMatchObject({
      command: 'baseline',
      action: 'write',
      exitCode: 2,
      baseline: null,
    });
    const commonDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    expect(existsSync(join(commonDir, 'whatsoup', 'git-estate-baseline.v2.json'))).toBe(false);
  });

  it('emits one JSON document and stable exit codes for usage', () => {
    const { repo } = initRepo();
    const unsupportedMutation = run(repo, ['baseline', 'remove', '--json']);
    expect(unsupportedMutation.status).toBe(64);
    expect(JSON.parse(unsupportedMutation.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'error',
      exitCode: 64,
      error: { kind: 'usage' },
    });

    const usage = run(repo, ['guard', '--phase', 'later', '--json']);
    expect(usage.status).toBe(64);
    expect(JSON.parse(usage.stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'error',
      exitCode: 64,
      error: { kind: 'usage' },
    });
    expect(usage.stderr).toContain('pre-commit|pre-push');

    const help = run(repo, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('snapshot');
    expect(help.stdout).toContain('guard --phase');
    expect(help.stdout).not.toMatch(/\u001b\[/);
  });
});
