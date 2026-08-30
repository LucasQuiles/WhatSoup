/**
 * CLI for the drift classifier (rider P1).
 *
 *   npm run drift:classify -- --base <ref> [--observed <ref>] [--candidate <ref>]
 *
 * Answers "my evidence was earned against <base>; `main` has moved — what still holds?".
 * Path judgement lives in `scripts/lib/drift-classifier.ts`, pure and exhaustively tested;
 * this file is the IO boundary. Since the #2822 adoption the changed-path set feeding that
 * judgement is earned through `scripts/lib/ci-control/classification-admission.ts`: every
 * ref is resolved to an immutable OID, a risk-classification receipt is created against the
 * control manifest at <base>, and the verdict reads the ADMITTED classification's change
 * facts — never a raw `git diff`. Whatever admission refuses (a base that is not the
 * observed tip's predecessor, a missing or drifted manifest, an unverifiable receipt) is
 * INCONCLUSIVE, not a verdict.
 *
 * Exit codes follow the repo's three-outcome discipline, and the third one is the point:
 *   0  continue        — drift does not invalidate the evidence that matters
 *   1  stop            — reconcile, regenerate, or hand to an integrator first
 *   2  INCONCLUSIVE    — could not determine; NOT the same as "found a problem"
 *
 * Collapsing 2 into 1 sends an operator hunting for a violation that was never
 * established; collapsing it into 0 ships a false green.
 */
import { spawnSync } from 'node:child_process';

import { assertKnownFlag, takeValue } from './lib/cli-args.ts';
import {
  createRiskClassificationReceipt,
  matchesSameProcessRiskClassificationAdmission,
  type AdmittedRiskClassificationV1,
} from './lib/ci-control/classification-admission.ts';
import { readControlManifestAtRevision } from './lib/ci-control/classifier.ts';
import { FULL_OID, type ChangeFactV1 } from './lib/ci-control/git-input-core.ts';
import { digestControlManifest } from './lib/ci-control/manifest.ts';
import { cleanGitEnv } from './lib/guard-core.ts';
import {
  EXIT_CONTINUE,
  EXIT_INCONCLUSIVE,
  classifyDrift,
  exitCodeFor,
  type DriftVerdict,
} from './lib/drift-classifier.ts';

const GIT_TIMEOUT_MS = 30_000;

/**
 * 64 MiB, matching `guard-core`. A large tree's `ls-tree` overflows the 1 MiB default and
 * would surface as a spawn failure — i.e. INCONCLUSIVE — rather than a real verdict.
 */
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

interface Args {
  base?: string;
  observed: string;
  candidate?: string;
  json: boolean;
  selfCheck: boolean;
}

/** The receipt bindings a verdict was earned under, reported alongside it. */
interface AdmissionEvidence {
  evidenceDigest: string;
  manifestDigest: string;
  classifierDigest: string;
  changeSetDigest: string | null;
  reasons: string[];
  candidateEvidenceDigest: string | null;
  candidateReasons: string[];
}

const KNOWN_FLAGS = ['--base', '--observed', '--candidate', '--json', '--self-check'] as const;

/**
 * Uses `takeValue` rather than `argv[++i]`. The hand-rolled form silently accepted two
 * wrong inputs, both measured in this very function before the change: `--base` with no
 * value dropped the flag entirely, and `--base --json` set base to the string `"--json"` —
 * which was then handed to git as a ref. See scripts/lib/cli-args.ts.
 */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { observed: 'origin/main', json: false, selfCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    assertKnownFlag(a, KNOWN_FLAGS);
    if (a === '--base') { const t = takeValue(argv, i, a); args.base = t.value; i = t.index; }
    else if (a === '--observed') { const t = takeValue(argv, i, a); args.observed = t.value; i = t.index; }
    else if (a === '--candidate') { const t = takeValue(argv, i, a); args.candidate = t.value; i = t.index; }
    else if (a === '--json') args.json = true;
    else if (a === '--self-check') args.selfCheck = true;
  }
  return args;
}

/**
 * Run a git command and return its output lines, or `null` if git could not answer.
 *
 * NULL, NOT `[]`. An empty array is a real result meaning "nothing changed"; `null` means
 * "I could not look". Conflating them is exactly how an unexaminable tree gets certified,
 * and keeping them distinct is what lets `main` route a failure into
 * `ClassifyOptions.analysisFailed` and report INCONCLUSIVE rather than a verdict.
 *
 * Deliberately NOT `guard-core`'s `git()`/`gitList()`, which use `execFileSync` and THROW
 * on non-zero exit — this module needs the failure as a value, not an exception. It does
 * borrow that module's environment and buffer policy, which is the part worth sharing:
 * `cleanGitEnv()` stops an ambient `GIT_DIR` (set whenever a guard runs from a git hook)
 * resolving these commands against the wrong repository.
 */
