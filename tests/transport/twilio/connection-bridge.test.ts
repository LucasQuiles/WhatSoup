// tests/transport/twilio/connection-bridge.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';

// Recorder for the bridge's child logger — vi.mock is hoisted, so the holder
// must be hoisted too. Only the 'twilio-bridge' child is intercepted.
const bridgeLogRecorder = vi.hoisted(() => ({
  onError: null as ((fields: Record<string, unknown>, msg: string) => void) | null,
}));
vi.mock('../../../src/logger.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/logger.ts')>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== 'twilio-bridge') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'error') {
            return (fields: Record<string, unknown>, msg: string) => {
              bridgeLogRecorder.onError?.(fields, msg);
              return (target as { error: (f: unknown, m: string) => unknown }).error(fields, msg);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});
import { TwilioConnection, UnsupportedTransportOperationError } from '../../../src/transport/twilio/connection-bridge.ts';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';
import type { TwilioSmsConfig } from '../../../src/transport/twilio/types.ts';
import { makeTwilioConfig } from './helpers.ts';
import type { IncomingMessage } from '../../../src/core/types.ts';
import type { InboundSms } from '../../../src/transport/twilio/port.ts';
import { withWarmIdentity } from '../../helpers/outbound-identity.ts';

afterEach(() => {
  vi.useRealTimers();
});

/** Config with a 1s poll interval so tests can advance fake timers to trigger a poll. */
const makeConfig = (overrides?: Partial<TwilioSmsConfig>): TwilioSmsConfig =>
  makeTwilioConfig({ pollIntervalMs: 1000, ...overrides });

function makeInboundSms(overrides?: Partial<InboundSms>): InboundSms {
  return {
    sid: 'SM000001',
    from: '+14155550100',
    to: '+15559990000',
    body: 'hello world',
    sentAt: new Date(0),
    fromMe: false,
    ...overrides,
  };
}

function makeBridge(configOverrides?: Partial<TwilioSmsConfig>): {
  bridge: TwilioConnection;
  port: MockTwilioSmsPort;
  adapter: TwilioSmsAdapter;
} {
  const port = new MockTwilioSmsPort();
  const adapter = new TwilioSmsAdapter(makeConfig(configOverrides), port);
  const bridge = withWarmIdentity(new TwilioConnection(adapter));
  return { bridge, port, adapter };
}

