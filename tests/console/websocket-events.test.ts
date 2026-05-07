import { describe, it, expect } from 'vitest';
import {
  getFleetWebSocketUrl,
  getInvalidationKeys,
  applyTypingUpdate,
  type TypingEntry,
  type WsTypingEvent,
} from '../../console/src/lib/realtime-events';

describe('getFleetWebSocketUrl', () => {
  it('returns wss: for https: pages', () => {
    const url = getFleetWebSocketUrl({ protocol: 'https:', host: 'fleet.example.com' }, 'tok123');
    expect(url).toBe('wss://fleet.example.com/ws?token=tok123');
  });

  it('returns ws: for http: pages', () => {
    const url = getFleetWebSocketUrl({ protocol: 'http:', host: 'localhost:9099' }, 'abc');
    expect(url).toBe('ws://localhost:9099/ws?token=abc');
  });

  it('returns null when no token', () => {
    expect(getFleetWebSocketUrl({ protocol: 'http:', host: 'localhost' }, null)).toBeNull();
  });

  it('encodes token in URL', () => {
    const url = getFleetWebSocketUrl({ protocol: 'http:', host: 'localhost' }, 'a b+c');
    expect(url).toContain('token=a%20b%2Bc');
  });
});

describe('getInvalidationKeys', () => {
  it('maps instance_status to lines queries', () => {
    const keys = getInvalidationKeys({ type: 'instance_status', instance: 'q' });
    expect(keys).toEqual([['lines'], ['lines', 'q']]);
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
