// Ingest exits recorded by inbound-observation.ts, with admission, dispatch,
// duplicate and displacement behaviour unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';
import type { DurabilityEngine } from '../../src/core/durability.ts';
import { deferred } from '../helpers/deferred.ts';

const doubles = vi.hoisted(() => ({
  emitAlert: vi.fn(),
  storeFails: false,
}));

vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  const logger = singletonLoggerMock();
  return { createChildLogger: () => logger };
});

vi.mock('../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAlert: doubles.emitAlert,
}));

vi.mock('../../src/core/messages.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/messages.ts')>();
  return {
    ...actual,
    storeMessageIfNew: (...args: Parameters<typeof actual.storeMessageIfNew>) => {
      if (doubles.storeFails) throw new Error('SQLITE_FULL: database or disk is full');
      return actual.storeMessageIfNew(...args);
    },
  };
});

vi.mock('../../src/core/command-router.ts', () => ({
  isAdminMessage: vi.fn().mockReturnValue(false),
  parseAdminCommand: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/admin.ts', () => ({
  handleAdminCommand: vi.fn().mockResolvedValue(undefined),
  handleFallbackCommand: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/access-policy.ts', () => ({
  shouldRespond: vi.fn().mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' }),
}));

vi.mock('../../src/core/access-list.ts', () => ({
  extractLocal: vi.fn((jid: string) => jid.split('@')[0]),
  resolvePhoneFromJid: vi.fn((jid: string) => jid.split('@')[0]),
  lookupAccess: vi.fn(),
  insertPending: vi.fn(),
  updateAccess: vi.fn(),
}));

import { Database } from '../../src/core/database.ts';
import { config } from '../../src/config.ts';
import { createIngestHandler, getIngestStats } from '../../src/core/ingest.ts';
import { getInboundObservationHealth, resetInboundObservations } from '../../src/core/inbound-observation.ts';

const BOT_JID = '15551230004@s.whatsapp.net';

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'message-default',
    chatJid: '15551230008@s.whatsapp.net',
    senderJid: '15551230008@s.whatsapp.net',
    senderName: 'Alice',
    content: 'hello',
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

function makeRuntime(handleMessage = vi.fn().mockResolvedValue(undefined)): Runtime {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage,
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
  };
}

function makeDurability(journalInbound = vi.fn()) {
  let nextSeq = 0;
  if (journalInbound.getMockImplementation() === undefined) journalInbound.mockImplementation(() => ++nextSeq);
  const durability = {
    matchEcho: vi.fn().mockReturnValue(false),
    journalInbound,
    getInboundReceivedAtUnixSeconds: vi.fn().mockReturnValue(1_780_000_000),
    markInboundSkipped: vi.fn(),
    markInboundFailed: vi.fn(),
    markInboundFailedIfProcessing: vi.fn(),
  } as unknown as DurabilityEngine;
  return { durability, journalInbound };
}

function makeHandler(db: Database, runtime: Runtime, durability: DurabilityEngine) {
  const messenger: Messenger = {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
  return createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null, durability);
}

async function waitForIdle(): Promise<void> {
  await vi.waitFor(() => {
    const stats = getIngestStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  }, { timeout: 5_000, interval: 5 });
}

function openDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function storedCount(db: Database, messageId: string): number {
  return (db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE message_id = ?').get(messageId) as { n: number }).n;
}

const allZero = () => getInboundObservationHealth().counts;

beforeEach(() => {
  vi.clearAllMocks();
  doubles.storeFails = false;
  doubles.emitAlert.mockReset();
  doubles.emitAlert.mockReturnValue({ ok: true, channel: 'sink', status: 'durably_queued' });
  resetInboundObservations();
});

describe('ingest exits recorded as inbound observations', () => {
  it('a dispatched message records nothing', async () => {
    const db = openDb();
    const runtime = makeRuntime();
    const { durability } = makeDurability();

    makeHandler(db, runtime, durability)(makeMessage({ messageId: 'obs-ok' }));
    await waitForIdle();

    expect(runtime.handleMessage).toHaveBeenCalledTimes(1);
    expect(Object.values(allZero()).every((n) => n === 0)).toBe(true);
    expect(doubles.emitAlert).not.toHaveBeenCalled();
  });

  it('a store failure records ingest.store_failed and alerts once; nothing is journaled or dispatched', async () => {
    const db = openDb();
    const runtime = makeRuntime();
    const { durability, journalInbound } = makeDurability();
    doubles.storeFails = true;

    makeHandler(db, runtime, durability)(makeMessage({ messageId: 'obs-store-failed' }));
    await waitForIdle();

    expect(journalInbound).not.toHaveBeenCalled();
    expect(runtime.handleMessage).not.toHaveBeenCalled();
    expect(getInboundObservationHealth().counts).toMatchObject({
      'ingest.store_failed': 1,
      'ingest.stored_not_admitted': 0,
    });
    expect(doubles.emitAlert).toHaveBeenCalledTimes(1);
    expect(doubles.emitAlert.mock.calls[0]![1]).toBe('inbound_store_failed');
  });

  it('a journal failure after a successful store records ingest.stored_not_admitted only; nothing is dispatched', async () => {
    const db = openDb();
    const runtime = makeRuntime();
    const { durability } = makeDurability(vi.fn().mockImplementation(() => { throw new Error('journal write failed'); }));

    makeHandler(db, runtime, durability)(makeMessage({ messageId: 'obs-journal-failed' }));
    await waitForIdle();

    expect(storedCount(db, 'obs-journal-failed')).toBe(1);
    expect(runtime.handleMessage).not.toHaveBeenCalled();
    expect(getInboundObservationHealth().counts).toMatchObject({
      'ingest.stored_not_admitted': 1,
      'ingest.store_failed': 0,
    });
    expect(doubles.emitAlert).not.toHaveBeenCalled();
  });

  it('a duplicate delivery is not counted and is dispatched once', async () => {
    const db = openDb();
    const runtime = makeRuntime();
    const { durability, journalInbound } = makeDurability();
    const handler = makeHandler(db, runtime, durability);

    handler(makeMessage({ messageId: 'obs-duplicate' }));
    await waitForIdle();
    handler(makeMessage({ messageId: 'obs-duplicate' }));
    await waitForIdle();

    expect(runtime.handleMessage).toHaveBeenCalledTimes(1);
    expect(journalInbound).toHaveBeenCalledTimes(1);
    expect(Object.values(allZero()).every((n) => n === 0)).toBe(true);
  });

  it('a queue displacement stays owned by the displacement counter and alert, not counted here', async () => {
    const original = Object.getOwnPropertyDescriptor(config, 'ingest');
    Object.defineProperty(config, 'ingest', {
      configurable: true,
      value: { ...(config.ingest ?? {}), maxConcurrent: 1, maxQueueDepth: 1 },
    });
    try {
      const db = openDb();
      const anchor = deferred<void>();
      const runtime = makeRuntime(vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        if (msg.messageId === 'obs-anchor') return anchor.promise;
      }));
      const { durability } = makeDurability();
      const handler = makeHandler(db, runtime, durability);
      const droppedBefore = getIngestStats().dropped;
      const jid = '15551239901@s.whatsapp.net';

      handler(makeMessage({ messageId: 'obs-anchor' }));
      await vi.waitFor(() => expect(getIngestStats().active).toBe(1));
      handler(makeMessage({ messageId: 'obs-displaced', chatJid: jid, senderJid: jid }));
      await vi.waitFor(() => expect(getIngestStats().queued).toBe(1));
      handler(makeMessage({ messageId: 'obs-survivor', chatJid: jid, senderJid: jid }));
      anchor.resolve();
      await waitForIdle();

      expect(getIngestStats().dropped).toBe(droppedBefore + 1);
      expect(doubles.emitAlert).toHaveBeenCalledTimes(1);
      expect(doubles.emitAlert.mock.calls[0]![1]).toBe('ingest_queue_displacement');
      expect(Object.values(allZero()).every((n) => n === 0)).toBe(true);
    } finally {
      if (original) Object.defineProperty(config, 'ingest', original);
    }
  });

  it('a broken warning logger during a store failure still alerts and leaves admission unchanged', async () => {
    const { createChildLogger } = await import('../../src/logger.ts');
    const logger = createChildLogger('inbound-observation') as unknown as { warn: ReturnType<typeof vi.fn> };
    logger.warn.mockImplementation((_fields: unknown, message?: string) => {
      if (message === 'inbound message not admitted locally') throw new Error('logger exploded');
    });
    try {
      const db = openDb();
      const runtime = makeRuntime();
      const { durability, journalInbound } = makeDurability();
      doubles.storeFails = true;

      const handler = makeHandler(db, runtime, durability);
      handler(makeMessage({ messageId: 'obs-logger-a' }));
      await waitForIdle();
      doubles.storeFails = false;
      handler(makeMessage({ messageId: 'obs-logger-b' }));
      await waitForIdle();

      expect(doubles.emitAlert).toHaveBeenCalledTimes(1);
      expect(doubles.emitAlert.mock.calls[0]![1]).toBe('inbound_store_failed');
      expect(journalInbound).toHaveBeenCalledTimes(1);
      expect(runtime.handleMessage).toHaveBeenCalledTimes(1);
      expect(getInboundObservationHealth()).toMatchObject({
        counts: { 'ingest.store_failed': 1 },
        alerts: { durably_queued: 1 },
        recorder_failures: 1,
      });
    } finally {
      logger.warn.mockReset();
    }
  });

  it('an alert outbox that throws during a store failure leaves admission unchanged', async () => {
    const db = openDb();
    const runtime = makeRuntime();
    const { durability, journalInbound } = makeDurability();
    doubles.storeFails = true;
    doubles.emitAlert.mockImplementation(() => { throw new Error('outbox exploded'); });

    const handler = makeHandler(db, runtime, durability);
    handler(makeMessage({ messageId: 'obs-recorder-a' }));
    await waitForIdle();
    doubles.storeFails = false;
    handler(makeMessage({ messageId: 'obs-recorder-b' }));
    await waitForIdle();

    expect(journalInbound).toHaveBeenCalledTimes(1);
    expect(runtime.handleMessage).toHaveBeenCalledTimes(1);
    expect(getInboundObservationHealth()).toMatchObject({
      counts: { 'ingest.store_failed': 1 },
      recorder_failures: 1,
    });
  });
});
