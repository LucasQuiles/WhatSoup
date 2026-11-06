import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import type { Messenger } from '../../src/core/types.ts';
import { OutboundQueue } from '../../src/runtimes/agent/outbound-queue.ts';
import { SignalAdapter } from '../../src/transport/signal/adapter.ts';
import { SignalConnection } from '../../src/transport/signal/connection-bridge.ts';
import { ImessageAdapter } from '../../src/transport/imessage/adapter.ts';
import { ImessageConnection } from '../../src/transport/imessage/connection-bridge.ts';
import { TwilioSmsAdapter } from '../../src/transport/twilio/adapter.ts';
import { TwilioConnection } from '../../src/transport/twilio/connection-bridge.ts';
import { MockTwilioSmsPort } from '../../src/transport/twilio/testing/mock-port.ts';
import { MockSignalPort, makeSignalConfig } from './signal/mock-port.ts';
import { MockImessagePort, makeImessageConfig } from './imessage/mock-port.ts';
import { makeTwilioConfig } from './twilio/helpers.ts';

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: () => true,
  emitAlertChecked: () => true,
  emitObservationChecked: () => true,
  clearAlertSource: () => true,
  clearAlertSourceChecked: () => true,
}));

type Bridge = Messenger & { shutdown(): Promise<void> };
type Row = { status: string; wa_message_id: string | null };

describe.each(['signal', 'imessage', 'sms'] as const)('%s outbound correlation', (kind) => {
  let db: Database;
  let connection: Bridge;
  let pending: Array<() => void>;
  let starts: number;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    db.open();
    pending = [];
    starts = 0;
  });

  afterEach(async () => {
    for (const resolve of pending) resolve();
    await vi.runAllTimersAsync();
    await connection.shutdown();
    const timers = vi.getTimerCount();
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(timers).toBe(0);
  });

  it.each(['exhaustion', 'shutdown', 'success'] as const)('preserves provider identity on %s', async (mode) => {
    function reply<T>(body: string, value: T): Promise<T> {
      if (body !== 'answer') return Promise.resolve(value);
      starts++;
      return mode === 'success'
        ? Promise.resolve(value)
        : new Promise((resolve) => pending.push(() => resolve(value)));
    }

    let expectedId: string;
    if (kind === 'signal') {
      const port = new MockSignalPort();
      vi.spyOn(port, 'send').mockImplementation(({ body }) => reply(body, { timestamp: 12345 }));
      connection = new SignalConnection(new SignalAdapter(makeSignalConfig(), port));
      expectedId = '12345';
    } else if (kind === 'imessage') {
      const port = new MockImessagePort();
      vi.spyOn(port, 'send').mockImplementation(({ body }) => reply(body, { guid: 'provider-guid' }));
      connection = new ImessageConnection(new ImessageAdapter(makeImessageConfig(), port), port);
      expectedId = 'provider-guid';
    } else {
      const port = new MockTwilioSmsPort();
      vi.spyOn(port, 'sendSms').mockImplementation(({ body }) => reply(body, { sid: 'SM000001' }));
      connection = new TwilioConnection(new TwilioSmsAdapter(makeTwilioConfig(), port));
      expectedId = 'SM000001';
    }

    const sends = vi.spyOn(connection, 'sendMessage');
    const durability = new DurabilityEngine(db);
    const queue = new OutboundQueue(connection, `+15551112222@${kind}`);
    queue.setDurability(durability);
    queue.enqueueText('answer', 'answer');
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(1);
    if (mode === 'shutdown') queue.preemptForShutdown(Date.now());
    await vi.runAllTimersAsync();
    await queue.flush();

    const row = db.raw.prepare('SELECT status, wa_message_id FROM outbound_ops').get() as Row;
    const echoScope = (db.raw.prepare('SELECT conversation_key FROM outbound_ops').get() as {
      conversation_key: string;
    }).conversation_key;
    const requestedId = sends.mock.calls[0]?.[2]?.messageId;
    expect(requestedId).toMatch(/^[A-F0-9]{32}$/);
    expect(requestedId).not.toBe(expectedId);
    expect(starts).toBe(mode === 'exhaustion' ? 3 : 1);
    if (mode === 'success') {
      expect(row).toEqual({ status: 'submitted', wa_message_id: expectedId });
    } else {
      expect(row).toEqual({ status: 'maybe_sent', wa_message_id: null });
      expect(durability.matchEcho(requestedId!, echoScope)).toBe(false);
    }
  });
});
