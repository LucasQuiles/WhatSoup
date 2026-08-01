// tests/transport/imessage/read-receipts.test.ts
// #2189 — iMessage inbound read-receipt subscriptions: the adapter advertises
// `read-receipts` and exposes `on("read", ...)`, but nothing emitted into the
// listener set. These tests verify the emit site is wired and handles dedupe,
// restart-safe filtering, identity preservation, and unsupported backends.

import { describe, it, expect } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import {
  MockImessagePort,
  makeImessageConfig,
} from './mock-port.ts';
import type { ReadEvent } from '../../../src/transport/contract/events.ts';
import type { InboundImessage } from '../../../src/transport/imessage/port.ts';

function makeAdapter(port: MockImessagePort = new MockImessagePort()) {
  const adapter = new ImessageAdapter(makeImessageConfig({ pollIntervalMs: 0 }), port);
  return { adapter, port };
}

/** A standard outbound (fromMe: true) text record with an optional dateRead. */
function outboundEnvelope(overrides: Partial<InboundImessage> = {}): InboundImessage {
  return {
    guid: 'out-1',
    from: 'bot@example.com',
    to: 'peer@users.noreply.github.com',
    body: 'hello',
    fromMe: true,
    kind: 'text',
    timestamp: 5000,
    ...overrides,
  };
}

