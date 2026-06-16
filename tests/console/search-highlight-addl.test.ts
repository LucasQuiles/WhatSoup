/**
 * Addl coverage for console/src/lib/search-highlight.ts.
 *
 * Existing tests in tests/console/search-highlight.test.ts cover:
 *   - blank query → unmatched
 *   - quoted phrases + bare terms
 *   - boolean operator filtering
 *
 * This file exercises the uncovered branches:
 *   s[5]/s[6]/s[7]  line 18-19  — phrase match path (phrasePattern.exec loop, trim/push)
 *   s[12]           line 25     — BOOLEAN_OPERATORS skip branch inside remaining split
 *   s[22]           line 37     — terms.length === 0 early-return after extractTerms
 *   b[0] if line 19             — phrase trim guard: phrase present but trimmed empty
 *   b[1] if line 25             — normalized empty → continue (falsy normalized)
 *   b[4] if line 37             — terms.length === 0 fast-path
 *   b[7] cond-expr line 56      — segments.length === 0 fallback (entire text is one match)
 *
 * All tests are pure Node (no jsdom required).
 */
import { describe, expect, it } from 'vitest'
import { splitSearchHighlights } from '../../console/src/lib/search-highlight.ts'

// ---------------------------------------------------------------------------
// extractTerms internal branch: phrase-only query (triggers loop body + trim)
// ---------------------------------------------------------------------------

describe('splitSearchHighlights — quoted phrase extraction path', () => {
  it('extracts a single quoted phrase and highlights its occurrence', () => {
    const result = splitSearchHighlights('hello world foo', '"hello world"')
    expect(result).toEqual([
      { text: 'hello world', matched: true },
      { text: ' foo', matched: false },
    ])
  })

  it('handles a quoted phrase with surrounding whitespace inside the quotes', () => {
    // phrase.trim() strips inner padding; the trimmed form is used for matching
    const result = splitSearchHighlights('hello world', '" hello world "')
    expect(result).toEqual([
      { text: 'hello world', matched: true },
    ])
  })

  it('skips an empty quoted phrase (trim produces empty string — phrase not pushed)', () => {
    // "  " → phrase = "  " → trim → "" → if (phrase) skipped
    // Remaining after removing the empty-phrase pattern is just the bare word.
    const result = splitSearchHighlights('alpha beta', '"  " alpha')
    // "  " is a quoted phrase whose trimmed value is "" → skipped.
    // "alpha" is a bare term → matched.
    expect(result).toEqual([
      { text: 'alpha', matched: true },
      { text: ' beta', matched: false },
    ])
  })
})

// ---------------------------------------------------------------------------
// extractTerms internal branch: normalized-empty bare term → continue
// ---------------------------------------------------------------------------

describe('splitSearchHighlights — normalized empty term skip (b[1])', () => {
  it('ignores a bare term that reduces to empty after stripping non-alphanumeric chars', () => {
    // A term consisting only of punctuation normalizes to "" → skipped.
    const result = splitSearchHighlights('hello world', '--- hello')
    // "---" normalizes to "" → skipped. "hello" → matched.
    expect(result).toEqual([
      { text: 'hello', matched: true },
      { text: ' world', matched: false },
    ])
  })

  it('strips trailing wildcard * from bare terms before matching', () => {
    // "hello*" → normalized removes trailing * → "hello" → matched
    const result = splitSearchHighlights('hello there', 'hello*')
    expect(result).toEqual([
      { text: 'hello', matched: true },
      { text: ' there', matched: false },
    ])
  })
})

// ---------------------------------------------------------------------------
// terms.length === 0 after extractTerms → early return (s[22], b[4])
// ---------------------------------------------------------------------------

describe('splitSearchHighlights — zero usable terms after extraction (b[4])', () => {
  it('returns unmatched segment when query contains only boolean operators', () => {
    // All terms are boolean operators → BOOLEAN_OPERATORS filters them → terms = []
    const result = splitSearchHighlights('any text here', 'AND OR NOT NEAR')
    expect(result).toEqual([{ text: 'any text here', matched: false }])
  })

  it('returns unmatched segment when query is only quoted empty phrases', () => {
    // "" alone → trimmed empty → not pushed → terms = []
    const result = splitSearchHighlights('some text', '""')
    expect(result).toEqual([{ text: 'some text', matched: false }])
  })
})

// ---------------------------------------------------------------------------
// segments.length === 0 fallback (b[7], cond-expr line 56)
// ---------------------------------------------------------------------------

describe('splitSearchHighlights — entire text is one match (b[7])', () => {
  it('returns a single matched segment when the whole text equals the query term', () => {
    // The regex matches from index 0 to end; no unmatched prefix/suffix.
    // segments.length > 0 after the loop, but the fallback cond-expr at line 56
    // evaluates segments.length > 0 → returns segments (not the fallback).
    // To hit b[7] true branch (segments empty), we need a case where the regex
    // finds no matches — but the terms guard already handles terms=[].
    // NOTE: b[7] is the cond-expr `segments.length > 0 ? segments : [...]`.
    // The FALSE branch (return fallback) would require the while loop to never
    // execute even with non-empty terms. That cannot happen with a valid pattern.
    // The only way is if the pattern matches nothing in the text.
    //
    // Test case: query has a term that doesn't appear in text → while never runs
    // → lastIndex stays 0 → no trailing push (lastIndex === text.length=0 if text='')
    // Use empty text with a non-matching query to drive lastIndex<text.length=false.
    const result = splitSearchHighlights('', 'nomatch')
    // text='', terms=['nomatch'], pattern matches nothing, loop never fires,
    // lastIndex(0) is NOT < text.length(0) → segments stays empty
    // → cond-expr FALSE branch: returns [{ text:'', matched: false }]
    expect(result).toEqual([{ text: '', matched: false }])
  })

  it('returns a single matched segment when query exactly matches the full text', () => {
    const result = splitSearchHighlights('exact', 'exact')
    expect(result).toEqual([{ text: 'exact', matched: true }])
  })
})

// ---------------------------------------------------------------------------
// Deduplication and longest-first ordering in extractTerms
// ---------------------------------------------------------------------------

describe('splitSearchHighlights — term dedup and longest-first (b[5], b[6])', () => {
  it('longer terms take priority — "alpha beta" matches before "alpha"', () => {
    // extractTerms sorts by descending length; the combined phrase wins over the single word
    const result = splitSearchHighlights('alpha beta gamma', '"alpha beta" alpha')
    // "alpha beta" is longer → comes first in the pattern alternation
    expect(result).toEqual([
      { text: 'alpha beta', matched: true },
      { text: ' gamma', matched: false },
    ])
  })

  it('deduplicates identical terms from query', () => {
    const result = splitSearchHighlights('hello world', 'hello hello')
    // Both "hello" entries deduplicate → only one match per occurrence
    expect(result).toEqual([
      { text: 'hello', matched: true },
      { text: ' world', matched: false },
    ])
  })
})
