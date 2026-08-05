import { describe, it, expect } from 'vitest';
import {
  asNonEmptyString,
  asRecord,
  isNonEmptyString,
  isRecord,
  nonEmptyString,
  nonEmptyStringRaw,
  requireArrayOfRecords,
  requireBoolean,
  requireEnum,
  requireNullableBoolean,
  requireNullableNumber,
  requireNullableString,
  requireNumber,
  requireRecord,
  requireString,
  requireStringArray,
} from '../../src/lib/type-guards.js';

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

/**
 * Contract-lock tests for requireRecord — the throwing companion to
 * isRecord/asRecord.
 *
 * Contract: returns the value itself (same reference, narrowed to
 * Record<string, unknown>) when isRecord holds, otherwise throws an `Error`
 * whose message contains the caller-supplied `label`. Naming mirrors the
 * `require*` prefix already used by throwing validators elsewhere in the
 * codebase (e.g. scripts/lib/ci-control/result.ts `requireRecord`) — kept
 * distinct from `asRecord` (the non-throwing coercer) so the two never
 * collide on name or behaviour.
 */
describe('requireRecord', () => {
  describe('returns the same reference for record values', () => {
    it.each([
      ['empty object literal', {}],
      ['object with primitive value', { a: 1 }],
      ['nested object', { a: { b: 2 } }],
      ['Object.create(null) — no prototype', Object.create(null) as Record<string, unknown>],
      ['Date instance (pinned: isRecord accepts object instances)', new Date()],
    ])('%s', (_label, value) => {
      expect(requireRecord(value, 'X')).toBe(value);
    });
  });

  describe('throws with the label embedded for non-records', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['empty string', ''],
      ['non-empty string', 'string'],
      ['zero', 0],
      ['true', true],
      ['empty array', []],
      ['populated array', [1, 2, 3]],
    ])('%s', (_label, value) => {
      expect(() => requireRecord(value, 'X')).toThrow('X must be an object');
    });
  });

  it('agrees with isRecord on every probe (delegation contract)', () => {
    const probes: unknown[] = [
      {}, { a: 1 }, [], [1], null, undefined, '', 'x', 0, 1, true, false, new Date(), () => {},
    ];
    for (const probe of probes) {
      let threw = false;
      try {
        requireRecord(probe, 'X');
      } catch {
        threw = true;
      }
      expect(!threw).toBe(isRecord(probe));
    }
  });
});

/**
 * Contract-lock tests for requireString.
 *
 * Contract: returns the string itself (no trimming — distinct from
 * asNonEmptyString, which trims) when the value is a non-empty string,
 * otherwise throws an `Error` whose message contains `label`. "Non-empty"
 * here means `.length > 0`, NOT `isNonEmptyString`'s whitespace-aware
 * definition — a call site that needs whitespace-rejection should compose
 * `asNonEmptyString`/`isNonEmptyString` instead.
 */
describe('requireString', () => {
  describe('returns the string for non-empty strings', () => {
    it.each([
      ['single word', 'hello'],
      ['whitespace-only string (accepted — length > 0, not trim-checked)', '   '],
      ['single character', 'x'],
    ])('%s', (_label, value) => {
      expect(requireString(value, 'X')).toBe(value);
    });
  });

  describe('throws with the label embedded for non-strings or empty string', () => {
    it.each([
      ['empty string', ''],
      ['null', null],
      ['undefined', undefined],
      ['zero', 0],
      ['positive integer', 42],
      ['true', true],
      ['empty object', {}],
      ['empty array', []],
    ])('%s', (_label, value) => {
      expect(() => requireString(value, 'X')).toThrow('X must be a string');
    });
  });
});

/**
 * Contract-lock tests for requireBoolean.
 */
describe('requireBoolean', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])('returns the boolean for %s', (_label, value) => {
    expect(requireBoolean(value, 'X')).toBe(value);
  });

  describe('throws with the label embedded for non-booleans', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['zero', 0],
      ['one', 1],
      ['string "true"', 'true'],
      ['empty object', {}],
      ['empty array', []],
    ])('%s', (_label, value) => {
      expect(() => requireBoolean(value, 'X')).toThrow('X must be a boolean');
    });
  });
});

/**
 * Contract-lock tests for requireNumber.
 *
 * Contract: accepts any finite number (rejects NaN/Infinity — a common
 * silent-corruption vector for untrusted JSON payloads that the plain
 * `typeof value === 'number'` clones being replaced do not uniformly guard
 * against).
 */
describe('requireNumber', () => {
  it.each([
    ['zero', 0],
    ['positive integer', 42],
    ['negative integer', -1],
    ['float', 3.14],
  ])('returns the number for %s', (_label, value) => {
    expect(requireNumber(value, 'X')).toBe(value);
  });

  describe('throws with the label embedded for non-finite-numbers', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['string "1"', '1'],
      ['true', true],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['empty object', {}],
      ['empty array', []],
    ])('%s', (_label, value) => {
      expect(() => requireNumber(value, 'X')).toThrow('X must be a number');
    });
  });
});

/**
 * Contract-lock tests for requireEnum.
 *
 * Contract: `(value, label, allowed)` — `label` is the second parameter
 * (matching every other `require*` helper's argument order in this module)
 * and `allowed` is a `ReadonlySet<T>` (not an array — `Set.has` gives O(1)
 * membership, matching the SSOT's existing `Set`-based call sites such as
 * scripts/provider-parity-report.ts's `EXPECTATION_VALUES`).
 */
