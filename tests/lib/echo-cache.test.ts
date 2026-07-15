import { describe, expect, it, vi } from 'vitest';

import { createEchoCache, normalizeEchoText } from '../../src/lib/echo-cache.ts';

// ── normalizeEchoText ──────────────────────────────────────────────────────

describe('normalizeEchoText', () => {
  it('returns clean text unchanged', () => {
    expect(normalizeEchoText('hello world')).toBe('hello world');
  });

  it('strips NUL characters', () => {
    expect(normalizeEchoText('hel\u0000lo')).toBe('hello');
  });

  it('strips BOM', () => {
    expect(normalizeEchoText('\uFEFFhello')).toBe('hello');
  });

  it('strips replacement character', () => {
    expect(normalizeEchoText('hel\uFFFDlo')).toBe('hello');
  });

  it('strips noncharacters (U+FFFE, U+FFFF)', () => {
    expect(normalizeEchoText('a\uFFFEb\uFFFFc')).toBe('abc');
  });

  it('strips multiple corruption markers', () => {
    expect(normalizeEchoText('\u0000\uFEFFhi\uFFFD\uFFFE\uFFFF')).toBe('hi');
  });

  it('handles empty string', () => {
    expect(normalizeEchoText('')).toBe('');
  });
});

// ── createEchoCache — record + check ──────────────────────────────────────

describe('createEchoCache — basic record and check', () => {
  it('detects an echo by text match', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    const result = cache.check({ conversationKey: 'chat1', text: 'Hello!' });
    expect(result.isEcho).toBe(true);
    expect(result.matchedBy).toBe('text');
    expect(result.entry?.text).toBe('Hello!');
  });

  it('detects an echo by message-ID match', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'Hello!', messageId: 'msg123' });
    const result = cache.check({ conversationKey: 'chat1', messageId: 'msg123' });
    expect(result.isEcho).toBe(true);
    expect(result.matchedBy).toBe('id');
  });

  it('prefers ID match over text match', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'Hello!', messageId: 'msg123' });
    const result = cache.check({ conversationKey: 'chat1', text: 'Hello!', messageId: 'msg123' });
    expect(result.isEcho).toBe(true);
    expect(result.matchedBy).toBe('id');
  });

  it('returns isEcho=false for unmatched text', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    const result = cache.check({ conversationKey: 'chat1', text: 'Goodbye!' });
    expect(result.isEcho).toBe(false);
  });

  it('returns isEcho=false for unmatched conversationKey', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    const result = cache.check({ conversationKey: 'chat2', text: 'Hello!' });
    expect(result.isEcho).toBe(false);
  });

  it('returns isEcho=false for empty cache', () => {
    const cache = createEchoCache();
    const result = cache.check({ conversationKey: 'chat1', text: 'anything' });
    expect(result.isEcho).toBe(false);
  });

  it('returns isEcho=false when neither text nor messageId provided', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    const result = cache.check({ conversationKey: 'chat1' });
    expect(result.isEcho).toBe(false);
  });

  it('normalizes corruption markers in both record and check', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'hel\u0000lo' });
    const result = cache.check({ conversationKey: 'chat1', text: 'hello' });
    expect(result.isEcho).toBe(true);
  });
});

// ── TTL expiry ────────────────────────────────────────────────────────────

