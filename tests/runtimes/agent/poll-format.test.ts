import { describe, it, expect } from 'vitest';
import { formatPollQuestion } from '../../../src/runtimes/agent/runtime.ts';

// Budget constants mirrored from production code
const OPTION_MAX = 95;
const SEPARATOR = ' — ';
const ELLIPSIS = '…';

describe('formatPollQuestion', () => {
  describe('question text', () => {
    it('passes short questions through unchanged', () => {
      const result = formatPollQuestion({
        question: 'Which language?',
        options: [
          { label: 'Python', description: 'Dynamic typing' },
          { label: 'Go', description: 'Compiled' },
        ],
      });
      expect(result.pollName).toBe('Which language?');
    });

    it('truncates questions exceeding 900 chars with ellipsis', () => {
      const longQ = 'A'.repeat(950);
      const result = formatPollQuestion({
        question: longQ,
        options: [
          { label: 'A', description: 'opt a' },
          { label: 'B', description: 'opt b' },
        ],
      });
      expect(result.pollName.length).toBe(900);
      expect(result.pollName.endsWith(ELLIPSIS)).toBe(true);
      expect(result.pollName.startsWith('AAAA')).toBe(true);
    });

    it('passes exactly 900-char questions through unchanged', () => {
      const exactQ = 'B'.repeat(900);
      const result = formatPollQuestion({
        question: exactQ,
        options: [
          { label: 'A', description: '' },
          { label: 'B', description: '' },
        ],
      });
      expect(result.pollName).toBe(exactQ);
    });
  });

  describe('rich option text (label — description)', () => {
    it('combines label and description when within budget', () => {
      const result = formatPollQuestion({
        question: 'Pick one',
        options: [
          { label: 'Python', description: 'Dynamic typing, great for scripting' },
          { label: 'TypeScript', description: 'Static typing on JavaScript' },
        ],
      });
      expect(result.pollValues).toEqual([
        'Python — Dynamic typing, great for scripting',
        'TypeScript — Static typing on JavaScript',
      ]);
      expect(result.needsFollowUp).toBe(false);
    });

    it('truncates long description with prefix and ellipsis within budget', () => {
      const longDesc = 'D'.repeat(120);
      const result = formatPollQuestion({
        question: 'Pick one',
        options: [
          { label: 'Python', description: longDesc },
          { label: 'Go', description: 'Short desc' },
        ],
      });
      // Python: label(6) + " — "(3) = 9 prefix, budget for desc = 95 - 9 - 1(ellipsis) = 85
      expect(result.pollValues[0]).toMatch(/^Python — D+…$/);
      expect(result.pollValues[0].length).toBe(OPTION_MAX);
      // Go fits fully
      expect(result.pollValues[1]).toBe('Go — Short desc');
      expect(result.needsFollowUp).toBe(true);
    });

    it('uses bare label when description is empty', () => {
      const result = formatPollQuestion({
        question: 'Pick one',
        options: [
          { label: 'Option A', description: '' },
          { label: 'Option B', description: '  ' },
        ],
      });
      expect(result.pollValues).toEqual(['Option A', 'Option B']);
      expect(result.needsFollowUp).toBe(false);
    });

    it('falls to bare label only when label nearly fills the budget', () => {
      // Label of 85 chars + " — " = 88, leaving only 7 chars for desc (< 10 minimum)
      const longLabel = 'L'.repeat(85);
      const result = formatPollQuestion({
        question: 'Pick one',
        options: [
          { label: longLabel, description: 'Some description text' },
        ],
      });
      // desc budget = 95 - 85 - 3 - 1 = 6, below 10 minimum → bare label
      expect(result.pollValues[0]).toBe(longLabel);
      expect(result.needsFollowUp).toBe(true);
    });

    it('truncates label with ellipsis when label itself exceeds budget', () => {
      const hugeLabel = 'X'.repeat(120);
      const result = formatPollQuestion({
        question: 'Pick one',
        options: [
          { label: hugeLabel, description: '' },
        ],
      });
      expect(result.pollValues[0].length).toBe(OPTION_MAX);
      expect(result.pollValues[0].endsWith(ELLIPSIS)).toBe(true);
      expect(result.needsFollowUp).toBe(true);
    });
  });

  describe('needsFollowUp', () => {
    it('is false when all descriptions fit in poll options', () => {
      const result = formatPollQuestion({
        question: 'Pick one',
        options: [
          { label: 'A', description: 'Short A' },
          { label: 'B', description: 'Short B' },
          { label: 'C', description: 'Short C' },
        ],
      });
      expect(result.needsFollowUp).toBe(false);
    });

    it('is true when any description is truncated', () => {
      const result = formatPollQuestion({
        question: 'Pick one',
        options: [
          { label: 'A', description: 'Short' },
          { label: 'B', description: 'X'.repeat(120) },
          { label: 'C', description: 'Short' },
        ],
      });
      expect(result.needsFollowUp).toBe(true);
      // B truncated with prefix
      expect(result.pollValues[1]).toMatch(/^B — X+…$/);
      expect(result.pollValues[1].length).toBe(OPTION_MAX);
      // A and C kept full rich
      expect(result.pollValues[0]).toBe('A — Short');
      expect(result.pollValues[2]).toBe('C — Short');
    });

    it('is false when all descriptions are empty', () => {
      const result = formatPollQuestion({
        question: 'Pick one',
        options: [
          { label: 'A', description: '' },
          { label: 'B', description: '' },
        ],
      });
      expect(result.needsFollowUp).toBe(false);
    });
  });

  describe('boundary conditions', () => {
    it('exactly-at-budget option is not truncated', () => {
      // "X — " = 4 chars, desc can be 91 to hit exactly 95
      const desc = 'D'.repeat(91);
      const result = formatPollQuestion({
        question: 'Q',
        options: [
          { label: 'X', description: desc },
          { label: 'Y', description: 'ok' },
        ],
      });
      expect(result.pollValues[0]).toBe(`X${SEPARATOR}${desc}`);
      expect(result.pollValues[0].length).toBe(OPTION_MAX);
      expect(result.needsFollowUp).toBe(false);
    });

    it('one-over-budget option gets description truncated', () => {
      const desc = 'D'.repeat(92); // "X — " + 92 = 96, 1 over
      const result = formatPollQuestion({
        question: 'Q',
        options: [
          { label: 'X', description: desc },
          { label: 'Y', description: 'ok' },
        ],
      });
      // Truncated: "X — DDD...D…" at exactly 95 chars
      expect(result.pollValues[0].length).toBe(OPTION_MAX);
      expect(result.pollValues[0].startsWith('X — D')).toBe(true);
      expect(result.pollValues[0].endsWith(ELLIPSIS)).toBe(true);
      expect(result.needsFollowUp).toBe(true);
    });

    it('all poll values are within WhatsApp budget', () => {
      const result = formatPollQuestion({
        question: 'Q'.repeat(1000),
        options: [
          { label: 'A'.repeat(50), description: 'B'.repeat(200) },
          { label: 'C'.repeat(30), description: 'D'.repeat(100) },
          { label: 'E', description: 'F'.repeat(10) },
          { label: 'G'.repeat(100), description: '' },
        ],
      });
      expect(result.pollName.length).toBeLessThanOrEqual(900);
      for (const v of result.pollValues) {
        expect(v.length).toBeLessThanOrEqual(OPTION_MAX);
      }
    });

    it('handles real-world brainstorming options with truncated descriptions', () => {
      // From gate-a-schema-proof.md Sample 2
      const result = formatPollQuestion({
        question: 'Should I proceed with implementing the forensic closure plan?',
        options: [
          {
            label: 'Proceed with full plan implementation (Recommended)',
            description: 'Execute all three closure tracks with local filesystem and CLI access',
          },
          {
            label: 'Proceed with read-only analysis only',
            description: 'Analyze current state without making changes to settings or hooks',
          },
          {
            label: 'Cancel - review plan first',
            description: 'Stop and let me review the complete plan document before proceeding',
          },
        ],
      });

      // All options should be within budget
      for (const v of result.pollValues) {
        expect(v.length).toBeLessThanOrEqual(OPTION_MAX);
      }

      // Each should contain at least partial description (label + separator fits)
      for (const v of result.pollValues) {
        expect(v).toContain(SEPARATOR);
      }

      // Some or all will be truncated given the long labels + descriptions
      // The key invariant: every value is within budget
      expect(result.needsFollowUp).toBe(true);
    });
  });
});
