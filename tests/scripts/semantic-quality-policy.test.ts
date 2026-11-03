import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../src/lib/git-env.ts';
import {
  __setTestGitPath,
  MAX_EXACT_SINGLE_BLOB_BYTES,
} from '../../scripts/lib/ci-control/git-input-core.ts';
import {
  readCandidateTree,
  type CandidateTree,
} from '../../scripts/lib/semantic-quality/git-tree.ts';
import {
  evaluateSemanticPolicy,
  loadSemanticPolicy,
  type SemanticPolicyFinding,
  type SemanticQualityPolicy,
} from '../../scripts/lib/semantic-quality/policy.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

const BASE_POLICY: SemanticQualityPolicy = {
  schemaVersion: 1,
  roots: ['src/main.ts'],
  sourcePrefixes: ['src/'],
  excludedSuffixes: ['.d.ts'],
  allowlist: [],
};

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(repo: string, relativePath: string, contents: string): void {
  const absolute = path.join(repo, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, 'utf8');
}

function commit(repo: string, message: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function makeRepo(extraFiles: Record<string, string> = {}): { repo: string; baseOid: string } {
  const repo = tmp.make('semantic-quality-policy');
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.name', 'Semantic Quality Test']);
  git(repo, ['config', 'user.email', 'semantic-quality-test@users.noreply.github.com']);
  write(repo, 'src/main.ts', 'export const main = true;\n');
  for (const [relativePath, contents] of Object.entries(extraFiles)) write(repo, relativePath, contents);
  return { repo, baseOid: commit(repo, 'baseline') };
}

function resolveOnPath(command: string): string {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable here; keep searching PATH.
    }
  }
  throw new Error(`${command} is not on PATH`);
}

function shellQuoted(value: string): string {
  if (value.includes("'")) throw new Error(`path cannot be single-quoted: ${value}`);
  return `'${value}'`;
}

// A `git` shim that runs `body` (which sees "$@") and then the real Git.
function writeGitShim(name: string, body: string[]): string {
  const shim = path.join(tmp.make(name), 'git');
  const lines = ['#!/bin/sh', ...body, `exec ${shellQuoted(resolveOnPath('git'))} "$@"`, ''];
  writeFileSync(shim, lines.join('\n'), { mode: 0o700 });
  return shim;
}

// A `git` shim whose `cat-file` calls drain stdin and fail; other calls run the real Git.
function writeFailingBatchShim(name: string): string {
  return writeGitShim(name, [
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    -*) ;;',
    '    cat-file) cat >/dev/null; exit 1 ;;',
    '    *) break ;;',
    '  esac',
    'done',
  ]);
}

// Reads the tree with `shim` as the Git of the exact blob reader (the ci-control
// test seam) and, when `onPath`, also first on PATH for git-tree.ts's own calls.
function readTreeWithShim(repo: string, shim: string, onPath: boolean): CandidateTree {
  const priorGitPath = __setTestGitPath(shim);
  if (onPath) vi.stubEnv('PATH', `${path.dirname(shim)}${path.delimiter}${process.env.PATH ?? ''}`);
  try {
    return readCandidateTree({ cwd: repo, head: 'HEAD', scope: 'tree' });
  } finally {
    vi.unstubAllEnvs();
    __setTestGitPath(priorGitPath);
  }
}

function readBranch(repo: string, baseOid: string): CandidateTree {
  return readCandidateTree({ cwd: repo, head: 'HEAD', baseRef: baseOid, scope: 'branch' });
}

function findingsFor(repo: string, baseOid: string, policy = BASE_POLICY): SemanticPolicyFinding[] {
  return evaluateSemanticPolicy({
    tree: readBranch(repo, baseOid),
    policy,
    now: new Date('2026-07-15T12:00:00Z'),
  });
}

function findingForPath(
  findings: SemanticPolicyFinding[],
  ruleId: SemanticPolicyFinding['ruleId'],
  relativePath: string,
): SemanticPolicyFinding | undefined {
  return findings.find((finding) => finding.ruleId === ruleId && finding.paths.includes(relativePath));
}

