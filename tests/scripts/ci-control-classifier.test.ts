import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { runClassifierCli } from '../../scripts/ci-control-classify.ts';
import {
  acquireLineageLease,
  assertClassifierToolSourcesStable,
  CLASSIFIER_TOOL_SOURCE_PATHS,
  classifyExactRevision,
  digestClassifierToolSources,
  invalidateForLineageChange,
  LineageLeaseError,
  type ExactRevisionInput,
  type LineageLeaseInput,
} from '../../scripts/lib/ci-control/classifier.ts';
import { readExactChangeFacts } from '../../scripts/lib/ci-control/git-input.ts';
import { digestControlManifest, loadControlManifest } from '../../scripts/lib/ci-control/manifest.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];
const ZERO_OID = '0'.repeat(40);
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Author',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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

function fixture(): { root: string; baseOid: string; manifestDigest: string } {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-classifier-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet']);
  mkdirSync(join(root, 'controls'), { recursive: true });
  cpSync(join(projectRoot, 'controls/ci-control-manifest.json'), join(root, 'controls/ci-control-manifest.json'));
  write(root, 'docs/guide.md', 'base guide\n');
  write(root, 'src/example.ts', 'export const value = 1;\n');
  write(root, 'tests/example.test.ts', 'export {};\n');
  const baseOid = commit(root, 'base');
  return { root, baseOid, manifestDigest: digestControlManifest(loadControlManifest(root)) };
}

function input(baseOid: string, candidateOid: string, manifestDigest: string, overrides: Partial<ExactRevisionInput> = {}): ExactRevisionInput {
  return {
    eventName: 'local',
    baseOid,
    candidateOid,
    mergeOid: null,
    manifestDigest,
    ...overrides,
  };
}

function classify(root: string, baseOid: string, candidateOid: string, manifestDigest: string) {
  return classifyExactRevision(root, input(baseOid, candidateOid, manifestDigest));
}