describe('TwilioConnection bridge', () => {
  describe('connect()', () => {
    it('calls adapter connect and emits historySyncComplete (deferred past connect resolution)', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge } = makeBridge();
      const events: string[] = [];

      await bridge.connect();
      // main.ts pattern: the once-listener registers AFTER connect() resolves;
      // the deferred emit must still reach it.
      bridge.once('historySyncComplete', () => events.push('historySyncComplete'));
      await vi.advanceTimersByTimeAsync(0);

      expect(events).toEqual(['historySyncComplete']);
    });

    it('sets botJid from adapter selfRef after connect', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge } = makeBridge();
      expect(bridge.botJid).toBeNull();

      await bridge.connect();

      expect(bridge.botJid).toBe('+15559990000@sms');
    });

    it('botLid is always null (LIDs are WhatsApp-specific)', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge } = makeBridge();
      await bridge.connect();
      expect(bridge.botLid).toBeNull();
      // connect really completed — null is not a not-yet-initialised artifact
      expect(bridge.botJid).toBe('+15559990000@sms');
    });
  });

  describe('inbound message mapping', () => {
    /**
     * Verify InboundMessage (contract) → IncomingMessage (core/types.ts) mapping.
     * Fields asserted here are the ones that src/core/ingest.ts:138+ reads.
     * Quoted facts from ingest.ts:
     *   msg.messageId, msg.chatJid, msg.senderJid, msg.content,
     *   msg.contentType, msg.isFromMe, msg.isGroup, msg.mentionedJids,
     *   msg.timestamp, msg.quotedMessageId, msg.isResponseWorthy
     */
    it('routes inbound InboundMessage to onMessage with correct IncomingMessage shape', async () => {
      // Time 0 so cursor = epoch - 1000ms; sentAt = epoch, so sentAt >= cursor.
      vi.useFakeTimers({ now: 0 });
      const { bridge, port } = makeBridge();

      const received: IncomingMessage[] = [];
      bridge.onMessage = (msg) => received.push(msg);

      port.injectInbound(makeInboundSms({
        sid: 'SMabc123',
        from: '+14155550100',
        body: 'test message',
        sentAt: new Date(0),
      }));

      await bridge.connect();

      // Advance fake time by one poll interval to trigger pollOnce
      await vi.advanceTimersByTimeAsync(1000);

      // Assert all fields that ingest.ts reads (src/core/ingest.ts:138+)
      expect(received).toHaveLength(1);
      const msg = received[0]!;
      expect(msg.messageId).toBe('SMabc123');          // ref.id
      expect(msg.chatJid).toBe('+14155550100@sms');     // conversation.id + sms jid suffix
      expect(msg.senderJid).toBe('+14155550100@sms');   // sender.id + sms jid suffix
      expect(msg.content).toBe('test message');         // text
      expect(msg.contentType).toBe('text');
      expect(msg.isFromMe).toBe(false);
      expect(msg.isGroup).toBe(false);
      expect(msg.mentionedJids).toEqual([]);
      expect(msg.isResponseWorthy).toBe(true);
      expect(msg.quotedMessageId).toBeNull();
      expect(msg.senderName).toBeNull();
      expect(msg.contentText).toBeNull();
      expect(typeof msg.timestamp).toBe('number');      // epoch seconds
      expect(msg.timestamp).toBe(0);                   // new Date(0) / 1000 = 0s
    });

    it('drops an inbound message silently when no onMessage handler is set', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge, port } = makeBridge();
      // bridge.onMessage left at its default null → the `onMessage !== null` guard is false.

      port.injectInbound(makeInboundSms({
        sid: 'SMnohandler',
        from: '+14155550100',
        body: 'no handler',
        sentAt: new Date(0),
      }));

      await bridge.connect();
      await vi.advanceTimersByTimeAsync(1000); // message arrives, guard false → dropped, no throw

      // Bridge stays healthy after silently dropping the unhandled message.
      expect(bridge.getConnectionState?.()?.connected).toBe(true);
    });

    it('inbound message not delivered after shutdown', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge, port } = makeBridge();

      const received: IncomingMessage[] = [];
      bridge.onMessage = (msg) => received.push(msg);

      await bridge.connect();
      bridge.shutdown();

      port.injectInbound(makeInboundSms({ sid: 'SMpost001', sentAt: new Date(0) }));
      await vi.advanceTimersByTimeAsync(2000);

      expect(received).toHaveLength(0);
    });
  });

  describe('sendMessage()', () => {
    it('delegates to adapter.sendText and returns waMessageId', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge, port } = makeBridge();
      await bridge.connect();

      const receipt = await bridge.sendMessage('+14155550100', 'reply text');

      // MockTwilioSmsPort.sendSms returns SM000001 for the first send
      expect(receipt).toEqual({ waMessageId: 'SM000001' });
      expect(port.sent).toHaveLength(1);
      expect(port.sent[0]?.body).toBe('reply text');
      expect(port.sent[0]?.to).toBe('+14155550100');
    });
  });

  describe('sendMedia()', () => {
    it('rejects with UnsupportedTransportOperationError', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge } = makeBridge();
      await bridge.connect();

      await expect(
        bridge.sendMedia('+14155550100', { type: 'image', buffer: Buffer.from('x') }),
      ).rejects.toBeInstanceOf(UnsupportedTransportOperationError);
    });
  });

  describe('sendRaw()', () => {
    it('rejects with UnsupportedTransportOperationError', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge } = makeBridge();
      await bridge.connect();

      await expect(
        bridge.sendRaw('+14155550100', { type: 'text', text: 'raw' }),
      ).rejects.toBeInstanceOf(UnsupportedTransportOperationError);
    });
  });

  describe('getConnectionState()', () => {
    it('returns disconnected state before connect', () => {
      const { bridge } = makeBridge();
      const state = bridge.getConnectionState?.();
      expect(state?.connected).toBe(false);
      expect(state?.state).toBe('disconnected');
    });

    it('returns connected state after connect', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge } = makeBridge();
      await bridge.connect();

      const state = bridge.getConnectionState?.();
      expect(state?.connected).toBe(true);
      expect(state?.state).toBe('connected');
    });
  });

  describe('getSocket()', () => {
    it('always returns null', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge } = makeBridge();
      await bridge.connect();
      expect(bridge.getSocket()).toBeNull();
    });
  });

  describe('shutdown()', () => {
    it('calls adapter disconnect, transitioning to disconnected state', async () => {
      vi.useFakeTimers({ now: 0 });
      const { bridge, adapter } = makeBridge();
      await bridge.connect();

      bridge.shutdown();

      expect(adapter.state().state).toBe('disconnected');
    });
  });

  describe('presenceCache and contactsDir', () => {
    it('presenceCache is instantiated (health.ts reads it unconditionally)', () => {
      const { bridge } = makeBridge();
      expect(bridge.presenceCache).toBeDefined();
      expect(typeof bridge.presenceCache.get).toBe('function');
    });

    it('contactsDir is instantiated (main.ts seeds from message history)', () => {
      const { bridge } = makeBridge();
      expect(bridge.contactsDir).toBeDefined();
      expect(typeof bridge.contactsDir.observe).toBe('function');
    });
  });
});

