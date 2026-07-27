/**
 * How much debt does a baseline file tolerate? — the measurement behind "baselines may
 * only shrink".
 *
 * WHY THIS EXISTS. This repo has 7 committed baseline files enumerating accepted debt, and
 * every guard that reads one compares CURRENT CODE against it. That direction catches new
 * violations in the code. It cannot catch the opposite move: editing the baseline upward so
 * the violation becomes accepted. `check-shadow-baseline.mjs --update` and
 * `check-design-burndown.mjs --update` rewrite their baselines wholesale, so
 * "add a violation, re-run --update, commit" passes every gate in the repo today.
 *
 * Verified on origin/main 084908d91: 7 baseline files, each read by 1-22 scripts/tests,
 * and ZERO assertions in tests/ or scripts/ that any baseline cannot grow.
 *
 * DESIGN. This module is PURE — no fs, no git, no process — so the weighing rules are
 * testable directly and the CLI stays a thin shell around them. Same split as
 * `drift-classifier.ts`.
 *
 * The weight is an ORDINAL DEBT SCORE, not a count. It only has to be monotone in
 * "how much are we tolerating", because the only operation performed on it is a
 * comparison between two revisions of the same file. Do not read a weight as an entry
 * count or print it as one.
 */

/** The five distinct document shapes the 7 baselines actually use. */
export type BaselineShape = 'entry-array' | 'single-array-object' | 'count-map' | 'fitness-rules';

export interface RegisteredBaseline {
  /** Stable id used in error messages and in the registry-coverage test. */
  id: string;
  /** Repo-relative path. */
  path: string;
  shape: BaselineShape;
  /**
   * Exact audited weight allowed when this path does not exist at the base
   * revision. Once the path lands, ordinary base-vs-head comparison takes over.
   */
  initialWeight?: number;
  /** Why this file is allowed to exist at all — quoted back when it grows. */
  tolerates: string;
}

/**
 * Every committed baseline in the tree.
 *
 * SSOT: `tests/scripts/baseline-growth-guard.test.ts` asserts this registry against a live
 * scan of the working tree, so a newly-added baseline file that nobody registers here fails
 * the build rather than going silently unwatched. That check is what stops this guard from
 * quietly narrowing to a subset over time.
 */
export const BASELINE_REGISTRY: readonly RegisteredBaseline[] = [
  {
    id: 'fitness',
    path: '.claude/fitness/baseline.json',
    shape: 'fitness-rules',
    tolerates: 'files exceeding architectural size/shape ceilings',
  },
  {
    id: 'boundary',
    path: '.claude/fitness/boundary-baseline.json',
    shape: 'entry-array',
    tolerates: 'layer-boundary violations (core importing runtimes, etc.)',
  },
  {
    id: 'transport-patterns',
    path: '.claude/fitness/transport-patterns-baseline.json',
    shape: 'entry-array',
    tolerates: 'transport-hygiene pattern violations',
  },
  {
    id: 'test-integrity',
    path: '.claude/test-integrity/baseline.json',
    shape: 'single-array-object',
    tolerates: 'known test-integrity findings (vacuous assertions, masked failures)',
  },
  {
    id: 'lint-shadow',
    path: 'console/lint-shadow-baseline.json',
    shape: 'count-map',
    tolerates: 'per-rule ESLint shadow warnings in console/',
  },
  {
    id: 'design-burndown',
    path: 'console/design-burndown-baseline.json',
    shape: 'count-map',
    tolerates: 'per-category design-token violations in console/',
  },
  {
    id: 'service-units',
    path: 'scripts/service-units-baseline.json',
    shape: 'single-array-object',
    tolerates: 'grandfathered service-unit guard exceptions',
  },
  {
    id: 'catch-justification',
    path: 'eslint-rules/catch-ratchet-baseline.json',
    shape: 'entry-array',
    initialWeight: 127,
    tolerates: 'inherited catch blocks that swallow failures without meaningful handling',
  },
];

