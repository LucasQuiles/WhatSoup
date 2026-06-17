import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeStringEqual as fleetSafeStringEqual } from '../../src/fleet/safe-compare.ts';
import { safeStringEqual as libSafeStringEqual } from '../../src/lib/safe-compare.ts';

const implementations = [
  ['src/lib/safe-compare.ts', libSafeStringEqual],
  ['src/fleet/safe-compare.ts', fleetSafeStringEqual],
] as const;

describe.each(implementations)('%s safeStringEqual', (_label, safeStringEqual) => {
  it('returns true only for byte-identical non-empty strings', () => {
    expect(safeStringEqual('hello', 'hello')).toBe(true);
    expect(safeStringEqual('hello', 'world')).toBe(false);
    expect(safeStringEqual('hello', 'hello!')).toBe(false);
  });

  it('accepts well-formed multibyte and astral Unicode strings', () => {
    expect(safeStringEqual('cafe\u0301', 'cafe\u0301')).toBe(true);
    expect(safeStringEqual('日本語', '日本語')).toBe(true);
    expect(safeStringEqual('🔐', '🔐')).toBe(true);
  });

  it('returns false for equal-character unequal-byte strings without throwing', () => {
    expect(() => safeStringEqual('é'.repeat(8), 'a'.repeat(8))).not.toThrow();
    expect(safeStringEqual('é'.repeat(8), 'a'.repeat(8))).toBe(false);
  });

  it('rejects malformed UTF-16 on either side', () => {
    expect(safeStringEqual('\uD800', 'x')).toBe(false);
    expect(safeStringEqual('\uD800x', 'xx')).toBe(false);
    expect(safeStringEqual('\uDC00', 'x')).toBe(false);
    expect(safeStringEqual('x', '\uDC00')).toBe(false);
  });

  it('rejects empty and non-string inputs', () => {
    expect(safeStringEqual('', 'token')).toBe(false);
    expect(safeStringEqual('token', '')).toBe(false);
    expect(safeStringEqual('', '')).toBe(false);
    expect(safeStringEqual(null, 'token')).toBe(false);
    expect(safeStringEqual('token', undefined)).toBe(false);
    expect(safeStringEqual(42, 'token')).toBe(false);
  });
});

describe('safeStringEqual defensive crypto failure handling', () => {
  afterEach(() => {
    vi.doUnmock('node:crypto');
    vi.resetModules();
  });

  it('returns false when shared lib timingSafeEqual throws', async () => {
    vi.resetModules();
    vi.doMock('node:crypto', () => ({
      timingSafeEqual: () => {
        throw new Error('forced comparison failure');
      },
    }));

    const { safeStringEqual } = await import('../../src/lib/safe-compare.ts');

    expect(safeStringEqual('token', 'token')).toBe(false);
  });

  it('returns false when fleet timingSafeEqual throws', async () => {
    vi.resetModules();
    vi.doMock('node:crypto', () => ({
      timingSafeEqual: () => {
        throw new Error('forced comparison failure');
      },
    }));

    const { safeStringEqual } = await import('../../src/fleet/safe-compare.ts');

    expect(safeStringEqual('token', 'token')).toBe(false);
  });
});