describe('TwilioConnection sms jid scheme (ingest round-trip)', () => {
  it('inbound chatJid/senderJid are @sms-suffixed and survive toConversationKey', async () => {
    const { toConversationKey } = await import('../../../src/core/conversation-key.ts');
    vi.useFakeTimers({ now: 0 });
    const { bridge, port } = makeBridge();
    const received: IncomingMessage[] = [];
    bridge.onMessage = (m) => received.push(m);

    await bridge.connect();
    port.injectInbound(makeInboundSms({ sid: 'SMrt1', body: 'hi' }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(received).toHaveLength(1);
    expect(received[0].chatJid).toBe('+14155550100@sms');
    expect(received[0].senderJid).toBe('+14155550100@sms');
    // The exact call ingest makes — must not throw and must be stable
    expect(toConversationKey(received[0].chatJid)).toBe('+14155550100_at_sms');
    bridge.shutdown();
  });

  it('replying to the inbound chatJid round-trips: suffix stripped, adapter accepts the target', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, port } = makeBridge();
    const received: IncomingMessage[] = [];
    bridge.onMessage = (m) => received.push(m);

    await bridge.connect();
    port.injectInbound(makeInboundSms({ sid: 'SMrt2', body: 'q' }));
    await vi.advanceTimersByTimeAsync(1000);

    // Reply exactly the way ChatRuntime does: sendMessage(msg.chatJid, text)
    const receipt = await bridge.sendMessage(received[0].chatJid, 'answer');
    expect(receipt.waMessageId).toMatch(/^SM/);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0].to).toBe('+14155550100');
    bridge.shutdown();
  });
});

