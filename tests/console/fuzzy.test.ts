/**
 * @vitest-environment jsdom
 *
 * fuzzy.test.ts — pure subsequence matcher + scorer (showcase §17 ⌘K palette).
 *
 * Contract per the design spec:
 *   - subsequence match (case-insensitive)
 *   - empty query → { score: 0 } (match-all)
 *   - non-match → null
 *   - ranking rewards contiguous runs, word-starts, and earlier first matches
 */
import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from '../../console/src/lib/fuzzy';

describe('fuzzyMatch — empty query', () => {
  it('returns a neutral score for an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0 });
  });

  it('returns a neutral score for an empty query against empty text', () => {
    expect(fuzzyMatch('', '')).toEqual({ score: 0 });
  });
});

describe('fuzzyMatch — subsequence matching', () => {
  it('matches an exact subsequence', () => {
    expect(fuzzyMatch('abc', 'abc')).not.toBeNull();
  });

  it('matches a scattered subsequence', () => {
    expect(fuzzyMatch('abc', 'xaybzc')).not.toBeNull();
  });

  it('is case-insensitive (uppercase query, lowercase text)', () => {
    expect(fuzzyMatch('ABC', 'abc')).not.toBeNull();
  });

  it('is case-insensitive (mixed-case text)', () => {
    expect(fuzzyMatch('abc', 'AxeBeeCee')).not.toBeNull();
  });

  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull();
  });

  it('returns null when only a prefix of the query matches', () => {
    expect(fuzzyMatch('abc', 'ab')).toBeNull();
  });

  it('returns null when a middle char is missing from the text', () => {
    // 'b' is absent from 'axc' → no subsequence
    expect(fuzzyMatch('abc', 'axc')).toBeNull();
  });

  it('matches when every query char is present in order, even non-contiguously', () => {
    expect(fuzzyMatch('abc', 'aXbYc')).not.toBeNull();
  });

  it('returns null when the query has a char not in the text', () => {
    expect(fuzzyMatch('abcd', 'abc')).toBeNull();
  });

  it('matches a single-character query', () => {
    expect(fuzzyMatch('k', 'kitchen')).not.toBeNull();
  });

  it('matches an empty-text edge case (non-empty query must fail)', () => {
    expect(fuzzyMatch('a', '')).toBeNull();
  });
});

describe('fuzzyMatch — ranking', () => {
  it('scores a contiguous exact match higher than a scattered one', () => {
    const tight = fuzzyMatch('abc', 'abc')!;
    const scattered = fuzzyMatch('abc', 'xaybzc')!;
    expect(tight.score).toBeGreaterThan(scattered.score);
  });

  it('scores a word-start match higher than a mid-word match', () => {
    const wordStart = fuzzyMatch('k', 'kitchen')!;
    const midWord = fuzzyMatch('k', 'snack')!;
    expect(wordStart.score).toBeGreaterThan(midWord.score);
  });

  it('scores a prefix match higher than a suffix match for the same chars', () => {
    const prefix = fuzzyMatch('abc', 'abcdef')!;
    const suffix = fuzzyMatch('abc', 'xyzabc')!;
    expect(prefix.score).toBeGreaterThan(suffix.score);
  });

  it('prefers an earlier first match when the rest is equal', () => {
    const earlier = fuzzyMatch('a', 'alpha')!;
    const later = fuzzyMatch('a', 'xalpha')!;
    expect(earlier.score).toBeGreaterThan(later.score);
  });

  it('rewards a contiguous run with a higher score than two isolated hits', () => {
    const contiguous = fuzzyMatch('ab', 'ab')!;
    const isolated = fuzzyMatch('ab', 'aXb')!;
    expect(contiguous.score).toBeGreaterThan(isolated.score);
  });

  it('rewards word-start matches on common separators (-/_/whitespace/slash)', () => {
    // Word-start 'k' (after a space) outranks a mid-word 'k' (inside "bakery").
    const afterSpace = fuzzyMatch('k', 'foo kitchen')!;
    const midWord = fuzzyMatch('k', 'bakery')!;
    expect(afterSpace.score).toBeGreaterThan(midWord.score);
  });

  it('produces stable, deterministic scores (same input → same output)', () => {
    const a = fuzzyMatch('inbox', 'Inbox')!;
    const b = fuzzyMatch('inbox', 'Inbox')!;
    expect(a.score).toBe(b.score);
  });
});
