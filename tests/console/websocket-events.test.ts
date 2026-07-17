import { describe, it, expect, vi } from 'vitest';
import {
  getFleetWebSocketUrl,
  getInvalidationKeys,
  applyTypingUpdate,
  parseWsEvent,
  type TypingEntry,
  type WsTypingEvent,
} from '../../console/src/lib/realtime-events';

describe('getFleetWebSocketUrl', () => {
  function fetcher(ticket: string) {
    return () => Promise.resolve({ ticket, expiresIn: 60 });
  }

  it('returns a wss: ticket URL for https: pages', async () => {
    const url = await getFleetWebSocketUrl(
      { protocol: 'https:', host: 'fleet.example.com' },
      fetcher('tkt-1'),
    );
    expect(url).toBe('wss://fleet.example.com/ws?ticket=tkt-1');
  });

  it('returns a ws: ticket URL for http: pages', async () => {
    const url = await getFleetWebSocketUrl(
      { protocol: 'http:', host: 'localhost:9099' },
      fetcher('tkt-2'),
    );
    expect(url).toBe('ws://localhost:9099/ws?ticket=tkt-2');
  });

  it('returns null when the ticket fetcher rejects', async () => {
    const fetchTicket = vi.fn(() => Promise.reject(new Error('unauthorized')));
    const url = await getFleetWebSocketUrl(
      { protocol: 'http:', host: 'localhost' },
      fetchTicket,
    );
    expect(url).toBeNull();
    // Strengthen the null-path: fetcher invoked exactly once, no URL constructed.
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    expect(typeof url === 'string' && /^wss?:/.test(url)).toBe(false);
  });

  it('returns null when the ticket payload is empty', async () => {
    const fetchTicket = vi.fn(() => Promise.resolve({ ticket: '', expiresIn: 60 }));
    const url = await getFleetWebSocketUrl(
      { protocol: 'http:', host: 'localhost' },
      fetchTicket,
    );
    expect(url).toBeNull();
    // Strengthen the null-path: fetcher invoked exactly once, no URL constructed.
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    expect(typeof url === 'string' && /^wss?:/.test(url)).toBe(false);
  });

  it('encodes the ticket payload', async () => {
    const url = await getFleetWebSocketUrl(
      { protocol: 'http:', host: 'localhost' },
      fetcher('a b+c'),
    );
    expect(url).toContain('ticket=a%20b%2Bc');
  });
});

describe('getInvalidationKeys', () => {
  it('maps instance_status to lines, provider-status, and feed queries (#1882 criterion 4)', () => {
    const keys = getInvalidationKeys({ type: 'instance_status', instance: 'q' });
    // The feed also carries a synthesized transition for this status change
    // (src/fleet/routes/feed.ts), so it must invalidate alongside the lines.
    expect(keys).toEqual([['lines'], ['lines', 'q'], ['provider-status', 'q'], ['feed']]);
  });

  it('maps message_received to messages, chats, and history search', () => {
    const keys = getInvalidationKeys({ type: 'message_received', instance: 'q' });
    expect(keys).toEqual([['messages', 'q'], ['chats', 'q'], ['search', 'q']]);
  });

  it('maps feed_event to feed', () => {
    const keys = getInvalidationKeys({ type: 'feed_event', instance: 'q' });
    expect(keys).toEqual([['feed']]);
  });

  it('maps access_changed to access', () => {
    const keys = getInvalidationKeys({ type: 'access_changed', instance: 'q' });
    expect(keys).toEqual([['access', 'q']]);
  });

  it('maps lid_conflict to fleet LID mapping queries', () => {
    const keys = getInvalidationKeys({ type: 'lid_conflict', instance: 'q', lid: 'lid-1' });
    expect(keys).toEqual([['lid-mappings']]);
  });
});

describe('applyTypingUpdate', () => {
  it('adds a new typing entry on composing=true', () => {
    const event: WsTypingEvent = { type: 'typing_update', instance: 'q', jid: '123@s.whatsapp.net', composing: true, since: 1000 };
    const result = applyTypingUpdate([], event);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ instance: 'q', jid: '123@s.whatsapp.net', since: 1000 });
  });

  it('updates an existing entry on composing=true', () => {
    const prev: TypingEntry[] = [{ instance: 'q', jid: '123@s.whatsapp.net', since: 500 }];
    const event: WsTypingEvent = { type: 'typing_update', instance: 'q', jid: '123@s.whatsapp.net', composing: true, since: 1000 };
    const result = applyTypingUpdate(prev, event);
    expect(result).toHaveLength(1);
    expect(result[0].since).toBe(1000);
  });

  it('removes entry on composing=false', () => {
    const prev: TypingEntry[] = [{ instance: 'q', jid: '123@s.whatsapp.net', since: 500 }];
    const event: WsTypingEvent = { type: 'typing_update', instance: 'q', jid: '123@s.whatsapp.net', composing: false, since: 0 };
    const result = applyTypingUpdate(prev, event);
    expect(result).toHaveLength(0);
  });

  it('handles undefined previous', () => {
    const event: WsTypingEvent = { type: 'typing_update', instance: 'q', jid: '123@s.whatsapp.net', composing: true, since: 1000 };
    const result = applyTypingUpdate(undefined, event);
    expect(result).toHaveLength(1);
  });
});

describe('parseWsEvent', () => {
  it('returns null for frames that are not valid JSON objects', () => {
    expect(parseWsEvent('not json')).toBeNull();
    expect(parseWsEvent('null')).toBeNull();
    expect(parseWsEvent('[]')).toBeNull();
  });

  it('accepts valid connected and invalidation events', () => {
    expect(parseWsEvent('{"type":"connected","timestamp":1000}')).toEqual({
      type: 'connected',
      timestamp: 1000,
    });
    expect(parseWsEvent('{"type":"message_received","instance":"q","conversationKey":"123"}')).toEqual({
      type: 'message_received',
      instance: 'q',
      conversationKey: '123',
    });
    expect(parseWsEvent('{"type":"lid_conflict","instance":"q","lid":"lid-1"}')).toEqual({
      type: 'lid_conflict',
      instance: 'q',
      lid: 'lid-1',
    });
  });

  it('rejects invalid event payload shapes', () => {
    expect(parseWsEvent('{"type":"connected","timestamp":"soon"}')).toBeNull();
    expect(parseWsEvent('{"type":"message_received","instance":""}')).toBeNull();
    expect(parseWsEvent('{"type":"typing_update","instance":"q","jid":"","composing":true,"since":1}')).toBeNull();
    expect(parseWsEvent('{"type":"typing_update","instance":"q","jid":"123@s.whatsapp.net","composing":"yes","since":1}')).toBeNull();
  });
});