function writePolicy(repo: string, payload: unknown): void {
  write(repo, 'config/semantic-quality.json', `${JSON.stringify(payload, null, 2)}\n`);
}

describe('exact candidate Git tree', () => {
  it('reads full head, base, and merge-base OIDs and accepts an integrated added module', () => {
    const { repo, baseOid } = makeRepo();
    write(repo, 'src/main.ts', `import { feature } from './feature.ts';\nfeature();\n`);
    write(repo, 'src/feature.ts', 'export function feature() { return true; }\n');
    const headOid = commit(repo, 'add integrated feature');

    const tree = readBranch(repo, baseOid);
    const findings = evaluateSemanticPolicy({ tree, policy: BASE_POLICY, now: new Date('2026-07-15') });

    expect(tree.headOid).toBe(headOid);
    expect(tree.baseOid).toBe(baseOid);
    expect(tree.mergeBaseOid).toBe(baseOid);
    expect(tree.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(tree.changedPaths).toEqual([
      { status: 'added', path: 'src/feature.ts' },
      { status: 'modified', path: 'src/main.ts' },
    ]);
    expect(findingForPath(findings, 'semantic.production-reachability', 'src/feature.ts')).toBeUndefined();
  });

  it('blocks an added module imported only from tests', () => {
    const { repo, baseOid } = makeRepo();
    write(repo, 'src/feature.ts', 'export const feature = true;\n');
    write(repo, 'tests/feature.test.ts', `import { feature } from '../src/feature.ts';\nvoid feature;\n`);
    commit(repo, 'add test-only feature');

    expect(findingForPath(findingsFor(repo, baseOid), 'semantic.production-reachability', 'src/feature.ts'))
      .toMatchObject({ decision: 'block' });
  });

  it('blocks a renamed module that remains unreachable and names its new path', () => {
    const { repo, baseOid } = makeRepo({
      'src/old-island.ts': 'export const island = true;\n',
    });
    git(repo, ['mv', 'src/old-island.ts', 'src/new-island.ts']);
    commit(repo, 'rename island');

    const tree = readBranch(repo, baseOid);
    expect(tree.changedPaths).toContainEqual({
      status: 'renamed',
      oldPath: 'src/old-island.ts',
      path: 'src/new-island.ts',
    });
    expect(
      findingForPath(
        evaluateSemanticPolicy({ tree, policy: BASE_POLICY, now: new Date('2026-07-15') }),
        'semantic.production-reachability',
        'src/new-island.ts',
      ),
    ).toMatchObject({ decision: 'block' });
  });

  it('warns for a modified pre-existing unreachable module', () => {
    const { repo, baseOid } = makeRepo({
      'src/island.ts': 'export const island = true;\n',
    });
    write(repo, 'src/island.ts', 'export const island = false;\n');
    commit(repo, 'modify island');

    expect(findingForPath(findingsFor(repo, baseOid), 'semantic.production-reachability', 'src/island.ts'))
      .toMatchObject({ decision: 'warn' });
  });

  it('ignores a deleted module for production reachability', () => {
    const { repo, baseOid } = makeRepo({
      'src/island.ts': 'export const island = true;\n',
    });
    rmSync(path.join(repo, 'src/island.ts'));
    commit(repo, 'delete island');

    const findings = findingsFor(repo, baseOid);
    expect(findingForPath(findings, 'semantic.production-reachability', 'src/island.ts')).toBeUndefined();
  });

  it('does not read a working-tree integration edit after the inspected HEAD', () => {
    const { repo, baseOid } = makeRepo();
    write(repo, 'src/feature.ts', 'export const feature = true;\n');
    commit(repo, 'add unreachable feature');
    write(repo, 'src/main.ts', `import { feature } from './feature.ts';\nvoid feature;\n`);

    const tree = readBranch(repo, baseOid);
    const main = tree.sources.find((source) => source.path === 'src/main.ts');

    expect(main?.text).toBe('export const main = true;\n');
    expect(readFileSync(path.join(repo, 'src/main.ts'), 'utf8')).toContain("from './feature.ts'");
    expect(
      findingForPath(
        evaluateSemanticPolicy({ tree, policy: BASE_POLICY, now: new Date('2026-07-15') }),
        'semantic.production-reachability',
        'src/feature.ts',
      ),
    ).toMatchObject({ decision: 'block' });
  });

  it('returns an inconclusive finding when the requested base cannot be resolved', () => {
    const { repo } = makeRepo();

    const tree = readCandidateTree({
      cwd: repo,
      head: 'HEAD',
      baseRef: 'refs/heads/does-not-exist',
      scope: 'branch',
    });
    const findings = evaluateSemanticPolicy({ tree, policy: BASE_POLICY, now: new Date('2026-07-15') });

    expect(tree.limitations.join(' ')).toMatch(/base.*does-not-exist/i);
    expect(findings).toContainEqual(
      expect.objectContaining({ decision: 'inconclusive' }),
    );
  });

  it('treats a parse failure as inconclusive rather than a partial clean graph', () => {
    const { repo, baseOid } = makeRepo();
    write(repo, 'src/main.ts', `import { feature from './feature.ts';\n`);
    commit(repo, 'add malformed source');

    const findings = findingsFor(repo, baseOid);

    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'semantic.analysis-unavailable',
        decision: 'inconclusive',
      }),
    );
  });

  it('warns on an unresolved relative runtime edge in a changed production module', () => {
    const { repo, baseOid } = makeRepo();
    write(repo, 'src/main.ts', `import './missing.ts';\nexport const main = true;\n`);
    commit(repo, 'add unresolved runtime edge');

    expect(findingForPath(findingsFor(repo, baseOid), 'semantic.unresolved-runtime-edge', 'src/main.ts'))
      .toMatchObject({
        decision: 'warn',
        evidence: expect.arrayContaining([
          { label: 'unresolved_specifier', value: './missing.ts' },
        ]),
      });
  });

  it('warns with export-level evidence for a reachable but unowned runtime export', () => {
    const { repo, baseOid } = makeRepo();
    write(repo, 'src/main.ts', `import './feature.ts';\nexport const main = true;\n`);
    write(repo, 'src/feature.ts', 'export function feature() { return true; }\n');
    commit(repo, 'add unowned export');

    expect(findingForPath(findingsFor(repo, baseOid), 'semantic.export-ownership', 'src/feature.ts'))
      .toMatchObject({
        decision: 'warn',
        evidence: expect.arrayContaining([
          { label: 'unowned_export', value: 'src/feature.ts#feature' },
        ]),
      });
  });

  it('uses tree scope as a warning-only full-tree inventory', () => {
    const { repo } = makeRepo({
      'src/island.ts': 'export const island = true;\n',
    });

    const tree = readCandidateTree({ cwd: repo, head: 'HEAD', scope: 'tree' });
    const finding = findingForPath(
      evaluateSemanticPolicy({ tree, policy: BASE_POLICY, now: new Date('2026-07-15') }),
      'semantic.production-reachability',
      'src/island.ts',
    );

    expect(tree.baseOid).toBeNull();
    expect(tree.mergeBaseOid).toBeNull();
    expect(tree.changedPaths).toContainEqual({ status: 'modified', path: 'src/island.ts' });
    expect(finding).toMatchObject({ decision: 'warn' });
  });

  // A per-file `git show` made the Git subprocess count grow with the tree (one
  // process per source file). The shim logs each call's subcommand, on PATH and
  // as the exact reader's Git, only around the read.
  it.each([12, 40])('reads every head blob through a fixed set of Git processes (%i extra files)', (count) => {
    const extraFiles = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`src/module-${index}.ts`, `export const value${index} = ${index};\n`]),
    );
    const { repo } = makeRepo(extraFiles);
    const logPath = path.join(tmp.make('semantic-quality-git-log'), 'git-calls.log');
    const shim = writeGitShim('semantic-quality-git-shim', [
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    -*) ;;',
      `    *) printf '%s\\n' "$arg" >> ${shellQuoted(logPath)}; break ;;`,
      '  esac',
      'done',
    ]);

    const tree = readTreeWithShim(repo, shim, true);

    const calls = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(tree.limitations).toEqual([]);
    expect(tree.sources).toHaveLength(count + 1);
    expect(tree.sources.find((source) => source.path === 'src/module-7.ts')?.text)
      .toBe('export const value7 = 7;\n');
    expect(calls.filter((call) => call === 'show')).toEqual([]);
    expect(calls).toEqual(['rev-parse', 'ls-tree', 'rev-parse', 'cat-file', 'cat-file']);
  });

  // Oracle: the batch read must return what a per-file `git show` returns for
  // every blob entry (a gitlink to an existing commit is the disclosed
  // exception; see the next test) — same text for a spaced path, a newline path,
  // a symlink, CRLF text and non-UTF-8 bytes, and a per-path limitation wherever
  // `git show` fails.
  it('matches per-file git show content and failures across awkward tree entries', () => {
    const { repo } = makeRepo();
    write(repo, 'src/with space.ts', 'export const spaced = true;\n');
    write(repo, 'src/new\nline.ts', 'export const newline = true;\n');
    write(repo, 'src/crlf.ts', 'export const crlf = true;\r\n');
    writeFileSync(path.join(repo, 'src/bytes.ts'), Buffer.from([0x2f, 0x2f, 0xff, 0xfe, 0x00, 0x41, 0x0a]));
    symlinkSync('main.ts', path.join(repo, 'src/link.ts'));
    git(repo, ['add', '-A']);
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},src/gitlink.ts`]);
    git(repo, ['commit', '-m', 'awkward entries']);

    const listed = git(repo, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', 'src'])
      .split('\0')
      .filter((entry) => entry.endsWith('.ts'))
      .sort();
    const expectedSources: Array<{ path: string; text: string }> = [];
    const expectedFailures: string[] = [];
    for (const sourcePath of listed) {
      try {
        const text = execFileSync('git', ['show', `HEAD:${sourcePath}`], {
          cwd: repo,
          encoding: 'utf8',
          env: cleanGitEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        expectedSources.push({ path: sourcePath, text });
      } catch {
        expectedFailures.push(sourcePath);
      }
    }
    expect(listed).toContain('src/gitlink.ts');
    expect(expectedFailures).toEqual(['src/gitlink.ts']);

    const tree = readCandidateTree({ cwd: repo, head: 'HEAD', scope: 'tree' });

    expect(tree.sources).toEqual(expectedSources);
    for (const failed of expectedFailures) {
      expect(tree.limitations.some((entry) => entry.startsWith(`head blob ${failed} could not be read: `)), failed)
        .toBe(true);
    }
    expect(tree.limitations).toContain(`source tree is incomplete: read ${expectedSources.length} of ${listed.length} blobs`);
  });

  // The batch read refuses a non-blob entry per path. A gitlink whose commit
  // exists is the one entry where this differs from per-file `git show`, which
  // printed the formatted commit; the analyzer must not see that as source.
  it('refuses a gitlink to an existing commit as a non-blob head entry', () => {
    const { repo, baseOid } = makeRepo();
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},src/sub.ts`]);
    git(repo, ['commit', '-m', 'gitlink to an existing commit']);

    const tree = readCandidateTree({ cwd: repo, head: 'HEAD', scope: 'tree' });

    expect(tree.sources.map((source) => source.path)).toEqual(['src/main.ts']);
    expect(tree.limitations).toContain('head blob src/sub.ts could not be read: object is a commit, not a blob');
    expect(tree.limitations).toContain('source tree is incomplete: read 1 of 2 blobs');
  });

  // A failure of the batch read itself is one tree-level limitation and no
  // sources, never a partial tree. Only the exact reader's Git sees this shim.
  it('reports one limitation and no sources when the head blob batch fails', () => {
    const { repo } = makeRepo();
    const shim = writeFailingBatchShim('semantic-quality-git-failing-batch');

    const tree = readTreeWithShim(repo, shim, false);

    expect(tree.sources).toEqual([]);
    expect(tree.limitations).toEqual([
      'head blobs could not be read: ci.input.blob-unavailable',
      'source tree is incomplete: read 0 of 1 blobs',
    ]);
  });

  // The per-path refusal of a non-blob entry does not depend on the read: a
  // gitlink keeps its limitation when the batch read fails as well.
  it('keeps the gitlink refusal when the head blob batch fails', () => {
    const { repo, baseOid } = makeRepo();
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},src/sub.ts`]);
    git(repo, ['commit', '-m', 'gitlink to an existing commit']);
    const shim = writeFailingBatchShim('semantic-quality-git-failing-batch-gitlink');

    const tree = readTreeWithShim(repo, shim, false);

    expect(tree.sources).toEqual([]);
    expect(tree.limitations).toEqual([
      'head blob src/sub.ts could not be read: object is a commit, not a blob',
      'head blobs could not be read: ci.input.blob-unavailable',
      'source tree is incomplete: read 0 of 2 blobs',
    ]);
  });

  // The exact reader caps one blob at MAX_EXACT_SINGLE_BLOB_BYTES; a larger
  // source file fails the whole read closed instead of being analysed.
  it('fails the head read closed when one source blob exceeds the exact reader size cap', () => {
    const { repo } = makeRepo({
      'src/large.ts': `export const large = '${'x'.repeat(MAX_EXACT_SINGLE_BLOB_BYTES)}';\n`,
    });

    const tree = readCandidateTree({ cwd: repo, head: 'HEAD', scope: 'tree' });

    expect(tree.sources).toEqual([]);
    expect(tree.limitations).toEqual([
      'head blobs could not be read: ci.input.blob-set-budget',
      'source tree is incomplete: read 0 of 2 blobs',
    ]);
  });

  it('does not report an empty source tree as healthy', () => {
    const { repo } = makeRepo();
    rmSync(path.join(repo, 'src'), { recursive: true, force: true });
    write(repo, 'README.md', '# Empty source tree\n');
    commit(repo, 'remove sources');

    const tree = readCandidateTree({ cwd: repo, head: 'HEAD', scope: 'tree' });

    expect(tree.sources).toEqual([]);
    expect(tree.limitations.join(' ')).toMatch(/no TypeScript source/i);
  });
});

describe('semantic quality policy allowlist', () => {
  it('blocks an expired allowlist record', () => {
    const { repo, baseOid } = makeRepo();
    write(repo, 'src/feature.ts', 'export const feature = true;\n');
    commit(repo, 'add expired-override feature');
    const policy: SemanticQualityPolicy = {
      ...BASE_POLICY,
      allowlist: [{
        path: 'src/feature.ts',
        owner: 'runtime-maintainers',
        reason: 'Temporary migration bridge',
        expiresOn: '2026-07-14',
        reentryCondition: 'Wire through src/main.ts',
      }],
    };

    expect(findingForPath(findingsFor(repo, baseOid, policy), 'semantic.invalid-allowlist', 'src/feature.ts'))
      .toMatchObject({ decision: 'block' });
  });

  it('lowers only the exact active allowlisted path and records its reason', () => {
    const { repo, baseOid } = makeRepo();
    write(repo, 'src/allowed.ts', 'export const allowed = true;\n');
    write(repo, 'src/blocked.ts', 'export const blocked = true;\n');
    commit(repo, 'add two islands');
    const policy: SemanticQualityPolicy = {
      ...BASE_POLICY,
      allowlist: [{
        path: 'src/allowed.ts',
        owner: 'runtime-maintainers',
        reason: 'Temporary migration bridge',
        expiresOn: '2099-12-31',
        reentryCondition: 'Wire through src/main.ts',
      }],
    };

    const findings = findingsFor(repo, baseOid, policy);
    const allowed = findingForPath(findings, 'semantic.production-reachability', 'src/allowed.ts');
    const blocked = findingForPath(findings, 'semantic.production-reachability', 'src/blocked.ts');

    expect(allowed).toMatchObject({
      decision: 'warn',
      evidence: expect.arrayContaining([
        { label: 'allowlist_reason', value: 'Temporary migration bridge' },
        { label: 'allowlist_owner', value: 'runtime-maintainers' },
      ]),
    });
    expect(blocked).toMatchObject({ decision: 'block' });
  });
});

describe('semantic quality policy loader', () => {
  it('loads the versioned policy when every field is valid', () => {
    const { repo } = makeRepo();
    writePolicy(repo, {
      schemaVersion: 1,
      roots: ['src/main.ts'],
      sourcePrefixes: ['src/'],
      excludedSuffixes: ['.d.ts'],
      allowlist: [],
    });

    expect(loadSemanticPolicy(repo)).toEqual(BASE_POLICY);
  });

  it('loads policy from the requested commit instead of an unstaged override', () => {
    const { repo } = makeRepo();
    writePolicy(repo, BASE_POLICY);
    commit(repo, 'add semantic policy');
    writePolicy(repo, {
      ...BASE_POLICY,
      allowlist: [{
        path: 'src/main.ts',
        owner: 'unstaged-owner',
        reason: 'Uncommitted bypass attempt',
        expiresOn: '2099-12-31',
        reentryCondition: 'Never durable',
      }],
    });

    expect(loadSemanticPolicy(repo, 'HEAD').allowlist).toEqual([]);
  });

  it.each([
    ['an unknown top-level key', { ...BASE_POLICY, unexpected: true }, /unknown top-level key.*unexpected/i],
    ['duplicate roots', { ...BASE_POLICY, roots: ['src/main.ts', 'src/main.ts'] }, /duplicate root/i],
    ['a root outside src', { ...BASE_POLICY, roots: ['scripts/tool.ts'] }, /root.*outside/i],
    [
      'an invalid ISO expiry',
      {
        ...BASE_POLICY,
        allowlist: [{
          path: 'src/feature.ts',
          owner: 'runtime-maintainers',
          reason: 'Temporary bridge',
          expiresOn: 'not-a-date',
          reentryCondition: 'Wire the owner',
        }],
      },
      /expiresOn.*YYYY-MM-DD/i,
    ],
    [
      'an expired entry',
      {
        ...BASE_POLICY,
        allowlist: [{
          path: 'src/feature.ts',
          owner: 'runtime-maintainers',
          reason: 'Temporary bridge',
          expiresOn: '2000-01-01',
          reentryCondition: 'Wire the owner',
        }],
      },
      /expired.*src\/feature\.ts/i,
    ],
    [
      'duplicate allowlist paths',
      {
        ...BASE_POLICY,
        allowlist: [
          {
            path: 'src/feature.ts',
            owner: 'runtime-maintainers',
            reason: 'Temporary bridge',
            expiresOn: '2099-12-31',
            reentryCondition: 'Wire the owner',
          },
          {
            path: 'src/feature.ts',
            owner: 'runtime-maintainers',
            reason: 'Another bridge',
            expiresOn: '2099-12-31',
            reentryCondition: 'Wire the owner',
          },
        ],
      },
      /duplicate allowlist path/i,
    ],
    [
      'a missing required allowlist field',
      {
        ...BASE_POLICY,
        allowlist: [{
          path: 'src/feature.ts',
          reason: 'Temporary bridge',
          expiresOn: '2099-12-31',
          reentryCondition: 'Wire the owner',
        }],
      },
      /allowlist.*owner/i,
    ],
  ])('rejects %s', (_name, payload, expected) => {
    const { repo } = makeRepo();
    writePolicy(repo, payload);

    expect(() => loadSemanticPolicy(repo)).toThrow(expected);
  });
});
