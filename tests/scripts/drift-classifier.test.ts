import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DRIFT_ADAPTER_SOURCE_PATHS,
  assertDriftAdapterSourcesStable,
  digestDriftAdapterSources,
  main,
  parseArgs,
  trackedPaths,
} from '../../scripts/drift-classify.ts';
import {
  readControlManifestAtRevision,
} from '../../scripts/lib/ci-control/classifier.ts';
import { createRiskClassificationReceipt } from '../../scripts/lib/ci-control/classification-admission.ts';
import type { ChangeFactV1 } from '../../scripts/lib/ci-control/git-input.ts';
import {
  digestControlManifest,
  loadControlManifest,
  type ControlManifestV1,
} from '../../scripts/lib/ci-control/manifest.ts';
import {
  DRIFT_CLASSES,
  DRIFT_MATRIX,
  EXIT_CONTINUE,
  EXIT_INCONCLUSIVE,
  EXIT_STOP,
  RECEIPT_TAG_EXAMPLES,
  SENSITIVITY_TAGS,
  classifyDrift,
  classifyDriftFacts,
  codeForDrift,
  exitCodeFor,
  outcomeForDrift,
  projectDriftResult,
  receiptSurvives,
  worstOf,
} from '../../scripts/lib/drift-classifier.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const manifest = loadControlManifest(repoRoot);
const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
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
      GIT_AUTHOR_NAME: 'CI fixture',
      GIT_AUTHOR_EMAIL: 'ci-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'CI fixture',
      GIT_COMMITTER_EMAIL: 'ci-fixture@example.invalid',
    },
  }).trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function fixture(minimumFiles = 0): { root: string; baseOid: string; manifestDigest: string } {
  const root = mkdtempSync(join(tmpdir(), 'drift-classifier-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet']);
  write(root, 'controls/ci-control-manifest.json', readFileSync(resolve(repoRoot, 'controls/ci-control-manifest.json'), 'utf8'));
  write(root, 'docs/base.md', 'base\n');
  for (let index = 0; index < minimumFiles; index += 1) write(root, `docs/generated-${index}.md`, `${index}\n`);
  const baseOid = commit(root, 'base');
  return {
    root,
    baseOid,
    manifestDigest: digestControlManifest(readControlManifestAtRevision(root, baseOid)),
  };
}

function fact(path: string, overrides: Partial<ChangeFactV1> = {}): ChangeFactV1 {
  return {
    status: 'added', oldPath: null, path,
    oldMode: '000000', newMode: '100644',
    oldOid: '0'.repeat(40), newOid: '1'.repeat(40),
    oldType: 'absent', newType: 'blob', similarity: null,
    ...overrides,
  };
}

describe('drift matrix invariants', () => {
  it('defines every class with a substantive reason and only real sensitivity tags', () => {
    for (const drift of DRIFT_CLASSES) {
      expect(DRIFT_MATRIX[drift].why.length).toBeGreaterThan(30);
      for (const tag of DRIFT_MATRIX[drift].invalidates) expect(SENSITIVITY_TAGS).toContain(tag);
    }
  });

  it('never invalidates candidate-only evidence and preserves only explicitly reusable disjoint-code receipts', () => {
    for (const drift of DRIFT_CLASSES) expect(receiptSurvives(['candidate-only'], drift)).toBe(true);
    expect(receiptSurvives(['base-sensitive'], 'DISJOINT_CODE')).toBe(true);
    expect(receiptSurvives(['merge-sensitive'], 'DISJOINT_CODE')).toBe(false);
    for (const drift of DRIFT_CLASSES.filter((value) => !['NONE', 'DISJOINT_METADATA', 'DISJOINT_CODE'].includes(value))) {
      for (const tag of SENSITIVITY_TAGS.filter((value) => value !== 'candidate-only')) {
        expect(receiptSurvives([tag], drift), `${drift} preserved ${tag}`).toBe(false);
      }
    }
  });

  it('keeps examples inside the closed sensitivity vocabulary', () => {
    for (const tags of Object.values(RECEIPT_TAG_EXAMPLES)) {
      for (const tag of tags) expect(SENSITIVITY_TAGS).toContain(tag);
    }
  });
});

