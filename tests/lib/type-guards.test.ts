import { describe, it, expect } from 'vitest';
import { asRecord, isRecord, nonEmptyString, nonEmptyStringRaw, type NonEmptyString } from '../../src/lib/type-guards.js';

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
 * Contract-lock tests for nonEmptyString / nonEmptyStringRaw (#2211).
 *
 * These are the consolidation targets for the 26+ open-coded
 * `typeof v === 'string' && v.trim() !== ''` sites. The two variants
 * exist because the open-coded idiom diverged: some sites returned the
 * TRIMMED value, others returned the RAW value. Each helper pins one
 * behavior by name.
 */

describe('nonEmptyString (returns TRIMMED)', () => {
  describe('returns trimmed value for non-empty strings', () => {
    it.each([
      ['plain string', 'hello', 'hello'],
      ['leading whitespace', '  hello', 'hello'],
      ['trailing whitespace', 'hello  ', 'hello'],
      ['both sides', '  hello  ', 'hello'],
      ['single char', 'x', 'x'],
    ])('%s', (_label, input, expected) => {
      expect(nonEmptyString(input)).toBe(expected);
    });
  });

  describe('returns null for empty/whitespace/non-string', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['tab only', '\t'],
      ['newline only', '\n'],
      ['mixed whitespace', ' \t\n '],
      ['null', null],
      ['undefined', undefined],
      ['number', 123],
      ['boolean', true],
      ['object', {}],
      ['array', []],
    ])('%s', (_label, value) => {
      expect(nonEmptyString(value)).toBeNull();
    });
  });

  it('return type narrows to NonEmptyString (brand is transparent to string)', () => {
    const v = nonEmptyString('test');
    expect(v).not.toBeNull();
    if (v !== null) {
      // Brand is transparent: NonEmptyString is assignable to string.
      const _: NonEmptyString = v;
      expect(_.length).toBe(4);
      expect(_.toUpperCase()).toBe('TEST');
    }
  });
});

describe('nonEmptyStringRaw (returns RAW, un-trimmed)', () => {
  describe('returns raw (un-trimmed) value for non-empty strings', () => {
    it.each([
      ['plain string', 'hello', 'hello'],
      ['leading whitespace', '  hello', '  hello'],
      ['trailing whitespace', 'hello  ', 'hello  '],
      ['both sides', '  hello  ', '  hello  '],
    ])('%s', (_label, input, expected) => {
      expect(nonEmptyStringRaw(input)).toBe(expected);
    });
  });

  describe('returns null for empty/whitespace/non-string', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['null', null],
      ['undefined', undefined],
      ['number', 0],
      ['object', {}],
    ])('%s', (_label, value) => {
      expect(nonEmptyStringRaw(value)).toBeNull();
    });
  });

  it('differs from nonEmptyString on whitespace-padded input (raw vs trimmed)', () => {
    const input = '  hello  ';
    expect(nonEmptyString(input)).toBe('hello');
    expect(nonEmptyStringRaw(input)).toBe('  hello  ');
  });
});
