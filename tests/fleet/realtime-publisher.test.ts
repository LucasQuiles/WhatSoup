/**
 * Direct unit coverage for src/fleet/realtime-publisher.ts.
 *
 * The module ships 8 typed helpers that route handlers call instead of
 * constructing WsEvent objects inline.
 * Existing tests reference the module indirectly via the realtime-event-poller
 * suites; this file pins the event-shape contract per helper.
 *
 * Tests use a recording fake `FleetRealtimePublisher` so no WebSocket
 * server is needed.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  publishInstanceStatus,
  publishMessageReceived,
  publishChatUpdated,
  publishAccessChanged,
  publishLogChanged,
  publishFeedEvent,
  publishLidConflict,
  publishTypingUpdate,
  type FleetRealtimePublisher,
} from '../../src/fleet/realtime-publisher.ts';

/** Test-only recording publisher — captures every event passed to publish(). */
function makeRecordingPublisher(): FleetRealtimePublisher & {
  events: ReadonlyArray<unknown>;
} {
  const events: unknown[] = [];
  return {
    events,
    publish(event) {
      events.push(event);
    },
  } as FleetRealtimePublisher & { events: ReadonlyArray<unknown> };
}

describe('publishInstanceStatus', () => {
  it('publishes { type: "instance_status", instance }', () => {
    const pub = makeRecordingPublisher();
    publishInstanceStatus(pub, 'alpha');
    expect(pub.events).toEqual([{ type: 'instance_status', instance: 'alpha' }]);
  });
});

describe('publishMessageReceived', () => {
  it('publishes minimal event when no optional args', () => {
    const pub = makeRecordingPublisher();
    publishMessageReceived(pub, 'alpha');
    expect(pub.events).toEqual([{ type: 'message_received', instance: 'alpha' }]);
  });

  it('adds conversationKey when provided', () => {
    const pub = makeRecordingPublisher();
    publishMessageReceived(pub, 'alpha', 'conv-key-123');
    expect(pub.events).toEqual([
      { type: 'message_received', instance: 'alpha', conversationKey: 'conv-key-123' },
    ]);
  });

  it('adds messagePk when provided', () => {
    const pub = makeRecordingPublisher();
    publishMessageReceived(pub, 'alpha', undefined, 42);
    expect(pub.events).toEqual([{ type: 'message_received', instance: 'alpha', messagePk: 42 }]);
  });

  it('adds both conversationKey and messagePk when provided', () => {
    const pub = makeRecordingPublisher();
    publishMessageReceived(pub, 'alpha', 'conv-key', 99);
    expect(pub.events).toEqual([
      { type: 'message_received', instance: 'alpha', conversationKey: 'conv-key', messagePk: 99 },
    ]);
  });

  it('treats messagePk=0 as present (not omitted)', () => {
    // Optional-chaining `!== undefined` check means 0 is preserved.
    const pub = makeRecordingPublisher();
    publishMessageReceived(pub, 'alpha', undefined, 0);
    expect(pub.events).toEqual([{ type: 'message_received', instance: 'alpha', messagePk: 0 }]);
  });
});

describe('publishChatUpdated', () => {
  it('publishes without conversationKey when not provided', () => {
    const pub = makeRecordingPublisher();
    publishChatUpdated(pub, 'alpha');
    expect(pub.events).toEqual([{ type: 'chat_updated', instance: 'alpha' }]);
  });

  it('adds conversationKey when provided', () => {
    const pub = makeRecordingPublisher();
    publishChatUpdated(pub, 'alpha', 'conv-key');
    expect(pub.events).toEqual([
      { type: 'chat_updated', instance: 'alpha', conversationKey: 'conv-key' },
    ]);
  });
});

describe('publishAccessChanged / publishLogChanged / publishFeedEvent', () => {
  it('each emits its respective event type with instance only', () => {
    const pub = makeRecordingPublisher();
    publishAccessChanged(pub, 'alpha');
    publishLogChanged(pub, 'beta');
    publishFeedEvent(pub, 'gamma');
    expect(pub.events).toEqual([
      { type: 'access_changed', instance: 'alpha' },
      { type: 'log_entry', instance: 'beta' },
      { type: 'feed_event', instance: 'gamma' },
    ]);
  });
});

describe('publishLidConflict', () => {
  it('adds lid when non-empty', () => {
    const pub = makeRecordingPublisher();
    publishLidConflict(pub, 'alpha', '12345');
    expect(pub.events).toEqual([{ type: 'lid_conflict', instance: 'alpha', lid: '12345' }]);
  });

  it('omits lid when empty string (truthy check)', () => {
    const pub = makeRecordingPublisher();
    publishLidConflict(pub, 'alpha', '');
    expect(pub.events).toEqual([{ type: 'lid_conflict', instance: 'alpha' }]);
  });
});

describe('publishTypingUpdate', () => {
  it('emits a typing_update event with all fields + an integer since timestamp', () => {
    const pub = makeRecordingPublisher();
    // Freeze time to make the `since` field deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T10:00:00Z'));
    try {
      publishTypingUpdate(pub, 'alpha', '15551234567@s.whatsapp.net', true);
      expect(pub.events).toEqual([
        {
          type: 'typing_update',
          instance: 'alpha',
          jid: '15551234567@s.whatsapp.net',
          composing: true,
          since: new Date('2026-05-12T10:00:00Z').getTime(),
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates composing=false', () => {
    const pub = makeRecordingPublisher();
    publishTypingUpdate(pub, 'alpha', '15551234567@s.whatsapp.net', false);
    expect((pub.events[0] as { composing: boolean }).composing).toBe(false);
  });
});
