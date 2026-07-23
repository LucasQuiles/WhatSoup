/**
 * CLI argument primitives, and the ratchet that stops hand-rolled parsers multiplying.
 *
 * The tests that matter here are the two silent-corruption cases `takeValue` exists to
 * refuse. Both were present in shipped code (`scripts/drift-classify.ts`) when this helper
 * was written, and neither produced any error at the time:
 *
 *   parseArgs(['--base'])          -> no `base` at all, flag silently dropped
 *   parseArgs(['--base','--json']) -> base === '--json', the next FLAG consumed as a value
 *
 * The second is the dangerous one: that string would have been handed to git as a ref.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CliArgError,
  assertKnownFlag,
  isFlagToken,
  isHelpFlag,
  takeNumber,
  takeValue,
} from '../../scripts/lib/cli-args.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('takeValue — refuses the two silent-corruption cases', () => {
  it('reads a normal value', () => {
    expect(takeValue(['--base', 'abc123'], 0)).toEqual({ value: 'abc123', index: 1 });
  });

  it('THROWS when the value is missing entirely', () => {
    // Was: silently undefined, flag dropped with no signal.
    expect(() => takeValue(['--base'], 0)).toThrow(/--base requires a value/);
    expect(() => takeValue(['--base'], 0)).toThrow(CliArgError);
  });

  it('THROWS when the next argument is another flag', () => {
    // Was: base === '--json', which would then be used as a git ref. This is the case
    // that actually corrupts rather than merely dropping.
    expect(() => takeValue(['--base', '--json'], 0)).toThrow(/another flag \(--json\)/);
  });

  it('accepts a bare "-" as a value — it is stdin, not a flag', () => {
    // `guard:branch-protection-drift` pipes with `--observed -`; treating that as a flag
    // would break a real existing call site.
    expect(takeValue(['--observed', '-'], 0).value).toBe('-');
  });

  it('accepts a negative-number-looking value only when it is not flag-shaped', () => {
    expect(isFlagToken('-5')).toBe(true); // conservative: reject, force explicit handling
    expect(isFlagToken('-')).toBe(false);
    expect(isFlagToken('abc')).toBe(false);
    expect(isFlagToken(undefined)).toBe(false);
  });

  it('names the flag in the error even when the caller overrides the label', () => {
    expect(() => takeValue(['-b'], 0, '--base')).toThrow(/--base requires a value/);
  });
});

describe('takeNumber', () => {
  it('parses a real number', () => {
    expect(takeNumber(['--port', '8080'], 0)).toEqual({ value: 8080, index: 1 });
  });

  it('THROWS on a non-numeric value rather than yielding NaN', () => {
    // Number('abc') is NaN and would flow onward as a plausible-looking bound.
    expect(() => takeNumber(['--port', 'abc'], 0)).toThrow(/requires a number/);
  });

  it('THROWS on an empty value rather than yielding 0', () => {
    // Number('') === 0 — a silently valid-looking port.
    expect(() => takeNumber(['--port', ''], 0)).toThrow(/requires a number/);
  });

  it('inherits the missing-value and next-flag refusals', () => {
    expect(() => takeNumber(['--port'], 0)).toThrow(/requires a value/);
    expect(() => takeNumber(['--port', '--json'], 0)).toThrow(/another flag/);
  });
});

describe('assertKnownFlag', () => {
  it('accepts a known flag and ignores positionals', () => {
    expect(() => assertKnownFlag('--json', ['--json', '--help'])).not.toThrow();
    expect(() => assertKnownFlag('some/path.ts', ['--json'])).not.toThrow();
  });

  it('THROWS on an unknown flag and lists what was accepted', () => {
    // A silently-ignored typo turns "--staged" into a full-tree scan reporting success.
    expect(() => assertKnownFlag('--stagd', ['--json', '--staged'])).toThrow(/Unknown argument: --stagd/);
    expect(() => assertKnownFlag('--stagd', ['--json', '--staged'])).toThrow(/--json, --staged/);
  });
});

describe('isHelpFlag', () => {
  it('matches both spellings this tree uses and nothing else', () => {
    expect(isHelpFlag('--help')).toBe(true);
    expect(isHelpFlag('-h')).toBe(true);
    expect(isHelpFlag('--helpful')).toBe(false);
  });
});

/**
 * Warn-level ratchet on hand-rolled parsers.
 *
 * 34 scripts define their own `parseArgs` or `parseArguments`. Rewriting all of them is a large, low-value,
 * high-blast-radius change across many lanes, so this does NOT demand that. It pins the
 * count so the number cannot grow: existing debt is tolerated, new debt is blocked — the
 * same shape as the `arch.ssot-*` count ratchets.
 *
 * Lowering the baseline as scripts migrate is expected and the assertion says so.
 */
describe('hand-rolled parseArgs ratchet', () => {
  const HAND_ROLLED_PARSEARGS_BASELINE = 34;

  const scriptsDefiningParseArgs = (): string[] =>
    execFileSync('git', ['grep', '-E', '-l', 'function parse(Args|Arguments)', 'HEAD', '--', 'scripts/*.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);

  it('the scan is not vacuous — it really finds hand-rolled parsers', () => {
    // Without this, a git-grep that returned nothing would make the ratchet pass trivially.
    expect(scriptsDefiningParseArgs().length).toBeGreaterThan(10);
  });

  it('the number of hand-rolled parsers does not grow', () => {
    const found = scriptsDefiningParseArgs();
    expect(
      found.length,
      found.length > HAND_ROLLED_PARSEARGS_BASELINE
        ? `${found.length - HAND_ROLLED_PARSEARGS_BASELINE} new hand-rolled parseArgs since the baseline. ` +
          `Use the primitives in scripts/lib/cli-args.ts instead — takeValue() refuses the ` +
          `missing-value and next-flag-as-value cases that hand-rolled 'argv[++i]' accepts silently.`
        : `Baseline is stale: ${found.length} found, baseline ${HAND_ROLLED_PARSEARGS_BASELINE}. ` +
          `Scripts migrated — LOWER HAND_ROLLED_PARSEARGS_BASELINE to ${found.length} to lock in the gain.`,
    ).toBe(HAND_ROLLED_PARSEARGS_BASELINE);
  });
});
