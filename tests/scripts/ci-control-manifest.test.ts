import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runManifestCli } from '../../scripts/ci-control-manifest.ts';
import { REF_POLICY_TOOL_SOURCE_PATHS } from '../../scripts/ci-control-ref-policy.ts';
import {
  MAX_CONTROL_COUNT,
  MAX_MANIFEST_BYTES,
  buildControlInventory,
  digestControlManifest,
  loadControlManifest,
  parseControlManifestBytes,
  validateControlManifest,
  type ControlManifestV1,
} from '../../scripts/lib/ci-control/manifest.ts';
import { CLASSIFIER_TOOL_SOURCE_PATHS } from '../../scripts/lib/ci-control/classifier.ts';
import { runtimeSourceClosure } from '../helpers/runtime-source-closure.ts';

const root = resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function control(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    policyCategory: 'repository-hygiene',
    domain: 'repository-hygiene',
    owner: 'repository-policy-owner',
    decisionOwner: 'repository-hygiene-decision-owner',
    implementation: {
      commandId: `guard:${id}`,
      detectorId: `detector:${id}`,
      nativeSchemaVersion: null,
    },
    stages: ['pre-commit'],
    trustClass: 'untrusted-candidate',
    mode: 'block',
    availability: 'planned',
    severity: 'high',
    riskTiers: ['standard'],
    surfaces: ['repository'],
    dependencies: [],
    evidence: {
      schemaVersion: null,
      paths: ['.'],
      digestBinding: 'none',
      freshness: 'same-process',
    },
    failurePolicy: {
      finding: 'block',
      crash: 'inconclusive',
      timeout: 'inconclusive',
      missing: 'inconclusive',
      skipped: 'inconclusive',
      cancelled: 'inconclusive',
      stale: 'inconclusive',
    },
    remediation: {
      summary: 'Run the canonical guard.',
      steps: ['Run the guard.', 'Repair the named finding.'],
      reproduction: 'npm run guard:repo',
    },
    exceptionPolicy: {
      allowed: false,
      scope: 'none',
      approverRole: null,
      maxLifetimeSeconds: null,
    },
    ...overrides,
  };
}

function exactBlockingControl(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return control('one', {
    mode: 'block',
    availability: 'blocking',
    implementation: {
      commandId: 'guard:one',
      detectorId: 'detector:one',
      nativeSchemaVersion: 1,
    },
    evidence: {
      schemaVersion: 1,
      paths: ['.'],
      digestBinding: 'exact',
      freshness: 'receipt',
    },
    ...overrides,
  });
}

function manifest(controls: Record<string, unknown>[] = [control('repo.hygiene')]): Record<string, unknown> {
  const commands = Object.fromEntries(
    controls.map((entry) => {
      const implementation = entry.implementation as { commandId: string };
      return [implementation.commandId, ['bash', 'scripts/run-with-pinned-node.sh', `scripts/${entry.id}.ts`]];
    }),
  );
  return {
    schemaVersion: 1,
    policyVersion: '2026-07-20',
    controls,
    requiredSurfaces: ['repository'],
    riskRules: [],
    stages: ['pre-commit'],
    trustClasses: ['untrusted-candidate'],
    canonicalCommands: commands,
    outgoingRefPolicy: null,
    resultSchema: 'ci-control-result-v1',
    exceptionSchema: 'ci-control-exception-v1',
  };
}

function issueCodes(value: unknown): string[] {
  return validateControlManifest(value).map((entry) => entry.code);
}

function fixtureRoot(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'ci-control-manifest-'));
  temporaryRoots.push(directory);
  mkdirSync(join(directory, 'controls'));
  writeFileSync(join(directory, 'controls/ci-control-manifest.json'), `${JSON.stringify(value)}\n`, 'utf8');
  return directory;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  );
}

