import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExactGitInputError,
  MAX_EXACT_AGGREGATE_BLOB_BYTES,
  MAX_EXACT_BLOB_COUNT,
  MAX_EXACT_COMMIT_COUNT,
  MAX_EXACT_COMMIT_RANGE_BYTES,
  MAX_EXACT_SINGLE_BLOB_BYTES,
  readExactChangeFacts,
  readExactBlobs,
  readExactCommitRange,
} from '../../scripts/lib/ci-control/git-input.ts';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function gitEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: cwd,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment(cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitWithInput(cwd: string, args: string[], input: Uint8Array): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnvironment(cwd),
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function fixture(): { root: string; baseOid: string } {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-git-input-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet', '--object-format=sha1']);
  write(root, 'README.md', 'base\n');
  return { root, baseOid: commit(root, 'base') };
}

function expectCode(run: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ExactGitInputError);
  expect(thrown).toMatchObject({ code });
  expect(String(thrown)).toContain(code);
}

function hashBlob(root: string, bytes: Uint8Array): string {
  return gitWithInput(root, ['hash-object', '-w', '--stdin'], bytes);
}

interface GitShimResponse {
  stdout?: string;
  stdoutBase64?: string;
  stderr?: string;
  exit?: number;
  signal?: 'SIGKILL';
}

function responseKey(args: readonly string[]): string {
  return JSON.stringify(args);
}

