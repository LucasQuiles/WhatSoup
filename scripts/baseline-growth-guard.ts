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
 * WHICH REVISIONS. The candidate defaults to the WORKING TREE so a local run catches growth
 * in uncommitted edits. `--candidate <rev>` pins the exact object weighed instead, and CI
 * passes the run's own SHA: a guard that weighs "whatever is checked out" cannot prove WHICH
 * commit it cleared, and its verdict is not reproducible after the checkout moves. When a
 * candidate is pinned, the base/candidate pair is also checked for relations that cannot
 * express growth at all — see `baseRelationError`.
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
  GROWTH_WAIVERS_PATH,
  type GrowthWaiver,
  type WeighedBaseline,
  applyWaivers,
  baselineIdentities,
  compareWeights,
  parseWaiverDocument,
  weighBaseline,
} from './lib/baseline-weight.ts';
import { CliArgError, assertKnownFlag, isHelpFlag, takeValue } from './lib/cli-args.ts';
import { cleanGitEnv } from './lib/guard-core.ts';
import { readGitTextAtRevision } from './lib/semantic-quality/git-tree.ts';

const EXIT_PASS = 0;
const EXIT_BLOCK = 1;
const EXIT_INCONCLUSIVE = 2;

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN_FLAGS = ['--base', '--candidate', '--repo', '--json', '--help', '-h'] as const;

/**
 * GitHub reports an all-zero OID for "there is no such commit" — the `before` of a branch
 * creation, and of the first push to a new ref. It is a sentinel, not a revision, and
 * resolving it always fails. Treated as "no explicit base was given" so the guard falls
 * back to merge-base inference instead of reporting INCONCLUSIVE on a legitimate push.
 */
const NULL_OID = /^0{40}$/;