function gitLinesOrNull(args: string[], cwd: string): string[] | null {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Every path tracked at HEAD, or null if git could not answer. */
export function trackedPaths(cwd: string): string[] | null {
  return gitLinesOrNull(['ls-tree', '-r', 'HEAD', '--name-only'], cwd);
}

/**
 * `--self-check`: can this classifier still understand this repository?
 *
 * Classifies every tracked file and fails ONLY on INCONCLUSIVE — i.e. a path matching no
 * rule. Deliberately not a drift check: real drift legitimately returns 1 (stop) all the
 * time, so gating CI on the drift verdict itself would be pure noise. What is NOT normal is
 * the classifier meeting a surface it does not recognise, because from that moment every
 * verdict touching that surface silently degrades to "I don't know".
 *
 * This runs the real CLI end-to-end — arg parsing, git invocation, exit code — which the
 * unit tests exercise only in pieces.
 */
function selfCheck(cwd: string): number {
  const files = trackedPaths(cwd);
  if (files === null) {
    console.error('drift-classify --self-check: INCONCLUSIVE — could not enumerate tracked files');
    return EXIT_INCONCLUSIVE;
  }
  if (files.length < 100) {
    // A near-empty listing would otherwise pass trivially: nothing to classify, nothing
    // unclassified, green. Same false-green shape the empty-scope guards exist for.
    console.error(
      `drift-classify --self-check: INCONCLUSIVE — only ${files.length} tracked file(s); ` +
        'refusing to certify classifier coverage against a tree that was never really examined',
    );
    return EXIT_INCONCLUSIVE;
  }
  const verdict = classifyDrift(files);
  if (verdict.unclassified.length > 0) {
    console.error(
      `drift-classify --self-check: INCONCLUSIVE — ${verdict.unclassified.length} of ${files.length} ` +
        'tracked path(s) match no classification rule, so any drift touching them returns no verdict:',
    );
    for (const u of verdict.unclassified.slice(0, 25)) console.error(`    ${u}`);
    console.error('  Add a PATH_RULES entry in scripts/lib/drift-classifier.ts.');
    return EXIT_INCONCLUSIVE;
  }
  const counts = new Map<string, number>();
  for (const c of verdict.classifications) counts.set(c.drift, (counts.get(c.drift) ?? 0) + 1);
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`);
  console.log(
    `drift-classify --self-check: all ${files.length} tracked path(s) classify (${summary.join(', ')})`,
  );
  return EXIT_CONTINUE;
}

/** Resolve any ref to the full commit OID admission can bind, or null if git cannot answer. */
function resolveCommitOid(ref: string, cwd: string): string | null {
  const lines = gitLinesOrNull(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  const oid = lines?.[0];
  return oid !== undefined && FULL_OID.test(oid) ? oid : null;
}

/** Every path a change-fact touches: renames contribute both sides. */
function factPaths(changed: readonly ChangeFactV1[]): string[] {
  return changed.flatMap((fact) => (fact.oldPath === null ? [fact.path] : [fact.oldPath, fact.path]));
}

/**
 * Project an admitted risk classification into a drift verdict.
 *
 * Port of the #2084 anchor's `projectDriftResult`, adapted to the landed admission API.
 * The changed-path set is read from the ADMITTED classification, and every binding this
 * adapter relies on is re-verified here: the admission is same-process (the WeakMap +
 * digest re-check in `matchesSameProcessRiskClassificationAdmission`), the base really is
 * the observed tip's predecessor, no merge object is involved, and both receipts were
 * earned against the manifest read at <base> by the same classifier. Anything that fails
 * degrades to UNKNOWN — INCONCLUSIVE — rather than a verdict.
 */
function projectAdmittedDrift(
  observedAdmission: unknown,
  manifestDigest: string,
  candidateAdmission: unknown,
): DriftVerdict {
  if (!matchesSameProcessRiskClassificationAdmission(observedAdmission)
    || (candidateAdmission !== null && !matchesSameProcessRiskClassificationAdmission(candidateAdmission))) {
    return classifyDrift([], { analysisFailed: true });
  }
  const observed = observedAdmission.classification;
  const candidate = candidateAdmission === null
    ? null
    : (candidateAdmission as AdmittedRiskClassificationV1).classification;
  const candidateBindingsMatch = candidate === null || (
    candidate.outcome === 'pass'
    && candidate.baseOid === observed.baseOid
    && candidate.mergeBaseOid === observed.baseOid
    && candidate.mergeOid === null
    && candidate.manifestDigest === observed.manifestDigest
    && candidate.classifierDigest === observed.classifierDigest
  );
  if (observed.outcome !== 'pass'
    || observed.baseOid === null
    || observed.mergeBaseOid !== observed.baseOid
    || observed.mergeOid !== null
    || observed.manifestDigest !== manifestDigest
    || !candidateBindingsMatch) {
    return classifyDrift([], { analysisFailed: true });
  }
  return classifyDrift(factPaths(observed.changed), {
    candidatePaths: candidate === null ? [] : factPaths(candidate.changed),
  });
}

function main(argv: readonly string[], cwd: string): number {
  const args = parseArgs(argv);
  if (args.selfCheck) return selfCheck(cwd);
  if (!args.base) {
    console.error(
      'drift-classify: INCONCLUSIVE — --base <oid> is required; without the OID the evidence ' +
        'was earned against, there is nothing to classify drift relative to',
    );
    return EXIT_INCONCLUSIVE;
  }

  // Admission binds exact objects, not refs: resolve everything to immutable OIDs first.
  const baseOid = resolveCommitOid(args.base, cwd);
  const observedOid = resolveCommitOid(args.observed, cwd);
  const candidateOid = args.candidate === undefined ? null : resolveCommitOid(args.candidate, cwd);

  let verdict: DriftVerdict;
  let admission: AdmissionEvidence | null = null;
  if (baseOid === null || observedOid === null || (args.candidate !== undefined && candidateOid === null)) {
    verdict = classifyDrift([], { analysisFailed: true });
  } else {
    try {
      const manifestDigest = digestControlManifest(readControlManifestAtRevision(cwd, baseOid));
      const observed = createRiskClassificationReceipt(cwd, {
        eventName: 'push',
        baseOid,
        candidateOid: observedOid,
        mergeOid: null,
        manifestDigest,
      });
      const candidate = candidateOid === null ? null : createRiskClassificationReceipt(cwd, {
        eventName: 'local',
        baseOid,
        candidateOid,
        mergeOid: null,
        manifestDigest,
      });
      verdict = projectAdmittedDrift(observed, manifestDigest, candidate);
      admission = {
        evidenceDigest: observed.evidenceDigest,
        manifestDigest: observed.classification.manifestDigest,
        classifierDigest: observed.classification.classifierDigest,
        changeSetDigest: observed.classification.changeSetDigest,
        reasons: [...observed.classification.reasons],
        candidateEvidenceDigest: candidate?.evidenceDigest ?? null,
        candidateReasons: [...(candidate?.classification.reasons ?? [])],
      };
    } catch (error) {
      // The manifest could not be read at <base>, or the admission boundary refused the
      // receipt. Either way nothing was classified — INCONCLUSIVE, never a verdict.
      const code = error instanceof Error && /^ci\./.test(error.message)
        ? error.message
        : 'ci.classification.graph-unavailable';
      console.error(`drift-classify: INCONCLUSIVE — admission refused the classification (${code})`);
      verdict = classifyDrift([], { analysisFailed: true });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ ...verdict, admission }, null, 2));
  } else {
    console.log(`drift-classify: ${verdict.drift} — ${verdict.behavior}`);
    console.log(`  ${verdict.why}`);
    console.log(
      `  examined ${verdict.classifications.length} changed path(s) between ${args.base.slice(0, 9)} and ${args.observed}`,
    );
    if (verdict.invalidates.length > 0) {
      console.log(`  invalidates receipts tagged: ${verdict.invalidates.join(', ')}`);
    } else {
      console.log('  invalidates no receipts');
    }
    if (admission !== null) {
      console.log(`  admitted via classification-admission (evidence ${admission.evidenceDigest})`);
      if (admission.reasons.length > 0) {
        console.log(`  admission reasons: ${admission.reasons.join(', ')}`);
      }
    }
    for (const c of verdict.classifications.slice(0, 20)) {
      console.log(`    ${c.drift.padEnd(20)} ${c.path}  (${c.rule})`);
    }
    if (verdict.classifications.length > 20) {
      console.log(`    … ${verdict.classifications.length - 20} more`);
    }
    for (const u of verdict.unclassified) console.log(`    UNCLASSIFIED         ${u}`);
  }

  return exitCodeFor(verdict.drift);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}

export { main };