function runtimeSourceClosure(entryPath: string, sourceRoot = projectRoot): string[] {
  const pending = [resolve(sourceRoot, entryPath)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      let specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : null;
      if (specifier === null && ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        if (isDynamicImport || isRequire) {
          const argument = node.arguments[0];
          const validArity = isDynamicImport
            ? node.arguments.length === 1 || node.arguments.length === 2
            : node.arguments.length === 1;
          if (!validArity || argument === undefined || !ts.isStringLiteralLike(argument)) {
            throw new Error(`unbounded runtime import in ${relative(sourceRoot, sourcePath)}`);
          }
          specifier = argument.text;
        }
      }
      if (specifier?.startsWith('.') === true) {
        const unresolved = resolve(dirname(sourcePath), specifier);
        const dependency = [unresolved, `${unresolved}.ts`, join(unresolved, 'index.ts')]
          .find((candidate) => existsSync(candidate));
        if (dependency === undefined) throw new Error(`unresolved local import in ${relative(sourceRoot, sourcePath)}`);
        pending.push(dependency);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...visited].map((path) => relative(sourceRoot, path).replaceAll('\\', '/')).sort();
}

const LOW_CONTROLS = [
  'ci.exact-revision-classifier',
  'ci.hooks.installed',
  'ci.outgoing-ref-policy',
  'privacy.publication',
  'repo.hygiene',
  'workflow.safeguard-diagnostics',
];
const ALL_CONTROLS = [
  'architecture.fitness-lint',
  'ci.exact-revision-classifier',
  'ci.hooks.installed',
  'ci.outgoing-ref-policy',
  'privacy.publication',
  'repo.hygiene',
  'test.integrity',
  'workflow.safeguard-diagnostics',
];

describe('exact Git-object input', () => {
  it('reports exact added, modified, and deleted facts between the supplied OIDs', () => {
    const { root, baseOid } = fixture();
    write(root, 'src/added.ts', 'export const added = 7;\n');
    write(root, 'src/example.ts', 'export const value = 2;\n');
    rmSync(join(root, 'docs/guide.md'));
    const candidateOid = commit(root, 'add modify delete');
    const facts = readExactChangeFacts(root, baseOid, candidateOid);
    expect(facts).toEqual([
      {
        status: 'deleted', oldPath: null, path: 'docs/guide.md',
        oldMode: '100644', newMode: '000000',
        oldOid: git(root, ['rev-parse', `${baseOid}:docs/guide.md`]), newOid: ZERO_OID,
        oldType: 'blob', newType: 'absent', similarity: null,
      },
      {
        status: 'added', oldPath: null, path: 'src/added.ts',
        oldMode: '000000', newMode: '100644',
        oldOid: ZERO_OID, newOid: git(root, ['rev-parse', `${candidateOid}:src/added.ts`]),
        oldType: 'absent', newType: 'blob', similarity: null,
      },
      {
        status: 'modified', oldPath: null, path: 'src/example.ts',
        oldMode: '100644', newMode: '100644',
        oldOid: git(root, ['rev-parse', `${baseOid}:src/example.ts`]), newOid: git(root, ['rev-parse', `${candidateOid}:src/example.ts`]),
        oldType: 'blob', newType: 'blob', similarity: null,
      },
    ]);
  });

  it('reports R100 rename and C100 copy from the original source path', () => {
    const { root, baseOid } = fixture();
    mkdirSync(join(root, 'lib'), { recursive: true });
    git(root, ['mv', 'src/example.ts', 'lib/renamed.ts']);
    cpSync(join(root, 'lib/renamed.ts'), join(root, 'lib/copied.ts'));
    const candidateOid = commit(root, 'rename and copy');
    const sourceOid = git(root, ['rev-parse', `${baseOid}:src/example.ts`]);
    expect(readExactChangeFacts(root, baseOid, candidateOid)).toEqual([
      {
        status: 'copied', oldPath: 'src/example.ts', path: 'lib/copied.ts',
        oldMode: '100644', newMode: '100644', oldOid: sourceOid, newOid: sourceOid,
        oldType: 'blob', newType: 'blob', similarity: 100,
      },
      {
        status: 'renamed', oldPath: 'src/example.ts', path: 'lib/renamed.ts',
        oldMode: '100644', newMode: '100644', oldOid: sourceOid, newOid: sourceOid,
        oldType: 'blob', newType: 'blob', similarity: 100,
      },
    ]);
  });

  it('reports executable mode changes without changing the blob identity', () => {
    const { root, baseOid } = fixture();
    git(root, ['update-index', '--chmod=+x', 'src/example.ts']);
    git(root, ['commit', '--quiet', '-m', 'chmod']);
    const candidateOid = git(root, ['rev-parse', 'HEAD']);
    const blobOid = git(root, ['rev-parse', `${baseOid}:src/example.ts`]);
    expect(readExactChangeFacts(root, baseOid, candidateOid)).toEqual([{
      status: 'modified', oldPath: null, path: 'src/example.ts',
      oldMode: '100644', newMode: '100755', oldOid: blobOid, newOid: blobOid,
      oldType: 'blob', newType: 'executable', similarity: null,
    }]);
  });

  it('reports symlink and gitlink modes and exact object identities', () => {
    const { root, baseOid } = fixture();
    write(root, '.link-target', 'guide.md');
    const linkOid = git(root, ['hash-object', '-w', '.link-target']);
    rmSync(join(root, '.link-target'));
    git(root, ['update-index', '--add', '--cacheinfo', `120000,${linkOid},docs/guide-link`]);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'symlink and gitlink']);
    const candidateOid = git(root, ['rev-parse', 'HEAD']);
    const facts = readExactChangeFacts(root, baseOid, candidateOid);
    expect(facts).toEqual([
      {
        status: 'added', oldPath: null, path: 'docs/guide-link',
        oldMode: '000000', newMode: '120000', oldOid: ZERO_OID,
        newOid: linkOid,
        oldType: 'absent', newType: 'symlink', similarity: null,
      },
      {
        status: 'added', oldPath: null, path: 'vendor/component',
        oldMode: '000000', newMode: '160000', oldOid: ZERO_OID, newOid: baseOid,
        oldType: 'absent', newType: 'gitlink', similarity: null,
      },
    ]);
  });

  it('does not read a dirty worktree or index when classifying exact commits', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, '.github/workflows/unsafe.yml', 'permissions: write-all\n');
    const candidateOid = commit(root, 'add workflow');
    const clean = classify(root, baseOid, candidateOid, manifestDigest);
    rmSync(join(root, '.github/workflows/unsafe.yml'));
    write(root, 'docs/ambient-only.md', 'must be ignored\n');
    git(root, ['add', '-A']);
    const contaminated = classify(root, baseOid, candidateOid, manifestDigest);
    expect(contaminated).toEqual(clean);
    expect(contaminated.changed.map(({ path }) => path)).toContain('.github/workflows/unsafe.yml');
    expect(contaminated.changed.map(({ path }) => path)).not.toContain('docs/ambient-only.md');
  });
});

