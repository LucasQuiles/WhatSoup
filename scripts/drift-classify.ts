#!/usr/bin/env node
/**
 * Exact-object drift receipt adapter.
 *
 * This command never owns path policy. It invokes the canonical exact-revision classifier
 * for immutable OIDs and translates that native result into receipt invalidation.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readControlManifestAtRevision,
} from './lib/ci-control/classifier.ts';
import {
  createRiskClassificationReceipt,
  matchesSameProcessRiskClassificationAdmission,
} from './lib/ci-control/classification-admission.ts';
import {
  FULL_OID,
  gitBytes,
  readExactTreePaths,
} from './lib/ci-control/git-input-core.ts';
import { digestControlManifest } from './lib/ci-control/manifest.ts';
import {
  EXIT_CONTINUE,
  EXIT_INCONCLUSIVE,
  DRIFT_MATRIX,
  classifyDrift,
  codeForDrift,
  exitCodeFor,
  outcomeForDrift,
  projectDriftResult,
  type DriftOutcome,
  type DriftVerdict,
} from './lib/drift-classifier.ts';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const USAGE = 'Usage: npm run drift:classify -- --base <40-hex> --observed <40-hex> --manifest-digest <sha256:hex> [--candidate <40-hex>] [--json]\n       npm run drift:classify -- --self-check [--json]\n';
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DRIFT_ADAPTER_SOURCE_PATHS = [
  'scripts/drift-classify.ts',
  'scripts/lib/drift-classifier.ts',
  'scripts/lib/ci-control/classification-admission.ts',
] as const;

/** Native report-only evidence; a protected adapter must create ci-control-result-v1. */
export interface NativeDriftObservationV1 {
  schemaVersion: 1;
  resultKind: 'native-report-only-observation';
  outcome: DriftOutcome;
  exitCode: 0 | 1 | 2;
  code: string;
  detectorId: 'ci-control-classifier';
  authorization: 'report-only';
  adapterDigest: string | null;
  bindings: {
    baseOid: string | null;
    observedOid: string | null;
    candidateOid: string | null;
    manifestDigest: string | null;
    classifierDigest: string | null;
    observedChangeSetDigest: string | null;
    candidateChangeSetDigest: string | null;
  };
  nativeOutcome: 'pass' | 'inconclusive';
  nativeCauseCompleteness: 'complete' | 'unavailable';
  nativeCauseCodes: string[];
  observedNativeCauseCodes: string[];
  candidateNativeCauseCodes: string[];
  limitationCodes: string[];
  verdict: DriftVerdict;
  trackedPathCount?: number;
  unclassifiedCount?: number;
  unclassified?: readonly string[];
}

interface Args {
  base?: string;
  observed?: string;
  candidate?: string;
  manifestDigest?: string;
  json: boolean;
  selfCheck: boolean;
  help: boolean;
  error?: string;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { json: argv.includes('--json'), selfCheck: false, help: false };
  const seen = new Set<string>();
  const valued = new Set(['--base', '--observed', '--candidate', '--manifest-digest']);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (!valued.has(option) && !['--json', '--self-check', '--help'].includes(option)) {
      return { ...args, error: 'ci.input.option-unknown' };
    }
    if (seen.has(option)) return { ...args, error: 'ci.input.duplicate-option' };
    seen.add(option);
    if (option === '--json') args.json = true;
    else if (option === '--self-check') args.selfCheck = true;
    else if (option === '--help') args.help = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { ...args, error: 'ci.input.option-value-missing' };
      if (option === '--base') args.base = value;
      else if (option === '--observed') args.observed = value;
      else if (option === '--candidate') args.candidate = value;
      else args.manifestDigest = value;
      index += 1;
    }
  }
  if (args.help && argv.length !== 1) return { ...args, error: 'ci.input.option-conflict' };
  if (args.selfCheck && (args.base !== undefined || args.observed !== undefined
    || args.candidate !== undefined || args.manifestDigest !== undefined)) {
    return { ...args, error: 'ci.input.option-conflict' };
  }
  return args;
}

