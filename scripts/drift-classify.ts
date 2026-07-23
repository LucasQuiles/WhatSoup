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
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { observed: 'origin/main', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--observed') args.observed = argv[++i] ?? args.observed;
    else if (a === '--candidate') args.candidate = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
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
