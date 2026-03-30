import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PresenceCache } from '../../src/transport/presence-cache.ts';

describe('PresenceCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves a presence entry', () => {
    const cache = new PresenceCache();
    cache.update('15551234567@s.whatsapp.net', { status: 'available' });

    const result = cache.get('15551234567@s.whatsapp.net');
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('available');
    expect(result!.stale).toBe(false);
  });

  it('stores and retrieves lastSeen when provided', () => {
    const cache = new PresenceCache();
    cache.update('15551234567@s.whatsapp.net', { status: 'unavailable', lastSeen: 1700000000 });

    const result = cache.get('15551234567@s.whatsapp.net');
    expect(result).not.toBeUndefined();
    expect(result!.lastSeen).toBe(1700000000);
  });

  it('returns undefined for unknown JID', () => {
    const cache = new PresenceCache();
    const result = cache.get('unknown@s.whatsapp.net');
    expect(result).toBeUndefined();
  });

  it('entry is not stale immediately after update', () => {
    vi.useFakeTimers();

    const cache = new PresenceCache();
    cache.update('15551234567@s.whatsapp.net', { status: 'available' });

    const result = cache.get('15551234567@s.whatsapp.net');
    expect(result!.stale).toBe(false);
  });

  it('entry is stale after 5 minutes', () => {
    vi.useFakeTimers();

    const cache = new PresenceCache();
    cache.update('15551234567@s.whatsapp.net', { status: 'available' });

    // Advance exactly 5 minutes + 1ms
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const result = cache.get('15551234567@s.whatsapp.net');
    expect(result).not.toBeUndefined();
    expect(result!.stale).toBe(true);
  });

  it('entry is not stale at 4m 59s', () => {
    vi.useFakeTimers();

    const cache = new PresenceCache();
    cache.update('15551234567@s.whatsapp.net', { status: 'available' });

    // Advance just under 5 minutes
    vi.advanceTimersByTime(4 * 60 * 1000 + 59_000);

    const result = cache.get('15551234567@s.whatsapp.net');
    expect(result!.stale).toBe(false);
  });

  it('update refreshes the staleness timestamp', () => {
    vi.useFakeTimers();

    const cache = new PresenceCache();
    cache.update('15551234567@s.whatsapp.net', { status: 'available' });

    // Advance 4 minutes — not stale yet
    vi.advanceTimersByTime(4 * 60 * 1000);

    // Re-update the entry
    cache.update('15551234567@s.whatsapp.net', { status: 'composing' });

    // Advance another 4 minutes — total 8min from first update, but only 4min from second
    vi.advanceTimersByTime(4 * 60 * 1000);

    const result = cache.get('15551234567@s.whatsapp.net');
    expect(result!.status).toBe('composing');
    expect(result!.stale).toBe(false); // 4 min from last update, not stale
  });

  it('tracks multiple JIDs independently', () => {
    const cache = new PresenceCache();
    cache.update('alice@s.whatsapp.net', { status: 'available' });
    cache.update('bob@s.whatsapp.net', { status: 'unavailable', lastSeen: 1700000000 });

    expect(cache.get('alice@s.whatsapp.net')!.status).toBe('available');
    expect(cache.get('bob@s.whatsapp.net')!.status).toBe('unavailable');
    expect(cache.get('charlie@s.whatsapp.net')).toBeUndefined();
  });
});
