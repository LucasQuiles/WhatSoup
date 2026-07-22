import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compileReportOnlyExecutionPlan,
  EXECUTION_PLAN_INPUT_BUDGET,
  ExecutionPlanError,
  matchesSameProcessControlExecutionPlan,
  type ControlExecutionPlanV1,
} from '../../scripts/lib/ci-control/execution-plan.ts';
import {
  preflightReportOnlyExecutionPlan,
  type KernelPreflightV1,
  type ReportOnlyKernelPreflightV1,
} from '../../scripts/lib/ci-control/execution-kernel-preflight.ts';
import {
  createRiskClassificationReceipt,
  type AdmittedRiskClassificationV1,
} from '../../scripts/lib/ci-control/classification-admission.ts';
import type { ExactRevisionInput } from '../../scripts/lib/ci-control/classifier.ts';
import {
  digestControlManifest,
  type ControlAvailability,
  type ControlManifestV1,
} from '../../scripts/lib/ci-control/manifest.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

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

function baseManifest(): ControlManifestV1 {
  return JSON.parse(readFileSync(join(projectRoot, 'controls/ci-control-manifest.json'), 'utf8')) as ControlManifestV1;
}

function control(manifest: ControlManifestV1, id: string) {
  const record = manifest.controls.find((candidate) => candidate.id === id);
  if (record === undefined) throw new Error(`missing fixture control ${id}`);
  return record;
}

function fixture(options: {
  candidatePath?: string;
  mutateManifest?: (manifest: ControlManifestV1) => void;
  baseOid?: 'commit' | 'null';
} = {}): {
  root: string;
  manifest: ControlManifestV1;
  trustedInput: ExactRevisionInput;
  admission: AdmittedRiskClassificationV1;
} {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-execution-plan-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet']);
  const manifest = baseManifest();
  options.mutateManifest?.(manifest);
  write(root, 'controls/ci-control-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  write(root, 'docs/guide.md', 'base guide\n');
  write(root, 'src/example.ts', 'export const value = 1;\n');
  write(root, 'tests/example.test.ts', 'export {};\n');
  const committedBaseOid = commit(root, 'base');
  write(root, options.candidatePath ?? 'docs/guide.md', 'candidate content\n');
  const candidateOid = commit(root, 'candidate');
  let manifestDigest: string;
  try {
    manifestDigest = digestControlManifest(manifest);
  } catch {
    manifestDigest = `sha256:${'0'.repeat(64)}`;
  }
  const trustedInput: ExactRevisionInput = {
    eventName: 'local',
    baseOid: options.baseOid === 'null' ? null : committedBaseOid,
    candidateOid,
    mergeOid: null,
    manifestDigest,
  };
  return {
    root,
    manifest,
    trustedInput,
    admission: createRiskClassificationReceipt(root, trustedInput),
  };
}

function makeLowControlsAvailable(manifest: ControlManifestV1): void {
  control(manifest, 'ci.agent-writer-lease').availability = 'report-only';
  control(manifest, 'workflow.safeguard-diagnostics').availability = 'report-only';
}

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionPlanError);
    const planError = error as ExecutionPlanError;
    expect(planError.outcome).toBe('inconclusive');
    expect(planError.exitCode).toBe(2);
    return planError.code;
  }
  throw new Error('expected ExecutionPlanError');
}

function assertDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) assertDeeplyFrozen(nested);
}

/**
 * Narrows the preflight union on its `code` discriminant. Only the admitted
 * `ReportOnlyKernelPreflightV1` arm carries `exactChildControlIds`/`unavailableInputs`; the
 * unadmitted arm deliberately carries neither, so reading them requires proving the arm first.
 */
function assertReportOnlyPreflight(
  preflight: KernelPreflightV1,
): asserts preflight is ReportOnlyKernelPreflightV1 {
  expect(preflight.code).toBe('ci.execution-kernel.contracts-unavailable');
  if (preflight.code !== 'ci.execution-kernel.contracts-unavailable') {
    throw new Error(`expected an admitted report-only preflight, received ${preflight.code}`);
  }
}

