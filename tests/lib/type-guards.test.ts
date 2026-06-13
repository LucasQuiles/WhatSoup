import { describe, it, expect } from 'vitest';
import { asRecord, isRecord } from '../../src/lib/type-guards.js';

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
