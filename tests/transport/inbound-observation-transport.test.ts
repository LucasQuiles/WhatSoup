/**
 * Transport exits between a received messages.upsert batch and the ingest
 * consumer are recorded under closed inbound-observation labels, and each
 * exit keeps its existing behaviour: nothing new reaches the consumer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logRef, emitAlert } = vi.hoisted(() => ({
  logRef: {} as Record<string, ReturnType<typeof vi.fn>>,
  emitAlert: vi.fn(),
}));

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth-inbound-observation-transport',
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-inbound-observation-transport/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: { conversation: 'm', extraction: 'm', validation: 'm', fallback: 'm' },
  },
}));

vi.mock('../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../helpers/logger-mock.ts');
  return hoistedLoggerMock(logRef);
});

vi.mock('../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAlert,
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { getInboundObservationHealth, resetInboundObservations } from '../../src/core/inbound-observation.ts';

const USER_MESSAGE = {
  key: { remoteJid: '15550109001@s.whatsapp.net', id: 'INBOUND-1', fromMe: false },
  message: { conversation: 'synthetic inbound text' },
  messageTimestamp: 1_780_000_000,
};

function makeMockSocket() {
  let callback: ((events: Record<string, unknown>) => void) | undefined;
  const sock = {
    ev: { process: vi.fn((cb: (events: Record<string, unknown>) => void) => { callback = cb; }) },
    sendMessage: vi.fn(),
    end: vi.fn(),
    user: { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid', name: 'WhatSoup' },
  };
  const emit = (events: Record<string, unknown>) => {
    if (!callback) throw new Error('ev.process callback not registered');
    callback(events);
  };
  return { sock, emit };
}

const counts = () => getInboundObservationHealth().counts;
const totalCount = () => Object.values(counts()).reduce((sum, n) => sum + n, 0);

describe('transport inbound exits record observations', () => {
  let cm: ConnectionManager;
  let emit: (events: Record<string, unknown>) => void;
  let consumer: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
    const mock = makeMockSocket();
    emit = mock.emit;
    (makeWASocket as ReturnType<typeof vi.fn>).mockReturnValue(mock.sock);
    cm = new ConnectionManager();
    consumer = vi.fn();
    cm.onMessage = consumer as unknown as (msg: unknown) => void;
    await cm.connect();
    emit({ 'connection.update': { connection: 'open' } });
    await new Promise((resolve) => setImmediate(resolve));
    resetInboundObservations();
    emitAlert.mockClear();
  });

  afterEach(async () => {
    await cm.shutdown();
    resetInboundObservations();
  });

  async function deliver(events: Record<string, unknown>): Promise<void> {
    emit(events);
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('a user message reaches the consumer and records nothing', async () => {
    await deliver({ 'messages.upsert': { messages: [USER_MESSAGE], type: 'notify' } });
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(totalCount()).toBe(0);
  });

  it('a consumer failure keeps its existing warning and records nothing', async () => {
    consumer.mockImplementation(() => { throw new Error('consumer failed'); });
    await deliver({ 'messages.upsert': { messages: [USER_MESSAGE], type: 'notify' } });
    expect(logRef.warn).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'INBOUND-1' }), 'onMessage callback threw');
    expect(totalCount()).toBe(0);
  });

  it('an undecryptable message stays a decryption failure, not a parser refusal', async () => {
    const failures = vi.fn();
    cm.on('decryptionFailure', failures);
    await deliver({ 'messages.upsert': { messages: [{ key: USER_MESSAGE.key, messageStubType: 2, messageStubParameters: ['No session'] }], type: 'notify' } });
    expect(failures).toHaveBeenCalledTimes(1);
    expect(totalCount()).toBe(0);
  });

  it('a user message with no consumer wired records transport.no_consumer and alerts', async () => {
    cm.onMessage = null;
    await deliver({ 'messages.upsert': { messages: [USER_MESSAGE], type: 'notify' } });
    expect(counts()['transport.no_consumer']).toBe(1);
    expect(emitAlert).toHaveBeenCalledTimes(1);
    expect(emitAlert.mock.calls[0]![1]).toBe('inbound_no_consumer');
  });

  it('a batch from a socket that is no longer current records one stale_socket attempt per message, advisory', async () => {
    (cm as unknown as { sock: unknown }).sock = { replaced: true };
    await deliver({ 'messages.upsert': { messages: [USER_MESSAGE, { ...USER_MESSAGE, key: { ...USER_MESSAGE.key, id: 'INBOUND-2' } }], type: 'notify' } });
    expect(consumer).not.toHaveBeenCalled();
    expect(counts()['transport.stale_socket']).toBe(2);
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('a stale non-message batch records nothing', async () => {
    (cm as unknown as { sock: unknown }).sock = { replaced: true };
    await deliver({ 'chats.update': [{ id: '15550109001@s.whatsapp.net' }] });
    expect(totalCount()).toBe(0);
  });

  it('a batch with an unsupported upsert type records its attempts, advisory', async () => {
    await deliver({ 'messages.upsert': { messages: [USER_MESSAGE], type: 'prepend' } });
    expect(consumer).not.toHaveBeenCalled();
    expect(counts()['transport.unsupported_upsert_type']).toBe(1);
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('a message the parser refuses records transport.parser_refused, advisory', async () => {
    await deliver({ 'messages.upsert': { messages: [{ key: USER_MESSAGE.key, messageStubType: 20 }], type: 'notify' } });
    expect(consumer).not.toHaveBeenCalled();
    expect(counts()['transport.parser_refused']).toBe(1);
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('a throwing alert outbox does not stop the rest of the batch', async () => {
    cm.onMessage = null;
    emitAlert.mockImplementation(() => { throw new Error('outbox exploded'); });
    await deliver({ 'messages.upsert': { messages: [USER_MESSAGE], type: 'notify' } });
    cm.onMessage = consumer as unknown as (msg: unknown) => void;
    await deliver({ 'messages.upsert': { messages: [{ ...USER_MESSAGE, key: { ...USER_MESSAGE.key, id: 'INBOUND-3' } }], type: 'notify' } });
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(getInboundObservationHealth()).toMatchObject({
      counts: { 'transport.no_consumer': 1 },
      recorder_failures: 1,
    });
  });
});