function assertDependencyFirst(plan: ControlExecutionPlanV1): void {
  const positions = new Map(plan.steps.map((step, index) => [step.controlId, index]));
  for (const step of plan.steps) {
    for (const dependency of step.dependencies) {
      expect(positions.get(dependency)).toBeLessThan(positions.get(step.controlId)!);
    }
  }
}

function valueCountProbe(totalValues: number): Record<string, unknown> {
  const probe: Record<string, unknown> = {};
  let remaining = totalValues - 1;
  let index = 0;
  while (remaining > 0) {
    const itemCount = Math.min(
      EXECUTION_PLAN_INPUT_BUDGET.maxContainerItems,
      remaining - 1,
    );
    probe[`row${index}`] = Array.from({ length: itemCount }, () => null);
    remaining -= itemCount + 1;
    index += 1;
  }
  return probe;
}

function depthProbe(depth: number): unknown {
  let probe: unknown = null;
  for (let index = 0; index < depth; index += 1) probe = { nested: probe };
  return probe;
}

describe('report-only control execution plan compiler', () => {
  it('compiles a deterministic, exact, dependency-first low-risk plan without granting execution authority', () => {
    const { manifest, trustedInput, admission } = fixture({ mutateManifest: makeLowControlsAvailable });
    const plan = compileReportOnlyExecutionPlan(manifest, admission, trustedInput);
    const repeated = compileReportOnlyExecutionPlan(structuredClone(manifest), admission, { ...trustedInput });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      authorization: 'report-only',
      executable: false,
      readiness: 'report-only',
      manifestDigest: trustedInput.manifestDigest,
      classificationEvidenceDigest: admission.evidenceDigest,
      classifierDigest: admission.classification.classifierDigest,
      baseOid: trustedInput.baseOid,
      candidateOid: trustedInput.candidateOid,
      mergeOid: null,
      riskTier: 'low',
      classificationOutcome: 'pass',
      requiredSuites: [],
      unavailableControls: [],
      limitations: ['ci.execution-plan.report-only'],
    });
    expect(plan.requiredControls).toEqual(admission.classification.requiredControls);
    expect(plan.steps.map(({ controlId }) => controlId).sort()).toEqual([...plan.requiredControls].sort());
    expect(new Set(plan.steps.map(({ controlId }) => controlId)).size).toBe(plan.requiredControls.length);
    expect(plan.steps.every(({ disposition }) => disposition === 'report-only')).toBe(true);
    assertDependencyFirst(plan);
    assertDeeplyFrozen(plan);
    expect(repeated).toEqual(plan);
    expect(repeated.planDigest).toBe(plan.planDigest);
    expect(plan.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps the checked-in quarantined lease unavailable and makes readiness inconclusive', () => {
    const { manifest, trustedInput, admission } = fixture();
    const plan = compileReportOnlyExecutionPlan(manifest, admission, trustedInput);

    expect(plan.readiness).toBe('inconclusive');
    expect(plan.unavailableControls).toContain('ci.agent-writer-lease');
    expect(plan.limitations).toContain('ci.execution-plan.controls-unavailable');
    expect(plan.steps.find(({ controlId }) => controlId === 'ci.agent-writer-lease')).toMatchObject({
      availability: 'quarantined',
      disposition: 'unavailable',
    });
  });

  it('preserves detached direct argv arrays and rejects shell-source or interpolation payloads', () => {
    const { manifest, trustedInput, admission } = fixture({ mutateManifest: makeLowControlsAvailable });
    const original = [...manifest.canonicalCommands['guard:repo']!];
    const plan = compileReportOnlyExecutionPlan(manifest, admission, trustedInput);
    const step = plan.steps.find(({ controlId }) => controlId === 'repo.hygiene')!;

    expect(step.argv).toEqual(original);
    expect(step.argv).not.toBe(manifest.canonicalCommands['guard:repo']);
    manifest.canonicalCommands['guard:repo']![0] = 'changed-after-compilation';
    expect(step.argv).toEqual(original);

    for (const unsafe of ['echo success; false', 'echo $HOME', 'echo $(id)', 'echo `${value}`', 'false || true', 'one\ntwo']) {
      const hostile = fixture({
        mutateManifest: (candidate) => {
          makeLowControlsAvailable(candidate);
          candidate.canonicalCommands['guard:repo'] = ['bash', '-c', unsafe];
        },
      });
      expect(errorCode(() => compileReportOnlyExecutionPlan(
        hostile.manifest,
        hostile.admission,
        hostile.trustedInput,
      ))).toBe('ci.execution-plan.command-unresolved');
    }

    const nestedShell = fixture({
      mutateManifest: (candidate) => {
        makeLowControlsAvailable(candidate);
        candidate.canonicalCommands['guard:repo'] = ['env', 'FIXTURE=1', 'bash', '-c', 'echo safe'];
      },
    });
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      nestedShell.manifest,
      nestedShell.admission,
      nestedShell.trustedInput,
    ))).toBe('ci.execution-plan.command-unresolved');
  });

  it('keeps every availability state explicit and makes unavailable controls inconclusive', () => {
    const states: ControlAvailability[] = [
      'planned', 'report-only', 'advisory', 'canary', 'blocking', 'quarantined', 'deprecated',
    ];
    const current = fixture({
      candidatePath: 'unknown/new-surface.data',
      mutateManifest: (manifest) => {
        manifest.controls.forEach((record, index) => {
          const availability = states[index % states.length]!;
          record.availability = availability;
          if (availability === 'blocking') {
            record.mode = 'block';
            record.implementation.nativeSchemaVersion = 1;
            record.evidence = {
              schemaVersion: 1,
              paths: ['.'],
              digestBinding: 'exact',
              freshness: 'receipt',
            };
          }
        });
      },
    });
    const plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);

    expect(plan.classificationOutcome).toBe('inconclusive');
    expect(plan.readiness).toBe('inconclusive');
    expect(plan.requiredControls).toEqual(current.admission.classification.requiredControls);
    expect(plan.requiredSuites.length).toBeGreaterThan(0);
    expect(plan.limitations).toEqual([
      'ci.execution-plan.classification-inconclusive',
      'ci.execution-plan.controls-unavailable',
      'ci.execution-plan.report-only',
      'ci.execution-plan.suite-registry-unavailable',
    ]);
    expect(plan.steps.map(({ availability }) => availability).sort()).toEqual(
      current.manifest.controls.map(({ availability }) => availability).sort(),
    );
    expect(plan.unavailableControls).toEqual(
      current.manifest.controls
        .filter(({ availability }) => ['planned', 'quarantined', 'deprecated'].includes(availability))
        .map(({ id }) => id)
        .sort(),
    );
    for (const step of plan.steps) {
      expect(step.disposition).toBe(
        ['planned', 'quarantined', 'deprecated'].includes(step.availability) ? 'unavailable' : 'report-only',
      );
    }
  });

  it('rejects cloned, reconstructed, mutated-byte, and coherently altered admissions before reading other inputs', () => {
    const { manifest, trustedInput, admission } = fixture({ mutateManifest: makeLowControlsAvailable });
    const clone = structuredClone(admission) as AdmittedRiskClassificationV1;
    const reconstructed = Object.freeze({
      authorization: admission.authorization,
      classification: admission.classification,
      receiptBytes: admission.receiptBytes,
      evidenceDigest: admission.evidenceDigest,
    }) as AdmittedRiskClassificationV1;
    const altered = structuredClone(admission) as AdmittedRiskClassificationV1;
    (altered.classification.requiredControls as string[]).push('substitute.control');
    const mutationFixture = fixture();
    const mutatedBytes = createRiskClassificationReceipt(mutationFixture.root, mutationFixture.trustedInput);
    mutatedBytes.receiptBytes[0] = mutatedBytes.receiptBytes[0] === 0x7b ? 0x5b : 0x7b;

    for (const candidate of [clone, reconstructed, altered, mutatedBytes]) {
      let manifestGetterCalls = 0;
      const unreadableManifest = Object.defineProperty({}, 'controls', {
        enumerable: true,
        get() {
          manifestGetterCalls += 1;
          throw new Error('must not inspect manifest before admission');
        },
      });
      expect(errorCode(() => compileReportOnlyExecutionPlan(
        unreadableManifest as ControlManifestV1,
        candidate,
        trustedInput,
      ))).toBe('ci.execution-plan.classification-unadmitted');
      expect(manifestGetterCalls).toBe(0);
    }

    expect(errorCode(() => compileReportOnlyExecutionPlan(manifest, clone, trustedInput)))
      .toBe('ci.execution-plan.classification-unadmitted');
  });

  it('rejects manifest, trusted-input, and evidence binding drift without partial plans', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const differentManifest = structuredClone(current.manifest);
    differentManifest.policyVersion = 'different-policy';
    const wrongOid = `${current.trustedInput.candidateOid[0] === 'a' ? 'b' : 'a'}${current.trustedInput.candidateOid.slice(1)}`;

    expect(errorCode(() => compileReportOnlyExecutionPlan(
      differentManifest,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-binding-mismatch');
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      current.manifest,
      current.admission,
      { ...current.trustedInput, candidateOid: wrongOid },
    ))).toBe('ci.execution-plan.classification-binding-mismatch');

    current.admission.receiptBytes[0] = current.admission.receiptBytes[0] === 0x7b ? 0x5b : 0x7b;
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      current.manifest,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.classification-unadmitted');
  });

  it('rejects full-set sentinels and invalid dependency graphs instead of inventing work', () => {
    const sentinel = fixture({ baseOid: 'null' });
    expect(sentinel.admission.classification.requiredControls).toContain('@full-control-set');
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      sentinel.manifest,
      sentinel.admission,
      sentinel.trustedInput,
    ))).toBe('ci.execution-plan.required-set-invalid');

    for (const mutateManifest of [
      (manifest: ControlManifestV1) => { control(manifest, 'ci.hooks.installed').dependencies = ['missing.control']; },
      (manifest: ControlManifestV1) => {
        control(manifest, 'repo.hygiene').dependencies = ['ci.hooks.installed'];
        control(manifest, 'ci.hooks.installed').dependencies = ['repo.hygiene'];
      },
    ]) {
      const invalid = fixture({ mutateManifest });
      expect(errorCode(() => compileReportOnlyExecutionPlan(
        invalid.manifest,
        invalid.admission,
        invalid.trustedInput,
      ))).toBe('ci.execution-plan.manifest-invalid');
    }
  });

  it('rejects duplicate command ownership and keeps required suites opaque and explicit', () => {
    const ambiguous = fixture({
      mutateManifest: (manifest) => {
        makeLowControlsAvailable(manifest);
        control(manifest, 'privacy.publication').implementation.commandId = 'guard:repo';
        delete manifest.canonicalCommands['guard:publication'];
      },
    });
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      ambiguous.manifest,
      ambiguous.admission,
      ambiguous.trustedInput,
    ))).toBe('ci.execution-plan.command-ambiguous');

    const suites = fixture({ candidatePath: 'src/example.ts', mutateManifest: makeLowControlsAvailable });
    const plan = compileReportOnlyExecutionPlan(suites.manifest, suites.admission, suites.trustedInput);
    expect(plan.requiredSuites).toEqual(suites.admission.classification.requiredSuites);
    expect(plan.requiredSuites.length).toBeGreaterThan(0);
    expect(plan.readiness).toBe('inconclusive');
    expect(plan.limitations).toContain('ci.execution-plan.suite-registry-unavailable');
    expect(plan.steps.flatMap(({ argv }) => argv)).not.toEqual(expect.arrayContaining([...plan.requiredSuites]));
  });

  it('orders a reversed diamond graph dependency-first and hashes the canonical plan, not caller order', () => {
    const diamond = (manifest: ControlManifestV1): void => {
      makeLowControlsAvailable(manifest);
      control(manifest, 'ci.hooks.installed').dependencies = ['privacy.publication', 'repo.hygiene'];
      control(manifest, 'workflow.safeguard-diagnostics').dependencies = ['privacy.publication', 'repo.hygiene'];
      control(manifest, 'ci.outgoing-ref-policy').dependencies = [
        'workflow.safeguard-diagnostics',
        'ci.hooks.installed',
      ];
      manifest.controls.reverse();
    };
    const current = fixture({ mutateManifest: diamond });
    const plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);
    const reversedAgain = structuredClone(current.manifest);
    reversedAgain.controls.reverse();
    const reordered = compileReportOnlyExecutionPlan(reversedAgain, current.admission, current.trustedInput);

    assertDependencyFirst(plan);
    expect(reordered).toEqual(plan);
    expect(new Set(plan.steps.map(({ commandId }) => commandId)).size).toBe(plan.steps.length);
  });

  it('rejects hostile accessors, symbols, prototypes, and invalid trusted input without invoking getters', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    let manifestGetterCalls = 0;
    const accessorManifest = Object.defineProperty({}, 'controls', {
      enumerable: true,
      get() {
        manifestGetterCalls += 1;
        return [];
      },
    });
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      accessorManifest as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');
    expect(manifestGetterCalls).toBe(0);

    const symbolManifest = structuredClone(current.manifest) as ControlManifestV1 & { [key: symbol]: string };
    symbolManifest[Symbol('hidden')] = 'value';
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      symbolManifest,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');

    const prototypeKeyManifest = structuredClone(current.manifest);
    Object.defineProperty(prototypeKeyManifest, '__proto__', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: { controls: [] },
    });
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      prototypeKeyManifest,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');

    const nonPlainManifest = Object.assign(Object.create({ inherited: true }), current.manifest) as ControlManifestV1;
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      nonPlainManifest,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');

    const cyclicManifest = structuredClone(current.manifest) as ControlManifestV1 & { cycle?: unknown };
    cyclicManifest.cycle = cyclicManifest;
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      cyclicManifest,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');

    let inputGetterCalls = 0;
    const accessorInput = Object.defineProperty({}, 'candidateOid', {
      enumerable: true,
      get() {
        inputGetterCalls += 1;
        return current.trustedInput.candidateOid;
      },
    });
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      current.manifest,
      current.admission,
      accessorInput as ExactRevisionInput,
    ))).toBe('ci.execution-plan.classification-binding-mismatch');
    expect(inputGetterCalls).toBe(0);
  });

  it('rejects aggregate text one byte over only after accepting the exact progressive limit', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const key = 'x';
    const exact = { [key]: 'a'.repeat(EXECUTION_PLAN_INPUT_BUDGET.maxAggregateTextBytes - Buffer.byteLength(key)) };
    const over = { [key]: `${exact[key]}a` };

    expect(errorCode(() => compileReportOnlyExecutionPlan(
      exact as unknown as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      over as unknown as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.input-budget');
  });

  it('rejects total visited values one over only after accepting the exact progressive limit', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const exact = valueCountProbe(EXECUTION_PLAN_INPUT_BUDGET.maxVisitedValues);
    const over = valueCountProbe(EXECUTION_PLAN_INPUT_BUDGET.maxVisitedValues + 1);

    expect(errorCode(() => compileReportOnlyExecutionPlan(
      exact as unknown as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      over as unknown as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.input-budget');
  });

  it('rejects depth one over only after accepting the exact progressive limit', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      depthProbe(EXECUTION_PLAN_INPUT_BUDGET.maxDepth) as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      depthProbe(EXECUTION_PLAN_INPUT_BUDGET.maxDepth + 1) as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.input-budget');
  });

  it('rejects a container one item over only after accepting the exact progressive limit', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const exact = Array.from({ length: EXECUTION_PLAN_INPUT_BUDGET.maxContainerItems }, () => null);
    const over = [...exact, null];

    expect(errorCode(() => compileReportOnlyExecutionPlan(
      exact as unknown as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.manifest-invalid');
    expect(errorCode(() => compileReportOnlyExecutionPlan(
      over as unknown as ControlManifestV1,
      current.admission,
      current.trustedInput,
    ))).toBe('ci.execution-plan.input-budget');
  });

  it('has no ambient time, working-directory, environment, network, or process dependency', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const originalCwd = process.cwd;
    const originalNow = Date.now;
    const originalFetch = globalThis.fetch;
    process.cwd = () => { throw new Error('ambient cwd forbidden'); };
    Date.now = () => { throw new Error('ambient time forbidden'); };
    globalThis.fetch = (() => { throw new Error('network forbidden'); }) as typeof fetch;
    try {
      const plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);
      expect(plan.authorization).toBe('report-only');
      expect(plan.executable).toBe(false);
    } finally {
      process.cwd = originalCwd;
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
  });

  it('recognizes only exact same-process compiler plans without inspecting unbranded values', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);
    const clone = structuredClone(plan);
    const reconstructed = Object.freeze({ ...plan });
    const wrapped = new Proxy(plan, {});
    let hostileTraps = 0;
    const hostile = new Proxy({}, {
      get() { hostileTraps += 1; throw new Error('unbranded value inspected'); },
      ownKeys() { hostileTraps += 1; throw new Error('unbranded value inspected'); },
      getOwnPropertyDescriptor() { hostileTraps += 1; throw new Error('unbranded value inspected'); },
    });

    expect(matchesSameProcessControlExecutionPlan(plan)).toBe(true);
    for (const value of [clone, reconstructed, wrapped, hostile, null, 'plan']) {
      expect(matchesSameProcessControlExecutionPlan(value)).toBe(false);
    }
    expect(hostileTraps).toBe(0);
  });

  it('keeps same-process plan recognition bound to captured lookup primordials', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);
    const originalApply = Reflect.apply;
    const originalGet = WeakMap.prototype.get;
    let recognized = false;
    try {
      Reflect.apply = (() => { throw new Error('mutable Reflect.apply used'); }) as typeof Reflect.apply;
      WeakMap.prototype.get = (() => { throw new Error('mutable WeakMap.get used'); }) as typeof WeakMap.prototype.get;
      recognized = matchesSameProcessControlExecutionPlan(plan);
    } finally {
      Reflect.apply = originalApply;
      WeakMap.prototype.get = originalGet;
    }
    expect(recognized).toBe(true);
  });

  it('freezes every nested plan value under selective ambient freeze replacement', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const originalFreeze = Object.freeze;
    let plan: ControlExecutionPlanV1 | undefined;
    try {
      Object.freeze = ((value: object) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, 'planDigest');
        return descriptor === undefined ? value : originalFreeze(value);
      }) as typeof Object.freeze;
      plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);
    } finally {
      Object.freeze = originalFreeze;
    }
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan!.steps)).toBe(true);
    expect(Object.isFrozen(plan!.steps[0])).toBe(true);
    expect(Object.isFrozen(plan!.steps[0]!.argv)).toBe(true);
    expect(matchesSameProcessControlExecutionPlan(plan)).toBe(true);
  });

  it('returns only a frozen, non-spawning report-only preflight for genuine plans', () => {
    for (const current of [
      fixture({ mutateManifest: makeLowControlsAvailable }),
      fixture({ candidatePath: 'unknown/new-surface.data' }),
    ]) {
      const plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);
      const preflight = preflightReportOnlyExecutionPlan(plan);
      assertReportOnlyPreflight(preflight);
      expect(preflight).toMatchObject({
        schemaVersion: 1,
        authorization: 'report-only',
        operation: 'evidence-collection',
        outcome: 'inconclusive',
        exitCode: 2,
        spawnAllowed: false,
        code: 'ci.execution-kernel.contracts-unavailable',
        planDigest: plan.planDigest,
        unavailableControls: plan.unavailableControls,
        requiredSuites: plan.requiredSuites,
        limitations: plan.limitations,
      });
      expect(preflight.exactChildControlIds).toEqual(plan.steps.map(({ controlId }) => controlId));
      expect([...preflight.exactChildControlIds].sort()).toEqual([...plan.requiredControls].sort());
      expect(preflight.unavailableInputs).toEqual([
        'environment-allowlist-policy',
        'executable-identity-policy',
        'output-budget-policy',
        'precondition-receipt-producer',
        'supervisor-process-lease-producer',
        'taint-and-write-scope-policy',
        'terminal-result-producer',
        'timeout-policy',
        'working-directory-policy',
      ]);
      assertDeeplyFrozen(preflight);
    }
  });

  it('rejects unadmitted preflight inputs before caller or ambient inspection', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);
    let hostileTraps = 0;
    const hostile = new Proxy({}, {
      get() { hostileTraps += 1; throw new Error('unadmitted plan inspected'); },
      ownKeys() { hostileTraps += 1; throw new Error('unadmitted plan inspected'); },
      getOwnPropertyDescriptor() { hostileTraps += 1; throw new Error('unadmitted plan inspected'); },
    });
    const originalCwd = process.cwd;
    const originalNow = Date.now;
    const originalFetch = globalThis.fetch;
    process.cwd = () => { throw new Error('ambient cwd forbidden'); };
    Date.now = () => { throw new Error('ambient time forbidden'); };
    globalThis.fetch = (() => { throw new Error('network forbidden'); }) as typeof fetch;
    try {
      for (const value of [structuredClone(plan), { ...plan }, new Proxy(plan, {}), hostile]) {
        expect(preflightReportOnlyExecutionPlan(value)).toEqual({
          schemaVersion: 1,
          authorization: 'report-only',
          operation: 'evidence-collection',
          outcome: 'inconclusive',
          exitCode: 2,
          spawnAllowed: false,
          code: 'ci.execution-kernel.plan-unadmitted',
        });
      }
    } finally {
      process.cwd = originalCwd;
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
    }
    expect(hostileTraps).toBe(0);
  });

  it('keeps the preflight source free of execution and ambient-authority dependencies', () => {
    const source = readFileSync(join(projectRoot, 'scripts/lib/ci-control/execution-kernel-preflight.ts'), 'utf8');
    for (const forbidden of [
      'node:child_process', 'node:fs', 'node:http', 'node:https', 'process.cwd',
      'process.env', 'Date.now', 'fetch(', 'spawn(', 'exec(',
    ]) expect(source).not.toContain(forbidden);
  });

  it('keeps preflight refusal bound to captured collection and freeze primordials', () => {
    const current = fixture({ mutateManifest: makeLowControlsAvailable });
    const plan = compileReportOnlyExecutionPlan(current.manifest, current.admission, current.trustedInput);
    const originalApply = Reflect.apply;
    const originalMap = Array.prototype.map;
    const originalSlice = Array.prototype.slice;
    const originalSort = Array.prototype.sort;
    const originalFreeze = Object.freeze;
    let preflight: ReturnType<typeof preflightReportOnlyExecutionPlan> | undefined;
    try {
      Reflect.apply = (() => { throw new Error('mutable Reflect.apply used'); }) as typeof Reflect.apply;
      Array.prototype.map = (() => { throw new Error('mutable Array.map used'); }) as typeof Array.prototype.map;
      Array.prototype.slice = (() => { throw new Error('mutable Array.slice used'); }) as typeof Array.prototype.slice;
      Array.prototype.sort = (() => { throw new Error('mutable Array.sort used'); }) as typeof Array.prototype.sort;
      Object.freeze = (() => { throw new Error('mutable Object.freeze used'); }) as typeof Object.freeze;
      preflight = preflightReportOnlyExecutionPlan(plan);
    } finally {
      Reflect.apply = originalApply;
      Array.prototype.map = originalMap;
      Array.prototype.slice = originalSlice;
      Array.prototype.sort = originalSort;
      Object.freeze = originalFreeze;
    }
    expect(preflight).toMatchObject({
      code: 'ci.execution-kernel.contracts-unavailable',
      spawnAllowed: false,
    });
    assertDeeplyFrozen(preflight);
  });
});
