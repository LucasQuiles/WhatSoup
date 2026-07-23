/**
 * CLI for the drift classifier (rider P1).
 *
 *   npm run drift:classify -- --base <oid> [--observed <ref>] [--candidate <ref>]
 *
 * Answers "my evidence was earned against <base>; `main` has moved — what still holds?"
 * by enumerating the paths that changed and classifying them. See
 * `scripts/lib/drift-classifier.ts` for the matrix; all judgement lives there, pure and
 * exhaustively tested. This file is only the IO boundary.
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

import {
  EXIT_CONTINUE,
  EXIT_INCONCLUSIVE,
  classifyDrift,
  exitCodeFor,
  type ClassifyOptions,
} from './lib/drift-classifier.ts';

const GIT_TIMEOUT_MS = 30_000;

interface Args {
  base?: string;
  observed: string;
  candidate?: string;
  json: boolean;
  selfCheck: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { observed: 'origin/main', json: false, selfCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--observed') args.observed = argv[++i] ?? args.observed;
    else if (a === '--candidate') args.candidate = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--self-check') args.selfCheck = true;
  }
  return args;
}

/** Every path tracked at HEAD, or null if git could not answer. */
export function trackedPaths(cwd: string): string[] | null {
  const r = spawnSync('git', ['ls-tree', '-r', 'HEAD', '--name-only'], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
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

/**
 * `git diff --name-only A..B`, or null if git could not answer.
 *
 * Returns null rather than [] on failure. An empty array is a real result meaning "nothing
 * changed"; a failure means "I could not look", and the two must not share a
 * representation — that conflation is precisely how an unexaminable tree gets certified.
 */
export function changedPaths(from: string, to: string, cwd: string): string[] | null {
  const r = spawnSync('git', ['diff', '--name-only', `${from}..${to}`], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
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

  const drifted = changedPaths(args.base, args.observed, cwd);
  const options: ClassifyOptions = { analysisFailed: drifted === null };
  if (args.candidate) {
    const candidatePaths = changedPaths(args.base, args.candidate, cwd);
    // A failed candidate diff cannot be treated as "the candidate touches nothing" — that
    // would silently downgrade every genuine CONFLICT to a milder class.
    if (candidatePaths === null) options.analysisFailed = true;
    else options.candidatePaths = candidatePaths;
  }

  const verdict = classifyDrift(drifted ?? [], options);

  if (args.json) {
    console.log(JSON.stringify(verdict, null, 2));
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
