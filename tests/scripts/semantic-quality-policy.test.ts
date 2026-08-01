import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { cleanGitEnv } from '../../src/lib/git-env.ts';
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
