import { describe, expect, it } from 'vitest';

import {
  isRecord,
  stringifyValue,
  getNestedNumber,
  extractMessage,
  extractTokenCounts,
} from '../../../../src/runtimes/agent/providers/parser-utils.ts';

describe('isRecord', () => {
  it.each([
    { label: 'plain object', value: {}, expected: true },
    { label: 'populated object', value: { a: 1 }, expected: true },
    { label: 'null', value: null, expected: false },
    { label: 'undefined', value: undefined, expected: false },
    { label: 'array', value: [1, 2, 3], expected: false },
    { label: 'string', value: 'x', expected: false },
    { label: 'number', value: 42, expected: false },
    { label: 'boolean', value: true, expected: false },
  ])('returns $expected for $label', ({ value, expected }) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('stringifyValue', () => {
  it('returns strings unchanged', () => {
    expect(stringifyValue('hello')).toBe('hello');
    expect(stringifyValue('')).toBe('');
  });

  it('returns empty string for null and undefined', () => {
    expect(stringifyValue(null)).toBe('');
    expect(stringifyValue(undefined)).toBe('');
  });

  it('JSON-serializes objects and arrays', () => {
    expect(stringifyValue({ a: 1 })).toBe('{"a":1}');
    expect(stringifyValue([1, 2])).toBe('[1,2]');
  });

  it('JSON-serializes numbers and booleans', () => {
    expect(stringifyValue(42)).toBe('42');
    expect(stringifyValue(false)).toBe('false');
  });

  it('falls back to String() when JSON.stringify throws (e.g. circular reference)', () => {
    const circular: Record<string, unknown> = { name: 'cycle' };
    circular.self = circular;
    const result = stringifyValue(circular);
    expect(typeof result).toBe('string');
    expect(result).toContain('[object');
  });
});

describe('getNestedNumber', () => {
  it('returns the value at the given path when it is a number', () => {
    expect(getNestedNumber({ a: { b: 42 } }, ['a', 'b'])).toBe(42);
  });

  it('returns undefined when any path segment is missing', () => {
    expect(getNestedNumber({ a: { b: 1 } }, ['a', 'missing'])).toBeUndefined();
    expect(getNestedNumber({ a: { b: 1 } }, ['missing'])).toBeUndefined();
  });

  it('returns undefined when an intermediate value is not a record', () => {
    expect(getNestedNumber({ a: 'string' }, ['a', 'b'])).toBeUndefined();
    expect(getNestedNumber({ a: [1, 2] }, ['a', 'b'])).toBeUndefined();
    expect(getNestedNumber({ a: null }, ['a', 'b'])).toBeUndefined();
  });

  it('returns undefined when the final value is not a number', () => {
    expect(getNestedNumber({ a: { b: '42' } }, ['a', 'b'])).toBeUndefined();
    expect(getNestedNumber({ a: { b: null } }, ['a', 'b'])).toBeUndefined();
  });

  it('returns the root value when path is empty and value is a number', () => {
    expect(getNestedNumber(42, [])).toBe(42);
    expect(getNestedNumber('not a number', [])).toBeUndefined();
  });

  it('returns 0 (not undefined) when the value is the numeric zero', () => {
    expect(getNestedNumber({ a: 0 }, ['a'])).toBe(0);
  });
});

describe('extractMessage', () => {
  it('returns a top-level string unchanged when non-empty', () => {
    expect(extractMessage('hello')).toBe('hello');
  });

  it('returns null for an empty top-level string', () => {
    expect(extractMessage('')).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(extractMessage(null)).toBeNull();
    expect(extractMessage(undefined)).toBeNull();
  });

  it('searches default keys in order: text > message > error > details > content > output > aggregated_output', () => {
    expect(extractMessage({ text: 'A', message: 'B' })).toBe('A');
    expect(extractMessage({ message: 'A', error: 'B' })).toBe('A');
    expect(extractMessage({ error: 'A', details: 'B' })).toBe('A');
    expect(extractMessage({ content: 'A', output: 'B' })).toBe('A');
    expect(extractMessage({ aggregated_output: 'last' })).toBe('last');
  });

  it('recurses into nested objects', () => {
    expect(extractMessage({ content: { text: 'deep' } })).toBe('deep');
    expect(extractMessage({ output: { details: { message: 'very deep' } } })).toBe('very deep');
  });

  it('joins multiple array parts with newlines', () => {
    expect(extractMessage(['a', 'b'])).toBe('a\nb');
    expect(extractMessage([{ text: 'x' }, { text: 'y' }])).toBe('x\ny');
  });

  it('filters out empty/null array parts', () => {
    expect(extractMessage(['a', '', null, 'b'])).toBe('a\nb');
  });

  it('returns null for an array of all-empty parts', () => {
    expect(extractMessage(['', '', null])).toBeNull();
    expect(extractMessage([])).toBeNull();
  });

  it('honors a custom keys list when provided', () => {
    expect(extractMessage({ text: 'default', custom: 'custom' }, ['custom'])).toBe('custom');
    expect(extractMessage({ text: 'default' }, ['custom'])).toBeNull();
  });

  it('returns null for primitive non-string values at top level', () => {
    expect(extractMessage(42)).toBeNull();
    expect(extractMessage(true)).toBeNull();
  });

  // QR-070: deeply-nested provider JSON must NOT blow the call stack. A
  // provider stdout line nested ~20k deep parses fine (V8 parses iteratively)
  // but unbounded recursion in extractMessage throws an uncaught RangeError in
  // the session stdout handler → instance shutdown (DoS). The depth bound makes
  // it degrade gracefully (return null past the limit) instead of throwing.
  it('does not throw on deeply-nested input (depth-bounded — QR-070)', () => {
    let deep: Record<string, unknown> = { error: 'leaf' };
    for (let i = 0; i < 20000; i++) deep = { error: deep };
    expect(() => extractMessage(deep)).not.toThrow();
    expect(extractMessage(deep)).toBeNull();
  });

  it('still finds a message within the depth bound', () => {
    let nested: Record<string, unknown> = { error: 'found-me' };
    for (let i = 0; i < 10; i++) nested = { error: nested };
    expect(extractMessage(nested)).toBe('found-me');
  });
});

describe('extractTokenCounts', () => {
  it('extracts top-level input_tokens and output_tokens', () => {
    expect(extractTokenCounts({ input_tokens: 100, output_tokens: 50 })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('extracts camelCase variants inputTokens / outputTokens', () => {
    expect(extractTokenCounts({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('extracts nested usage.input_tokens / usage.output_tokens', () => {
    expect(
      extractTokenCounts({ usage: { input_tokens: 200, output_tokens: 100 } }),
    ).toEqual({ inputTokens: 200, outputTokens: 100 });
  });

  it('extracts nested tokenUsage.* paths', () => {
    expect(
      extractTokenCounts({ tokenUsage: { input_tokens: 7, output_tokens: 3 } }),
    ).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('returns only inputTokens when output is missing', () => {
    expect(extractTokenCounts({ input_tokens: 50 })).toEqual({ inputTokens: 50 });
  });

  it('returns only outputTokens when input is missing', () => {
    expect(extractTokenCounts({ output_tokens: 25 })).toEqual({ outputTokens: 25 });
  });

  it('returns empty object when nothing extractable is present', () => {
    expect(extractTokenCounts({})).toEqual({});
    expect(extractTokenCounts(null)).toEqual({});
    expect(extractTokenCounts('string')).toEqual({});
  });

  it('adds cache_creation + cache_read tokens onto the input total when present', () => {
    expect(
      extractTokenCounts({
        input_tokens: 10,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
        output_tokens: 2,
      }),
    ).toEqual({ inputTokens: 17, outputTokens: 2 });
  });

  it('adds cache tokens at matching nested depth (usage.*)', () => {
    expect(
      extractTokenCounts({
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 4,
          output_tokens: 2,
        },
      }),
    ).toEqual({ inputTokens: 17, outputTokens: 2 });
  });

  it('does not add cache tokens when both creation and read are zero or missing', () => {
    expect(extractTokenCounts({ input_tokens: 10, output_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});