describe('exact revision classification', () => {
  it('digests the bounded runtime source inventory and rejects symlink substitution', () => {
    expect([...CLASSIFIER_TOOL_SOURCE_PATHS].sort()).toEqual(
      runtimeSourceClosure('scripts/ci-control-classify.ts'),
    );
    const sourceRoot = mkdtempSync(join(tmpdir(), 'ci-control-source-identity-'));
    temporaryRoots.push(sourceRoot);
    for (const path of CLASSIFIER_TOOL_SOURCE_PATHS) {
      const target = join(sourceRoot, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(projectRoot, path), target);
    }
    const before = digestClassifierToolSources(sourceRoot);
    const transitivePath = join(sourceRoot, 'src/lib/type-guards.ts');
    writeFileSync(transitivePath, `${readFileSync(transitivePath, 'utf8')}\n`, 'utf8');
    expect(digestClassifierToolSources(sourceRoot)).not.toBe(before);

    rmSync(transitivePath);
    symlinkSync(join(projectRoot, 'src/lib/type-guards.ts'), transitivePath);
    expect(() => digestClassifierToolSources(sourceRoot)).toThrow('ci.classification.tool-source-symlink');
  });

  it('tracks bounded dynamic imports and rejects computed runtime dependencies', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'ci-control-import-closure-'));
    temporaryRoots.push(sourceRoot);
    write(sourceRoot, 'entry.ts', [
      "void import('./dynamic-one.ts');",
      'void import(`./dynamic-two.ts`, {});',
      "require('./required.ts');",
      '',
    ].join('\n'));
    for (const path of ['dynamic-one.ts', 'dynamic-two.ts', 'required.ts']) {
      write(sourceRoot, path, 'export const value = 1;\n');
    }
    expect(runtimeSourceClosure('entry.ts', sourceRoot)).toEqual([
      'dynamic-one.ts',
      'dynamic-two.ts',
      'entry.ts',
      'required.ts',
    ]);

    for (const expression of ['void import(target);', 'require(target);']) {
      write(sourceRoot, 'entry.ts', `const target = './dynamic-one.ts'; ${expression}\n`);
      expect(() => runtimeSourceClosure('entry.ts', sourceRoot))
        .toThrow('unbounded runtime import in entry.ts');
    }
  });

  it('rejects tool sources changed after process start or after the loaded digest was captured', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'ci-control-source-stability-'));
    temporaryRoots.push(sourceRoot);
    for (const path of CLASSIFIER_TOOL_SOURCE_PATHS) {
      const target = join(sourceRoot, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(projectRoot, path), target);
    }
    const loadedDigest = digestClassifierToolSources(sourceRoot);
    expect(assertClassifierToolSourcesStable(sourceRoot, Date.now() + 60_000, loadedDigest)).toBe(loadedDigest);
    expect(() => assertClassifierToolSourcesStable(sourceRoot, 0, loadedDigest))
      .toThrow('ci.classification.tool-source-changed-during-process');

    const transitivePath = join(sourceRoot, 'src/lib/type-guards.ts');
    writeFileSync(transitivePath, `${readFileSync(transitivePath, 'utf8')}\n`, 'utf8');
    expect(() => assertClassifierToolSourcesStable(sourceRoot, Date.now() + 60_000, loadedDigest))
      .toThrow('ci.classification.tool-source-changed');
  });

  it('passes a positively covered documentation-only neighbor at low risk', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/guide.md', 'updated guide\n');
    const candidateOid = commit(root, 'docs only');
    const result = classify(root, baseOid, candidateOid, manifestDigest);
    expect(result.outcome).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.riskTier).toBe('low');
    expect(result.reasons).toEqual(['ci.classification.docs-only']);
    expect(result.baseOid).toBe(baseOid);
    expect(result.candidateOid).toBe(candidateOid);
    expect(result.mergeOid).toBeNull();
    expect(result.mergeBaseOid).toBe(baseOid);
    expect(result.manifestDigest).toBe(manifestDigest);
    expect(result.classifierDigest).toBe(digestClassifierToolSources(projectRoot));
    expect(result.graphDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.changeSetDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.requiredControls).toEqual(LOW_CONTROLS);
    expect(result.requiredSuites).toEqual([]);
  });

  it('rejects caller-selected risk fields at the library boundary', () => {
    const { root, baseOid, manifestDigest } = fixture();
    const result = classifyExactRevision(root, {
      ...input(baseOid, baseOid, manifestDigest),
      risk: 'low',
    } as ExactRevisionInput);
    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(result.reasons).toEqual(['ci.input.shape-invalid']);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it.each([
    ['dependency manifest', 'package.json', '{}\n', 'elevated', ['ci.classification.dependency-manifest']],
    ['dependency lock', 'package-lock.json', '{}\n', 'elevated', ['ci.classification.dependency-lock']],
    ['workflow', '.github/workflows/quality.yml', 'name: quality\n', 'elevated', ['ci.classification.workflow']],
    ['hook', '.husky/pre-push', '#!/bin/sh\n', 'elevated', ['ci.classification.executable-mode', 'ci.classification.hook']],
    ['release', 'deploy/release.json', '{}\n', 'elevated', ['ci.classification.release']],
    ['policy', 'controls/policy.json', '{}\n', 'system-wide', ['ci.classification.policy']],
  ] as const)('classifies %s from manifest-owned path rules', (_label, path, bytes, tier, reasons) => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, path, bytes);
    let candidateOid: string;
    if (path === '.husky/pre-push') {
      git(root, ['add', path]);
      git(root, ['update-index', '--chmod=+x', path]);
      git(root, ['commit', '--quiet', '-m', `change ${path}`]);
      candidateOid = git(root, ['rev-parse', 'HEAD']);
    } else {
      candidateOid = commit(root, `change ${path}`);
    }
    const result = classify(root, baseOid, candidateOid, manifestDigest);
    expect(result.outcome).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.riskTier).toBe(tier);
    expect(result.reasons).toEqual(reasons);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it('fails closed on an uncovered gitlink while preserving its native object-type reason', () => {
    const { root, baseOid, manifestDigest } = fixture();
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'gitlink']);
    const candidateOid = git(root, ['rev-parse', 'HEAD']);
    const result = classify(root, baseOid, candidateOid, manifestDigest);
    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(result.reasons).toEqual([
      'ci.classification.gitlink',
      'ci.classification.unknown-path',
    ]);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it('takes the maximum old/new-path and object-type risk for renames and mode changes', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'controls/owned.ts', 'export {};\n');
    const setupOid = commit(root, 'add policy source');
    mkdirSync(join(root, 'docs'), { recursive: true });
    git(root, ['mv', 'controls/owned.ts', 'docs/owned.md']);
    git(root, ['update-index', '--chmod=+x', 'src/example.ts']);
    git(root, ['commit', '--quiet', '-m', 'rename and chmod']);
    const candidateOid = git(root, ['rev-parse', 'HEAD']);
    const result = classify(root, setupOid, candidateOid, manifestDigest);
    expect(result.outcome).toBe('pass');
    expect(result.riskTier).toBe('system-wide');
    expect(result.reasons).toEqual(['ci.classification.executable-mode', 'ci.classification.policy']);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
    expect(result.changed.find(({ path }) => path === 'src/example.ts')).toMatchObject({ oldMode: '100644', newMode: '100755', oldType: 'blob', newType: 'executable' });
    expect(result.changed.find(({ path }) => path === 'docs/owned.md')).toMatchObject({ status: 'renamed', oldPath: 'controls/owned.ts' });
    expect(result.baseOid).toBe(setupOid);
    expect(result.mergeBaseOid).toBe(setupOid);
    expect(baseOid).not.toBe(setupOid);
  });

  it.each(['deleted', 'copied'] as const)('preserves old-path policy risk when a control file is %s', (operation) => {
    const { root, manifestDigest } = fixture();
    write(root, 'controls/owned.ts', 'export const owned = true;\n');
    const baseOid = commit(root, 'policy source');
    if (operation === 'deleted') {
      rmSync(join(root, 'controls/owned.ts'));
    } else {
      write(root, 'docs/copied.md', readFileSync(join(root, 'controls/owned.ts'), 'utf8'));
    }
    const candidateOid = commit(root, operation);
    const result = classify(root, baseOid, candidateOid, manifestDigest);
    expect(result).toMatchObject({ outcome: 'pass', exitCode: 0, riskTier: 'system-wide' });
    expect(result.reasons).toEqual(['ci.classification.policy']);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject(operation === 'deleted'
      ? { status: 'deleted', path: 'controls/owned.ts', oldPath: null }
      : { status: 'copied', path: 'docs/copied.md', oldPath: 'controls/owned.ts' });
  });

  it('keeps generated output elevated when its generator is unchanged', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'scripts/generators/report.ts', 'export const generate = true;\n');
    const generatorOid = commit(root, 'generator baseline');
    write(root, 'docs/generated/report.md', 'generated\n');
    const candidateOid = commit(root, 'generated output only');
    const result = classify(root, generatorOid, candidateOid, manifestDigest);
    expect(result).toMatchObject({ outcome: 'pass', exitCode: 0, riskTier: 'elevated' });
    expect(result.reasons).toEqual(['ci.classification.generated-output']);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
    expect(baseOid).not.toBe(generatorOid);
  });

  it('classifies the exact base-to-candidate tree delta instead of substituting their merge base', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/guide.md', 'candidate docs\n');
    const candidateOid = commit(root, 'candidate docs');
    write(root, 'controls/late-policy.ts', 'export const required = true;\n');
    const laterBaseOid = commit(root, 'later protected policy');

    const result = classify(root, laterBaseOid, candidateOid, manifestDigest);
    expect(result).toMatchObject({
      outcome: 'pass', exitCode: 0, riskTier: 'system-wide',
      baseOid: laterBaseOid, candidateOid, mergeBaseOid: candidateOid,
    });
    expect(result.reasons).toEqual(['ci.classification.policy']);
    expect(result.changed).toEqual([expect.objectContaining({
      status: 'deleted', path: 'controls/late-policy.ts', oldPath: null,
    })]);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
    expect(baseOid).not.toBe(candidateOid);
  });

  it('requires the tested merge object for pull requests and binds both parents', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/guide.md', 'candidate docs\n');
    const candidateOid = commit(root, 'candidate docs');
    const missing = classifyExactRevision(root, input(baseOid, candidateOid, manifestDigest, {
      eventName: 'pull_request',
    }));
    expect(missing).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(missing.reasons).toEqual(['ci.classification.merge-binding-invalid']);
    expect(missing.requiredControls).toEqual(ALL_CONTROLS);
    expect(missing.requiredSuites).toEqual(['tests/example.test.ts']);

    const unrelated = git(root, ['commit-tree', git(root, ['rev-parse', `${baseOid}^{tree}`]), '-m', 'not a merge']);
    const wrong = classifyExactRevision(root, input(baseOid, candidateOid, manifestDigest, {
      eventName: 'pull_request',
      mergeOid: unrelated,
    }));
    expect(wrong).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(wrong.reasons).toEqual(['ci.classification.merge-binding-invalid']);
    expect(wrong.requiredControls).toEqual(ALL_CONTROLS);
    expect(wrong.requiredSuites).toEqual(['tests/example.test.ts']);

    write(root, 'scripts/merge-only.sh', '#!/bin/sh\nexit 0\n');
    git(root, ['add', 'scripts/merge-only.sh']);
    git(root, ['update-index', '--chmod=+x', 'scripts/merge-only.sh']);
    const unsafeMergeOid = git(root, [
      'commit-tree', git(root, ['write-tree']),
      '-p', baseOid, '-p', candidateOid, '-m', 'merge-only executable',
    ]);
    const unsafeMerge = classifyExactRevision(root, input(baseOid, candidateOid, manifestDigest, {
      eventName: 'pull_request',
      mergeOid: unsafeMergeOid,
    }));
    expect(unsafeMerge).toMatchObject({ outcome: 'pass', exitCode: 0, riskTier: 'elevated' });
    expect(unsafeMerge.reasons).toEqual([
      'ci.classification.docs-only',
      'ci.classification.executable-mode',
      'ci.classification.shared-tooling',
    ]);
    expect(unsafeMerge.changed.map(({ path }) => path)).toEqual(['docs/guide.md', 'scripts/merge-only.sh']);
    expect(unsafeMerge.requiredControls).toEqual(ALL_CONTROLS);
    expect(unsafeMerge.requiredSuites).toEqual(['tests/example.test.ts']);

    const mergeOid = git(root, [
      'commit-tree', git(root, ['rev-parse', `${candidateOid}^{tree}`]),
      '-p', baseOid, '-p', candidateOid, '-m', 'tested merge',
    ]);
    const valid = classifyExactRevision(root, input(baseOid, candidateOid, manifestDigest, {
      eventName: 'pull_request',
      mergeOid,
    }));
    expect(valid).toMatchObject({
      outcome: 'pass', exitCode: 0, riskTier: 'low',
      baseOid, candidateOid, mergeOid,
    });
    expect(valid.reasons).toEqual(['ci.classification.docs-only']);
    expect(valid.requiredControls).toEqual(LOW_CONTROLS);
    expect(valid.requiredSuites).toEqual([]);
  });

  it('binds merge-group classification to the exact proposed merge object', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/guide.md', 'merge queue docs\n');
    const proposedMergeOid = commit(root, 'proposed merge group');

    const valid = classifyExactRevision(root, input(baseOid, proposedMergeOid, manifestDigest, {
      eventName: 'merge_group',
      mergeOid: proposedMergeOid,
    }));
    expect(valid).toMatchObject({
      outcome: 'pass', exitCode: 0, riskTier: 'low',
      baseOid, candidateOid: proposedMergeOid, mergeOid: proposedMergeOid,
      mergeBaseOid: baseOid,
    });
    expect(valid.reasons).toEqual(['ci.classification.docs-only']);
    expect(valid.requiredControls).toEqual(LOW_CONTROLS);
    expect(valid.requiredSuites).toEqual([]);

    const substituted = classifyExactRevision(root, input(baseOid, baseOid, manifestDigest, {
      eventName: 'merge_group',
      mergeOid: proposedMergeOid,
    }));
    expect(substituted).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(substituted.reasons).toEqual(['ci.classification.merge-binding-invalid']);
    expect(substituted.requiredControls).toEqual(ALL_CONTROLS);
    expect(substituted.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it('fails closed when a push predecessor is not an ancestor of the outgoing commit', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/guide.md', 'outgoing\n');
    const candidateOid = commit(root, 'outgoing');
    const siblingOid = git(root, [
      'commit-tree', git(root, ['rev-parse', `${baseOid}^{tree}`]),
      '-p', baseOid, '-m', 'divergent predecessor',
    ]);
    const result = classifyExactRevision(root, input(siblingOid, candidateOid, manifestDigest, {
      eventName: 'push',
    }));
    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(result.reasons).toEqual(['ci.classification.predecessor-not-ancestor']);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it.each([
    ['unknown path', (root: string) => write(root, 'mystery/run.bin', 'opaque\n'), ['ci.classification.unknown-path']],
  ] as const)('fails closed for %s while selecting the full system-wide work set', (_label, mutate, reasons) => {
    const { root, baseOid, manifestDigest } = fixture();
    mutate(root);
    const candidateOid = commit(root, 'uncertain');
    const result = classify(root, baseOid, candidateOid, manifestDigest);
    expect(result.outcome).toBe('inconclusive');
    expect(result.exitCode).toBe(2);
    expect(result.riskTier).toBe('system-wide');
    expect(result.reasons).toEqual(reasons);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it('fails closed for an exact symlink object without relying on host symlink behavior', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, '.link-target', '../docs/guide.md');
    const linkOid = git(root, ['hash-object', '-w', '.link-target']);
    rmSync(join(root, '.link-target'));
    git(root, ['update-index', '--add', '--cacheinfo', `120000,${linkOid},src/link`]);
    git(root, ['commit', '--quiet', '-m', 'symlink object']);
    const candidateOid = git(root, ['rev-parse', 'HEAD']);
    const result = classify(root, baseOid, candidateOid, manifestDigest);
    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(result.reasons).toEqual([
      'ci.classification.application-code',
      'ci.classification.symlink',
    ]);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it('fails closed when the candidate commit is missing', () => {
    const { root, baseOid, manifestDigest } = fixture();
    const result = classify(root, baseOid, 'f'.repeat(40), manifestDigest);
    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(result.reasons).toEqual([
      'ci.classification.graph-unavailable',
      'ci.input.revision-unavailable',
    ]);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['@full-suite:coverage:check']);
  });

  it('fails closed when a blob is supplied where a commit is required', () => {
    const { root, baseOid, manifestDigest } = fixture();
    const blobOid = git(root, ['hash-object', 'docs/guide.md']);
    const result = classify(root, baseOid, blobOid, manifestDigest);
    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(result.reasons).toEqual([
      'ci.classification.graph-unavailable',
      'ci.input.revision-not-commit',
    ]);
    expect(result.requiredControls).toEqual(ALL_CONTROLS);
    expect(result.requiredSuites).toEqual(['@full-suite:coverage:check']);
  });

  it('fails closed when the candidate manifest does not match the trusted digest', () => {
    const { root, baseOid } = fixture();
    const mismatch = classify(root, baseOid, baseOid, DIGEST_A);
    expect(mismatch).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(mismatch.reasons).toEqual(['ci.classification.manifest-mismatch']);
    expect(mismatch.requiredControls).toEqual(ALL_CONTROLS);
    expect(mismatch.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it.each(['missing', 'malformed'] as const)('uses conservative sentinels when protected policy is %s', (state) => {
    const { root, manifestDigest } = fixture();
    if (state === 'missing') rmSync(join(root, 'controls/ci-control-manifest.json'));
    else write(root, 'controls/ci-control-manifest.json', '{not-json\n');
    const invalidBaseOid = commit(root, 'invalid protected policy');
    mkdirSync(join(root, 'controls'), { recursive: true });
    cpSync(join(projectRoot, 'controls/ci-control-manifest.json'), join(root, 'controls/ci-control-manifest.json'));
    const candidateOid = commit(root, 'repair candidate policy');

    const result = classify(root, invalidBaseOid, candidateOid, manifestDigest);
    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(result.reasons).toEqual([
      state === 'missing'
        ? 'ci.classification.manifest-unavailable'
        : 'ci.classification.manifest-invalid',
    ]);
    expect(result.requiredControls).toEqual(['@full-control-set']);
    expect(result.requiredSuites).toEqual(['@full-suite:coverage:check']);
  });

  it('does not let candidate policy authorize its own lower risk', () => {
    const { root, baseOid, manifestDigest } = fixture();
    const manifestPath = join(root, 'controls/ci-control-manifest.json');
    const candidateManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { riskRules: Array<{ id: string; tier: string }> };
    const policyRule = candidateManifest.riskRules.find(({ id }) => id === 'risk.control-policy');
    if (policyRule === undefined) throw new Error('fixture policy rule missing');
    policyRule.tier = 'low';
    writeFileSync(manifestPath, `${JSON.stringify(candidateManifest, null, 2)}\n`, 'utf8');
    const candidateOid = commit(root, 'candidate weakens policy');
    const candidateDigest = digestControlManifest(loadControlManifest(root));

    const selfAuthorized = classify(root, baseOid, candidateOid, candidateDigest);
    expect(selfAuthorized).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(selfAuthorized.reasons).toEqual(['ci.classification.manifest-mismatch']);
    expect(selfAuthorized.requiredControls).toEqual(ALL_CONTROLS);
    expect(selfAuthorized.requiredSuites).toEqual(['tests/example.test.ts']);

    const protectedPolicy = classify(root, baseOid, candidateOid, manifestDigest);
    expect(protectedPolicy).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(protectedPolicy.reasons).toEqual([
      'ci.classification.candidate-policy-changed',
      'ci.classification.policy',
    ]);
    expect(protectedPolicy.requiredControls).toEqual(ALL_CONTROLS);
    expect(protectedPolicy.requiredSuites).toEqual(['tests/example.test.ts']);
  });

  it('fails closed when the base and candidate histories are unrelated', () => {
    const { root, baseOid, manifestDigest } = fixture();
    const other = mkdtempSync(join(tmpdir(), 'ci-control-unrelated-'));
    temporaryRoots.push(other);
    git(other, ['init', '--quiet']);
    mkdirSync(join(other, 'controls'), { recursive: true });
    cpSync(join(projectRoot, 'controls/ci-control-manifest.json'), join(other, 'controls/ci-control-manifest.json'));
    write(other, 'other.txt', 'other\n');
    const unrelatedOid = commit(other, 'unrelated');
    git(root, ['fetch', '--quiet', other, unrelatedOid]);
    const unrelated = classify(root, baseOid, unrelatedOid, manifestDigest);
    expect(unrelated).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(unrelated.reasons).toEqual(['ci.classification.merge-base-unavailable']);
    expect(unrelated.requiredControls).toEqual(ALL_CONTROLS);
    expect(unrelated.requiredSuites).toEqual(['@full-suite:coverage:check']);
  });

  it('fails closed when the base object is absent from a shallow graph', () => {
    const source = fixture();
    write(source.root, 'docs/guide.md', 'shallow candidate\n');
    const candidateOid = commit(source.root, 'candidate');
    const parent = mkdtempSync(join(tmpdir(), 'ci-control-shallow-parent-'));
    temporaryRoots.push(parent);
    const shallow = join(parent, 'clone');
    git(parent, ['clone', '--quiet', '--depth=1', `file://${source.root}`, shallow]);
    expect(git(shallow, ['rev-parse', 'HEAD'])).toBe(candidateOid);
    expect(() => git(shallow, ['cat-file', '-e', `${source.baseOid}^{commit}`])).toThrow();
    const result = classify(shallow, source.baseOid, candidateOid, source.manifestDigest);
    expect(result).toMatchObject({ outcome: 'inconclusive', exitCode: 2, riskTier: 'system-wide' });
    expect(git(shallow, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    expect(result.reasons).toEqual(['ci.classification.graph-incomplete']);
    expect(result.requiredControls).toEqual(['@full-control-set']);
    expect(result.requiredSuites).toEqual(['@full-suite:coverage:check']);
  });
});

describe('lineage lease invalidation', () => {
  function leaseInput(baseOid: string, candidateOid: string, manifestDigest: string, overrides: Partial<LineageLeaseInput> = {}): LineageLeaseInput {
    return {
      ...input(baseOid, candidateOid, manifestDigest),
      candidateRef: null,
      remoteRef: 'refs/remotes/origin/main',
      policyDigest: DIGEST_A,
      toolchainDigest: DIGEST_A,
      selectedPlanDigest: DIGEST_A,
      prerequisiteReceiptDigests: [DIGEST_A],
      createdAt: '2026-07-20T12:00:00.000Z',
      ...overrides,
    };
  }

  it('invalidates every dependent result when a bound identity changes', () => {
    const { root, baseOid, manifestDigest } = fixture();
    git(root, ['update-ref', 'refs/remotes/origin/main', baseOid]);
    const original = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));
    for (const mutate of [
      (value: typeof original) => ({ ...value, candidateOid: '1'.repeat(40) }),
      (value: typeof original) => ({ ...value, mergeOid: '2'.repeat(40) }),
      (value: typeof original) => ({ ...value, manifestDigest: DIGEST_B }),
      (value: typeof original) => ({ ...value, policyDigest: DIGEST_B }),
      (value: typeof original) => ({ ...value, toolchainDigest: DIGEST_B }),
      (value: typeof original) => ({ ...value, selectedPlanDigest: DIGEST_B }),
      (value: typeof original) => ({ ...value, prerequisiteReceiptDigests: [DIGEST_B] }),
    ]) {
      const decision = invalidateForLineageChange(original, mutate(original));
      expect(decision.scope).toBe('all');
      expect(decision.invalidated).toBe(true);
      expect(decision.revalidate).toEqual(['aggregate', 'classification', 'execution-plan', 'merge-result', 'metadata']);
    }
  });

  it('does not invalidate an identical lease solely because it was reacquired later', () => {
    const { root, baseOid, manifestDigest } = fixture();
    git(root, ['update-ref', 'refs/remotes/origin/main', baseOid]);
    const before = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));
    const after = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest, {
      createdAt: '2026-07-20T12:05:00.000Z',
    }));
    expect(invalidateForLineageChange(before, after)).toEqual({
      invalidated: false,
      scope: 'none',
      reasons: [],
      revalidate: [],
    });
  });

  it('invalidates when the bound candidate ref moves after lease acquisition', () => {
    const { root, baseOid, manifestDigest } = fixture();
    git(root, ['update-ref', 'refs/remotes/origin/main', baseOid]);
    git(root, ['update-ref', 'refs/heads/candidate', baseOid]);
    const before = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest, {
      candidateRef: 'refs/heads/candidate',
    }));
    write(root, 'docs/moved.md', 'moved\n');
    const movedOid = commit(root, 'move candidate ref');
    git(root, ['update-ref', 'refs/heads/candidate', movedOid]);
    expect(before.candidateRefOid).toBe(baseOid);
    let failure: unknown;
    try {
      acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest, {
        candidateRef: 'refs/heads/candidate',
      }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LineageLeaseError);
    expect(failure).toMatchObject({
      code: 'ci.lineage.candidate-moved',
      outcome: 'inconclusive',
      exitCode: 2,
      scope: 'all',
      revalidate: ['aggregate', 'classification', 'execution-plan', 'merge-result', 'metadata'],
      guidance: ['Reacquire the lease from the exact current ref and object identities.'],
      reproduce: 'npm run ci:classify -- --help',
      retryable: false,
    });
  });

  it('allows only child-receipt reuse after a disjoint remote documentation change', () => {
    const { root, baseOid, manifestDigest } = fixture();
    git(root, ['update-ref', 'refs/remotes/origin/main', baseOid]);
    const before = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));
    write(root, 'docs/remote.md', 'remote docs\n');
    const remoteOid = commit(root, 'remote docs');
    git(root, ['update-ref', 'refs/remotes/origin/main', remoteOid]);
    const after = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));
    expect(invalidateForLineageChange(before, after)).toEqual({
      invalidated: true,
      scope: 'metadata-and-merge',
      reasons: ['ci.lineage.remote-documentation-changed'],
      revalidate: ['aggregate', 'classification', 'merge-result', 'metadata'],
    });
  });

  it('invalidates all dependent evidence for a remote policy-document change', () => {
    const { root, baseOid, manifestDigest } = fixture();
    git(root, ['update-ref', 'refs/remotes/origin/main', baseOid]);
    const before = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));
    write(root, 'docs/superpowers/plans/control.md', 'policy\n');
    const remoteOid = commit(root, 'remote policy docs');
    git(root, ['update-ref', 'refs/remotes/origin/main', remoteOid]);
    const after = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));
    expect(invalidateForLineageChange(before, after)).toEqual({
      invalidated: true,
      scope: 'all',
      reasons: ['ci.lineage.remote-boundary-changed'],
      revalidate: ['aggregate', 'classification', 'execution-plan', 'merge-result', 'metadata'],
    });
  });

  it('derives remote invalidation from the exact protected manifest risk rules', () => {
    const { root } = fixture();
    const manifestPath = join(root, 'controls/ci-control-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      riskRules: Array<{ id: string; tier: string; reasons: string[]; pathPrefixes: string[] }>;
    };
    manifest.riskRules.push({
      id: 'risk.policy-next',
      tier: 'system-wide',
      reasons: ['ci.classification.policy-next'],
      pathPrefixes: ['docs/policy-next/'],
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const baseOid = commit(root, 'declare next policy surface');
    const manifestDigest = digestControlManifest(loadControlManifest(root));
    git(root, ['update-ref', 'refs/remotes/origin/main', baseOid]);
    const before = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));

    write(root, 'docs/policy-next/control.md', 'policy\n');
    const remoteOid = commit(root, 'change next policy surface');
    git(root, ['update-ref', 'refs/remotes/origin/main', remoteOid]);
    const after = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));

    expect(invalidateForLineageChange(before, after)).toEqual({
      invalidated: true,
      scope: 'all',
      reasons: ['ci.lineage.remote-boundary-changed'],
      revalidate: ['aggregate', 'classification', 'execution-plan', 'merge-result', 'metadata'],
    });
  });

  it('rejects unavailable remote graph evidence and defensively invalidates legacy null leases', () => {
    const { root, baseOid, manifestDigest } = fixture();
    const other = mkdtempSync(join(tmpdir(), 'ci-control-lineage-unrelated-'));
    temporaryRoots.push(other);
    git(other, ['init', '--quiet']);
    write(other, 'other.txt', 'other\n');
    const unrelatedOid = commit(other, 'unrelated remote');
    git(root, ['fetch', '--quiet', other, unrelatedOid]);
    git(root, ['update-ref', 'refs/remotes/origin/main', unrelatedOid]);

    let failure: unknown;
    try {
      acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LineageLeaseError);
    expect(failure).toMatchObject({
      code: 'ci.lineage.remote-graph-unavailable',
      outcome: 'inconclusive',
      exitCode: 2,
      scope: 'all',
    });

    git(root, ['update-ref', 'refs/remotes/origin/main', baseOid]);
    const valid = acquireLineageLease(root, leaseInput(baseOid, baseOid, manifestDigest));
    expect(invalidateForLineageChange(valid, { ...valid, treeGroupDigests: null })).toEqual({
      invalidated: true,
      scope: 'all',
      reasons: ['ci.lineage.remote-graph-unavailable'],
      revalidate: ['aggregate', 'classification', 'execution-plan', 'merge-result', 'metadata'],
    });

    write(root, 'docs/later.md', 'later\n');
    const laterBaseOid = commit(root, 'later local base');
    git(root, ['update-ref', 'refs/remotes/origin/main', baseOid]);
    let rewindFailure: unknown;
    try {
      acquireLineageLease(root, leaseInput(laterBaseOid, laterBaseOid, manifestDigest));
    } catch (error) {
      rewindFailure = error;
    }
    expect(rewindFailure).toBeInstanceOf(LineageLeaseError);
    expect(rewindFailure).toMatchObject({
      code: 'ci.lineage.remote-graph-unavailable',
      outcome: 'inconclusive',
      exitCode: 2,
      scope: 'all',
      revalidate: ['aggregate', 'classification', 'execution-plan', 'merge-result', 'metadata'],
      guidance: ['Reacquire the lease from the exact current ref and object identities.'],
      reproduce: 'npm run ci:classify -- --help',
      retryable: false,
    });
  });
});