describe('TwilioConnection event/lifecycle robustness', () => {
  it('double connect does not double-deliver inbound messages', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, port } = makeBridge();
    const received: IncomingMessage[] = [];
    bridge.onMessage = (m) => received.push(m);

    await bridge.connect();
    await bridge.connect();
    port.injectInbound(makeInboundSms({ sid: 'SMdup', body: 'x' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(received).toHaveLength(1);
    bridge.shutdown();
  });

  it('sendPollMessage rejects with UnsupportedTransportOperationError', async () => {
    const { bridge } = makeBridge();
    await expect(bridge.sendPollMessage('+1@sms', 'poll', ['a'], 1)).rejects.toBeInstanceOf(
      UnsupportedTransportOperationError,
    );
  });
});

describe('TwilioConnection bridge — fromMe echo mapping', () => {
  it('fromMe record surfaces as IncomingMessage with isFromMe: true and chatJid = peer@sms', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, port } = makeBridge();

    const received: IncomingMessage[] = [];
    bridge.onMessage = (msg) => received.push(msg);

    await bridge.connect();

    // Inject an outbound echo record (bot's own message)
    port.injectInbound(makeInboundSms({
      sid: 'SMecho001',
      from: '+15559990000',   // our number
      to: '+14155550100',     // remote peer
      body: 'bot reply',
      fromMe: true,
      sentAt: new Date(0),
    }));

    await vi.advanceTimersByTimeAsync(1000);

    expect(received).toHaveLength(1);
    const msg = received[0]!;

    // isFromMe must be true
    expect(msg.isFromMe).toBe(true);

    // chatJid must be the PEER (remote number) with @sms suffix
    expect(msg.chatJid).toBe('+14155550100@sms');

    // senderJid is our number with @sms suffix
    expect(msg.senderJid).toBe('+15559990000@sms');

    // messageId is the Twilio SID — used by durability.matchEcho
    expect(msg.messageId).toBe('SMecho001');

    bridge.shutdown();
  });

  it('chatJid is consistent between inbound and outbound records for the same peer', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, port } = makeBridge();
    const { toConversationKey } = await import('../../../src/core/conversation-key.ts');

    const received: IncomingMessage[] = [];
    bridge.onMessage = (msg) => received.push(msg);

    await bridge.connect();

    // Inbound message from peer
    port.injectInbound(makeInboundSms({
      sid: 'SMin001',
      from: '+14155550100',
      to: '+15559990000',
      body: 'hi bot',
      fromMe: false,
      sentAt: new Date(0),
    }));

    // Outbound echo (bot replied)
    port.injectInbound(makeInboundSms({
      sid: 'SMout001',
      from: '+15559990000',
      to: '+14155550100',
      body: 'hello user',
      fromMe: true,
      sentAt: new Date(1),
    }));

    await vi.advanceTimersByTimeAsync(1000);

    expect(received).toHaveLength(2);
    const inbound = received.find((m) => !m.isFromMe)!;
    const outbound = received.find((m) => m.isFromMe)!;

    // Both must have the same chatJid (peer number) so they share a conversation thread
    expect(inbound.chatJid).toBe('+14155550100@sms');
    expect(outbound.chatJid).toBe('+14155550100@sms');

    // And thus the same conversation key
    expect(toConversationKey(inbound.chatJid)).toBe(toConversationKey(outbound.chatJid));

    bridge.shutdown();
  });
});

describe('TwilioConnection isResponseWorthy derivation', () => {
  it('blank and whitespace-only bodies are not response-worthy (stored, never replied to)', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, port } = makeBridge();
    const received: IncomingMessage[] = [];
    bridge.onMessage = (m) => received.push(m);

    await bridge.connect();
    port.injectInbound(makeInboundSms({ sid: 'SMblank', body: '' }));
    port.injectInbound(makeInboundSms({ sid: 'SMspace', body: '   ', sentAt: new Date(1) }));
    port.injectInbound(makeInboundSms({ sid: 'SMreal', body: 'hello', sentAt: new Date(2) }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(received.map((m) => [m.messageId, m.isResponseWorthy])).toEqual([
      ['SMblank', false],
      ['SMspace', false],
      ['SMreal', true],
    ]);
    bridge.shutdown();
  });
});

describe('TwilioConnection background error logging', () => {
  it('logs adapter error events through the twilio-bridge child logger', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, port } = makeBridge();
    const logged: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    bridgeLogRecorder.onError = (fields, msg) => logged.push({ fields, msg });
    try {
      await bridge.connect();
      // Arm a transient poll failure; the adapter emits it on the error channel
      port.failNextList(Object.assign(new Error('twilio 503'), { status: 503 }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(logged.length).toBeGreaterThanOrEqual(1);
      expect(logged[0].msg).toContain('twilio transport error');
      expect(logged[0].fields).toMatchObject({ retryable: true, operation: 'pollInbound' });
      bridge.shutdown();
    } finally {
      bridgeLogRecorder.onError = null;
    }
  });
});

describe('TwilioConnection voice message mapping', () => {
  it('maps a voice-attachment InboundMessage to contentType audio with transcript content', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, adapter } = makeBridge({ voice: { enabled: true, voicemailMaxLengthSec: 120 } });
    const received: IncomingMessage[] = [];
    bridge.onMessage = (m) => received.push(m);
    await bridge.connect();
    adapter.handleTranscript({
      text: 'voicemail words', recordingSid: 'RE00000000000000000000000000000001',
      callSid: 'CA1', from: '+15551230001', to: '+15559990000',
    });
    expect(received).toHaveLength(1);
    expect(received[0].contentType).toBe('audio');
    expect(received[0].content).toBe('voicemail words');
    expect(received[0].chatJid).toBe('+15551230001@sms');
    expect(received[0].isResponseWorthy).toBe(true);
    bridge.shutdown();
  });
});
