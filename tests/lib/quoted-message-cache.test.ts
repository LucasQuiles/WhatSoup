import { describe, expect, it, vi } from 'vitest';

import { createQuotedMessageCache } from '../../src/lib/quoted-message-cache.ts';

describe('createQuotedMessageCache', () => {
  it('stores and retrieves metadata', () => {
    const cache = createQuotedMessageCache();
    cache.cache('acct-1', 'jid-1', 'msg-1', {
      participant: 'p',
      participantE164: '+1234',
      body: 'hello',
      fromMe: false,
    });
    expect(cache.lookup('acct-1', 'jid-1', 'msg-1')).toEqual({
      participant: 'p',
      participantE164: '+1234',
      body: 'hello',
      fromMe: false,
    });
  });

  it('returns undefined for a missing key', () => {
    const cache = createQuotedMessageCache();
    expect(cache.lookup('a', 'b', 'nope')).toBeUndefined();
  });

  it('isolates entries by accountId', () => {
    const cache = createQuotedMessageCache();
    cache.cache('acct-1', 'jid-1', 'msg-1', { body: 'one' });
    cache.cache('acct-2', 'jid-1', 'msg-1', { body: 'two' });
    expect(cache.lookup('acct-1', 'jid-1', 'msg-1')?.body).toBe('one');
    expect(cache.lookup('acct-2', 'jid-1', 'msg-1')?.body).toBe('two');
  });

  it('isolates entries by remoteJid', () => {
    const cache = createQuotedMessageCache();
    cache.cache('acct-1', 'jid-1', 'msg-1', { body: 'a' });
    cache.cache('acct-1', 'jid-2', 'msg-1', { body: 'b' });
    expect(cache.lookup('acct-1', 'jid-1', 'msg-1')?.body).toBe('a');
    expect(cache.lookup('acct-1', 'jid-2', 'msg-1')?.body).toBe('b');
  });

  it('isolates entries by messageId', () => {
    const cache = createQuotedMessageCache();
    cache.cache('acct-1', 'jid-1', 'msg-1', { body: 'x' });
    cache.cache('acct-1', 'jid-1', 'msg-2', { body: 'y' });
    expect(cache.lookup('acct-1', 'jid-1', 'msg-1')?.body).toBe('x');
    expect(cache.lookup('acct-1', 'jid-1', 'msg-2')?.body).toBe('y');
  });

  it('overwrites an existing key on re-cache', () => {
    const cache = createQuotedMessageCache();
    cache.cache('a', 'b', 'c', { body: 'old' });
    cache.cache('a', 'b', 'c', { body: 'new' });
    expect(cache.lookup('a', 'b', 'c')?.body).toBe('new');
  });

  it('ignores cache calls with empty accountId', () => {
    const cache = createQuotedMessageCache();
    cache.cache('', 'b', 'c', { body: 'x' });
    expect(cache.size()).toBe(0);
  });

  it('ignores cache calls with empty remoteJid', () => {
    const cache = createQuotedMessageCache();
    cache.cache('a', '', 'c', { body: 'x' });
    expect(cache.size()).toBe(0);
  });

  it('ignores cache calls with empty messageId', () => {
    const cache = createQuotedMessageCache();
    cache.cache('a', 'b', '', { body: 'x' });
    expect(cache.size()).toBe(0);
  });

  it('returns undefined after TTL expiry', () => {
    let clock = 1000;
    const cache = createQuotedMessageCache({ ttlMs: 5000, now: () => clock });
    cache.cache('a', 'b', 'c', { body: 'expiring' });
    expect(cache.lookup('a', 'b', 'c')?.body).toBe('expiring');
    clock += 4000;
    expect(cache.lookup('a', 'b', 'c')?.body).toBe('expiring');
    clock += 1001;
    expect(cache.lookup('a', 'b', 'c')).toBeUndefined();
  });

  it('deletes the entry on TTL-expired lookup', () => {
    let clock = 0;
    const cache = createQuotedMessageCache({ ttlMs: 100, now: () => clock });
    cache.cache('a', 'b', 'c', { body: 'gone' });
    clock += 200;
    cache.lookup('a', 'b', 'c');
    expect(cache.size()).toBe(0);
  });

  it('evicts the oldest entry when maxEntries is reached', () => {
    const cache = createQuotedMessageCache({ maxEntries: 2 });
    cache.cache('a', 'j', 'm1', { body: '1' });
    cache.cache('a', 'j', 'm2', { body: '2' });
    cache.cache('a', 'j', 'm3', { body: '3' });
    expect(cache.lookup('a', 'j', 'm1')).toBeUndefined();
    expect(cache.lookup('a', 'j', 'm2')?.body).toBe('2');
    expect(cache.lookup('a', 'j', 'm3')?.body).toBe('3');
  });

  it('does not evict when at but not exceeding capacity via overwrite', () => {
    const cache = createQuotedMessageCache({ maxEntries: 2 });
    cache.cache('a', 'j', 'm1', { body: '1' });
    cache.cache('a', 'j', 'm2', { body: '2' });
    cache.cache('a', 'j', 'm2', { body: '2-updated' });
    expect(cache.lookup('a', 'j', 'm1')?.body).toBe('1');
    expect(cache.lookup('a', 'j', 'm2')?.body).toBe('2-updated');
  });

  it('size() counts only live entries', () => {
    let clock = 0;
    const cache = createQuotedMessageCache({ ttlMs: 100, now: () => clock });
    cache.cache('a', 'j', 'm1', { body: '1' });
    cache.cache('a', 'j', 'm2', { body: '2' });
    expect(cache.size()).toBe(2);
    clock += 200;
    expect(cache.size()).toBe(0);
  });

  it('size() purges stale entries lazily', () => {
    let clock = 0;
    const cache = createQuotedMessageCache({ ttlMs: 100, now: () => clock });
    cache.cache('a', 'j', 'm1', { body: '1' });
    clock += 50;
    cache.cache('a', 'j', 'm2', { body: '2' });
    clock += 60; // m1 is now expired (110ms old), m2 is fresh (10ms old)
    expect(cache.size()).toBe(1);
  });

  it('clear() removes all entries', () => {
    const cache = createQuotedMessageCache();
    cache.cache('a', 'b', 'c', { body: 'x' });
    cache.cache('a', 'b', 'd', { body: 'y' });
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.lookup('a', 'b', 'c')).toBeUndefined();
  });

  it('stores partial metadata (only fromMe)', () => {
    const cache = createQuotedMessageCache();
    cache.cache('a', 'b', 'c', { fromMe: true });
    expect(cache.lookup('a', 'b', 'c')).toEqual({ fromMe: true });
  });

  it('stores empty metadata object', () => {
    const cache = createQuotedMessageCache();
    cache.cache('a', 'b', 'c', {});
    expect(cache.lookup('a', 'b', 'c')).toEqual({});
  });

  it('uses default TTL of 10 minutes', () => {
    let clock = 0;
    const cache = createQuotedMessageCache({ now: () => clock });
    cache.cache('a', 'b', 'c', { body: 'x' });
    clock += 599_999;
    expect(cache.lookup('a', 'b', 'c')?.body).toBe('x');
    clock += 2;
    expect(cache.lookup('a', 'b', 'c')).toBeUndefined();
  });

  it('uses default maxEntries of 500', () => {
    const cache = createQuotedMessageCache();
    for (let i = 0; i < 600; i++) {
      cache.cache('a', 'j', `m${i}`, { body: String(i) });
    }
    // oldest 100 evicted
    expect(cache.lookup('a', 'j', 'm0')).toBeUndefined();
    expect(cache.lookup('a', 'j', 'm99')).toBeUndefined();
    expect(cache.lookup('a', 'j', 'm100')?.body).toBe('100');
    expect(cache.lookup('a', 'j', 'm599')?.body).toBe('599');
  });

  it('does not mutate the input meta object', () => {
    const cache = createQuotedMessageCache();
    const meta = { body: 'original', fromMe: false };
    cache.cache('a', 'b', 'c', meta);
    // The cache copies meta internally; mutating after should not affect the cache.
    meta.body = 'mutated';
    expect(cache.lookup('a', 'b', 'c')?.body).toBe('original');
  });

  it('handles multiple independent cache instances', () => {
    const c1 = createQuotedMessageCache();
    const c2 = createQuotedMessageCache();
    c1.cache('a', 'b', 'c', { body: 'from-c1' });
    expect(c2.lookup('a', 'b', 'c')).toBeUndefined();
    c2.cache('a', 'b', 'c', { body: 'from-c2' });
    expect(c1.lookup('a', 'b', 'c')?.body).toBe('from-c1');
    expect(c2.lookup('a', 'b', 'c')?.body).toBe('from-c2');
  });
});
