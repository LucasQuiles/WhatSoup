// Intended repo path: tests/transport/presence-cache.eviction.test.ts
//
// Closes uncovered statements/branches in src/transport/presence-cache.ts:
//   - lines 37-39  : LRU eviction path when the cache reaches maxEntries
//                    (branch 37 taken/not-taken; branch 39 oldest!==undefined)
//   - line 53      : getAll() yielding entries with the computed `stale` flag
//                    over a NON-empty map (existing test only asserts [] on empty)
//
// The existing presence-cache.test.ts never fills the cache to capacity and never
// iterates getAll() over populated entries, so these paths were uncovered.
import { describe, it, expect, vi, afterEach } from 'vitest';

import { PresenceCache } from '../../src/transport/presence-cache.ts';

describe('PresenceCache — LRU eviction at capacity', () => {
  afterEach(() => vi.useRealTimers());

  it('evicts the least-recently-used entry when at capacity', () => {
    const cache = new PresenceCache(2);
    cache.update('a@s.whatsapp.net', { status: 'available' });
    cache.update('b@s.whatsapp.net', { status: 'available' });
    expect(cache.size).toBe(2);

    // Inserting a third entry must evict 'a' (oldest / least-recently-inserted).
    cache.update('c@s.whatsapp.net', { status: 'available' });

    expect(cache.size).toBe(2);
    expect(cache.get('a@s.whatsapp.net')).toBeUndefined();
    expect(cache.get('b@s.whatsapp.net')).not.toBeUndefined();
    expect(cache.get('c@s.whatsapp.net')).not.toBeUndefined();
  });

  it('promotes via get() so the recently-read entry survives eviction', () => {
    const cache = new PresenceCache(2);
    cache.update('a@s.whatsapp.net', { status: 'available' });
    cache.update('b@s.whatsapp.net', { status: 'available' });

    // Read 'a' -> promotes it to most-recently-used; now 'b' is the LRU.
    expect(cache.get('a@s.whatsapp.net')).not.toBeUndefined();

    cache.update('c@s.whatsapp.net', { status: 'available' });

    expect(cache.get('b@s.whatsapp.net')).toBeUndefined();
    expect(cache.get('a@s.whatsapp.net')).not.toBeUndefined();
    expect(cache.get('c@s.whatsapp.net')).not.toBeUndefined();
  });

  it('re-updating an existing key at capacity does not evict (delete-then-reinsert)', () => {
    const cache = new PresenceCache(2);
    cache.update('a@s.whatsapp.net', { status: 'available' });
    cache.update('b@s.whatsapp.net', { status: 'available' });

    // Updating an existing key: it is deleted first, so size drops below cap
    // before the capacity check — no eviction, both keys remain.
    cache.update('a@s.whatsapp.net', { status: 'composing' });

    expect(cache.size).toBe(2);
    expect(cache.get('a@s.whatsapp.net')!.status).toBe('composing');
    expect(cache.get('b@s.whatsapp.net')).not.toBeUndefined();
  });
});

describe('PresenceCache — getAll over populated entries', () => {
  afterEach(() => vi.useRealTimers());

  it('yields every entry with a fresh stale=false flag', () => {
    const cache = new PresenceCache();
    cache.update('a@s.whatsapp.net', { status: 'available' });
    cache.update('b@s.whatsapp.net', { status: 'unavailable', lastSeen: 1700000000 });

    const all = Array.from(cache.getAll());
    expect(all.map(([jid]) => jid).sort()).toEqual(['a@s.whatsapp.net', 'b@s.whatsapp.net']);
    for (const [, entry] of all) {
      expect(entry.stale).toBe(false);
      expect(typeof entry.updatedAt).toBe('number');
    }
    const bEntry = all.find(([jid]) => jid === 'b@s.whatsapp.net')![1];
    expect(bEntry.lastSeen).toBe(1700000000);
  });

  it('marks entries stale in getAll() after the 5-minute threshold', () => {
    vi.useFakeTimers();
    const cache = new PresenceCache();
    cache.update('a@s.whatsapp.net', { status: 'available' });

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const [[, entry]] = Array.from(cache.getAll());
    expect(entry.stale).toBe(true);
  });
});
