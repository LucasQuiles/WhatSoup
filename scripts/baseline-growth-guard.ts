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
import {
  ExactGitInputError,
  FULL_OID,
  UTF8,
  assertNoLegacyGrafts,
  gitBytes,
  readExactBlobs,
  readExactTreeEntries,
} from './lib/ci-control/git-input-core.ts';

const EXIT_PASS = 0;
const EXIT_BLOCK = 1;
const EXIT_INCONCLUSIVE = 2;
const MAX_GIT_IDENTITY_BYTES = 64 * 1024;

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN_FLAGS = ['--base', '--candidate', '--repo', '--json', '--help', '-h'] as const;

interface Options {
  base: string | null;
  candidate: string;
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
  const options: Options = { base: null, candidate: 'HEAD', repo: defaultRepoRoot, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (isHelpFlag(arg)) return 'help';
    assertKnownFlag(arg, KNOWN_FLAGS);
    if (arg === '--base') {
      const taken = takeValue(argv, i);
      options.base = taken.value;
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
function resolveCommit(revision: string, repoRoot: string): string | null {
  try {
    const out = UTF8.decode(
      gitBytes(
        repoRoot,
      ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
        'ci.input.revision-unavailable',
        MAX_GIT_IDENTITY_BYTES,
      ),
    );
    const oid = out.trim();
    return FULL_OID.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

function resolveBase(explicit: string | null, repoRoot: string, candidateOid: string): string | null {
  if (explicit) return resolveCommit(explicit, repoRoot);
  for (const baseRef of ['origin/main', 'main']) {
    try {
      const out = UTF8.decode(
        gitBytes(
          repoRoot,
          ['merge-base', baseRef, candidateOid],
          'ci.classification.merge-base-unavailable',
          MAX_GIT_IDENTITY_BYTES,
        ),
      );
      const oid = out.trim();
      if (oid) return oid;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function baseRelationError(baseOid: string, candidateOid: string, repoRoot: string): string | null {
  if (baseOid === candidateOid) {
    return 'base and candidate must differ; comparing a revision with itself cannot detect growth';
  }
  try {
    gitBytes(
      repoRoot,
      ['merge-base', '--is-ancestor', baseOid, candidateOid],
      'ci.classification.merge-base-unavailable',
      MAX_GIT_IDENTITY_BYTES,
    );
    return null;
  } catch {
    return `base ${baseOid} is not an ancestor of candidate ${candidateOid}`;
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
  | { kind: 'weight'; value: number }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function weighRevision(revision: string, repoRoot: string): ReadonlyMap<string, Weighing> {
  const paths = BASELINE_REGISTRY.map(({ path }) => path).sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
  const results = new Map<string, Weighing>();
  let entries: ReturnType<typeof readExactTreeEntries>['entries'];
  try {
    entries = readExactTreeEntries(repoRoot, { candidateOid: revision, paths }).entries;
  } catch (error) {
    const message = errorMessage(error);
    return new Map(paths.map((path) => [path, { kind: 'error', message }] as const));
  }

  const blobOids: string[] = [];
  for (const entry of entries) {
    if (entry.presence === 'absent') {
      results.set(entry.path, { kind: 'absent' });
      continue;
    }
    if (entry.mode !== '100644' || entry.objectType !== 'blob' || entry.objectOid === null) {
      results.set(entry.path, {
        kind: 'error',
        message: `${entry.path} must be a regular non-executable blob`,
      });
      continue;
    }
    blobOids.push(entry.objectOid);
  }

  let bytesByOid: ReadonlyMap<string, Uint8Array>;
  try {
    bytesByOid = new Map(
      readExactBlobs(repoRoot, blobOids).map(({ oid, bytes }) => [oid, bytes] as const),
    );
  } catch (error) {
    const message = errorMessage(error);
    for (const entry of entries) {
      if (!results.has(entry.path)) results.set(entry.path, { kind: 'error', message });
    }
    return results;
  }

  const registryByPath = new Map(BASELINE_REGISTRY.map((entry) => [entry.path, entry] as const));
  for (const entry of entries) {
    if (results.has(entry.path)) continue;
    const registryEntry = registryByPath.get(entry.path);
    const bytes = entry.objectOid === null ? undefined : bytesByOid.get(entry.objectOid);
    if (registryEntry === undefined || bytes === undefined) {
      results.set(entry.path, { kind: 'error', message: `${entry.path} has no exact blob bytes` });
      continue;
    }
    try {
      const text = UTF8.decode(bytes);
      results.set(entry.path, {
        kind: 'weight',
        value: weighBaseline(registryEntry.shape, JSON.parse(text)),
      });
    } catch (error) {
      results.set(entry.path, { kind: 'error', message: errorMessage(error) });
    }
  }
  return results;
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
        'Refuses any increase in the tolerated-debt weight of a committed baseline file.\n' +
        'Exit 0 = all baselines shrank or held, 1 = a baseline grew, 2 = inconclusive.',
    );
    return EXIT_PASS;
  }

  const repoRoot = options.repo;
  try {
    assertNoLegacyGrafts(repoRoot);
  } catch (error) {
    const code = error instanceof ExactGitInputError
      ? error.code
      : 'ci.input.git-control-unavailable';
    const remediation = code === 'ci.input.history-graft-present'
      ? 'Remove legacy Git graft metadata before retrying.'
      : 'Repair or select a trustworthy repository control path before retrying.';
    console.error(`FAIL(inconclusive): ${code}. ${remediation}`);
    return EXIT_INCONCLUSIVE;
  }
  const candidate = resolveCommit(options.candidate, repoRoot);
  if (candidate === null) {
    console.error(
      `FAIL(inconclusive): candidate revision ${options.candidate} could not be resolved to ` +
        'an exact commit, so baseline growth cannot be evaluated.',
    );
    return EXIT_INCONCLUSIVE;
  }
  const base = resolveBase(options.base, repoRoot, candidate);
  if (base === null) {
    console.error(
      'FAIL(inconclusive): could not resolve a merge base against origin/main or main, so ' +
        'baseline growth cannot be ruled out. Fetch the base branch and re-run, or pass ' +
        '--base <rev> explicitly.',
    );
    return EXIT_INCONCLUSIVE;
  }
  const relationError = baseRelationError(base, candidate, repoRoot);
  if (relationError !== null) {
    console.error(`FAIL(inconclusive): ${relationError}. Supply the exact trusted event base.`);
    return EXIT_INCONCLUSIVE;
  }

  const shapeErrors: string[] = [];
  const comparable: WeighedBaseline[] = [];
  const baseWeighings = weighRevision(base, repoRoot);
  const candidateWeighings = weighRevision(candidate, repoRoot);

  for (const entry of BASELINE_REGISTRY) {
    const atBase = baseWeighings.get(entry.path) ?? {
      kind: 'error' as const,
      message: `${entry.path} has no base result`,
    };
    const atHead = candidateWeighings.get(entry.path) ?? {
      kind: 'error' as const,
      message: `${entry.path} has no candidate result`,
    };

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
      base: atBase.kind === 'weight' ? atBase.value : null,
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
    console.log(JSON.stringify({ base, candidate, examined: comparable.length, findings }, null, 2));
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
        `  ./scripts/run-with-pinned-node.sh scripts/baseline-growth-guard.ts ` +
        `--base ${base} --candidate ${candidate} --json`,
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
