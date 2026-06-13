import { describe, expect, it } from 'vitest';
import { RAW_OUTPUT_TRUNCATE, truncateRaw } from '../../../../src/runtimes/chat/enrichment/raw-output.ts';

describe('truncateRaw', () => {
  it('501-char input is truncated to exactly 500 chars', () => {
    const input = 'a'.repeat(RAW_OUTPUT_TRUNCATE + 1);
    const result = truncateRaw(input);
    expect(result.length).toBe(RAW_OUTPUT_TRUNCATE);
  });

  it('input at exactly RAW_OUTPUT_TRUNCATE chars is returned unchanged', () => {
    const input = 'b'.repeat(RAW_OUTPUT_TRUNCATE);
    expect(truncateRaw(input)).toBe(input);
  });

  it('input shorter than RAW_OUTPUT_TRUNCATE is returned unchanged', () => {
    const input = 'short input';
    expect(truncateRaw(input)).toBe(input);
  });
});