describe('canonical CI control manifest', () => {
  it('loads the checked-in manifest and advertises only observed controls', () => {
    const loaded = loadControlManifest(root);
    const driftAdapterSourcePaths = runtimeSourceClosure('scripts/drift-classify.ts', root);
    expect([...REF_POLICY_TOOL_SOURCE_PATHS].sort()).toEqual(runtimeSourceClosure('scripts/ci-control-ref-policy.ts', root));
    expect(validateControlManifest(loaded)).toEqual([]);
    const inventory = buildControlInventory(loaded);
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(inventory.controls.length).toBeGreaterThan(0);
    expect(Object.fromEntries(inventory.controls.map(({ id, availability }) => [id, availability]))).toEqual({
      'architecture.fitness-lint': 'planned',
      'ci.agent-writer-lease': 'quarantined',
      'ci.drift-classifier-coverage': 'report-only',
      'ci.exact-revision-classifier': 'canary',
      'ci.hooks.installed': 'report-only',
      'ci.lineage-drift-observer': 'report-only',
      'ci.outgoing-ref-policy': 'report-only',
      'privacy.publication': 'report-only',
      'repo.hygiene': 'report-only',
      'test.integrity': 'planned',
      'workflow.safeguard-diagnostics': 'planned',
    });
    expect(inventory.controls.some(({ availability }) => availability === 'blocking')).toBe(false);
    expect(inventory.controls.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'architecture.fitness-lint',
      'test.integrity',
    ]));
    expect(inventory.absentCapabilityFamilies).toEqual([
      'artifact-integrity',
      'deployment-safety',
      'portability',
      'protected-policy',
      'scheduled',
    ]);
    expect(loaded.controls.every((entry) => entry.trustClass === 'untrusted-candidate')).toBe(true);
    expect(loaded.controls.filter(({ id }) => ![
      'ci.agent-writer-lease', 'ci.drift-classifier-coverage', 'ci.exact-revision-classifier', 'ci.hooks.installed', 'ci.lineage-drift-observer', 'ci.outgoing-ref-policy',
      'privacy.publication', 'repo.hygiene',
    ].includes(id)).every((entry) => entry.evidence.schemaVersion === null)).toBe(true);
    for (const id of ['repo.hygiene', 'privacy.publication']) {
      expect(loaded.controls.find((entry) => entry.id === id)).toMatchObject({
        implementation: { nativeSchemaVersion: 1 },
        evidence: {
          schemaVersion: 1,
          digestBinding: 'exact',
          freshness: 'receipt',
        },
      });
    }
    expect(loaded.controls.find(({ id }) => id === 'ci.exact-revision-classifier')?.evidence).toMatchObject({
      schemaVersion: 1,
      paths: CLASSIFIER_TOOL_SOURCE_PATHS,
      digestBinding: 'exact',
      freshness: 'receipt',
    });
    expect(loaded.controls.find(({ id }) => id === 'ci.outgoing-ref-policy')?.evidence).toMatchObject({
      schemaVersion: 1,
      paths: REF_POLICY_TOOL_SOURCE_PATHS,
      digestBinding: 'exact',
      freshness: 'receipt',
    });
    const lineageDriftObserver = loaded.controls.find(({ id }) => id === 'ci.lineage-drift-observer');
    expect(lineageDriftObserver).toMatchObject({
      availability: 'report-only',
      mode: 'block',
      stages: ['local'],
      evidence: {
        schemaVersion: 1,
        digestBinding: 'exact',
        freshness: 'same-process',
      },
    });
    // The declared evidence surface for the drift controls is a superset of drift-classify.ts's
    // real import closure (it also covers the exact-revision-classifier trust boundary by design);
    // assert containment rather than equality so real-but-untracked dependencies still fail loud.
    expect(lineageDriftObserver?.evidence.paths).toEqual(expect.arrayContaining(driftAdapterSourcePaths));

    const driftClassifierCoverage = loaded.controls.find(({ id }) => id === 'ci.drift-classifier-coverage');
    expect(driftClassifierCoverage).toMatchObject({
      availability: 'report-only',
      mode: 'warn',
      stages: ['pull-request', 'merge-group', 'default-branch'],
      implementation: { commandId: 'guard:drift-coverage' },
      evidence: {
        schemaVersion: 1,
        digestBinding: 'exact',
        freshness: 'same-process',
      },
    });
    expect(driftClassifierCoverage?.evidence.paths).toEqual(expect.arrayContaining(driftAdapterSourcePaths));
    expect(loaded.riskRules.length).toBeGreaterThan(0);
    expect(loaded.riskRules.find(({ id }) => id === 'risk.control-policy')?.pathPrefixes)
      .toEqual(expect.arrayContaining([
        'scripts/lib/repo-hygiene-policy.ts',
        'scripts/repo-hygiene-guard.ts',
        'scripts/ci-control-ref-policy.ts',
        'tests/scripts/ci-control-manifest.test.ts',
        'tests/scripts/ci-control-ref-policy.test.ts',
        'tests/scripts/repo-hygiene-policy.test.ts',
      ]));
    expect(loaded.controls.find(({ id }) => id === 'ci.agent-writer-lease')).toMatchObject({
      availability: 'quarantined',
      implementation: {
        commandId: 'agent:lease',
        detectorId: 'agent-lease',
        nativeSchemaVersion: 1,
      },
      mode: 'block',
    });
    expect(loaded.canonicalCommands['agent:lease']).toEqual([
      'bash',
      'scripts/run-with-pinned-node.sh',
      'scripts/agent-lease.ts',
    ]);
    expect(loaded.canonicalCommands['ci:classify']).toEqual([
      'bash',
      'scripts/run-with-pinned-node.sh',
      'scripts/ci-control-classify.ts',
    ]);
    expect(loaded.canonicalCommands['drift:classify']).toEqual([
      'bash',
      'scripts/run-with-pinned-node.sh',
      'scripts/drift-classify.ts',
    ]);
    expect(loaded.canonicalCommands['ci:ref-policy']).toEqual([
      'bash',
      'scripts/run-with-pinned-node.sh',
      'scripts/ci-control-ref-policy.ts',
    ]);
    expect(loaded.outgoingRefPolicy).toMatchObject({
      schemaVersion: 1,
      controlId: 'ci.outgoing-ref-policy',
      allowedDeleteRefs: [],
      nonFastForward: 'block',
      unknownRef: 'inconclusive',
    });
    expect(loaded.canonicalCommands['guard:test-integrity:required']).toEqual([
      'env',
      'WHATSOUP_REQUIRE_TEST_INTEGRITY=1',
      'bash',
      'scripts/test-integrity-ci.sh',
    ]);
    expect(loaded.canonicalCommands['guard:lint:src']).toEqual([
      'bash',
      'scripts/run-with-pinned-node.sh',
      'scripts/eslint-fitness-check.ts',
    ]);
    expect(loaded.controls.some((entry) => [
      'portability',
      'artifact-integrity',
      'deployment-safety',
      'runtime-assurance',
    ].includes(entry.domain))).toBe(false);
  });

  it('rejects unknown or missing keys and every closed record enum', () => {
    expect(issueCodes({ ...manifest(), unexpected: true })).toContain('ci.manifest.unknown-key');
    const nestedUnknown = control('one', { implementation: { commandId: 'guard:one', detectorId: 'detector:one', nativeSchemaVersion: null, extra: true } });
    expect(issueCodes(manifest([nestedUnknown]))).toContain('ci.manifest.unknown-key');
    expect(issueCodes(manifest([control('one', { mode: 'future-mode' })]))).toContain('ci.manifest.invalid-enum');
    expect(issueCodes(manifest([control('one', { availability: 'future-state' })]))).toContain('ci.manifest.invalid-enum');
    expect(issueCodes(manifest([control('one', { availability: 'absent' })]))).toContain('ci.manifest.invalid-enum');
    expect(issueCodes(manifest([control('one', { severity: 'urgent' })]))).toContain('ci.manifest.invalid-enum');
    expect(issueCodes(manifest([control('one', { riskTiers: ['tiny'] })]))).toContain('ci.manifest.invalid-enum');
    const missing = control('one');
    delete missing.failurePolicy;
    expect(issueCodes(manifest([missing]))).toContain('ci.manifest.missing-key');
    const missingAvailability = control('one');
    delete missingAvailability.availability;
    expect(issueCodes(manifest([missingAvailability]))).toContain('ci.manifest.missing-key');

    const nonEnumerable = manifest();
    Object.defineProperty(nonEnumerable, 'hidden', { enumerable: false, value: true });
    expect(issueCodes(nonEnumerable)).toContain('ci.manifest.invalid-property');
    const symbolKey = manifest();
    Object.defineProperty(symbolKey, Symbol('hidden'), { enumerable: true, value: true });
    expect(issueCodes(symbolKey)).toContain('ci.manifest.unknown-key');

    const hiddenCommand = manifest();
    Object.defineProperty(hiddenCommand.canonicalCommands as object, 'ghost', { enumerable: false, value: ['false'] });
    expect(issueCodes(hiddenCommand)).toContain('ci.manifest.invalid-property');
    const symbolCommand = manifest();
    Object.defineProperty(symbolCommand.canonicalCommands as object, Symbol('ghost'), { enumerable: true, value: ['false'] });
    expect(issueCodes(symbolCommand)).toContain('ci.manifest.unknown-key');
  });

  it('keeps desired blocking mode separate from reviewed capability availability', () => {
    const planned = manifest([control('one', { mode: 'block', availability: 'planned' })]);
    expect(issueCodes(planned)).toEqual([]);
    expect(buildControlInventory(planned as unknown as ControlManifestV1).controls[0]?.availability).toBe('planned');

    const exactReceipt = exactBlockingControl();
    expect(issueCodes(manifest([exactReceipt]))).toEqual([]);
    expect(buildControlInventory(manifest([exactReceipt]) as unknown as ControlManifestV1).controls[0]?.availability).toBe('blocking');

    const humanAuthorization = { ...exactReceipt, mode: 'human-authorization' };
    expect(issueCodes(manifest([humanAuthorization]))).toEqual([]);
  });

  it.each([
    {
      prerequisite: 'blocking intent',
      candidate: (): Record<string, unknown> => exactBlockingControl({ mode: 'assist' }),
    },
    {
      prerequisite: 'native schema',
      candidate: (): Record<string, unknown> => {
        const value = exactBlockingControl();
        return { ...value, implementation: { ...value.implementation as object, nativeSchemaVersion: null } };
      },
    },
    {
      prerequisite: 'evidence schema',
      candidate: (): Record<string, unknown> => {
        const value = exactBlockingControl();
        return { ...value, evidence: { ...value.evidence as object, schemaVersion: null } };
      },
    },
    {
      prerequisite: 'exact digest binding',
      candidate: (): Record<string, unknown> => {
        const value = exactBlockingControl();
        return { ...value, evidence: { ...value.evidence as object, digestBinding: 'none' } };
      },
    },
    {
      prerequisite: 'receipt freshness',
      candidate: (): Record<string, unknown> => {
        const value = exactBlockingControl();
        return { ...value, evidence: { ...value.evidence as object, freshness: 'same-process' } };
      },
    },
  ])('rejects blocking availability without $prerequisite', ({ candidate }) => {
    expect(issueCodes(manifest([candidate()]))).toContain('ci.manifest.capability-overclaimed');
  });

  it('rejects duplicate risk identities and unproven not-applicable failure policies', () => {
    const riskRule = { id: 'risk.docs', tier: 'low', reasons: ['docs-only'], pathPrefixes: ['docs/'] };
    expect(issueCodes({ ...manifest(), riskRules: [riskRule, riskRule] })).toContain('ci.manifest.duplicate-id');
    expect(issueCodes({ ...manifest(), riskRules: [riskRule, { ...riskRule, id: 'risk.examples' }] })).not.toContain('ci.manifest.duplicate-id');
    expect(issueCodes(manifest([control('a', {
      failurePolicy: {
        finding: 'block',
        crash: 'inconclusive',
        timeout: 'inconclusive',
        missing: 'not-applicable',
        skipped: 'inconclusive',
        cancelled: 'inconclusive',
        stale: 'inconclusive',
      },
    })]))).toContain('ci.manifest.invalid-enum');
  });

  it('validates one strict outgoing-ref policy and its canonical control cross-link', () => {
    const refControl = control('ci.outgoing-ref-policy', {
      policyCategory: 'source-integrity',
      domain: 'source-integrity',
      owner: 'ci-ref-policy-owner',
      decisionOwner: 'outgoing-ref-policy-decision-owner',
      implementation: {
        commandId: 'ci:ref-policy',
        detectorId: 'outgoing-ref-policy',
        nativeSchemaVersion: 1,
      },
      stages: ['pre-push'],
      mode: 'assist',
      surfaces: ['outgoing-ref-policy'],
      evidence: {
        schemaVersion: 1,
        paths: ['scripts/ci-control-ref-policy.ts', 'scripts/lib/ci-control/ref-policy.ts'],
        digestBinding: 'exact',
        freshness: 'receipt',
      },
    });
    const value = manifest([refControl]);
    value.requiredSurfaces = ['outgoing-ref-policy'];
    value.stages = ['pre-push'];
    value.canonicalCommands = {
      'ci:ref-policy': ['bash', 'scripts/run-with-pinned-node.sh', 'scripts/ci-control-ref-policy.ts'],
    };
    value.outgoingRefPolicy = {
      schemaVersion: 1,
      controlId: 'ci.outgoing-ref-policy',
      remotes: [{ name: 'origin', repositoryId: 'github.com/LucasQuiles/WhatSoup' }],
      branchNamespace: 'refs/heads/',
      releaseBranches: ['refs/heads/main'],
      releaseTagPrefixes: ['refs/tags/v'],
      allowedDeleteRefs: [],
      branchObjectType: 'commit',
      releaseTagObjectType: 'annotated-tag',
      nonFastForward: 'block',
      unknownRef: 'inconclusive',
    };

    expect(issueCodes(value)).toEqual([]);
    expect(issueCodes({ ...value, outgoingRefPolicy: { ...(value.outgoingRefPolicy as object), extra: true } }))
      .toContain('ci.manifest.unknown-key');
    expect(issueCodes({ ...value, outgoingRefPolicy: { ...(value.outgoingRefPolicy as object), allowedDeleteRefs: ['refs/heads/scratch/x', 'refs/heads/scratch/x'] } }))
      .toContain('ci.manifest.duplicate-value');
    expect(issueCodes({ ...value, outgoingRefPolicy: { ...(value.outgoingRefPolicy as object), allowedDeleteRefs: ['refs/heads/scratch/x'] } }))
      .toEqual([]);
    expect(issueCodes({ ...value, outgoingRefPolicy: { ...(value.outgoingRefPolicy as object), allowedDeleteRefs: ['refs/heads/main'] } }))
      .toContain('ci.manifest.ref-policy-protected-delete');
    expect(issueCodes({ ...value, outgoingRefPolicy: { ...(value.outgoingRefPolicy as object), allowedDeleteRefs: ['refs/tags/v1.2.3'] } }))
      .toContain('ci.manifest.ref-policy-protected-delete');
    expect(issueCodes({ ...value, outgoingRefPolicy: { ...(value.outgoingRefPolicy as object), controlId: 'missing' } }))
      .toContain('ci.manifest.ref-policy-control-mismatch');
    expect(issueCodes({ ...value, outgoingRefPolicy: null }))
      .toContain('ci.manifest.ref-policy-control-mismatch');
    expect(issueCodes({
      ...value,
      canonicalCommands: { ...(value.canonicalCommands as object), 'ci:ref-policy': ['true'] },
    })).toContain('ci.manifest.ref-policy-control-mismatch');
  });

  it('rejects duplicate identity or decision ownership while allowing independent observers', () => {
    expect(issueCodes(manifest([control('same'), control('same', { decisionOwner: 'other-owner' })]))).toContain('ci.manifest.duplicate-id');
    const sameDecisionOwner = manifest([
      control('one'),
      control('two', { dependencies: ['one'] }),
    ]);
    expect(issueCodes(sameDecisionOwner)).not.toContain('ci.manifest.duplicate-owner');

    const conflictingDecisionOwner = manifest([
      control('one'),
      control('two', { decisionOwner: 'other-owner', dependencies: ['one'] }),
    ]);
    expect(issueCodes(conflictingDecisionOwner)).toContain('ci.manifest.duplicate-owner');

    const independentQuestion = manifest([
      control('one'),
      control('two', {
        policyCategory: 'privacy-publication',
        domain: 'privacy-publication',
        decisionOwner: 'privacy-decision-owner',
        dependencies: ['one'],
      }),
    ]);
    expect(issueCodes(independentQuestion)).not.toContain('ci.manifest.duplicate-owner');

    const independentSurface = manifest([
      control('one'),
      control('two', {
        decisionOwner: 'other-owner',
        surfaces: ['other'],
      }),
    ]);
    independentSurface.requiredSurfaces = ['repository', 'other'];
    expect(issueCodes(independentSurface)).toEqual([]);
  });

  it('rejects missing dependencies, cycles, unowned surfaces, and unreachable controls', () => {
    expect(issueCodes(manifest([control('a', { dependencies: ['missing'] })]))).toContain('ci.manifest.missing-dependency');
    const cyclic = manifest([control('a', { dependencies: ['b'] }), control('b', { dependencies: ['a'], decisionOwner: 'other-owner' })]);
    expect(issueCodes(cyclic)).toContain('ci.manifest.dependency-cycle');
    expect(issueCodes({ ...manifest([control('a', { surfaces: ['other'] })]), requiredSurfaces: ['repository'] })).toContain('ci.manifest.required-control-unreachable');
    const unreachable = manifest([
      control('required'),
      control('orphan', { surfaces: ['unrequired'], decisionOwner: 'orphan-owner' }),
    ]);
    expect(issueCodes(unreachable)).toContain('ci.manifest.control-unreachable');
  });

  it('rejects missing remediation, owners, command bindings, and unbounded exceptions', () => {
    expect(issueCodes(manifest([control('a', { remediation: null })]))).toContain('ci.manifest.missing-remediation');
    expect(issueCodes(manifest([control('a', { owner: '' })]))).toContain('ci.manifest.missing-owner');
    expect(issueCodes({ ...manifest(), canonicalCommands: {} })).toContain('ci.manifest.command-set-mismatch');
    expect(issueCodes(manifest([control('a', { exceptionPolicy: { allowed: true, scope: 'any', approverRole: 'reviewer', maxLifetimeSeconds: null } })]))).toContain('ci.manifest.unbounded-exception');
  });

  it('checks raw UTF-8 bytes and control count before parsing or visiting members', () => {
    const oversized = Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x7b);
    expect(() => parseControlManifestBytes(oversized)).toThrowError(/ci\.manifest\.byte-budget/);

    let visited = false;
    const controls = Array.from({ length: MAX_CONTROL_COUNT + 1 }, () => ({}));
    Object.defineProperty(controls, 0, {
      get() {
        visited = true;
        throw new Error('must not visit');
      },
    });
    expect(validateControlManifest({ ...manifest(), controls })[0]?.code).toBe('ci.manifest.count-budget');
    expect(visited).toBe(false);

    const multibyte = Buffer.from(JSON.stringify({ ...manifest(), policyVersion: 'é'.repeat(MAX_MANIFEST_BYTES) }), 'utf8');
    expect(() => parseControlManifestBytes(multibyte)).toThrowError(/ci\.manifest\.byte-budget/);
  });

  it('rejects duplicate raw JSON keys before JSON.parse can collapse them', () => {
    const text = JSON.stringify(manifest());
    const duplicateTop = text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    expect(() => parseControlManifestBytes(Buffer.from(duplicateTop))).toThrowError(/ci\.manifest\.duplicate-json-key/);
    const duplicateNested = text.replace('"missing":"inconclusive"', '"missing":"inconclusive","missing":"inconclusive"');
    expect(() => parseControlManifestBytes(Buffer.from(duplicateNested))).toThrowError(/ci\.manifest\.duplicate-json-key/);

    const repeatedOrderedStep = manifest([control('a', {
      remediation: { summary: 'Repair.', steps: ['repeat', 'repeat'], reproduction: 'npm run guard:repo' },
    })]);
    expect(validateControlManifest(repeatedOrderedStep)).toEqual([]);
  });

  it('canonicalizes object keys and schema-declared sets but preserves ordered arrays', () => {
    const original = manifest() as unknown as ControlManifestV1;
    const reorderedKeys = reverseObjectKeys(original) as ControlManifestV1;
    expect(digestControlManifest(original)).toBe(digestControlManifest(reorderedKeys));

    const reorderedSets = structuredClone(original);
    reorderedSets.controls[0]!.stages = ['pull-request', 'pre-commit'];
    reorderedSets.stages = ['pull-request', 'pre-commit'];
    const inverseSets = structuredClone(reorderedSets);
    inverseSets.controls[0]!.stages.reverse();
    inverseSets.stages.reverse();
    expect(digestControlManifest(reorderedSets)).toBe(digestControlManifest(inverseSets));

    const changedSteps = structuredClone(original);
    changedSteps.controls[0]!.remediation.steps.reverse();
    expect(digestControlManifest(original)).not.toBe(digestControlManifest(changedSteps));
    const changedCommand = structuredClone(original);
    changedCommand.canonicalCommands[Object.keys(changedCommand.canonicalCommands)[0]!]!.reverse();
    expect(digestControlManifest(original)).not.toBe(digestControlManifest(changedCommand));
  });

  it('returns deterministic CLI results for help, valid input, invalid input, and duplicate options', () => {
    const invoke = (args: string[], cwd = root) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = runManifestCli(args, cwd, {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
    };

    const valid = invoke(['validate', '--json']);
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ outcome: 'pass', exitCode: 0 });
    expect(JSON.parse(invoke(['inventory', '--json']).stdout).manifestDigest).toMatch(/^sha256:/);
    expect(invoke(['--help']).stdout).toContain('ci:manifest');

    const malformedRoot = fixtureRoot({ ...manifest(), extra: true });
    const malformed = invoke(['validate', '--json'], malformedRoot);
    expect(malformed.exitCode).toBe(2);
    expect(JSON.parse(malformed.stdout).code).toBe('ci.manifest.unknown-key');
    expect(malformed.stdout).not.toContain(malformedRoot);
    expect(malformed.stderr).toBe('');

    const duplicate = invoke(['validate', '--json', '--json']);
    expect(duplicate.exitCode).toBe(2);
    expect(JSON.parse(duplicate.stdout).code).toBe('ci.input.duplicate-option');
  });

  it('declares the pinned package command and exact public-surface identifier', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['ci:manifest']).toBe('bash scripts/run-with-pinned-node.sh scripts/ci-control-manifest.ts');
    const surface = readFileSync(resolve(root, 'docs/public-surface.md'), 'utf8');
    expect(surface).toContain('| `cli:npm.ci-manifest` |');
  });
});