describe('createEchoCache — TTL expiry', () => {
  it('text entries expire after textTtlMs', () => {
    vi.useFakeTimers();
    const cache = createEchoCache({ textTtlMs: 100 });
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    vi.advanceTimersByTime(101);
    const result = cache.check({ conversationKey: 'chat1', text: 'Hello!' });
    expect(result.isEcho).toBe(false);
    vi.useRealTimers();
  });

  it('ID entries expire after idTtlMs', () => {
    vi.useFakeTimers();
    const cache = createEchoCache({ idTtlMs: 200 });
    cache.record({ conversationKey: 'chat1', text: 'Hi', messageId: 'msg1' });
    vi.advanceTimersByTime(201);
    const result = cache.check({ conversationKey: 'chat1', messageId: 'msg1' });
    expect(result.isEcho).toBe(false);
    vi.useRealTimers();
  });

  it('ID entries outlive text entries', () => {
    vi.useFakeTimers();
    const cache = createEchoCache({ textTtlMs: 100, idTtlMs: 500 });
    cache.record({ conversationKey: 'chat1', text: 'Hi', messageId: 'msg1' });
    vi.advanceTimersByTime(150); // text expired, ID still alive
    // Text check should fail
    expect(cache.check({ conversationKey: 'chat1', text: 'Hi' }).isEcho).toBe(false);
    // ID check should still succeed
    expect(cache.check({ conversationKey: 'chat1', messageId: 'msg1' }).isEcho).toBe(true);
    vi.useRealTimers();
  });
});

// ── confirmId ─────────────────────────────────────────────────────────────

describe('createEchoCache — confirmId', () => {
  it('promotes a text entry to the ID cache', () => {
    vi.useFakeTimers();
    const cache = createEchoCache({ textTtlMs: 100, idTtlMs: 1000 });
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    // Later, the platform assigns an ID
    cache.confirmId({ conversationKey: 'chat1', text: 'Hello!', messageId: 'msg456' });
    // After text TTL expires, ID should still match
    vi.advanceTimersByTime(150);
    const result = cache.check({ conversationKey: 'chat1', messageId: 'msg456' });
    expect(result.isEcho).toBe(true);
    expect(result.matchedBy).toBe('id');
    vi.useRealTimers();
  });

  it('works even if the text entry already expired', () => {
    vi.useFakeTimers();
    const cache = createEchoCache({ textTtlMs: 50, idTtlMs: 1000 });
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    vi.advanceTimersByTime(60); // text entry expired
    cache.confirmId({ conversationKey: 'chat1', text: 'Hello!', messageId: 'msg789' });
    const result = cache.check({ conversationKey: 'chat1', messageId: 'msg789' });
    expect(result.isEcho).toBe(true);
    vi.useRealTimers();
  });
});

// ── stats ─────────────────────────────────────────────────────────────────

describe('createEchoCache — stats', () => {
  it('reports zero entries initially', () => {
    const cache = createEchoCache();
    expect(cache.stats()).toEqual({ textEntries: 0, idEntries: 0 });
  });

  it('counts text entries', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'A' });
    cache.record({ conversationKey: 'chat2', text: 'B' });
    expect(cache.stats().textEntries).toBe(2);
    expect(cache.stats().idEntries).toBe(0);
  });

  it('counts ID entries', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'A', messageId: 'm1' });
    cache.record({ conversationKey: 'chat1', text: 'B', messageId: 'm2' });
    expect(cache.stats().textEntries).toBe(2);
    expect(cache.stats().idEntries).toBe(2);
  });

  it('updates after expiry', () => {
    vi.useFakeTimers();
    const cache = createEchoCache({ textTtlMs: 100 });
    cache.record({ conversationKey: 'chat1', text: 'A' });
    expect(cache.stats().textEntries).toBe(1);
    vi.advanceTimersByTime(101);
    expect(cache.stats().textEntries).toBe(0);
    vi.useRealTimers();
  });
});

// ── clear ─────────────────────────────────────────────────────────────────

describe('createEchoCache — clear', () => {
  it('removes all entries', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'A', messageId: 'm1' });
    cache.record({ conversationKey: 'chat2', text: 'B' });
    cache.clear();
    expect(cache.stats()).toEqual({ textEntries: 0, idEntries: 0 });
  });

  it('prevents future matches after clear', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'A' });
    cache.clear();
    expect(cache.check({ conversationKey: 'chat1', text: 'A' }).isEcho).toBe(false);
  });
});

// ── gc ────────────────────────────────────────────────────────────────────

