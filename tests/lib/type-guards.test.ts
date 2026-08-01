import { describe, it, expect } from 'vitest';
import { asNonEmptyString, asRecord, isNonEmptyString, isRecord } from '../../src/lib/type-guards.js';

/**
 * Contract-lock tests for isRecord.
 *
 * Implementation: typeof value === 'object' && value !== null && !Array.isArray(value)
 *
 * Behavioural note on built-in object wrappers (Date, Map, Set):
 * These are non-null, non-array objects, so isRecord returns true for them.
 * The function's stated contract is "non-null, non-array object record", which
 * encompasses all object instances — not only plain-object literals.  The
 * existing consumers (JSON-payload guards) are safe because JSON.parse never
 * produces Date/Map/Set; the narrowness of the JSON surface makes the broader
 * predicate safe in practice.  These tests pin the actual runtime behaviour.
 */

describe('isRecord', () => {
  describe('returns true for plain objects', () => {
    it.each([
      ['empty object literal', {}],
      ['object with primitive value', { a: 1 }],
      ['nested object', { a: { b: 2 } }],
      ['Object.create(null) — no prototype', Object.create(null) as Record<string, unknown>],
      ['object with custom prototype', Object.create({ proto: true }) as Record<string, unknown>],
    ])('%s', (_label, value) => {
      expect(isRecord(value)).toBe(true);
    });
  });

  describe('returns true for non-plain object instances (pinned actual behaviour)', () => {
    it.each([
      ['Date instance', new Date()],
      ['Map instance', new Map()],
      ['Set instance', new Set()],
      ['RegExp instance', /regex/],
    ])('%s — is object, not null, not array → true', (_label, value) => {
      expect(isRecord(value)).toBe(true);
    });
  });

  describe('returns false for non-objects', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['non-empty string', 'string'],
      ['zero', 0],
      ['positive integer', 42],
      ['negative integer', -1],
      ['true', true],
      ['false', false],
      ['arrow function', () => {}],
      ['Symbol', Symbol('sym')],
      ['NaN', NaN],
      ['Infinity', Infinity],
    ])('%s', (_label, value) => {
      expect(isRecord(value)).toBe(false);
    });
  });

  describe('returns false for arrays', () => {
    it.each([
      ['empty array', []],
      ['populated array', [1, 2, 3]],
      ['array of objects', [{ a: 1 }]],
      ['nested array', [[1, 2], [3, 4]]],
    ])('%s', (_label, value) => {
      expect(isRecord(value)).toBe(false);
    });
  });
});

/**
 * Contract-lock tests for asRecord — the coercer companion to isRecord.
 *
 * Contract: returns the value itself (same reference, narrowed to
 * Record<string, unknown>) when isRecord holds, otherwise `undefined`
 * (never `null` — `undefined` composes with optional parameters and `??`).
 */
describe('asRecord', () => {
  describe('returns the same reference for record values', () => {
    it.each([
      ['empty object literal', {}],
      ['object with primitive value', { a: 1 }],
      ['nested object', { a: { b: 2 } }],
      ['Object.create(null) — no prototype', Object.create(null) as Record<string, unknown>],
      ['Date instance (pinned: isRecord accepts object instances)', new Date()],
      ['Map instance (pinned: isRecord accepts object instances)', new Map()],
    ])('%s', (_label, value) => {
      expect(asRecord(value)).toBe(value);
    });
  });

  describe('returns undefined (never null) for non-records', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['non-empty string', 'string'],
      ['zero', 0],
      ['positive integer', 42],
      ['true', true],
      ['false', false],
      ['arrow function', () => {}],
      ['NaN', NaN],
      ['empty array', []],
      ['populated array', [1, 2, 3]],
    ])('%s', (_label, value) => {
      expect(asRecord(value)).toBeUndefined();
      expect(asRecord(value)).not.toBeNull();
    });
  });

  it('agrees with isRecord on every probe (delegation contract)', () => {
    const probes: unknown[] = [
      {}, { a: 1 }, [], [1], null, undefined, '', 'x', 0, 1, true, false, new Date(), () => {},
    ];
    for (const probe of probes) {
      expect(asRecord(probe) !== undefined).toBe(isRecord(probe));
    }
  });
});

/**
 * Contract-lock tests for isNonEmptyString.
 *
 * Implementation: typeof value === 'string' && value.trim() !== ''
 */
describe('isNonEmptyString', () => {
  describe('returns true for strings with non-whitespace content', () => {
    it.each([
      ['single word', 'hello'],
      ['sentence with spaces', 'hello world'],
      ['leading/trailing whitespace around real content', '  hello  '],
      ['single non-space character', 'x'],
      ['string with only interior whitespace preserved', 'a b'],
    ])('%s', (_label, value) => {
      expect(isNonEmptyString(value)).toBe(true);
    });
  });

  describe('returns false for empty or all-whitespace strings', () => {
    it.each([
      ['empty string', ''],
      ['single space', ' '],
      ['tabs and newlines', '\t\n  \t'],
      ['multiple spaces', '     '],
    ])('%s', (_label, value) => {
      expect(isNonEmptyString(value)).toBe(false);
    });
  });

  describe('returns false for non-strings', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['zero', 0],
      ['positive integer', 42],
      ['true', true],
      ['false', false],
      ['empty object', {}],
      ['empty array', []],
      ['arrow function', () => {}],
      ['NaN', NaN],
    ])('%s', (_label, value) => {
      expect(isNonEmptyString(value)).toBe(false);
    });
  });
});

/**
 * Contract-lock tests for asNonEmptyString — the trimming coercer companion
 * to isNonEmptyString.
 *
 * Contract: returns the TRIMMED string when isNonEmptyString holds, otherwise
 * `undefined` (never `null` — mirrors asRecord's undefined-over-null choice).
 */
describe('asNonEmptyString', () => {
  describe('returns the trimmed string for non-empty strings', () => {
    it.each([
      ['no whitespace', 'hello', 'hello'],
      ['leading whitespace', '  hello', 'hello'],
      ['trailing whitespace', 'hello  ', 'hello'],
      ['both sides', '  hello  ', 'hello'],
      ['interior whitespace preserved', '  hello world  ', 'hello world'],
    ])('%s', (_label, input, expected) => {
      expect(asNonEmptyString(input)).toBe(expected);
    });
  });

  describe('returns undefined (never null) for blank or non-string values', () => {
    it.each([
      ['empty string', ''],
      ['all whitespace', '   '],
      ['null', null],
      ['undefined', undefined],
      ['zero', 0],
      ['true', true],
      ['empty array', []],
      ['empty object', {}],
    ])('%s', (_label, value) => {
      expect(asNonEmptyString(value)).toBeUndefined();
      expect(asNonEmptyString(value)).not.toBeNull();
    });
  });

  it('agrees with isNonEmptyString on every probe (delegation contract)', () => {
    const probes: unknown[] = [
      '', ' ', 'x', '  x  ', null, undefined, 0, 1, true, false, {}, [], () => {},
    ];
    for (const probe of probes) {
      expect(asNonEmptyString(probe) !== undefined).toBe(isNonEmptyString(probe));
    }
  });
});