/** Raised when a baseline cannot be weighed. Callers MUST map this to INCONCLUSIVE. */
export class BaselineShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineShapeError';
  }
}

function sumNumericValues(record: unknown, where: string): number {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new BaselineShapeError(`${where}: expected an object of numeric counts`);
  }
  let total = 0;
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BaselineShapeError(`${where}: non-numeric count for key "${key}"`);
    }
    total += value;
  }
  return total;
}

/**
 * Weigh one baseline document.
 *
 * THROWS on any shape it does not recognise. Returning 0 for a malformed document would
 * make "the file became unparseable" indistinguishable from "the file tolerates nothing" —
 * and since shrinking is always allowed, a 0 would sail through as an improvement. That is
 * the precise false-green this guard exists to prevent, so the failure is loud.
 */
export function weighBaseline(shape: BaselineShape, doc: unknown): number {
  switch (shape) {
    case 'entry-array': {
      if (!Array.isArray(doc)) {
        throw new BaselineShapeError('expected an array of baseline entries');
      }
      return doc.length;
    }

    case 'single-array-object': {
      // An object wrapping exactly one array of tolerated entries, under whatever key that
      // file happens to use (`findings` in test-integrity, `grandfathered` in
      // service-units). Keyed by SHAPE rather than by name so a rename does not silently
      // drop the file to a weight of 0; ambiguity throws rather than picking one.
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new BaselineShapeError('expected an object wrapping a single array');
      }
      const arrays = Object.entries(doc as Record<string, unknown>).filter(([, v]) =>
        Array.isArray(v),
      );
      if (arrays.length === 0) {
        throw new BaselineShapeError('expected an object containing a "findings"-style array');
      }
      if (arrays.length > 1) {
        throw new BaselineShapeError(
          `ambiguous: ${arrays.length} array properties (${arrays.map(([k]) => k).join(', ')}); ` +
            'cannot tell which one holds the tolerated entries',
        );
      }
      return (arrays[0]![1] as unknown[]).length;
    }

    case 'count-map': {
      // Sum the counts, never the number of keys: raising one rule's ceiling from 1 to 9
      // tolerates 8 more violations without changing the key count.
      if (doc === null || typeof doc !== 'object') {
        throw new BaselineShapeError('expected an object with a "rules" or "categories" map');
      }
      const record = doc as Record<string, unknown>;
      const map = record.rules ?? record.categories;
      if (map === undefined) {
        throw new BaselineShapeError('expected a "rules" or "categories" map');
      }
      return sumNumericValues(map, 'count-map');
    }

    case 'fitness-rules': {
      // Weight = one point per exemption PLUS the sum of numeric ceilings. The ceiling term
      // matters: raising a file's maxLines tolerates more debt while the exemption count is
      // unchanged, so a count-only weight would call that no change.
      const rules = (doc as { rules?: unknown } | null)?.rules;
      if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) {
        throw new BaselineShapeError('expected an object with a "rules" map');
      }
      let total = 0;
      for (const [ruleId, entry] of Object.entries(rules as Record<string, unknown>)) {
        // Two rule shapes live in this one file: `arch.file-size` carries per-file
        // `measurements`, while every `arch.ssot-*` / `arch.ring-boundaries` rule carries a
        // bare `violationCount`. Handling only the first silently weighed 6 of the 7 rules
        // as an error, which the caller then dropped entirely.
        const measurements = (entry as { measurements?: unknown } | null)?.measurements;
        const violationCount = (entry as { violationCount?: unknown } | null)?.violationCount;

        if (Array.isArray(measurements)) {
          for (const m of measurements) {
            total += 1;
            const ceiling = (m as { maxLines?: unknown } | null)?.maxLines;
            if (typeof ceiling === 'number' && Number.isFinite(ceiling)) total += ceiling;
          }
        } else if (typeof violationCount === 'number' && Number.isFinite(violationCount)) {
          total += violationCount;
        } else {
          throw new BaselineShapeError(
            `rule "${ruleId}": expected a "measurements" array or a numeric "violationCount"`,
          );
        }
      }
      return total;
    }

    default: {
      const exhaustive: never = shape;
      throw new BaselineShapeError(`unknown baseline shape: ${String(exhaustive)}`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Return the semantic multiset compared for array baselines.
 *
 * Count alone cannot distinguish a true hold from replacing one tolerated
 * violation with another. Canonical JSON keeps object key reordering inert
 * while preserving duplicate entries as duplicate identities.
 */
export function baselineIdentities(
  shape: BaselineShape,
  doc: unknown,
): string[] | undefined {
  if (shape !== 'entry-array') return undefined;
  if (!Array.isArray(doc)) {
    throw new BaselineShapeError('expected an array of baseline entries');
  }
  return doc.map(canonicalJson);
}

export interface WeighedBaseline {
  id: string;
  path: string;
  /** Weight at the merge base. `null` means COULD NOT LOOK — never conflate with 0. */
  base: number | null;
  /** Weight in the candidate. `null` means the file could not be weighed there. */
  head: number | null;
  /** Canonical entry multiset when the baseline shape has semantic identities. */
  baseIdentities?: readonly string[];
  /** Candidate entry multiset; every occurrence must exist in baseIdentities. */
  headIdentities?: readonly string[];
}

export interface BaselineFinding {
  id: string;
  path: string;
  base: number | null;
  head: number | null;
  /** head - base when both are known; `null` otherwise. */
  delta: number | null;
  /** True when the comparison could not be made at all. Report, never pass. */
  inconclusive: boolean;
  message: string;
}

/**
 * Compare weights and report every baseline that grew or could not be compared.
 *
 * Shrinking and staying flat are both fine — the ratchet only ever tightens. An
 * unreadable side is reported as INCONCLUSIVE rather than as growth (a false alarm) or as
 * clean (a false green).
 */
export function compareWeights(weighed: readonly WeighedBaseline[]): BaselineFinding[] {
  const findings: BaselineFinding[] = [];
  for (const b of weighed) {
    if (b.base === null || b.head === null) {
      const side = b.base === null ? 'base' : 'candidate';
      findings.push({
        ...b,
        delta: null,
        inconclusive: true,
        message:
          `${b.path}: could not weigh the ${side} revision, so growth cannot be ruled out. ` +
          'This is INCONCLUSIVE, not a pass.',
      });
      continue;
    }
    if (b.baseIdentities !== undefined && b.headIdentities !== undefined) {
      const remaining = new Map<string, number>();
      for (const identity of b.baseIdentities) {
        remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
      }
      const introduced: string[] = [];
      for (const identity of b.headIdentities) {
        const count = remaining.get(identity) ?? 0;
        if (count === 0) {
          introduced.push(identity);
        } else {
          remaining.set(identity, count - 1);
        }
      }
      if (introduced.length > 0) {
        findings.push({
          ...b,
          delta: b.head - b.base,
          inconclusive: false,
          message:
            `${b.path}: tolerated-debt weight changed ${b.base} -> ${b.head}; candidate ` +
            `introduced ${introduced.length} baseline identity ` +
            `occurrence(s) not present in the base multiset. A baseline may only shrink; ` +
            'candidate identities must be a multiset subset of the base.',
        });
        continue;
      }
    }
    if (b.head > b.base) {
      findings.push({
        ...b,
        delta: b.head - b.base,
        inconclusive: false,
        message:
          `${b.path}: tolerated-debt weight rose ${b.base} -> ${b.head} (+${b.head - b.base}). ` +
          'A baseline may only shrink. Fix the underlying violation instead of widening the ' +
          'baseline, or land the widening as its own reviewed change that says why.',
      });
    }
  }
  return findings;
}