describe('ImessageAdapter — inbound read receipts (#2189)', () => {

  // ── Backend normalization ──────────────────────────────────────────────

  describe('backend normalization', () => {
    it('emits ReadEvent when an outbound message carries dateRead', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      // lastPolledAt is set to (now - pollIntervalMs) = now - 0 = now on
      // connect when pollIntervalMs === 0. Use a dateRead in the future to
      // clear the restart-dedup filter.
      const dateRead = Date.now() + 10_000;
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'out-read',
        dateRead,
      }));

      expect(received).toHaveLength(1);
      expect(received[0].target.id).toBe('out-read');
      expect(received[0].reader.id).toBe('peer@users.noreply.github.com');
      expect(received[0].at.getTime()).toBe(dateRead);
      await adapter.disconnect();
    });

    it('does not emit when dateRead is absent (unread message)', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      adapter.handleInboundRecord(outboundEnvelope({ guid: 'out-unread' }));

      expect(received).toHaveLength(0);
      await adapter.disconnect();
    });

    it('does not emit when dateRead is 0 or negative', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      adapter.handleInboundRecord(outboundEnvelope({ guid: 'out-zero', dateRead: 0 }));
      adapter.handleInboundRecord(outboundEnvelope({ guid: 'out-neg', dateRead: -1 }));

      expect(received).toHaveLength(0);
      await adapter.disconnect();
    });

    it('does not emit for inbound messages (fromMe: false) with dateRead', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      const dateRead = Date.now() + 10_000;
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'in-1',
        fromMe: false,
        from: 'peer@users.noreply.github.com',
        to: 'bot@example.com',
        dateRead,
      }));

      expect(received).toHaveLength(0);
      await adapter.disconnect();
    });
  });

  // ── Exactly-once dedupe ────────────────────────────────────────────────

  describe('dedupe', () => {
    it('emits exactly once for the same guid across multiple deliveries', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      const dateRead = Date.now() + 10_000;
      const record = outboundEnvelope({ guid: 'out-dedupe', dateRead });

      adapter.handleInboundRecord(record);
      adapter.handleInboundRecord(record);
      adapter.handleInboundRecord(record);

      expect(received).toHaveLength(1);
      await adapter.disconnect();
    });

    it('emits for distinct guids independently', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      const dateRead = Date.now() + 10_000;
      adapter.handleInboundRecord(outboundEnvelope({ guid: 'out-a', dateRead }));
      adapter.handleInboundRecord(outboundEnvelope({ guid: 'out-b', dateRead }));

      expect(received).toHaveLength(2);
      expect(received[0].target.id).toBe('out-a');
      expect(received[1].target.id).toBe('out-b');
      await adapter.disconnect();
    });
  });

  // ── Restart-safe time filter ───────────────────────────────────────────

  describe('restart dedup', () => {
    it('suppresses reads that predate the current session', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();

      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      // dateRead well before session start (epoch near zero) — suppressed by
      // the sessionStartedAt filter so a restart never replays old reads.
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'out-stale',
        dateRead: 1,
      }));

      expect(received).toHaveLength(0);
      await adapter.disconnect();
    });

    it('emits for a dateRead that falls after session start', async () => {
      const port = new MockImessagePort();
      const adapter = new ImessageAdapter(
        makeImessageConfig({ pollIntervalMs: 60_000 }),
        port,
      );
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      // dateRead 5 seconds after connect — past sessionStartedAt, passes.
      const recentDateRead = Date.now() + 5_000;
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'out-recent',
        dateRead: recentDateRead,
      }));

      expect(received).toHaveLength(1);
      await adapter.disconnect();
    });
  });

  // ── Identity preservation (direct + group) ─────────────────────────────

  describe('identity', () => {
    it('sets reader to the peer for 1:1 conversations', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      const dateRead = Date.now() + 10_000;
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'out-dm',
        to: 'alice@users.noreply.github.com',
        dateRead,
      }));

      expect(received).toHaveLength(1);
      expect(received[0].reader.id).toBe('alice@users.noreply.github.com');
      expect(received[0].target.conversation).toBe('alice@users.noreply.github.com');
      await adapter.disconnect();
    });

    it('sets reader to the group chat GUID for group conversations', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      const dateRead = Date.now() + 10_000;
      const groupGuid = 'iMessage;+;chat-abc123';
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'out-group',
        to: groupGuid,
        chatGuid: groupGuid,
        dateRead,
      }));

      expect(received).toHaveLength(1);
      expect(received[0].reader.id).toBe(groupGuid);
      expect(received[0].target.conversation).toBe(groupGuid);
      await adapter.disconnect();
    });

    it('preserves the outbound message ref as the read target', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      const dateRead = Date.now() + 10_000;
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'msg-guid-42',
        to: 'bob@users.noreply.github.com',
        dateRead,
      }));

      expect(received).toHaveLength(1);
      expect(received[0].target.id).toBe('msg-guid-42');
      await adapter.disconnect();
    });
  });

  // ── Unsupported backend ────────────────────────────────────────────────

  describe('unsupported backend', () => {
    it('does not emit when the backend returns no dateRead (imsg)', async () => {
      // The imsg backend does not populate dateRead on InboundImessage.
      // The adapter must silently no-op rather than crash.
      const { adapter } = makeAdapter();
      await adapter.connect();
      const received: ReadEvent[] = [];
      adapter.on('read', (e) => received.push(e));

      // Simulate an imsg record: fromMe: true but dateRead is undefined.
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'imsg-no-read',
        dateRead: undefined,
      }));

      expect(received).toHaveLength(0);
      await adapter.disconnect();
    });

    it('still processes text events for records that also carry dateRead', async () => {
      // An outbound message with both a body and dateRead should emit BOTH
      // a message event (text echo) and a read event. This verifies the
      // read-receipt path does not interfere with text processing.
      const { adapter } = makeAdapter();
      await adapter.connect();
      const readEvents: ReadEvent[] = [];
      const messageEvents: { text: string }[] = [];
      adapter.on('read', (e) => readEvents.push(e));
      // The message listener receives InboundMessage — use a loose type.
      adapter.on('message', ((m: { text: string }) => messageEvents.push(m)) as never);

      const dateRead = Date.now() + 10_000;
      adapter.handleInboundRecord(outboundEnvelope({
        guid: 'dual-emit',
        body: 'sent text',
        dateRead,
      }));

      expect(readEvents).toHaveLength(1);
      expect(messageEvents).toHaveLength(1);
      expect(messageEvents[0].text).toBe('sent text');
      await adapter.disconnect();
    });
  });
});
