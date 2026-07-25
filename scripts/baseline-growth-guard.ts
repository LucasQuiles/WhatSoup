#!/usr/bin/env node --experimental-strip-types
/**
 * Baseline growth guard — a committed baseline may only shrink.
 *
 * THE GAP THIS CLOSES. Every baseline guard in this repo compares CURRENT CODE against its
 * baseline. None of them checks the baseline itself. `check-shadow-baseline.mjs --update`
 * and `check-design-burndown.mjs --update` rewrite their baselines wholesale, so the
 * sequence "add a violation, re-run --update, commit" is green everywhere today. Measured
 * on origin/main 084908d91: 7 baseline files, each read by 1-22 scripts/tests, ZERO
 * assertions that any of them cannot grow.
 *
 * WHAT IT DOES. For each registered baseline, weigh the tolerated debt (see
 * `lib/baseline-weight.ts`) at the merge base and in the candidate, and refuse any increase.
 *
 * EXIT CODES — the repo's three-outcome discipline:
 *   0  every baseline shrank or held
 *   1  at least one baseline grew
 *   2  INCONCLUSIVE — a revision or document could not be read, so growth cannot be ruled
 *      out. Never reported as a pass: "could not look" is not "nothing changed".
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_REGISTRY,
  type BaselineFinding,
  type WeighedBaseline,
  compareWeights,
  weighBaseline,
} from './lib/baseline-weight.ts';
import { CliArgError, assertKnownFlag, isHelpFlag, takeValue } from './lib/cli-args.ts';
import { cleanGitEnv } from './lib/guard-core.ts';
import { readGitTextAtRevision } from './lib/semantic-quality/git-tree.ts';

const EXIT_PASS = 0;
const EXIT_BLOCK = 1;
const EXIT_INCONCLUSIVE = 2;

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN_FLAGS = ['--base', '--repo', '--json', '--help', '-h'] as const;

interface Options {
  base: string | null;
  /**
   * Test seam. Overrides the repo scanned, so the growth path can be proven against a
   * throwaway git repo instead of by mutating this one. Same seam idiom as
   * `check-shadow-baseline.mjs --baseline`. It changes only WHERE the registry paths are
   * resolved — every weighing and comparison rule below is the production path.
   */
  repo: string;
  json: boolean;
}

function parseOptions(argv: readonly string[]): Options | 'help' {
  const options: Options = { base: null, repo: defaultRepoRoot, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (isHelpFlag(arg)) return 'help';
    assertKnownFlag(arg, KNOWN_FLAGS);
    if (arg === '--base') {
      const taken = takeValue(argv, i);
      options.base = taken.value;
      i = taken.index;
    } else if (arg === '--repo') {
      const taken = takeValue(argv, i);
      options.repo = resolve(taken.value);
      i = taken.index;
    } else if (arg === '--json') {
      options.json = true;
    }
  }
  return options;
}

/**
 * Resolve the revision to compare against.
 *
 * Returns `null` rather than a fallback when the merge base cannot be computed — a guard
 * that silently compares against the wrong revision is worse than one that says it could
 * not determine the answer.
 */