describe('manifest-backed projection', () => {
  it.each([
    ['docs/runbook.md', 'DISJOINT_METADATA'],
    ['src/runtimes/agent/runtime.ts', 'AFFECTED_COMPONENT'],
    ['src/lib/phone.ts', 'SHARED_RUNTIME'],
    ['package-lock.json', 'DEPENDENCY'],
    ['artifacts/proof.json', 'GENERATED_INPUT'],
    ['deploy/service.plist', 'AFFECTED_COMPONENT'],
    ['.github/workflows/quality.yml', 'POLICY_OR_WORKFLOW'],
    ['.gitignore', 'POLICY_OR_WORKFLOW'],
    ['.env.example', 'POLICY_OR_WORKFLOW'],
    ['tmp/connection-exhausted-rca-2026-04-04.md', 'POLICY_OR_WORKFLOW'],
    ['tmp/connection-exhausted-rca-2026-04-04.md/unsafe.ts', 'POLICY_OR_WORKFLOW'],
    ['docs/superpowers/plan.md', 'POLICY_OR_WORKFLOW'],
    ['tests/scripts/ci-control-manifest.test.ts', 'POLICY_OR_WORKFLOW'],
    ['controls/ci-control-manifest.json', 'POLICY_OR_WORKFLOW'],
  ])('%s projects the canonical reason as %s', (path, expected) => {
    expect(classifyDrift([path], manifest).drift).toBe(expected);
  });

  it('has no path policy outside the manifest', () => {
    const changed = structuredClone(manifest) as ControlManifestV1;
    changed.riskRules = [{
      id: 'risk.future',
      tier: 'system-wide',
      reasons: ['ci.classification.policy'],
      pathPrefixes: ['future/'],
    }];
    expect(classifyDrift(['future/value.bin'], changed).drift).toBe('POLICY_OR_WORKFLOW');
    expect(classifyDrift(['docs/runbook.md'], changed).drift).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for an unknown path or unknown future native reason', () => {
    expect(classifyDrift(['future/value.bin'], manifest).drift).toBe('UNKNOWN');
    expect(classifyDrift(['tmp/future-policy.json'], manifest).drift).toBe('POLICY_OR_WORKFLOW');
    const changed = structuredClone(manifest) as ControlManifestV1;
    changed.riskRules = [{
      id: 'risk.future', tier: 'elevated', reasons: ['ci.classification.future-semantics'], pathPrefixes: ['future/'],
    }];
    expect(classifyDrift(['future/value.bin'], changed).drift).toBe('UNKNOWN');
  });

  it('uses the disjoint-code reuse path only for an explicit canonical disjoint reason', () => {
    const changed = structuredClone(manifest) as ControlManifestV1;
    changed.riskRules = [{
      id: 'risk.proven-disjoint', tier: 'standard', reasons: ['ci.classification.disjoint-code'], pathPrefixes: ['closed/'],
    }];
    expect(classifyDrift(['closed/value.ts'], changed).drift).toBe('DISJOINT_CODE');
  });

  it('preserves canonical policy invalidation when candidate paths overlap', () => {
    const verdict = classifyDrift(['controls/ci-control-manifest.json'], manifest, {
      candidatePaths: ['controls/ci-control-manifest.json'],
    });
    expect(verdict.drift).toBe('POLICY_OR_WORKFLOW');
    expect(verdict.classifications[0]?.rule).toContain('ci.lineage.path-conflict');
    expect(verdict.invalidates).toEqual(expect.arrayContaining(['policy-sensitive', 'toolchain-sensitive', 'platform-sensitive']));
  });

  it('dependency overlap remains fully invalidating even when displayed as conflict', () => {
    const verdict = classifyDrift(['package-lock.json'], manifest, { candidatePaths: ['package-lock.json'] });
    expect(verdict.drift).toBe('CONFLICT');
    expect(verdict.invalidates).toEqual(expect.arrayContaining(['policy-sensitive', 'toolchain-sensitive', 'platform-sensitive']));
  });

  it('uses both old and new rename paths and mode/type facts from the canonical reader', () => {
    const rename = fact('docs/renamed.md', {
      status: 'renamed', oldPath: 'controls/old-policy.json', oldMode: '100644', newMode: '100644', similarity: 100,
    });
    expect(classifyDriftFacts([rename], manifest).drift).toBe('POLICY_OR_WORKFLOW');
    expect(classifyDriftFacts([fact('docs/run.sh', { newMode: '100755', newType: 'executable' })], manifest).drift)
      .toBe('POLICY_OR_WORKFLOW');
    expect(classifyDriftFacts([fact('docs/link', { newMode: '120000', newType: 'symlink' })], manifest).drift)
      .toBe('UNKNOWN');
  });

  it('distinguishes failed analysis from a proven empty change set', () => {
    expect(classifyDrift([], manifest, { analysisFailed: true }).drift).toBe('UNKNOWN');
    expect(classifyDrift([], manifest).drift).toBe('NONE');
  });
});

