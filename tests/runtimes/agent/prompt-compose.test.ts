import { describe, expect, it } from 'vitest';

import { composeWithExactLineDedup } from '../../../src/runtimes/agent/prompt-compose.ts';

describe('composeWithExactLineDedup', () => {
  it('returns an empty string for empty input', () => {
    expect(composeWithExactLineDedup([])).toBe('');
  });

  it('passes a single source through unchanged', () => {
    expect(composeWithExactLineDedup(['alpha\n\nbeta\n'])).toBe('alpha\n\nbeta\n');
  });

  it('concatenates sources in order', () => {
    expect(composeWithExactLineDedup(['alpha', 'beta', 'gamma'])).toBe('alpha\nbeta\ngamma');
  });

  it('keeps the first occurrence of duplicated exact non-empty lines', () => {
    expect(composeWithExactLineDedup([
      'identity\nfirst instruction',
      'identity\nsecond instruction',
    ])).toBe('identity\nfirst instruction\nsecond instruction');
  });

  it('preserves empty and whitespace-only lines verbatim without deduping them', () => {
    expect(composeWithExactLineDedup([
      'alpha\n\n   \nalpha',
      '\n   \nbeta',
    ])).toBe('alpha\n\n   \n\n   \nbeta');
  });

  it('does not collapse substring matches', () => {
    expect(composeWithExactLineDedup([
      'agent\nagentic',
      'agent',
    ])).toBe('agent\nagentic');
  });
});