describe('requireEnum', () => {
  const ALLOWED = new Set(['a', 'b'] as const);

  it('returns the value when it is a member of the allowed set', () => {
    expect(requireEnum('a', 'X', ALLOWED)).toBe('a');
    expect(requireEnum('b', 'X', ALLOWED)).toBe('b');
  });

  describe('throws with the label and allowed set embedded for non-members', () => {
    it.each([
      ['string not in the set', 'c'],
      ['null', null],
      ['undefined', undefined],
      ['number', 1],
      ['empty object', {}],
    ])('%s', (_label, value) => {
      expect(() => requireEnum(value, 'X', ALLOWED)).toThrow(/X must be one of a, b/);
    });
  });
});

/**
 * Contract-lock tests for the nullable require* variants.
 *
 * Contract: accept `null` OR the base type; throw for everything else
 * (including `undefined`, which is deliberately NOT treated as `null` — a
 * missing key and an explicit null are different failure signatures for a
 * strict schema, mirroring scripts/provider-parity-report.ts's original
 * clones).
 */
describe('requireNullableString', () => {
  it('returns null for null', () => {
    expect(requireNullableString(null, 'X')).toBeNull();
  });

  it('returns the string for string values', () => {
    expect(requireNullableString('hello', 'X')).toBe('hello');
  });

  describe('throws with the label embedded for everything else', () => {
    it.each([
      ['undefined', undefined],
      ['number', 1],
      ['boolean', true],
      ['empty object', {}],
      ['empty array', []],
    ])('%s', (_label, value) => {
      expect(() => requireNullableString(value, 'X')).toThrow('X must be a string or null');
    });
  });
});

describe('requireNullableBoolean', () => {
  it('returns null for null', () => {
    expect(requireNullableBoolean(null, 'X')).toBeNull();
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('returns the boolean for %s', (_label, value) => {
    expect(requireNullableBoolean(value, 'X')).toBe(value);
  });

  describe('throws with the label embedded for everything else', () => {
    it.each([
      ['undefined', undefined],
      ['number', 1],
      ['string', 'true'],
      ['empty object', {}],
    ])('%s', (_label, value) => {
      expect(() => requireNullableBoolean(value, 'X')).toThrow('X must be a boolean or null');
    });
  });
});

describe('requireNullableNumber', () => {
  it('returns null for null', () => {
    expect(requireNullableNumber(null, 'X')).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['positive integer', 42],
    ['float', 3.14],
  ])('returns the number for %s', (_label, value) => {
    expect(requireNullableNumber(value, 'X')).toBe(value);
  });

  describe('throws with the label embedded for everything else (including NaN/Infinity)', () => {
    it.each([
      ['undefined', undefined],
      ['string', '1'],
      ['boolean', true],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['empty object', {}],
    ])('%s', (_label, value) => {
      expect(() => requireNullableNumber(value, 'X')).toThrow('X must be a finite number or null');
    });
  });
});

/**
 * Contract-lock tests for requireStringArray.
 *
 * Contract: every element must satisfy requireString (non-empty string);
 * per-element failures embed the array index in the thrown label
 * (`${label}[${index}]`), matching the original clone's convention.
 */
describe('requireStringArray', () => {
  it('returns the array for an all-string array (including empty)', () => {
    expect(requireStringArray([], 'X')).toEqual([]);
    expect(requireStringArray(['a', 'b'], 'X')).toEqual(['a', 'b']);
  });

  it('throws for a non-array', () => {
    expect(() => requireStringArray('not-an-array', 'X')).toThrow('X must be an array');
    expect(() => requireStringArray(null, 'X')).toThrow('X must be an array');
  });

  it('throws with the index embedded for a non-string element', () => {
    expect(() => requireStringArray(['a', 1, 'c'], 'X')).toThrow('X[1] must be a string');
  });
});

/**
 * Contract-lock tests for requireArrayOfRecords.
 *
 * Contract: every element must satisfy requireRecord; per-element failures
 * embed the array index in the thrown label.
 */
describe('requireArrayOfRecords', () => {
  it('returns the array for an all-record array (including empty)', () => {
    expect(requireArrayOfRecords([], 'X')).toEqual([]);
    expect(requireArrayOfRecords([{ a: 1 }, {}], 'X')).toEqual([{ a: 1 }, {}]);
  });

  it('throws for a non-array', () => {
    expect(() => requireArrayOfRecords('not-an-array', 'X')).toThrow('X must be an array');
  });

  it('throws with the index embedded for a non-record element', () => {
    expect(() => requireArrayOfRecords([{}, 'nope'], 'X')).toThrow('X[1] must be an object');
  });
});

/**
 * Contract-lock tests for the branded non-empty-string coercers (#2211).
 *
 * Contract: nonEmptyString returns the TRIMMED value (branded) or null;
 * nonEmptyStringRaw preserves the original spelling (un-trimmed) or null.
 * Both reject non-strings, empty strings, and whitespace-only strings.
 */
describe('nonEmptyString', () => {
  it('returns the trimmed value for strings with content', () => {
    expect(nonEmptyString('abc')).toBe('abc');
    expect(nonEmptyString('  abc  ')).toBe('abc');
  });

  it('returns null for empty, whitespace-only, and non-string values', () => {
    expect(nonEmptyString('')).toBeNull();
    expect(nonEmptyString('   ')).toBeNull();
    expect(nonEmptyString(undefined)).toBeNull();
    expect(nonEmptyString(42)).toBeNull();
  });
});

describe('nonEmptyStringRaw', () => {
  it('preserves the un-trimmed spelling for strings with content', () => {
    expect(nonEmptyStringRaw('  abc  ')).toBe('  abc  ');
  });

  it('returns null for empty, whitespace-only, and non-string values', () => {
    expect(nonEmptyStringRaw('')).toBeNull();
    expect(nonEmptyStringRaw(' \t\n ')).toBeNull();
    expect(nonEmptyStringRaw(null)).toBeNull();
    expect(nonEmptyStringRaw([])).toBeNull();
  });
});
