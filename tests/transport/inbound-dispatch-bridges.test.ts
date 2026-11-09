import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeChannelId } from '../../src/core/transport-refs.ts';
import type { InboundMessage } from '../../src/transport/contract/events.ts';
import type { SignalAdapter } from '../../src/transport/signal/adapter.ts';
import type { ImessageAdapter } from '../../src/transport/imessage/adapter.ts';
import type { TwilioSmsAdapter } from '../../src/transport/twilio/adapter.ts';
import { SignalConnection } from '../../src/transport/signal/connection-bridge.ts';
import { ImessageConnection } from '../../src/transport/imessage/connection-bridge.ts';
import { TwilioConnection } from '../../src/transport/twilio/connection-bridge.ts';

const bridgeLogError = vi.hoisted(() => vi.fn());
vi.mock('../../src/logger.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/logger.ts')>();
  return {
    ...original,
    createChildLogger(name: string) {
      const logger = original.createChildLogger(name);
      if (!['signal-bridge', 'imessage-bridge', 'twilio-bridge'].includes(name)) return logger;
      return new Proxy(logger, {
        get(target, property, receiver) {
          if (property === 'error') {
            return (fields: unknown, message: string) => bridgeLogError(name, fields, message);
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
});
vi.mock('../../src/lib/emit-alert.ts', () => ({
  clearAlertSourceChecked: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
}));

afterEach(() => vi.clearAllMocks());

function fixture(kind: 'signal' | 'imessage' | 'twilio') {
  const channel = makeChannelId(kind === 'twilio' ? 'sms' : kind, 'fixture');
  let onMessage: ((message: InboundMessage) => void) | undefined;
  // Keep the real bridge subscription and conversion path; the adapter never opens a transport.
  const adapter = {
    connect: async () => undefined,
    disconnect: async () => undefined,
    selfRef: () => ({ channel, id: '+15550000001' }),
    isGroupConversation: () => false,
    on(event: string, listener: (message: InboundMessage) => void) {
      if (event === 'message') onMessage = listener;
      return { dispose: () => { if (event === 'message') onMessage = undefined; } };
    },
  };
  const bridge = kind === 'signal'
    ? new SignalConnection(adapter as unknown as SignalAdapter)
    : kind === 'imessage'
      ? new ImessageConnection(adapter as unknown as ImessageAdapter)
      : new TwilioConnection(adapter as unknown as TwilioSmsAdapter);
  const message = (id: string): InboundMessage => ({
    ref: { channel, conversation: '+15550000002', id },
    conversation: { channel, id: '+15550000002' },
    sender: { channel, id: '+15550000002' },
    fromMe: false,
    text: 'fixture inbound',
    attachments: [],
    timestamp: new Date(0),
    inboundEventKey: id,
    transportTimestamp: new Date(0),
    ingestSeq: 1,
  });
  return {
    bridge,
    deliver(id: string, timestamp = new Date(0)) {
      if (onMessage === undefined) throw new Error('message subscription missing');
      onMessage({ ...message(id), timestamp });
    },
  };
}

describe.each(['signal', 'imessage', 'twilio'] as const)('%s inbound failure reporting', (kind) => {
  it('reports conversion failure once without invoking the handler and accepts the next message', async () => {
    const { bridge, deliver } = fixture(kind);
    const error = new Error('timestamp conversion failed');
    const timestamp = new Date(0);
    timestamp.getTime = () => { throw error; };
    const handler = vi.fn();
    bridge.onMessage = handler;
    try {
      await bridge.connect();
      expect(() => deliver('failed-conversion', timestamp)).not.toThrow();
      expect(handler).not.toHaveBeenCalled();
      expect(bridgeLogError).toHaveBeenCalledExactlyOnceWith(
        `${kind}-bridge`,
        { err: error, messageId: 'failed-conversion' },
        'inbound message handler failed',
      );
      deliver('next-message');
      expect(handler).toHaveBeenCalledTimes(1);
      await setImmediate();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(bridgeLogError).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.shutdown();
    }
  });

  it.each(['throw', 'reject'] as const)('reports a handler %s once and accepts the next inbound without replay', async (mode) => {
    const { bridge, deliver } = fixture(kind);
    const error = new Error('durable inbound finalization failed');
    const handler = vi.fn().mockImplementationOnce(() => {
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    });
    bridge.onMessage = handler;
    try {
      await bridge.connect();
      expect(() => deliver('failed-message')).not.toThrow();
      expect(handler).toHaveBeenCalledTimes(1);
      await setImmediate();
      expect(bridgeLogError).toHaveBeenCalledExactlyOnceWith(
        `${kind}-bridge`,
        { err: error, messageId: 'failed-message' },
        'inbound message handler failed',
      );
      deliver('next-message');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1]?.[0]).toMatchObject({ content: 'fixture inbound' });
      await setImmediate();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(bridgeLogError).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.shutdown();
    }
  });

  it('preserves synchronous delivery and successful asynchronous completion', async () => {
    const { bridge, deliver } = fixture(kind);
    const handler = vi.fn(async () => undefined);
    bridge.onMessage = handler;
    try {
      await bridge.connect();
      deliver('successful-message');
      expect(handler).toHaveBeenCalledTimes(1);
      await setImmediate();
      expect(bridgeLogError).not.toHaveBeenCalled();
    } finally {
      await bridge.shutdown();
    }
  });
});