interface Options {
  base: string | null;
  /**
   * The revision to weigh as the candidate. `null` means the WORKING TREE, which stays the
   * default so local runs keep catching growth in uncommitted edits — a pre-push gate that
   * only weighed HEAD would pass a working tree that is about to be committed and pushed.
   * Passing an explicit revision is what makes a CI run reproducible: it pins the exact
   * object weighed instead of trusting that the checkout happens to be the intended commit.
   */
  candidate: string | null;
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
  const options: Options = { base: null, candidate: null, repo: defaultRepoRoot, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (isHelpFlag(arg)) return 'help';
    assertKnownFlag(arg, KNOWN_FLAGS);
    if (arg === '--base') {
      const taken = takeValue(argv, i);
      options.base = NULL_OID.test(taken.value) ? null : taken.value;
      i = taken.index;
    } else if (arg === '--candidate') {
      const taken = takeValue(argv, i);
      options.candidate = taken.value;
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
function resolveBase(
  explicit: string | null,
  repoRoot: string,
  candidateRevision: string,
): string | null {
  if (explicit) return explicit;
  for (const baseRef of ['origin/main', 'main']) {
    try {
      const out = execFileSync('git', ['merge-base', baseRef, candidateRevision], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: cleanGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const oid = out.trim();
      if (oid) return oid;
    } catch {
      // try the next base ref
    }
  }
  return null;
}

/**
 * Resolve a user-supplied revision to a concrete commit OID.
 *
 * Returns `null` when it does not resolve. Reporting an unresolvable revision as
 * INCONCLUSIVE is the point: a guard handed a typo'd or unfetched ref must say it could not
 * look, never silently weigh something else.
 */
function resolveCommit(revision: string, repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const oid = out.trim();
    return oid === '' ? null : oid;
  } catch {
    return null;
  }
}

/**
 * Reject base/candidate pairs that cannot express growth.
 *
 * Two failures are silent-green today and both are reachable from CI wiring:
 *   - base === candidate: comparing a revision with itself always weighs equal, so the
 *     guard reports a clean pass having proven nothing. A merge_group or re-run that
 *     resolves both sides to the same OID would be permanently, invisibly vacuous.
 *   - base not an ancestor of candidate: the weights are then from divergent histories, so
 *     an "increase" may be someone else's work and a "decrease" may hide real growth.
 *
 * Only checkable when the candidate is an explicit revision; a working-tree candidate has
 * no OID to relate, and its base is a merge base by construction.
 */
function baseRelationError(baseOid: string, candidateOid: string, repoRoot: string): string | null {
  if (baseOid === candidateOid) {
    return `base and candidate are the same commit (${baseOid}); comparing a revision with `
      + 'itself cannot detect growth';
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', baseOid, candidateOid], {
      cwd: repoRoot,
      env: cleanGitEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return null;
  } catch {
    return `base ${baseOid} is not an ancestor of candidate ${candidateOid}, so their `
      + 'baseline weights come from divergent histories and a difference between them is '
      + 'not evidence of growth in this change';
  }
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
  | { kind: 'weight'; value: number; identities?: string[] }
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
    const document: unknown = JSON.parse(text);
    return {
      kind: 'weight',
      value: weighBaseline(entry.shape, document),
      identities: baselineIdentities(entry.shape, document),
    };
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
      'Usage: baseline-growth-guard.ts [--base <rev>] [--candidate <rev>] [--json]\n\n' +
        'Without --candidate the WORKING TREE is weighed, so uncommitted growth is caught.\n' +
        'Pass --candidate <rev> to pin the exact object weighed (CI passes the run SHA).\n' +
        'Refuses any increase in the tolerated-debt weight of a committed baseline file.\n' +
        'Exit 0 = all baselines shrank or held, 1 = a baseline grew, 2 = inconclusive.',
    );
    return EXIT_PASS;
  }

  const repoRoot = options.repo;

  // Resolve the candidate FIRST: the base is a merge base against it, so an unresolvable
  // candidate must not be reported as a base-resolution failure.
  let candidateOid: string | null = null;
  if (options.candidate !== null) {
    candidateOid = resolveCommit(options.candidate, repoRoot);
    if (candidateOid === null) {
      console.error(
        `FAIL(inconclusive): candidate revision ${options.candidate} could not be resolved to a ` +
          'commit, so baseline growth cannot be ruled out. Fetch it and re-run (CI needs ' +
          'fetch-depth: 0), or omit --candidate to weigh the working tree.',
      );
      return EXIT_INCONCLUSIVE;
    }
  }

  const base = resolveBase(options.base, repoRoot, candidateOid ?? 'HEAD');
  if (base === null) {
    console.error(
      'FAIL(inconclusive): could not resolve a merge base against origin/main or main, so ' +
        'baseline growth cannot be ruled out. Fetch the base branch and re-run, or pass ' +
        '--base <rev> explicitly.',
    );
    return EXIT_INCONCLUSIVE;
  }

  // Only meaningful for an explicit candidate — see baseRelationError.
  if (candidateOid !== null) {
    const baseOid = resolveCommit(base, repoRoot);
    if (baseOid === null) {
      console.error(
        `FAIL(inconclusive): base revision ${base} could not be resolved to a commit, so ` +
          'baseline growth cannot be ruled out.',
      );
      return EXIT_INCONCLUSIVE;
    }
    const relationError = baseRelationError(baseOid, candidateOid, repoRoot);
    if (relationError !== null) {
      console.error(`FAIL(inconclusive): ${relationError}.`);
      return EXIT_INCONCLUSIVE;
    }
  }

  const shapeErrors: string[] = [];
  const comparable: WeighedBaseline[] = [];

  for (const entry of BASELINE_REGISTRY) {
    const atBase = weighAt(base, entry.path, repoRoot);
    const atHead = weighAt(candidateOid, entry.path, repoRoot);
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
      baseIdentities:
        atBase.kind === 'weight' ? atBase.identities : undefined,
      headIdentities:
        atHead.kind === 'weight' ? atHead.identities : undefined,
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

  // Growth waivers are read from the MERGE BASE only. A candidate cannot author its own
  // authorization: the waiver must already be on the base branch, i.e. it landed through
  // its own reviewed PR. Absent file = no waivers. Malformed file = INCONCLUSIVE — an
  // unreadable authorization must not fail open in either direction.
  let waivers: GrowthWaiver[] = [];
  try {
    const waiverText = readGitTextAtRevision({ cwd: repoRoot, revision: base, path: GROWTH_WAIVERS_PATH });
    waivers = parseWaiverDocument(JSON.parse(waiverText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/does not exist|exists on disk, but not in|path .* does not exist/i.test(message)) {
      console.error(
        `FAIL(inconclusive): ${GROWTH_WAIVERS_PATH} at the merge base could not be read or ` +
          `validated, so waiver authority is unknown: ${message}`,
      );
      return EXIT_INCONCLUSIVE;
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const growthFindings = findings.filter((f) => !f.inconclusive);
  const unknown = findings.filter((f) => f.inconclusive);
  const { blocking: grew, waived } = applyWaivers(growthFindings, waivers, todayIso);

  if (options.json) {
    console.log(JSON.stringify({
      base,
      // The exact object weighed, so a receipt names what was measured rather than implying
      // it. 'working-tree' is reported literally — it is not reproducible from a SHA.
      candidate: candidateOid ?? 'working-tree',
      examined: comparable.length,
      findings: [...grew, ...unknown],
      waived,
    }, null, 2));
  }

  if (!options.json) {
    for (const f of grew) console.error(`FAIL(baseline-growth): ${f.message}`);
    for (const f of waived) {
      console.error(
        `WAIVED(baseline-growth): ${f.path} weight ${f.base} -> ${f.head} authorized up to ` +
          `${f.waiver.maxWeight} by ${f.waiver.issue} until ${f.waiver.expiresAt} — ${f.waiver.reason}`,
      );
    }
    for (const f of unknown) console.error(`INCONCLUSIVE: ${f.message}`);
  }

  if (grew.length > 0) {
    console.error(
      `\n${grew.length} baseline(s) expanded or replaced debt against ${base}. Reproduce with:\n` +
        '  ./scripts/run-with-pinned-node.sh scripts/baseline-growth-guard.ts --json' +
        // Name the exact revisions when they were pinned. A CI failure reproduced against a
        // moving HEAD is a different measurement than the one that failed.
        (candidateOid !== null ? ` --base ${base} --candidate ${candidateOid}` : ''),
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