describe('classifier CLI', () => {
  it('rejects caller-selected risk, abbreviated or symbolic revisions, duplicate options, and unknown options', () => {
    const { root, baseOid, manifestDigest } = fixture();
    const invoke = (args: string[]) => {
      let stdout = '';
      let stderr = '';
      const exitCode = runClassifierCli(args, root, { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } });
      return { exitCode, stdout, stderr };
    };
    for (const [args, code] of [
      [['--event', 'local', '--candidate', baseOid, '--base', baseOid, '--manifest-digest', manifestDigest, '--risk', 'low'], 'ci.input.option-unknown'],
      [['--event', 'local', '--candidate', baseOid.slice(0, 12), '--base', baseOid, '--manifest-digest', manifestDigest], 'ci.input.revision-invalid'],
      [['--event', 'local', '--candidate', 'HEAD', '--base', baseOid, '--manifest-digest', manifestDigest], 'ci.input.revision-invalid'],
      [['--event', 'local', '--candidate', baseOid, '--candidate', baseOid, '--base', baseOid, '--manifest-digest', manifestDigest], 'ci.input.duplicate-option'],
      [['--event', 'local', '--candidate', baseOid, '--base', baseOid, '--manifest-digest', manifestDigest, '--unknown'], 'ci.input.option-unknown'],
    ] as const) {
      const result = invoke([...args, '--json']);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        outcome: 'inconclusive',
        exitCode: 2,
        code,
        controlId: 'ci.exact-revision-classifier',
        owner: 'ci-classifier-owner',
        location: { kind: 'cli-invocation', name: 'ci:classify' },
        why: 'The exact-revision classifier invocation could not produce trusted evidence.',
        guidance: [
          'Provide only the closed event and full Git object identities.',
          'Re-run the canonical classifier command without caller-selected risk or checks.',
        ],
        reproduce: {
          command: 'npm run ci:classify -- --help',
          preconditions: ['Use the repository pinned runtime.'],
        },
        retryable: false,
      });
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(root);
    }
  });

  it('emits one terminal JSON result with the direct classifier exit code', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/guide.md', 'safe\n');
    const candidateOid = commit(root, 'safe docs');
    let stdout = '';
    let stderr = '';
    const exitCode = runClassifierCli([
      '--event', 'local', '--candidate', candidateOid, '--base', baseOid,
      '--manifest-digest', manifestDigest, '--json',
    ], root, { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } });
    expect(exitCode).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({ outcome: 'pass', exitCode: 0, candidateOid, baseOid });
    expect(stderr).toBe('');
  });
});