describe('closed exit semantics', () => {
  it('maps drift observations to leaf outcomes without treating invalidated assurance as a policy violation', () => {
    expect(exitCodeFor('NONE')).toBe(EXIT_CONTINUE);
    expect(exitCodeFor('DISJOINT_METADATA')).toBe(EXIT_CONTINUE);
    expect(exitCodeFor('DISJOINT_CODE')).toBe(EXIT_CONTINUE);
    expect(exitCodeFor('POLICY_OR_WORKFLOW')).toBe(EXIT_INCONCLUSIVE);
    expect(exitCodeFor('CONFLICT')).toBe(EXIT_STOP);
    expect(exitCodeFor('UNKNOWN')).toBe(EXIT_INCONCLUSIVE);
    expect(outcomeForDrift('NONE')).toBe('pass');
    expect(outcomeForDrift('DISJOINT_METADATA')).toBe('warn');
    expect(outcomeForDrift('DISJOINT_CODE')).toBe('warn');
    expect(outcomeForDrift('CONFLICT')).toBe('block');
    expect(codeForDrift('DISJOINT_METADATA')).toBe('git.lineage.base.drift-disjoint');
    expect(codeForDrift('POLICY_OR_WORKFLOW')).toBe('git.lineage.base.drift-policy');
    expect(codeForDrift('CONFLICT')).toBe('git.merge.result.conflict');
    expect(worstOf('DISJOINT_METADATA', 'POLICY_OR_WORKFLOW')).toBe('POLICY_OR_WORKFLOW');
  });
});