function resolveBase(explicit: string | null, repoRoot: string): string | null {
  if (explicit) return explicit;
  for (const candidate of ['origin/main', 'main']) {
    try {
      const out = execFileSync('git', ['merge-base', candidate, 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: cleanGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const oid = out.trim();
      if (oid) return oid;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The three genuinely different answers to "how much does this baseline tolerate here?".
 *
 * `absent` and `error` were originally collapsed into a single `null`, and the caller then
 * dropped any baseline that was null on BOTH sides as "not in the tree yet". That silently
 * un-watched every misconfigured registry row: two of the seven baselines had the wrong
 * shape recorded, both threw on every read, and the guard reported a clean pass over the
 * remaining five without ever mentioning them. Keeping the cases apart is what makes a
 * broken row loud instead of invisible.
 */
type Weighing =
  | { kind: 'weight'; value: number }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

function weighAt(revision: string | null, path: string, repoRoot: string): Weighing {
  let text: string;
  try {
    if (revision === null) {
      const abs = resolve(repoRoot, path);
      if (!existsSync(abs)) return { kind: 'absent' };
      text = readFileSync(abs, 'utf8');
    } else {
      text = readGitTextAtRevision({ cwd: repoRoot, revision, path });
    }
  } catch (error) {
    // A path missing at a revision is genuinely absent there; anything else is a real
    // read failure and must stay distinguishable from it.
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|exists on disk, but not in|path .* does not exist/i.test(message)) {
      return { kind: 'absent' };
    }
    return { kind: 'error', message };
  }

  const entry = BASELINE_REGISTRY.find((b) => b.path === path);
  if (!entry) return { kind: 'error', message: `${path} is not in BASELINE_REGISTRY` };
  try {
    return { kind: 'weight', value: weighBaseline(entry.shape, JSON.parse(text)) };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function main(): number {
  let options: Options | 'help';
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliArgError) {
      console.error(`FAIL(usage): ${error.message}`);
      return EXIT_INCONCLUSIVE;
    }
    throw error;
  }

  if (options === 'help') {
    console.log(
      'Usage: baseline-growth-guard.ts [--base <rev>] [--json]\n\n' +
        'Refuses any increase in the tolerated-debt weight of a committed baseline file.\n' +
        'Exit 0 = all baselines shrank or held, 1 = a baseline grew, 2 = inconclusive.',
    );
    return EXIT_PASS;
  }

  const repoRoot = options.repo;
  const base = resolveBase(options.base, repoRoot);
  if (base === null) {
    console.error(
      'FAIL(inconclusive): could not resolve a merge base against origin/main or main, so ' +
        'baseline growth cannot be ruled out. Fetch the base branch and re-run, or pass ' +
        '--base <rev> explicitly.',
    );
    return EXIT_INCONCLUSIVE;
  }

  const shapeErrors: string[] = [];
  const comparable: WeighedBaseline[] = [];

  for (const entry of BASELINE_REGISTRY) {
    const atBase = weighAt(base, entry.path, repoRoot);
    const atHead = weighAt(null, entry.path, repoRoot);
    if (
      entry.initialWeight !== undefined
      && (
        !Number.isInteger(entry.initialWeight)
        || entry.initialWeight < 0
      )
    ) {
      shapeErrors.push(
        `${entry.path} (registry): initialWeight must be a non-negative integer`,
      );
    }

    // A registry row that cannot be weighed is a BROKEN GUARD, not a clean baseline. It is
    // reported by path and message so it gets fixed, never dropped.
    for (const [side, w] of [['base', atBase], ['candidate', atHead]] as const) {
      if (w.kind === 'error') {
        shapeErrors.push(`${entry.path} (${side}): ${w.message}`);
      }
    }

    // Absent on BOTH sides means the file does not exist at either revision — a branch that
    // predates it. That is genuinely nothing to compare, and is the only case dropped.
    if (atBase.kind === 'absent' && atHead.kind === 'absent') continue;

    comparable.push({
      id: entry.id,
      path: entry.path,
      base:
        atBase.kind === 'weight'
          ? atBase.value
          : (
              atBase.kind === 'absent'
              && atHead.kind === 'weight'
              && entry.initialWeight !== undefined
            )
            ? entry.initialWeight
            : null,
      head: atHead.kind === 'weight' ? atHead.value : null,
    });
  }

  if (shapeErrors.length > 0) {
    console.error(
      `FAIL(inconclusive): ${shapeErrors.length} registered baseline(s) could not be weighed. ` +
        'A baseline this guard cannot read is unwatched, not clean — fix the shape in ' +
        'scripts/lib/baseline-weight.ts:\n  ' +
        shapeErrors.join('\n  '),
    );
    return EXIT_INCONCLUSIVE;
  }

  if (comparable.length === 0) {
    console.error(
      `FAIL(inconclusive): none of the ${BASELINE_REGISTRY.length} registered baselines could ` +
        'be read at either revision. A scan that examined nothing is not a pass.',
    );
    return EXIT_INCONCLUSIVE;
  }

  const findings: BaselineFinding[] = compareWeights(comparable);

  if (options.json) {
    console.log(JSON.stringify({ base, examined: comparable.length, findings }, null, 2));
  }

  const grew = findings.filter((f) => !f.inconclusive);
  const unknown = findings.filter((f) => f.inconclusive);

  if (!options.json) {
    for (const f of grew) console.error(`FAIL(baseline-growth): ${f.message}`);
    for (const f of unknown) console.error(`INCONCLUSIVE: ${f.message}`);
  }

  if (grew.length > 0) {
    console.error(
      `\n${grew.length} baseline(s) grew against ${base}. Reproduce with:\n` +
        '  ./scripts/run-with-pinned-node.sh scripts/baseline-growth-guard.ts --json',
    );
    return EXIT_BLOCK;
  }
  if (unknown.length > 0) return EXIT_INCONCLUSIVE;

  if (!options.json) {
    console.log(`OK: ${comparable.length} baseline(s) held or shrank against ${base}.`);
  }
  return EXIT_PASS;
}

process.exit(main());
