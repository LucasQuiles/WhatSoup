import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runManifestCli } from '../../scripts/ci-control-manifest.ts';
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
    expect(validateControlManifest(loaded)).toEqual([]);
    const inventory = buildControlInventory(loaded);
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(inventory.controls.length).toBeGreaterThan(0);
    expect(inventory.controls.every((entry) => entry.availability === 'blocking')).toBe(true);
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
    expect(loaded.controls.every((entry) => entry.evidence.schemaVersion === null)).toBe(true);
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
    expect(issueCodes(manifest([control('one', { severity: 'urgent' })]))).toContain('ci.manifest.invalid-enum');
    expect(issueCodes(manifest([control('one', { riskTiers: ['tiny'] })]))).toContain('ci.manifest.invalid-enum');
    const missing = control('one');
    delete missing.failurePolicy;
    expect(issueCodes(manifest([missing]))).toContain('ci.manifest.missing-key');

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

  it('rejects duplicate identity or decision ownership while allowing independent observers', () => {
    expect(issueCodes(manifest([control('same'), control('same', { decisionOwner: 'other-owner' })]))).toContain('ci.manifest.duplicate-id');
    expect(issueCodes(manifest([control('one'), control('two')]))).toContain('ci.manifest.duplicate-owner');
    const safe = manifest([
      control('one'),
      control('two', {
        policyCategory: 'privacy-publication',
        domain: 'privacy-publication',
        decisionOwner: 'privacy-decision-owner',
        dependencies: ['one'],
      }),
    ]);
    expect(issueCodes(safe)).not.toContain('ci.manifest.duplicate-owner');
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