function withGitShim<T>(
  responses: Record<string, GitShimResponse>,
  run: (cwd: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-git-shim-'));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  const cwd = join(root, 'work');
  mkdirSync(bin);
  mkdirSync(cwd);
  const scenarioPath = join(cwd, '.git-input-shim.json');
  writeFileSync(scenarioPath, JSON.stringify({ cwd, responses }), 'utf8');
  const shimPath = join(bin, 'git');
  writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const scenario = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.git-input-shim.json'), 'utf8'));
const args = process.argv.slice(2);
const fail = (message, code) => { fs.writeSync(2, message); process.exit(code); };
if (process.cwd() !== scenario.cwd) fail('unexpected cwd', 91);
if (args[0] !== '--no-replace-objects') fail('replacement isolation missing', 92);
if (process.env.GIT_NO_REPLACE_OBJECTS !== '1') fail('replace env missing', 93);
if (process.env.GIT_NO_LAZY_FETCH !== '1') fail('lazy fetch env missing', 94);
if (process.env.GIT_OPTIONAL_LOCKS !== '0') fail('optional locks env missing', 95);
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  if (process.env[name] !== undefined) fail('ambient git env leaked', 96);
}
const key = JSON.stringify(args.slice(1));
const response = scenario.responses[key];
if (response === undefined) fail('unexpected args', 97);
if (response.stdoutBase64 !== undefined) fs.writeSync(1, Buffer.from(response.stdoutBase64, 'base64'));
else if (response.stdout !== undefined) fs.writeSync(1, response.stdout);
if (response.stderr !== undefined) fs.writeSync(2, response.stderr);
if (response.signal === 'SIGKILL') process.kill(process.pid, 'SIGKILL');
process.exit(response.exit ?? 0);
`, 'utf8');
  chmodSync(shimPath, 0o755);

  const names = ['PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.GIT_DIR = '/ambient/repository';
  process.env.GIT_WORK_TREE = '/ambient/worktree';
  process.env.GIT_INDEX_FILE = '/ambient/index';
  try {
    return run(cwd);
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function emptyRangeResponses(oid: string): Record<string, GitShimResponse> {
  return {
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'commit\n' },
    [responseKey(['merge-base', '--all', oid, oid])]: { stdout: `${oid}\n` },
    [responseKey(['rev-list', '--count', `${oid}..${oid}`, '--'])]: { stdout: '0\n' },
    [responseKey(['rev-list', '--parents', `${oid}..${oid}`, '--'])]: { stdout: '' },
  };
}

function rangeResponses(
  baseOid: string,
  localOid: string,
  countOutput: string,
  rows: Uint8Array,
  rowExit = 0,
): Record<string, GitShimResponse> {
  return {
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    [responseKey(['cat-file', '-t', '--', baseOid])]: { stdout: 'commit\n' },
    [responseKey(['cat-file', '-t', '--', localOid])]: { stdout: 'commit\n' },
    [responseKey(['merge-base', '--all', baseOid, localOid])]: { stdout: `${baseOid}\n` },
    [responseKey(['rev-list', '--count', `${baseOid}..${localOid}`, '--'])]: { stdout: countOutput },
    [responseKey(['rev-list', '--parents', `${baseOid}..${localOid}`, '--'])]: {
      stdoutBase64: Buffer.from(rows).toString('base64'),
      exit: rowExit,
    },
  };
}

describe('exact commit range', () => {
  it('rejects malformed runtime records before Git or accessor evaluation', () => {
    const oid = 'a'.repeat(40);
    const malformed: unknown[] = [
      null,
      [],
      {},
      { baseOid: oid, remoteOid: null },
      { baseOid: oid, remoteOid: null, localOid: oid, extra: true },
      { baseOid: 7, remoteOid: null, localOid: oid },
      { baseOid: oid.toUpperCase(), remoteOid: null, localOid: oid },
      { baseOid: oid, remoteOid: '', localOid: oid },
      { baseOid: oid, remoteOid: 7, localOid: oid },
      { baseOid: oid, remoteOid: null, localOid: 'g'.repeat(40) },
    ];
    for (const value of malformed) {
      expectCode(() => readExactCommitRange(
        '/not-a-repository',
        value as never,
      ), 'ci.input.commit-range-malformed');
    }

    let getterCalls = 0;
    const accessor: Record<string, unknown> = { remoteOid: null, localOid: oid };
    Object.defineProperty(accessor, 'baseOid', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    expectCode(() => readExactCommitRange('/not-a-repository', accessor as never),
      'ci.input.commit-range-malformed');
    expect(getterCalls).toBe(0);
  });

  it('requires canonical scalar framing for object format and commit type', () => {
    const oid = 'a'.repeat(40);
    const malformedScalars = [' sha1\n', 'sha1 \n', 'sha1\n\n', 'sha1', 'sha1\r\n', 'shá1\n'];
    for (const scalar of malformedScalars) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: scalar },
      }, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }

    for (const scalar of [' commit\n', 'commit \n', 'commit\n\n', 'commit', 'commit\r\n', 'commít\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('distinguishes malformed merge-base framing from a well-formed unavailable relation', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const validRows = Buffer.from(`${localOid} ${baseOid}\n`);
    for (const scalar of [
      ` ${baseOid}\n`, `${baseOid} \n`, `${baseOid}\n\n`, baseOid, `${baseOid}\r\n`, `é${baseOid.slice(1)}\n`,
    ]) {
      const responses = rangeResponses(baseOid, localOid, '1\n', validRows);
      responses[responseKey(['merge-base', '--all', baseOid, localOid])] = { stdout: scalar };
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid, remoteOid: null, localOid,
      })), 'ci.input.commit-range-malformed');
    }

    const otherOid = 'c'.repeat(40);
    const responses = rangeResponses(baseOid, localOid, '1\n', validRows);
    responses[responseKey(['merge-base', '--all', baseOid, localOid])] = { stdout: `${otherOid}\n` };
    expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
      baseOid, remoteOid: null, localOid,
    })), 'ci.input.commit-range-unavailable');
  });

  it('requires canonical decimal framing for the commit count', () => {
    const oid = 'a'.repeat(40);
    for (const scalar of [' 0\n', '0 \n', '0\n\n', '0', '0\r\n', '０\n']) {
      const responses = emptyRangeResponses(oid);
      responses[responseKey(['rev-list', '--count', `${oid}..${oid}`, '--'])] = { stdout: scalar };
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('uses remoteOid when present and baseOid otherwise', () => {
    const { root, baseOid } = fixture();
    write(root, 'one.txt', 'one\n');
    const firstOid = commit(root, 'first');
    write(root, 'two.txt', 'two\n');
    const secondOid = commit(root, 'second');

    expect(readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: secondOid,
    })).toMatchObject({
      baseOid,
      remoteOid: null,
      rangeStartOid: baseOid,
      localOid: secondOid,
      commits: [{ oid: firstOid }, { oid: secondOid }],
    });

    expect(readExactCommitRange(root, {
      baseOid,
      remoteOid: firstOid,
      localOid: secondOid,
    })).toMatchObject({
      baseOid,
      remoteOid: firstOid,
      rangeStartOid: firstOid,
      localOid: secondOid,
      commits: [{ oid: secondOid }],
    });
  });

  it('rejects malformed, missing, non-commit, unsupported-format, and non-ancestor inputs', () => {
    const { root, baseOid } = fixture();
    write(root, 'candidate.txt', 'candidate\n');
    const localOid = commit(root, 'candidate');
    const blobOid = git(root, ['rev-parse', `${localOid}:candidate.txt`]);

    expectCode(() => readExactCommitRange(root, {
      baseOid: baseOid.toUpperCase(), remoteOid: null, localOid,
    }), 'ci.input.commit-range-malformed');
    expectCode(() => readExactCommitRange(root, {
      baseOid, remoteOid: null, localOid: 'f'.repeat(40),
    }), 'ci.input.commit-range-unavailable');
    expectCode(() => readExactCommitRange(root, {
      baseOid, remoteOid: null, localOid: blobOid,
    }), 'ci.input.commit-range-malformed');

    git(root, ['checkout', '--quiet', '--detach', baseOid]);
    write(root, 'other.txt', 'other\n');
    const unrelatedOid = commit(root, 'unrelated');
    expectCode(() => readExactCommitRange(root, {
      baseOid: localOid, remoteOid: null, localOid: unrelatedOid,
    }), 'ci.input.commit-range-unavailable');

    const sha256Root = mkdtempSync(join(tmpdir(), 'ci-control-git-input-sha256-'));
    temporaryRoots.push(sha256Root);
    git(sha256Root, ['init', '--quiet', '--object-format=sha256']);
    expectCode(() => readExactCommitRange(sha256Root, {
      baseOid: 'a'.repeat(40), remoteOid: null, localOid: 'b'.repeat(40),
    }), 'ci.input.commit-range-malformed');
  });

  it('enumerates transient commits by exact OID while ignoring ambient HEAD, index, and worktree', () => {
    const { root, baseOid } = fixture();
    write(root, 'transient.txt', 'introduced\n');
    const addOid = commit(root, 'add transient');
    rmSync(join(root, 'transient.txt'));
    const removeOid = commit(root, 'remove transient');

    write(root, 'ambient-head.txt', 'outside exact range\n');
    commit(root, 'ambient head');
    write(root, 'ambient-index.txt', 'index only\n');
    git(root, ['add', 'ambient-index.txt']);
    write(root, 'ambient-worktree.txt', 'worktree only\n');

    const result = readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: removeOid,
    });
    expect(result.commits.map(({ oid }) => oid)).toEqual([addOid, removeOid]);
    expect(result.commits[0]).toEqual({
      oid: addOid,
      parentOids: [baseOid],
      firstParentOid: baseOid,
    });
    expect(result.commits[1]).toEqual({
      oid: removeOid,
      parentOids: [addOid],
      firstParentOid: addOid,
    });

    const facts = result.commits.flatMap(({ firstParentOid, oid }) =>
      readExactChangeFacts(root, firstParentOid, oid));
    expect(facts.map(({ status, path, oldMode, newMode, oldType, newType }) => ({
      status, path, oldMode, newMode, oldType, newType,
    }))).toEqual([
      {
        status: 'added', path: 'transient.txt', oldMode: '000000', newMode: '100644',
        oldType: 'absent', newType: 'blob',
      },
      {
        status: 'deleted', path: 'transient.txt', oldMode: '100644', newMode: '000000',
        oldType: 'blob', newType: 'absent',
      },
    ]);
    const introducedBlobOids = facts
      .filter(({ newType }) => newType === 'blob' || newType === 'executable' || newType === 'symlink')
      .map(({ newOid }) => newOid);
    const [introduced] = readExactBlobs(root, introducedBlobOids);
    expect(Buffer.from(introduced!.bytes).toString('utf8')).toBe('introduced\n');
  });

  it('uses deterministic parent-before-child ordering with ready siblings sorted by OID', () => {
    const { root, baseOid } = fixture();
    git(root, ['checkout', '--quiet', '-b', 'left']);
    write(root, 'left.txt', 'left\n');
    const leftOid = commit(root, 'left');

    git(root, ['checkout', '--quiet', '-b', 'right', baseOid]);
    write(root, 'right.txt', 'right\n');
    const rightOid = commit(root, 'right');
    git(root, ['merge', '--quiet', '--no-ff', 'left', '-m', 'merge diamond']);
    const mergeOid = git(root, ['rev-parse', 'HEAD']);

    const result = readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: mergeOid,
    });
    expect(result.commits.map(({ oid }) => oid)).toEqual([
      ...[leftOid, rightOid].sort(),
      mergeOid,
    ]);
    expect(result.commits.at(-1)).toEqual({
      oid: mergeOid,
      parentOids: [rightOid, leftOid],
      firstParentOid: rightOid,
    });
  });

  it('publishes fixed inclusive range budgets', () => {
    expect(MAX_EXACT_COMMIT_COUNT).toBe(4_096);
    expect(MAX_EXACT_COMMIT_RANGE_BYTES).toBe(1 * 1_024 * 1_024);
  });

  it('rejects nonempty output for an empty range and blank normalized rows', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'c'.repeat(40);
    const firstOid = 'b'.repeat(40);
    const validRows = `${firstOid} ${baseOid}\n${localOid} ${firstOid}\n`;
    const cases = [
      {
        base: baseOid,
        local: baseOid,
        count: '0\n',
        rows: Buffer.from('\n'),
        responses: { ...emptyRangeResponses(baseOid) },
      },
      {
        base: baseOid,
        local: localOid,
        count: '2\n',
        rows: Buffer.from(validRows.replace('\n', '\n\n')),
      },
      {
        base: baseOid,
        local: localOid,
        count: '2\n',
        rows: Buffer.from(`${validRows}\n`),
      },
    ];

    for (const entry of cases) {
      const responses = rangeResponses(entry.base, entry.local, entry.count, entry.rows);
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid: entry.base,
        remoteOid: null,
        localOid: entry.local,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('rejects missing LF, row-count mismatch, duplicate rows, cycles, and discarded partial output', () => {
    const baseOid = 'a'.repeat(40);
    const firstOid = 'b'.repeat(40);
    const localOid = 'c'.repeat(40);
    const malformed = [
      { count: '1\n', rows: Buffer.from(`${localOid} ${baseOid}`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${localOid} ${baseOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${localOid} ${baseOid}\n${localOid} ${baseOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${firstOid} ${localOid}\n${localOid} ${firstOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '1\n', rows: Buffer.from(`${localOid} ${baseOid}\n`), exit: 1, code: 'ci.input.commit-range-unavailable' },
    ];
    for (const entry of malformed) {
      expectCode(() => withGitShim(
        rangeResponses(baseOid, localOid, entry.count, entry.rows, entry.exit),
        (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
      ), entry.code);
    }
  });

  it('accepts the exact commit-count bound and rejects one over before reading metadata', () => {
    const baseOid = 'a'.repeat(40);
    const commitOids = Array.from(
      { length: MAX_EXACT_COMMIT_COUNT },
      (_, index) => (index + 1).toString(16).padStart(40, '0'),
    );
    const localOid = commitOids.at(-1)!;
    const rows = Buffer.from(commitOids.map((oid, index) =>
      `${oid} ${index === 0 ? baseOid : commitOids[index - 1]}\n`).join(''));
    const exact = withGitShim(
      rangeResponses(baseOid, localOid, `${MAX_EXACT_COMMIT_COUNT}\n`, rows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    );
    expect(exact.commits).toHaveLength(MAX_EXACT_COMMIT_COUNT);
    expect(exact.commits[0]?.firstParentOid).toBe(baseOid);
    expect(exact.commits.at(-1)?.oid).toBe(localOid);

    const oneOverResponses = rangeResponses(
      baseOid,
      localOid,
      `${MAX_EXACT_COMMIT_COUNT + 1}\n`,
      Buffer.alloc(0),
    );
    delete oneOverResponses[responseKey(['rev-list', '--parents', `${baseOid}..${localOid}`, '--'])];
    expectCode(() => withGitShim(oneOverResponses, (cwd) => readExactCommitRange(cwd, {
      baseOid, remoteOid: null, localOid,
    })), 'ci.input.commit-range-budget');
  });

  it('accepts a near-limit valid range payload and rejects one byte over the output budget', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const wholeParentCount = Math.floor((MAX_EXACT_COMMIT_RANGE_BYTES / 41) - 1);
    const nearLimit = Buffer.from(`${localOid}${` ${baseOid}`.repeat(wholeParentCount)}\n`);
    expect(nearLimit.byteLength).toBe(MAX_EXACT_COMMIT_RANGE_BYTES - 1);
    const exact = withGitShim(
      rangeResponses(baseOid, localOid, '1\n', nearLimit),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    );
    expect(exact.commits).toHaveLength(1);

    const over = Buffer.alloc(MAX_EXACT_COMMIT_RANGE_BYTES + 1, 0x61);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', over),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-budget');
  });

  it('admits exactly the raw range-output byte limit before malformed parsing', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const exact = Buffer.alloc(MAX_EXACT_COMMIT_RANGE_BYTES, 0x61);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', exact),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-malformed');

    const over = Buffer.alloc(MAX_EXACT_COMMIT_RANGE_BYTES + 1, 0x61);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', over),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-budget');
  });

  it('uses bounded explicit Git calls with sanitized environment state', () => {
    const oid = 'a'.repeat(40);
    expect(withGitShim(emptyRangeResponses(oid), (cwd) => readExactCommitRange(cwd, {
      baseOid: oid,
      remoteOid: null,
      localOid: oid,
    }))).toEqual({
      baseOid: oid,
      remoteOid: null,
      rangeStartOid: oid,
      localOid: oid,
      commits: [],
    });
  });
});

describe('exact blob set', () => {
  it('validates every member before Git access', () => {
    const oid = 'a'.repeat(40);
    for (const invalid of ['', oid.toUpperCase(), 'g'.repeat(40), 7, null]) {
      expectCode(() => readExactBlobs(
        '/not-a-repository',
        [oid, invalid] as unknown as readonly string[],
      ), 'ci.input.blob-set-malformed');
    }

    let getterCalls = 0;
    const accessor: string[] = [];
    Object.defineProperty(accessor, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    Object.defineProperty(accessor, 'length', { value: 1 });
    expectCode(() => readExactBlobs('/not-a-repository', accessor),
      'ci.input.blob-set-malformed');
    expect(getterCalls).toBe(0);
  });

  it('requires canonical scalar framing for object format, blob type, and blob size', () => {
    const oid = 'a'.repeat(40);
    for (const scalar of [' sha1\n', 'sha1 \n', 'sha1\n\n', 'sha1', 'sha1\r\n', 'shá1\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }

    for (const scalar of [' blob\n', 'blob \n', 'blob\n\n', 'blob', 'blob\r\n', 'blób\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }

    for (const scalar of [' 0\n', '0 \n', '0\n\n', '0', '0\r\n', '０\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'blob\n' },
        [responseKey(['cat-file', '-s', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }
  });

  it('reads blob identities selected from regular, executable, and symlink tree entries', () => {
    const { root } = fixture();
    write(root, 'regular.txt', 'regular\n');
    write(root, 'executable.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'executable.sh'), 0o755);
    symlinkSync('regular.txt', join(root, 'regular-link'));
    const commitOid = commit(root, 'blob modes');
    const oids = [
      git(root, ['rev-parse', `${commitOid}:regular.txt`]),
      git(root, ['rev-parse', `${commitOid}:executable.sh`]),
      git(root, ['rev-parse', `${commitOid}:regular-link`]),
    ];

    const blobs = readExactBlobs(root, [oids[2]!, oids[0]!, oids[1]!, oids[0]!]);
    expect(blobs.map(({ oid }) => oid)).toEqual([...oids].sort());
    for (const blob of blobs) {
      expect(blob.byteLength).toBe(blob.bytes.byteLength);
      expect(blob.contentSha256).toBe(`sha256:${createHash('sha256').update(blob.bytes).digest('hex')}`);
      expect(gitWithInput(root, ['hash-object', '--stdin'], blob.bytes)).toBe(blob.oid);
    }
    expect(blobs.map(({ bytes }) => Buffer.from(bytes).toString('utf8')).sort()).toEqual([
      '#!/bin/sh\nexit 0\n',
      'regular\n',
      'regular.txt',
    ].sort());
  });

  it('rejects malformed, missing, and non-blob identities without returning partial results', () => {
    const { root, baseOid } = fixture();
    const validBlob = git(root, ['rev-parse', `${baseOid}:README.md`]);

    expectCode(() => readExactBlobs(root, [validBlob, 'A'.repeat(40)]), 'ci.input.blob-set-malformed');
    expectCode(() => readExactBlobs(root, [validBlob, 'f'.repeat(40)]), 'ci.input.blob-unavailable');
    expectCode(() => readExactBlobs(root, [validBlob, baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('ignores replacement objects and verifies the requested Git blob identity', () => {
    const { root } = fixture();
    const original = hashBlob(root, Buffer.from('original\n'));
    const replacement = hashBlob(root, Buffer.from('replacement\n'));
    git(root, ['replace', original, replacement]);

    const [blob] = readExactBlobs(root, [original]);
    expect(blob?.oid).toBe(original);
    expect(Buffer.from(blob!.bytes).toString('utf8')).toBe('original\n');
  });

  it('rejects a blob over the single-object budget before returning content', () => {
    const { root } = fixture();
    const oversized = hashBlob(root, Buffer.alloc(MAX_EXACT_SINGLE_BLOB_BYTES + 1, 0x61));
    expectCode(() => readExactBlobs(root, [oversized]), 'ci.input.blob-set-budget');
  });

  it('checks the deduplicated count budget before resolving object types', () => {
    const { root } = fixture();
    const tooMany = Array.from(
      { length: MAX_EXACT_BLOB_COUNT + 1 },
      (_, index) => index.toString(16).padStart(40, '0'),
    );
    expectCode(() => readExactBlobs(root, tooMany), 'ci.input.blob-set-budget');
  });

  it('checks raw array shape and count before Git access or deduplication', () => {
    const oid = 'a'.repeat(40);
    expectCode(() => readExactBlobs('/not-a-repository', null as unknown as readonly string[]),
      'ci.input.blob-set-malformed');
    expectCode(() => readExactBlobs(
      '/not-a-repository',
      Array.from({ length: MAX_EXACT_BLOB_COUNT + 1 }, () => oid),
    ), 'ci.input.blob-set-budget');
    expectCode(() => readExactBlobs(
      '/not-a-repository',
      Array.from({ length: MAX_EXACT_BLOB_COUNT }, () => oid),
    ), 'ci.input.blob-unavailable');
  });

  it('accepts the inclusive single and aggregate byte limits and rejects aggregate one over', () => {
    const { root } = fixture();
    const exactOids = Array.from({ length: 4 }, (_, index) => {
      const content = Buffer.alloc(MAX_EXACT_SINGLE_BLOB_BYTES, 0x61 + index);
      return hashBlob(root, content);
    });
    const exact = readExactBlobs(root, exactOids);
    expect(exact).toHaveLength(4);
    expect(exact.reduce((sum, blob) => sum + blob.byteLength, 0))
      .toBe(MAX_EXACT_AGGREGATE_BLOB_BYTES);
    expect(exact.every(({ byteLength }) => byteLength === MAX_EXACT_SINGLE_BLOB_BYTES)).toBe(true);

    const oneByteOid = hashBlob(root, Buffer.from('x'));
    expectCode(() => readExactBlobs(root, [...exactOids, oneByteOid]),
      'ci.input.blob-set-budget');
  });

  it('rejects preflight single and aggregate sizes before requesting blob content', () => {
    const singleOid = 'a'.repeat(40);
    expectCode(() => withGitShim({
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
      [responseKey(['cat-file', '-t', '--', singleOid])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', singleOid])]: {
        stdout: `${MAX_EXACT_SINGLE_BLOB_BYTES + 1}\n`,
      },
    }, (cwd) => readExactBlobs(cwd, [singleOid])), 'ci.input.blob-set-budget');

    const oids = ['a', 'b', 'c', 'd', 'e'].map((prefix) => prefix.repeat(40));
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    };
    for (const [index, oid] of oids.entries()) {
      responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'blob\n' };
      responses[responseKey(['cat-file', '-s', '--', oid])] = {
        stdout: `${index === oids.length - 1 ? 1 : MAX_EXACT_SINGLE_BLOB_BYTES}\n`,
      };
    }
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, oids)),
      'ci.input.blob-set-budget');
  });

  it('composes exact change facts and blob bytes for all supported Git entry modes', () => {
    const { root, baseOid } = fixture();
    write(root, 'regular.txt', 'regular mode\n');
    write(root, 'executable.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'executable.sh'), 0o755);
    symlinkSync('regular.txt', join(root, 'regular-link'));
    git(root, ['add', '-A']);
    const multibyteBytes = Buffer.from('multibyte path\n');
    const multibyteOid = hashBlob(root, multibyteBytes);
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${multibyteOid},docs/café.txt`]);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'all entry modes']);
    const localOid = git(root, ['rev-parse', 'HEAD']);

    const range = readExactCommitRange(root, { baseOid, remoteOid: null, localOid });
    expect(range.commits).toHaveLength(1);
    const facts = range.commits.flatMap(({ firstParentOid, oid }) =>
      readExactChangeFacts(root, firstParentOid, oid));
    expect(facts.map(({ path, newMode, newType }) => ({ path, newMode, newType }))).toEqual([
      { path: 'docs/café.txt', newMode: '100644', newType: 'blob' },
      { path: 'executable.sh', newMode: '100755', newType: 'executable' },
      { path: 'regular-link', newMode: '120000', newType: 'symlink' },
      { path: 'regular.txt', newMode: '100644', newType: 'blob' },
      { path: 'vendor/component', newMode: '160000', newType: 'gitlink' },
    ]);
    const eligibleFacts = facts.filter(({ newType }) =>
      newType === 'blob' || newType === 'executable' || newType === 'symlink');
    expect(eligibleFacts.map(({ path }) => path)).not.toContain('vendor/component');
    const blobs = readExactBlobs(root, eligibleFacts.map(({ newOid }) => newOid));
    const bytesByOid = new Map(blobs.map((blob) => [blob.oid, Buffer.from(blob.bytes).toString('utf8')]));
    expect(bytesByOid.get(multibyteOid)).toBe('multibyte path\n');
    expect([...bytesByOid.values()].sort()).toEqual([
      '#!/bin/sh\nexit 0\n',
      'multibyte path\n',
      'regular mode\n',
      'regular.txt',
    ].sort());
    expectCode(() => readExactBlobs(root, [baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('rejects bytes that do not rehash to the requested blob identity', () => {
    const oid = 'a'.repeat(40);
    const wrong = Buffer.from('different bytes');
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
      [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', oid])]: { stdout: `${wrong.byteLength}\n` },
      [responseKey(['cat-file', 'blob', '--', oid])]: {
        stdoutBase64: wrong.toString('base64'),
      },
    };
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, [oid])),
      'ci.input.blob-identity-mismatch');
  });

  it('does not send gitlink commit identities to blob reads during change-fact composition', () => {
    const { root, baseOid } = fixture();
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'gitlink']);
    const localOid = git(root, ['rev-parse', 'HEAD']);
    const facts = readExactChangeFacts(root, baseOid, localOid);
    expect(facts).toMatchObject([{ path: 'vendor/component', newType: 'gitlink', newOid: baseOid }]);
    const eligible = facts
      .filter(({ newType }) => newType === 'blob' || newType === 'executable' || newType === 'symlink')
      .map(({ newOid }) => newOid);
    expect(eligible).toEqual([]);
    expectCode(() => readExactBlobs(root, [baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('does not classify a SIGKILL-only child failure as a timeout', () => {
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { signal: 'SIGKILL' },
    };
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, [])),
      'ci.input.blob-unavailable');
  });

  it('maps only a proven ETIMEDOUT child-process error to the timeout code', async () => {
    const verifyIsolatedFailure = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      code: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: () => {
          throw failure;
        },
      }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactBlobs('/isolated-fixture', []);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code });
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };

    await verifyIsolatedFailure(
      Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT', signal: 'SIGKILL' }),
      'ci.input.git-execution-timeout',
    );
    await verifyIsolatedFailure(
      Object.assign(new Error('synthetic signal'), { signal: 'SIGKILL' }),
      'ci.input.blob-unavailable',
    );
  });

  it('publishes fixed inclusive blob budgets', () => {
    expect(MAX_EXACT_BLOB_COUNT).toBe(50_000);
    expect(MAX_EXACT_SINGLE_BLOB_BYTES).toBe(4 * 1_024 * 1_024);
    expect(MAX_EXACT_AGGREGATE_BLOB_BYTES).toBe(16 * 1_024 * 1_024);
  });
});
