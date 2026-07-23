/**
 * Argument-parsing primitives shared by `scripts/*.ts` CLIs.
 *
 * WHY THIS EXISTS, and why it is primitives rather than a parser. A duplication sweep
 * (2026-07-23) found **34 scripts each defining their own `parseArgs`** — the single
 * highest-signal duplication in the tree. They are not gratuitous copies: each CLI has a
 * genuinely different option set, so a single schema-driven parser would fit none of them
 * well and forcing one would be a worse outcome than the duplication.
 *
 * What they DO share is a handful of primitives, and one of those is where the bugs live.
 *
 * THE BUG THIS FIXES IS REAL AND WAS IN SHIPPED CODE. The `--flag VALUE` form is usually
 * written `args.x = argv[++i]`, which silently accepts two wrong inputs:
 *
 *   `--base`            -> value is `undefined`; the flag is silently ignored
 *   `--base --json`     -> value is `"--json"`; the NEXT FLAG is consumed as the value
 *
 * Measured against `scripts/drift-classify.ts` before this change: `parseArgs(['--base'])`
 * returned no `base` at all, and `parseArgs(['--base','--json'])` returned
 * `base: "--json"` — which would then have been handed to git as a ref. Some scripts
 * (`design-system-hygiene-guard.ts`) already guard against this by hand; most do not.
 *
 * `takeValue` makes the correct behaviour the easy one. Adopt incrementally: no existing
 * script is required to migrate, and `tests/scripts/cli-args.test.ts` stops the
 * hand-rolled count from GROWING without forcing a 34-file rewrite.
 */

/** A CLI argument-parsing fault, distinguishable from an IO or logic error by callers. */
export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

/** Does this token look like a flag rather than a value? */
export function isFlagToken(token: string | undefined): boolean {
  return typeof token === 'string' && token.startsWith('-') && token !== '-';
}

/** `--help` / `-h`, the one spelling every script in this tree agrees on. */
export function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}

export interface TakenValue {
  value: string;
  /** Index of the consumed value — the caller's loop should continue from here. */
  index: number;
}

/**
 * Read the value belonging to `argv[index]`, refusing the two silent-corruption cases.
 *
 * Throws rather than returning a sentinel: a missing option value is a usage error the
 * operator must see, and every alternative (undefined, empty string, the next flag) is a
 * value some downstream call would happily accept and then misbehave on.
 *
 * @param argv  full argument vector
 * @param index index OF THE FLAG, not of the value
 */
export function takeValue(argv: readonly string[], index: number, flag = argv[index]): TakenValue {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new CliArgError(`${flag} requires a value, but none was given`);
  }
  if (isFlagToken(value)) {
    throw new CliArgError(
      `${flag} requires a value, but the next argument is another flag (${value}) — ` +
        'the value was probably omitted',
    );
  }
  return { value, index: index + 1 };
}

/**
 * Same, for options whose value must be a number.
 *
 * `Number('')` is 0 and `Number('abc')` is NaN; both would flow onward as a plausible-looking
 * bound. Rejected here so the failure names the flag instead of surfacing later as an
 * inexplicable comparison.
 */
export function takeNumber(argv: readonly string[], index: number, flag = argv[index]): { value: number; index: number } {
  const taken = takeValue(argv, index, flag);
  // The emptiness check must come FIRST: `Number('')` and `Number('   ')` are both 0, which
  // IS finite, so a Number.isFinite guard alone lets an empty value through as a
  // plausible-looking zero. Caught by this module's own test — the implementation was wrong
  // and the test was right.
  if (taken.value.trim() === '') {
    throw new CliArgError(`${flag} requires a number, got an empty value`);
  }
  const value = Number(taken.value);
  if (!Number.isFinite(value)) {
    throw new CliArgError(`${flag} requires a number, got "${taken.value}"`);
  }
  return { value, index: taken.index };
}

/**
 * Reject an unrecognised flag, listing what was accepted.
 *
 * Silently ignoring an unknown flag is how a typo'd `--staged` becomes a full-tree scan
 * that reports success — the operator asked for one thing and was given another, with no
 * signal that it happened.
 */
export function assertKnownFlag(arg: string, known: readonly string[]): void {
  if (!isFlagToken(arg)) return;
  if (known.includes(arg)) return;
  throw new CliArgError(`Unknown argument: ${arg} (known flags: ${[...known].sort().join(', ')})`);
}