export function digestDriftAdapterSources(repositoryRoot: string): string {
  const hash = createHash('sha256');
  for (const path of DRIFT_ADAPTER_SOURCE_PATHS) {
    const bytes = readFileSync(resolve(repositoryRoot, path));
    hash.update(`${path.length}:${path}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function assertDriftAdapterSourcesStable(repositoryRoot: string, loadedDigest: string): string {
  const observed = digestDriftAdapterSources(repositoryRoot);
  if (observed !== loadedDigest) throw new Error('ci.classification.tool-source-changed');
  return loadedDigest;
}

const LOADED_ADAPTER_DIGEST = (() => {
  try {
    return digestDriftAdapterSources(REPOSITORY_ROOT);
  } catch {
    return null;
  }
})();

function adapterDigest(): string | null {
  if (LOADED_ADAPTER_DIGEST === null) return null;
  try {
    return assertDriftAdapterSourcesStable(REPOSITORY_ROOT, LOADED_ADAPTER_DIGEST);
  } catch {
    return null;
  }
}

function resolveHeadOid(cwd: string): string | null {
  try {
    const bytes = gitBytes(
      cwd,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      'ci.input.commit-metadata-unavailable',
      128,
    );
    const oid = bytes.toString('ascii').trim();
    return FULL_OID.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** Exact paths tracked by one immutable commit, or null if Git cannot answer. */
export function trackedPaths(cwd: string, oid: string): string[] | null {
  if (!FULL_OID.test(oid)) return null;
  try {
    return readExactTreePaths(cwd, oid).paths;
  } catch {
    return null;
  }
}

function projection(
  verdict: DriftVerdict,
  nativeReasons: readonly string[],
  bindings: NativeDriftObservationV1['bindings'],
  options: {
    forceInconclusive?: boolean;
    nativeOutcome?: NativeDriftObservationV1['nativeOutcome'];
    observedNativeReasons?: readonly string[];
    candidateNativeReasons?: readonly string[];
    trackedPathCount?: number;
    unclassifiedCount?: number;
    unclassified?: readonly string[];
    code?: string;
    outcome?: DriftOutcome;
    exitCode?: 0 | 1 | 2;
  } = {},
): NativeDriftObservationV1 {
  const observedAdapterDigest = adapterDigest();
  const forcedInconclusive = options.forceInconclusive === true || observedAdapterDigest === null;
  const allNativeReasons = observedAdapterDigest === null
    ? [...new Set([...nativeReasons, 'ci.classification.tool-source-changed'])]
    : [...nativeReasons];
  const output: NativeDriftObservationV1 = {
    schemaVersion: 1,
    resultKind: 'native-report-only-observation',
    outcome: forcedInconclusive ? 'inconclusive' : options.outcome ?? outcomeForDrift(verdict.drift),
    exitCode: forcedInconclusive ? EXIT_INCONCLUSIVE : options.exitCode ?? exitCodeFor(verdict.drift) as 0 | 1 | 2,
    code: forcedInconclusive ? 'ci.native.receipt-unavailable' : options.code ?? codeForDrift(verdict.drift),
    detectorId: 'ci-control-classifier',
    authorization: 'report-only',
    adapterDigest: observedAdapterDigest,
    bindings,
    nativeOutcome: options.nativeOutcome ?? (verdict.drift === 'UNKNOWN' ? 'inconclusive' : 'pass'),
    nativeCauseCompleteness: forcedInconclusive || verdict.drift === 'UNKNOWN' ? 'unavailable' : 'complete',
    nativeCauseCodes: allNativeReasons,
    observedNativeCauseCodes: [...(options.observedNativeReasons ?? nativeReasons)],
    candidateNativeCauseCodes: [...(options.candidateNativeReasons ?? [])],
    limitationCodes: [
      'ci.native.report-only',
      'ci.native.protected-policy-unavailable',
      'ci.native.terminal-attempt-unavailable',
      'ci.native.disjoint-component-proof-unavailable',
    ],
    verdict,
  };
  if (options.trackedPathCount !== undefined) output.trackedPathCount = options.trackedPathCount;
  if (options.unclassifiedCount !== undefined) output.unclassifiedCount = options.unclassifiedCount;
  if (options.unclassified !== undefined) output.unclassified = options.unclassified;
  return output;
}

function emptyBindings(): NativeDriftObservationV1['bindings'] {
  return {
    baseOid: null,
    observedOid: null,
    candidateOid: null,
    manifestDigest: null,
    classifierDigest: null,
    observedChangeSetDigest: null,
    candidateChangeSetDigest: null,
  };
}

function writeProjection(result: NativeDriftObservationV1, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const label = result.outcome.toUpperCase();
  const line = `drift-classify: ${label} — ${result.code}`;
  const details = [
    line,
    result.verdict.why ? `  ${result.verdict.why}` : null,
    result.nativeCauseCodes.length > 0 ? `  native: ${result.nativeCauseCodes.join(', ')}` : null,
    `  authorization=${result.authorization}; result=${result.resultKind}`,
  ].filter((value): value is string => value !== null).join('\n');
  const stream = result.exitCode === EXIT_CONTINUE ? process.stdout : process.stderr;
  stream.write(`${details}\n`);
}

function inconclusiveProjection(code: string): NativeDriftObservationV1 {
  const spec = DRIFT_MATRIX.UNKNOWN;
  return projection(
    {
      drift: 'UNKNOWN',
      behavior: spec.behavior,
      invalidates: spec.invalidates,
      classifications: [],
      unclassified: [],
      why: spec.why,
    },
    [code],
    emptyBindings(),
    { forceInconclusive: true, nativeOutcome: 'inconclusive' },
  );
}

function selfCheck(cwd: string, json: boolean): number {
  try {
    const oid = resolveHeadOid(cwd);
    if (oid === null) throw new Error('ci.input.revision-unavailable');
    const manifest = readControlManifestAtRevision(cwd, oid);
    const files = trackedPaths(cwd, oid);
    if (files === null || files.length < 100) throw new Error('ci.classification.graph-unavailable');
    const coverage = classifyDrift(files, manifest);
    const complete = coverage.unclassified.length === 0;
    const verdict: DriftVerdict = complete ? classifyDrift([], manifest) : {
      drift: 'UNKNOWN',
      behavior: DRIFT_MATRIX.UNKNOWN.behavior,
      invalidates: DRIFT_MATRIX.UNKNOWN.invalidates,
      classifications: [],
      unclassified: coverage.unclassified.slice(0, 25),
      why: DRIFT_MATRIX.UNKNOWN.why,
    };
    const result = projection(verdict, complete ? [] : ['ci.classification.unknown-path'], {
      ...emptyBindings(),
      baseOid: oid,
      observedOid: oid,
      manifestDigest: digestControlManifest(manifest),
    }, {
      code: complete ? 'ci.check.passed' : 'git.lineage.base.drift-relevant',
      outcome: complete ? 'pass' : 'inconclusive',
      exitCode: complete ? EXIT_CONTINUE : EXIT_INCONCLUSIVE,
      forceInconclusive: !complete,
      trackedPathCount: files.length,
      unclassifiedCount: coverage.unclassified.length,
      unclassified: coverage.unclassified.slice(0, 25),
    });
    writeProjection(result, json);
    return result.exitCode;
  } catch (error) {
    const code = error instanceof Error && /^ci\./.test(error.message)
      ? error.message
      : 'ci.classification.graph-unavailable';
    writeProjection(inconclusiveProjection(code), json);
    return EXIT_INCONCLUSIVE;
  }
}

export function main(argv: readonly string[], cwd: string): number {
  const args = parseArgs(argv);
  if (args.error !== undefined) {
    writeProjection(inconclusiveProjection(args.error), args.json);
    if (!args.json) console.error(USAGE.trimEnd());
    return EXIT_INCONCLUSIVE;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return EXIT_CONTINUE;
  }
  if (args.selfCheck) return selfCheck(cwd, args.json);
  if (!FULL_OID.test(args.base ?? '') || !FULL_OID.test(args.observed ?? '')
    || !(args.candidate === undefined || FULL_OID.test(args.candidate))
    || !DIGEST.test(args.manifestDigest ?? '')) {
    writeProjection(inconclusiveProjection('ci.input.exact-binding-required'), args.json);
    if (!args.json) console.error(USAGE.trimEnd());
    return EXIT_INCONCLUSIVE;
  }

  try {
    const manifest = readControlManifestAtRevision(cwd, args.base!);
    const observedAdmission = createRiskClassificationReceipt(cwd, {
      eventName: 'push',
      baseOid: args.base!,
      candidateOid: args.observed!,
      mergeOid: null,
      manifestDigest: args.manifestDigest!,
    });
    if (!matchesSameProcessRiskClassificationAdmission(observedAdmission)) {
      throw new Error('ci.classification.receipt.binding-mismatch');
    }
    const candidateAdmission = args.candidate === undefined ? null : createRiskClassificationReceipt(cwd, {
      eventName: 'local',
      baseOid: args.base!,
      candidateOid: args.candidate,
      mergeOid: null,
      manifestDigest: args.manifestDigest!,
    });
    if (candidateAdmission !== null && !matchesSameProcessRiskClassificationAdmission(candidateAdmission)) {
      throw new Error('ci.classification.receipt.binding-mismatch');
    }
    const observed = observedAdmission.classification;
    const candidate = candidateAdmission?.classification ?? null;
    const verdict = projectDriftResult(observedAdmission, manifest, candidateAdmission);
    const output = projection(verdict, [...observed.reasons, ...(candidate?.reasons ?? [])], {
      baseOid: args.base!,
      observedOid: args.observed!,
      candidateOid: args.candidate ?? null,
      manifestDigest: observed.manifestDigest,
      classifierDigest: observed.classifierDigest,
      observedChangeSetDigest: observed.changeSetDigest,
      candidateChangeSetDigest: candidate?.changeSetDigest ?? null,
    }, {
      nativeOutcome: observed.outcome,
      observedNativeReasons: observed.reasons,
      candidateNativeReasons: candidate?.reasons ?? [],
    });
    writeProjection(output, args.json);
    return output.exitCode;
  } catch (error) {
    const code = error instanceof Error && /^ci\./.test(error.message)
      ? error.message
      : 'ci.classification.graph-unavailable';
    writeProjection(inconclusiveProjection(code), args.json);
    return EXIT_INCONCLUSIVE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