describe('exact-object CLI boundary', () => {
  it('binds the complete drift adapter source set and rejects post-load source drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'drift-adapter-sources-'));
    temporaryRoots.push(root);
    for (const path of DRIFT_ADAPTER_SOURCE_PATHS) write(root, path, `${path}\n`);
    const loadedDigest = digestDriftAdapterSources(root);
    expect(assertDriftAdapterSourcesStable(root, loadedDigest)).toBe(loadedDigest);
    write(root, DRIFT_ADAPTER_SOURCE_PATHS[2], 'changed admission source\n');
    expect(() => assertDriftAdapterSourcesStable(root, loadedDigest))
      .toThrow(/ci\.classification\.tool-source-changed/);
  });

  it('parses only explicit exact-binding flags and rejects unknown or duplicate options', () => {
    expect(parseArgs(['--base', 'a'.repeat(40), '--observed', 'b'.repeat(40), '--manifest-digest', `sha256:${'c'.repeat(64)}`]))
      .toMatchObject({ base: 'a'.repeat(40), observed: 'b'.repeat(40), json: false });
    expect(parseArgs(['--wat']).error).toBe('ci.input.option-unknown');
    expect(parseArgs(['--json', '--json']).error).toBe('ci.input.duplicate-option');
  });

  it('rejects symbolic or missing revisions instead of resolving mutable defaults', () => {
    expect(main(['--base', 'HEAD', '--observed', 'origin/main', '--manifest-digest', `sha256:${'a'.repeat(64)}`], repoRoot))
      .toBe(EXIT_INCONCLUSIVE);
    expect(main([], repoRoot)).toBe(EXIT_INCONCLUSIVE);
  });

  it('classifies the supplied observed OID, not ambient HEAD', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/observed.md', 'observed\n');
    const observedOid = commit(root, 'observed docs');
    write(root, '.github/workflows/later.yml', 'permissions: write-all\n');
    commit(root, 'ambient later policy');
    expect(main(['--base', baseOid, '--observed', observedOid, '--manifest-digest', manifestDigest], root))
      .toBe(EXIT_CONTINUE);
  });

  it('binds exact candidate objects and blocks only a proven overlapping path', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/shared.md', 'observed\n');
    const observedOid = commit(root, 'observed docs');
    git(root, ['checkout', '--quiet', '-b', 'candidate', baseOid]);
    write(root, 'docs/shared.md', 'candidate\n');
    const overlappingCandidateOid = commit(root, 'overlapping candidate');
    git(root, ['checkout', '--quiet', '-b', 'disjoint', baseOid]);
    write(root, 'src/isolated.ts', 'export const isolated = true;\n');
    const disjointCandidateOid = commit(root, 'disjoint candidate addition');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(main([
      '--base', baseOid, '--observed', observedOid,
      '--candidate', overlappingCandidateOid, '--manifest-digest', manifestDigest, '--json',
    ], root)).toBe(EXIT_STOP);
    const overlap = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(overlap).toMatchObject({
      outcome: 'block', code: 'git.merge.result.conflict',
      bindings: { baseOid, observedOid, candidateOid: overlappingCandidateOid },
      verdict: { drift: 'CONFLICT' },
    });
    expect(overlap.observedNativeCauseCodes).toContain('ci.classification.docs-only');
    expect(overlap.candidateNativeCauseCodes).toContain('ci.classification.docs-only');

    expect(main([
      '--base', baseOid, '--observed', observedOid,
      '--candidate', disjointCandidateOid, '--manifest-digest', manifestDigest, '--json',
    ], root)).toBe(EXIT_CONTINUE);
    const disjoint = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(disjoint).toMatchObject({
      outcome: 'warn', code: 'git.lineage.base.drift-disjoint',
      bindings: { baseOid, observedOid, candidateOid: disjointCandidateOid },
      verdict: { drift: 'DISJOINT_METADATA' },
    });
    expect(disjoint.candidateNativeCauseCodes).toContain('ci.classification.application-code');
  }, 30_000);

  it('rejects a rewound observed OID instead of classifying a reverse diff as current drift', () => {
    const first = fixture();
    write(first.root, 'docs/advanced.md', 'advanced\n');
    const advancedOid = commit(first.root, 'advanced base');
    const advancedDigest = digestControlManifest(readControlManifestAtRevision(first.root, advancedOid));
    expect(main([
      '--base', advancedOid,
      '--observed', first.baseOid,
      '--manifest-digest', advancedDigest,
    ], first.root)).toBe(EXIT_INCONCLUSIVE);
  });

  it('returns INCONCLUSIVE for a manifest mismatch or missing object', () => {
    const { root, baseOid } = fixture();
    write(root, 'docs/observed.md', 'observed\n');
    const observedOid = commit(root, 'observed docs');
    expect(main(['--base', baseOid, '--observed', observedOid, '--manifest-digest', `sha256:${'a'.repeat(64)}`], root))
      .toBe(EXIT_INCONCLUSIVE);
    expect(main(['--base', baseOid, '--observed', 'f'.repeat(40), '--manifest-digest', `sha256:${'a'.repeat(64)}`], root))
      .toBe(EXIT_INCONCLUSIVE);
  });

  it('the exact manifest reader rejects symbolic refs', () => {
    const { root } = fixture();
    expect(() => readControlManifestAtRevision(root, 'HEAD')).toThrow(/ci\.input\.revision-unavailable/);
  });

  it('self-check reads one exact HEAD tree and fails closed outside a repository', () => {
    const { root } = fixture(110);
    expect(main(['--self-check'], root)).toBe(EXIT_CONTINUE);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(main(['--self-check', '--json'], root)).toBe(EXIT_CONTINUE);
    const serialized = String(stdout.mock.calls.at(-1)?.[0]);
    const result = JSON.parse(serialized);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(64 * 1024);
    expect(result.verdict.classifications).toEqual([]);
    expect(result).toMatchObject({ trackedPathCount: 112, unclassifiedCount: 0 });
    const outside = mkdtempSync(join(tmpdir(), 'drift-outside-'));
    temporaryRoots.push(outside);
    expect(main(['--self-check'], outside)).toBe(EXIT_INCONCLUSIVE);
  });

  it('tracked path enumeration requires a full immutable OID', () => {
    const { root, baseOid } = fixture();
    expect(trackedPaths(root, baseOid)).toContain('controls/ci-control-manifest.json');
    expect(trackedPaths(root, 'HEAD')).toBeNull();
  });

  it('emits one schema-bound JSON projection for successful and invalid invocations', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/observed.md', 'observed\n');
    const observedOid = commit(root, 'observed docs');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(main([
      '--base', baseOid,
      '--observed', observedOid,
      '--manifest-digest', manifestDigest,
      '--json',
    ], root)).toBe(EXIT_CONTINUE);
    const success = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(success).toMatchObject({
      schemaVersion: 1,
      resultKind: 'native-report-only-observation',
      outcome: 'warn',
      exitCode: 0,
      code: 'git.lineage.base.drift-disjoint',
      detectorId: 'ci-control-classifier',
      authorization: 'report-only',
      bindings: { baseOid, observedOid, manifestDigest },
      verdict: { drift: 'DISJOINT_METADATA' },
    });
    expect(success.adapterDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    stdout.mockClear();
    stderr.mockClear();
    expect(main(['--json', '--wat'], root)).toBe(EXIT_INCONCLUSIVE);
    const invalid = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(invalid).toMatchObject({
      schemaVersion: 1,
      outcome: 'inconclusive',
      exitCode: 2,
      code: 'ci.native.receipt-unavailable',
      nativeCauseCompleteness: 'unavailable',
      nativeCauseCodes: ['ci.input.option-unknown'],
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('rejects projection across mismatched base, manifest, or classifier bindings', () => {
    const { root, baseOid, manifestDigest } = fixture();
    write(root, 'docs/observed.md', 'observed\n');
    const observedOid = commit(root, 'observed docs');
    const observed = createRiskClassificationReceipt(root, {
      eventName: 'push', baseOid, candidateOid: observedOid, mergeOid: null, manifestDigest,
    });
    expect(observed.classification.outcome).toBe('pass');

    for (const classification of [
      { ...observed.classification, baseOid: 'f'.repeat(40) },
      { ...observed.classification, manifestDigest: `sha256:${'f'.repeat(64)}` },
      { ...observed.classification, classifierDigest: `sha256:${'f'.repeat(64)}` },
    ]) {
      const forged = { ...observed, classification };
      expect(projectDriftResult(observed, manifest, forged).drift).toBe('UNKNOWN');
    }
  });

  it('reuses canonical Git execution plumbing instead of defining another environment or process wrapper', () => {
    const source = readFileSync(resolve(repoRoot, 'scripts/drift-classify.ts'), 'utf8');
    expect(source).not.toContain('spawnSync');
    expect(source).not.toContain('cleanGitEnv');
    expect(source).not.toContain('function gitEnvironment');
    expect(source).toContain("from './lib/ci-control/git-input-core.ts'");
  });
});

describe('live canonical coverage', () => {
  const tracked = git(repoRoot, ['ls-files']).split('\n').filter(Boolean);

  it('is non-vacuous and every tracked path is owned by a canonical risk rule', () => {
    expect(tracked.length).toBeGreaterThan(1000);
    const verdict = classifyDrift(tracked, manifest);
    expect(verdict.unclassified).toEqual([]);
  });

  it('uses multiple semantic classes instead of one catch-all', () => {
    const classes = new Set(classifyDrift(tracked, manifest).classifications.map(({ drift }) => drift));
    expect(classes.size).toBeGreaterThanOrEqual(6);
  });
});
