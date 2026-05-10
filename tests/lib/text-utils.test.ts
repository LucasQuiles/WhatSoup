import { describe, expect, it } from 'vitest';

import { truncateForRerank } from '../../src/lib/text-utils.ts';

describe('truncateForRerank', () => {
  it('returns input unchanged when length is less than maxChars', () => {
    expect(truncateForRerank('short text', 20)).toBe('short text');
  });

  it('returns truncated text with an ellipsis when length exceeds maxChars', () => {
    expect(truncateForRerank('abcdefghij', 6)).toBe('abcdef…');
  });

  it('returns input unchanged when length exactly equals maxChars', () => {
    expect(truncateForRerank('exact', 5)).toBe('exact');
  });

  it('returns an empty string unchanged', () => {
    expect(truncateForRerank('', 10)).toBe('');
  });

  it('respects a custom maxChars parameter', () => {
    expect(truncateForRerank('custom length', 3)).toBe('cus…');
  });
});
