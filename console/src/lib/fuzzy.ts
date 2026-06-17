/**
 * fuzzy.ts — pure subsequence fuzzy matcher + scorer (showcase §17 ⌘K palette).
 *
 * Contract:
 *   - Case-insensitive subsequence match (every char of `query` appears in
 *     `text` in order, but not necessarily contiguously).
 *   - Empty query → `{ score: 0 }` (match-all, neutral score).
 *   - Non-match → `null`.
 *   - Scoring rewards contiguous runs and word-start hits so exact, tight,
 *     and prefix matches outrank scattered subsequence hits. Deterministic
 *     and side-effect free; no dependencies. Unit-tested.
 *
 * Bonuses (tuned so a tight prefix win beats a scattered hit):
 *   - base match                  +1
 *   - contiguous run (prev+1)     +8  (rewards tight clusters)
 *   - word-start boundary         +12 (preceded by space/-/_/etc or start)
 *   - earlier first-match         +max(0, 8 - firstMatchIndex)
 */
export interface FuzzyResult {
  score: number;
}

/** Characters that count as a word boundary when they precede a match. */
const WORD_BOUNDARY_PREV = /[\s\-_/.()]/;

/**
 * Returns `{ score }` when `query` is a case-insensitive subsequence of
 * `text`, otherwise `null`. An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0 };

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  let qi = 0;
  let prevTi = -2; // start impossibly far so the first match is never "contiguous"
  let firstMatchTi = -1;
  let score = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (q[qi] === t[ti]) {
      if (firstMatchTi === -1) firstMatchTi = ti;

      // Contiguous bonus: this match immediately follows the previous one.
      score += ti === prevTi + 1 ? 8 : 1;

      // Word-start bonus: preceded by a boundary char (or string start).
      if (ti === 0 || WORD_BOUNDARY_PREV.test(t[ti - 1])) {
        score += 12;
      }

      prevTi = ti;
      qi++;
    }
  }

  // Whole query must be consumed or it's not a subsequence match.
  if (qi < q.length) return null;

  // Position bonus: prefer matches that begin earlier in the text.
  score += Math.max(0, 8 - firstMatchTi);

  return { score };
}
