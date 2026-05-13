/**
 * Direct unit coverage for console/src/lib/preferences.ts.
 *
 * Two helpers wrap localStorage with:
 *   - a `whatsoup:` key prefix (namespace isolation)
 *   - try/catch swallow on both get and set (SSR / private-browsing safety)
 *
 * The module already exposes a `storage` injection point on both helpers
 * defaulting to `localStorage`, so we test against an in-memory fake instead
 * of needing a DOM environment. This keeps the test under the repo's Node
 * test convention.
 */
import { describe, expect, it } from 'vitest';
import { getPreference, setPreference } from '../../console/src/lib/preferences';

/**
 * Minimal Storage stand-in. Each test instantiates a fresh one to avoid
 * cross-test leakage.
 */
function makeMemoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    inspect: () => Object.fromEntries(store),
  };
}

/** Storage stub that throws on every operation — simulates SSR/private-browsing failures. */
const throwingStorage = {
  getItem: (_key: string): string | null => {
    throw new Error('storage unavailable');
  },
  setItem: (_key: string, _value: string): void => {
    throw new Error('storage unavailable');
  },
};

describe('getPreference', () => {
  it('returns the stored value when key exists (prefixed lookup)', () => {
    const storage = makeMemoryStorage({ 'whatsoup:theme': 'dark' });
    expect(getPreference('theme', 'light', storage)).toBe('dark');
  });

  it('returns the fallback when the prefixed key is missing', () => {
    const storage = makeMemoryStorage({});
    expect(getPreference('theme', 'light', storage)).toBe('light');
  });

  it('returns the fallback when storage.getItem throws', () => {
    expect(getPreference('theme', 'light', throwingStorage)).toBe('light');
  });

  it('uses the whatsoup: prefix (un-prefixed key does not match)', () => {
    const storage = makeMemoryStorage({ theme: 'dark' }); // un-prefixed key
    expect(getPreference('theme', 'light', storage)).toBe('light');
  });

  it('returns fallback even when explicitly-prefixed key is stored under a different name', () => {
    const storage = makeMemoryStorage({ 'whatsoup:other-key': 'value' });
    expect(getPreference('theme', 'light', storage)).toBe('light');
  });
});

describe('setPreference', () => {
  it('writes the value under the prefixed key', () => {
    const storage = makeMemoryStorage({});
    setPreference('theme', 'dark', storage);
    expect(storage.inspect()).toEqual({ 'whatsoup:theme': 'dark' });
  });

  it('overwrites an existing prefixed value', () => {
    const storage = makeMemoryStorage({ 'whatsoup:theme': 'light' });
    setPreference('theme', 'dark', storage);
    expect(storage.inspect()).toEqual({ 'whatsoup:theme': 'dark' });
  });

  it('silently swallows storage.setItem errors (no throw)', () => {
    expect(() => setPreference('theme', 'dark', throwingStorage)).not.toThrow();
  });

  it('does not pollute keys outside the whatsoup: namespace', () => {
    const storage = makeMemoryStorage({ 'other:key': 'preserved' });
    setPreference('theme', 'dark', storage);
    expect(storage.inspect()).toEqual({
      'other:key': 'preserved',
      'whatsoup:theme': 'dark',
    });
  });
});

describe('round-trip', () => {
  it('written value is readable back via getPreference', () => {
    const storage = makeMemoryStorage({});
    setPreference('view-mode', 'grid', storage);
    expect(getPreference('view-mode', 'list', storage)).toBe('grid');
  });
});