describe('createEchoCache — gc', () => {
  it('evicts expired entries and returns count', () => {
    let fakeNow = 0;
    const cache = createEchoCache({ textTtlMs: 100, idTtlMs: 200, now: () => fakeNow });
    fakeNow = 0;
    cache.record({ conversationKey: 'chat1', text: 'A', messageId: 'm1' });
    cache.record({ conversationKey: 'chat2', text: 'B' });
    // Jump forward past text TTL but NOT past ID TTL — without advancing fake timers
    // so auto-expiry hasn't fired. gc() must clean up the stale text entries.
    fakeNow = 150;
    const evicted = cache.gc();
    expect(evicted).toBe(2); // 2 text entries
    expect(cache.stats().textEntries).toBe(0);
    expect(cache.stats().idEntries).toBe(1);
  });

  it('returns 0 when nothing to evict', () => {
    const cache = createEchoCache();
    expect(cache.gc()).toBe(0);
  });
});

// ── eviction on overflow ──────────────────────────────────────────────────

describe('createEchoCache — overflow eviction', () => {
  it('evicts oldest text entry when at capacity', () => {
    const cache = createEchoCache({ maxTextEntries: 2 });
    cache.record({ conversationKey: 'c1', text: 'A' });
    cache.record({ conversationKey: 'c2', text: 'B' });
    cache.record({ conversationKey: 'c3', text: 'C' });
    // Should have evicted the oldest (c1)
    expect(cache.stats().textEntries).toBe(2);
    expect(cache.check({ conversationKey: 'c1', text: 'A' }).isEcho).toBe(false);
    expect(cache.check({ conversationKey: 'c3', text: 'C' }).isEcho).toBe(true);
  });

  it('evicts oldest ID entry when at capacity', () => {
    const cache = createEchoCache({ maxIdEntries: 2 });
    cache.record({ conversationKey: 'c1', text: 'A', messageId: 'm1' });
    cache.record({ conversationKey: 'c2', text: 'B', messageId: 'm2' });
    cache.record({ conversationKey: 'c3', text: 'C', messageId: 'm3' });
    expect(cache.stats().idEntries).toBe(2);
    expect(cache.check({ conversationKey: 'c1', messageId: 'm1' }).isEcho).toBe(false);
    expect(cache.check({ conversationKey: 'c3', messageId: 'm3' }).isEcho).toBe(true);
  });
});

// ── same text in different conversations ─────────────────────────────────

describe('createEchoCache — conversation isolation', () => {
  it('same text in different conversations does not match', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    const result = cache.check({ conversationKey: 'chat2', text: 'Hello!' });
    expect(result.isEcho).toBe(false);
  });

  it('same messageId in different conversations does not match', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'A', messageId: 'msg1' });
    const result = cache.check({ conversationKey: 'chat2', messageId: 'msg1' });
    expect(result.isEcho).toBe(false);
  });
});

// ── multiple records ──────────────────────────────────────────────────────

describe('createEchoCache — multiple records', () => {
  it('handles rapid successive records', () => {
    const cache = createEchoCache();
    for (let i = 0; i < 100; i++) {
      cache.record({ conversationKey: 'chat1', text: `msg${i}`, messageId: `id${i}` });
    }
    expect(cache.stats().textEntries).toBe(100);
    expect(cache.stats().idEntries).toBe(100);
    // Last message should still be detected
    expect(cache.check({ conversationKey: 'chat1', text: 'msg99' }).isEcho).toBe(true);
    expect(cache.check({ conversationKey: 'chat1', messageId: 'id99' }).isEcho).toBe(true);
  });

  it('overwrites text entry on re-record (same key)', () => {
    const cache = createEchoCache();
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    cache.record({ conversationKey: 'chat1', text: 'Hello!' });
    expect(cache.stats().textEntries).toBe(1);
    expect(cache.check({ conversationKey: 'chat1', text: 'Hello!' }).isEcho).toBe(true);
  });
});
