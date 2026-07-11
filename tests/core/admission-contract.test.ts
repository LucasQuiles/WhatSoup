import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';
import type { DurabilityEngine } from '../../src/core/durability.ts';
import { deferred } from '../helpers/deferred.ts';

const doubles = vi.hoisted(() => ({
  emitAlert: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => doubles.log,
}));

vi.mock('../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAlert: doubles.emitAlert,
}));

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

const BOT_JID = '15551230004@s.whatsapp.net';
const DISPLACEMENT_WINDOW_MS = 15 * 60 * 1000;

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

function makeDurability() {
  let nextSeq = 0;
  const matchEcho = vi.fn().mockReturnValue(false);
  const journalInbound = vi.fn().mockImplementation(() => ++nextSeq);
  const durability = {
    matchEcho,
    journalInbound,
    markInboundSkipped: vi.fn(),
    markInboundFailed: vi.fn(),
  } as unknown as DurabilityEngine;
  return { durability, matchEcho, journalInbound };
}

function makeHandler(db: Database, runtime: Runtime, durability: DurabilityEngine) {
  const messenger: Messenger = {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
  return createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null, durability);
}

async function waitForStats(assertStats: (stats: ReturnType<typeof getIngestStats>) => void): Promise<void> {
  await vi.waitFor(() => assertStats(getIngestStats()), { timeout: 5_000, interval: 5 });
}

async function waitForIdle(): Promise<void> {
  await waitForStats((stats) => {
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
  });
}

async function withIngestConfig(fn: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(config, 'ingest');
  Object.defineProperty(config, 'ingest', {
    configurable: true,
    value: { ...(config.ingest ?? {}), maxConcurrent: 1, maxQueueDepth: 1 },
  });
  try {
    await fn();
  } finally {
    if (original) Object.defineProperty(config, 'ingest', original);
  }
}

function displacementLog(messageId: string): Record<string, unknown> | undefined {
  return doubles.log.warn.mock.calls
    .map(([context]) => context as Record<string, unknown>)
    .find((context) => context['droppedMessageId'] === messageId);
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.emitAlert.mockReset();
  doubles.emitAlert.mockReturnValue({ ok: true, channel: 'sink', status: 'durably_queued' });
});

describe('typed ingest admission contract', () => {
  it('bounds limiter cardinality and evicts the least-recently-used conversation', async () => {
    const limiterMaxEntries = 256;
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000_000);
    try {
      await withIngestConfig(async () => {
        const db = new Database(':memory:');
        db.open();
        const anchor = deferred<void>();
        const runtime = makeRuntime(vi.fn().mockImplementation(async (msg: IncomingMessage) => {
          if (msg.messageId === 'bounded-anchor') return anchor.promise;
        }));
        const { durability } = makeDurability();
        const handler = makeHandler(db, runtime, durability);
        const jid = (index: number) => `155513${String(index).padStart(5, '0')}@s.whatsapp.net`;

        handler(makeMessage({ messageId: 'bounded-anchor' }));
        await waitForStats((stats) => expect(stats.active).toBe(1));

        handler(makeMessage({ messageId: 'bounded-0', chatJid: jid(0), senderJid: jid(0) }));
        await waitForStats((stats) => expect(stats.queued).toBe(1));

        // Fill the limiter to its explicit production cap.
        for (let index = 1; index < limiterMaxEntries; index++) {
          handler(makeMessage({
            messageId: `bounded-${index}`,
            chatJid: jid(index),
            senderJid: jid(index),
          }));
        }

        // Refresh keys 0 and 1, insert two new keys, then prove key 2 was
        // evicted while recently used key 0 remains rate-limited.
        handler(makeMessage({ messageId: 'bounded-touch-0', chatJid: jid(0), senderJid: jid(0) }));
        handler(makeMessage({ messageId: 'bounded-touch-1', chatJid: jid(1), senderJid: jid(1) }));
        handler(makeMessage({ messageId: 'bounded-new-256', chatJid: jid(256), senderJid: jid(256) }));
        handler(makeMessage({ messageId: 'bounded-new-257', chatJid: jid(257), senderJid: jid(257) }));
        handler(makeMessage({ messageId: 'bounded-requeue-2', chatJid: jid(2), senderJid: jid(2) }));
        handler(makeMessage({ messageId: 'bounded-recent-0', chatJid: jid(0), senderJid: jid(0) }));
        handler(makeMessage({ messageId: 'bounded-survivor', chatJid: jid(1), senderJid: jid(1) }));

        anchor.resolve();
        await waitForIdle();

        expect(doubles.emitAlert).toHaveBeenCalledTimes(259);
        expect(displacementLog('bounded-touch-0')).toMatchObject({
          displacementIncidentAccepted: false,
          displacementIncidentStatus: 'rate_limited',
        });
        expect(displacementLog('bounded-requeue-2')).toMatchObject({
          displacementIncidentAccepted: true,
          displacementIncidentStatus: 'durably_queued',
        });
        expect(displacementLog('bounded-recent-0')).toMatchObject({
          displacementIncidentAccepted: false,
          displacementIncidentStatus: 'rate_limited',
        });

        db.raw.close();
      });
    } finally {
      now.mockRestore();
    }
  });

  it('correlates and stores self echoes without consuming bounded admission capacity', async () => {
    await withIngestConfig(async () => {
      const db = new Database(':memory:');
      db.open();
      const anchor = deferred<void>();
      const handleMessage = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        if (msg.messageId === 'echo-anchor') return anchor.promise;
      });
      const runtime = makeRuntime(handleMessage);
      const { durability, matchEcho } = makeDurability();
      const handler = makeHandler(db, runtime, durability);

      db.raw.prepare(`
        INSERT INTO messages
          (message_id, chat_jid, conversation_key, sender_jid, content, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'echo-duplicate',
        '15551230008@s.whatsapp.net',
        '15551230008',
        BOT_JID,
        'already stored',
        'text',
        1,
        1,
      );

      handler(makeMessage({ messageId: 'echo-anchor' }));
      await waitForStats((stats) => expect(stats.active).toBe(1));

      handler(makeMessage({ messageId: 'ordinary-victim' }));
      await waitForStats((stats) => expect(stats.queued).toBe(1));

      const admissionBeforeEcho = getIngestStats();
      const missedEcho = makeMessage({
        messageId: 'echo-new',
        content: 'echo\uD800body',
        contentText: 'echo\uD800text',
        senderName: 'Echo\uD800Sender',
        isFromMe: true,
        senderJid: BOT_JID,
      });
      handler(missedEcho);
      await vi.waitFor(() => expect(matchEcho).toHaveBeenCalledWith('echo-new'));
      const admissionAfterFirstEcho = getIngestStats();

      handler(makeMessage({ messageId: 'echo-duplicate', isFromMe: true, senderJid: BOT_JID }));
      await vi.waitFor(() => expect(matchEcho).toHaveBeenCalledTimes(2));
      const admissionAfterDuplicateEcho = getIngestStats();

      const storedBeforeRedelivery = db.raw.prepare(
        `SELECT COUNT(*) AS count, MAX(content) AS content,
                MAX(content_text) AS contentText, MAX(sender_name) AS senderName
           FROM messages WHERE message_id = ?`,
      ).get('echo-new') as {
        count: number;
        content: string | null;
        contentText: string | null;
        senderName: string | null;
      };

      anchor.resolve();
      await waitForIdle();

      handler(makeMessage({
        messageId: 'echo-new',
        content: 'redelivered body',
        contentText: 'redelivered text',
        senderName: 'Redelivered Sender',
        isFromMe: true,
        senderJid: BOT_JID,
      }));
      await vi.waitFor(() => expect(matchEcho).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(doubles.log.debug).toHaveBeenCalledWith(
        { messageId: 'echo-new', reason: 'duplicate' },
        'skipping duplicate message delivery',
      ));

      expect(matchEcho.mock.calls.map(([messageId]) => messageId)).toStrictEqual([
        'echo-new',
        'echo-duplicate',
        'echo-new',
      ]);
      expect(admissionAfterFirstEcho).toStrictEqual(admissionBeforeEcho);
      expect(admissionAfterDuplicateEcho).toStrictEqual(admissionBeforeEcho);
      expect(matchEcho).toHaveNthReturnedWith(1, false);
      expect(missedEcho.content).toBe('echo\uFFFDbody');
      expect(missedEcho.contentText).toBe('echo\uFFFDtext');
      expect(missedEcho.senderName).toBe('Echo\uFFFDSender');
      expect(handleMessage.mock.calls.map(([msg]) => (msg as IncomingMessage).messageId)).toStrictEqual([
        'echo-anchor',
        'ordinary-victim',
      ]);
      expect(storedBeforeRedelivery.count).toBe(1);
      expect(storedBeforeRedelivery.content).toBe('echo\uFFFDbody');
      expect(storedBeforeRedelivery.contentText).toBe('echo\uFFFDtext');
      expect(storedBeforeRedelivery.senderName).toBe('Echo\uFFFDSender');
      expect(
        (db.raw.prepare('SELECT COUNT(*) AS count FROM messages WHERE message_id = ?').get('echo-duplicate') as { count: number }).count,
      ).toBe(1);
      const storedAfterRedelivery = db.raw.prepare(
        `SELECT COUNT(*) AS count, MAX(content) AS content,
                MAX(content_text) AS contentText, MAX(sender_name) AS senderName
           FROM messages WHERE message_id = ?`,
      ).get('echo-new') as {
        count: number;
        content: string | null;
        contentText: string | null;
        senderName: string | null;
      };
      expect(storedAfterRedelivery.count).toBe(1);
      expect(storedAfterRedelivery.content).toBe('echo\uFFFDbody');
      expect(storedAfterRedelivery.contentText).toBe('echo\uFFFDtext');
      expect(storedAfterRedelivery.senderName).toBe('Echo\uFFFDSender');
      expect(getIngestStats().dropped).toBe(admissionBeforeEcho.dropped);

      db.raw.close();
    });
  });

  it('emits one durable structured displacement incident per chat and window', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await withIngestConfig(async () => {
        const db = new Database(':memory:');
        db.open();
        const anchor = deferred<void>();
        const runtime = makeRuntime(vi.fn().mockImplementation(async (msg: IncomingMessage) => {
          if (msg.messageId === 'rate-anchor') return anchor.promise;
        }));
        const { durability, journalInbound } = makeDurability();
        const handler = makeHandler(db, runtime, durability);
        const chatJid = '15551230111@s.whatsapp.net';

        handler(makeMessage({ messageId: 'rate-anchor' }));
        await waitForStats((stats) => expect(stats.active).toBe(1));

        handler(makeMessage({ messageId: 'rate-victim-1', chatJid, senderJid: chatJid }));
        await waitForStats((stats) => expect(stats.queued).toBe(1));

        const droppedBefore = getIngestStats().dropped;
        handler(makeMessage({ messageId: 'rate-victim-2', chatJid, senderJid: chatJid }));
        await waitForStats((stats) => expect(stats.dropped).toBe(droppedBefore + 1));

        handler(makeMessage({ messageId: 'rate-victim-3', chatJid, senderJid: chatJid }));
        await waitForStats((stats) => expect(stats.dropped).toBe(droppedBefore + 2));

        now.mockReturnValue(1_000_000 + DISPLACEMENT_WINDOW_MS);
        handler(makeMessage({ messageId: 'rate-survivor', chatJid, senderJid: chatJid }));
        await waitForStats((stats) => expect(stats.dropped).toBe(droppedBefore + 3));

        anchor.resolve();
        await waitForIdle();

        expect(doubles.emitAlert).toHaveBeenCalledTimes(2);
        const firstAlert = doubles.emitAlert.mock.calls[0] as unknown[];
        expect(firstAlert.slice(0, 3)).toStrictEqual([
          config.botName,
          'ingest_queue_displacement',
          'ingest queue displaced a pre-journal message',
        ]);
        expect(JSON.parse(String(firstAlert[3]))).toStrictEqual({
          chatJid,
          messageId: 'rate-victim-1',
          evictionReason: 'wait_queue_capacity',
          queueDepth: 1,
        });
        expect(firstAlert[4]).toBe('warning');
        expect(displacementLog('rate-victim-1')).toMatchObject({
          displacementIncidentAccepted: true,
          displacementIncidentStatus: 'durably_queued',
        });
        expect(displacementLog('rate-victim-2')).toMatchObject({
          displacementIncidentAccepted: false,
          displacementIncidentStatus: 'rate_limited',
        });
        expect(displacementLog('rate-victim-3')).toMatchObject({
          displacementIncidentAccepted: true,
          displacementIncidentStatus: 'durably_queued',
        });
        expect(journalInbound).not.toHaveBeenCalledWith(
          'rate-victim-1',
          expect.anything(),
          expect.anything(),
          expect.anything(),
        );

        db.raw.close();
      });
    } finally {
      now.mockRestore();
    }
  });

  it('shares one limiter window across bare and device-suffixed delivery JIDs', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      await withIngestConfig(async () => {
        const db = new Database(':memory:');
        db.open();
        const anchor = deferred<void>();
        const runtime = makeRuntime(vi.fn().mockImplementation(async (msg: IncomingMessage) => {
          if (msg.messageId === 'suffix-anchor') return anchor.promise;
        }));
        const { durability } = makeDurability();
        const handler = makeHandler(db, runtime, durability);
        const bareJid = '15551230333@s.whatsapp.net';
        const suffixedJid = '15551230333:7@s.whatsapp.net';

        handler(makeMessage({ messageId: 'suffix-anchor' }));
        await waitForStats((stats) => expect(stats.active).toBe(1));

        handler(makeMessage({ messageId: 'suffix-victim', chatJid: suffixedJid, senderJid: suffixedJid }));
        await waitForStats((stats) => expect(stats.queued).toBe(1));

        handler(makeMessage({ messageId: 'bare-victim', chatJid: bareJid, senderJid: bareJid }));
        const droppedBeforeSecondEviction = getIngestStats().dropped;
        handler(makeMessage({ messageId: 'suffix-survivor', chatJid: suffixedJid, senderJid: suffixedJid }));
        await waitForStats((stats) => expect(stats.dropped).toBe(droppedBeforeSecondEviction + 1));

        anchor.resolve();
        await waitForIdle();

        expect(doubles.emitAlert).toHaveBeenCalledOnce();
        expect(JSON.parse(String(doubles.emitAlert.mock.calls[0]?.[3]))).toMatchObject({
          chatJid: suffixedJid,
          messageId: 'suffix-victim',
        });
        expect(displacementLog('bare-victim')).toMatchObject({
          displacementIncidentAccepted: false,
          displacementIncidentStatus: 'rate_limited',
        });

        db.raw.close();
      });
    } finally {
      now.mockRestore();
    }
  });

  it('counts displacement while legacy, failed, and throwing sinks remain unaccepted', async () => {
    await withIngestConfig(async () => {
      const db = new Database(':memory:');
      db.open();
      const anchor = deferred<void>();
      const runtime = makeRuntime(vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        if (msg.messageId === 'outcome-anchor') return anchor.promise;
      }));
      const { durability } = makeDurability();
      const handler = makeHandler(db, runtime, durability);

      handler(makeMessage({ messageId: 'outcome-anchor' }));
      await waitForStats((stats) => expect(stats.active).toBe(1));

      handler(makeMessage({
        messageId: 'legacy-victim',
        chatJid: '15551230201@s.whatsapp.net',
        senderJid: '15551230201@s.whatsapp.net',
      }));
      await waitForStats((stats) => expect(stats.queued).toBe(1));

      const droppedBefore = getIngestStats().dropped;
      doubles.emitAlert.mockReturnValueOnce({
        ok: true,
        channel: 'legacy',
        status: 'legacy_accepted_unconfirmed',
      });
      handler(makeMessage({
        messageId: 'failed-victim',
        chatJid: '15551230202@s.whatsapp.net',
        senderJid: '15551230202@s.whatsapp.net',
      }));
      await waitForStats((stats) => expect(stats.dropped).toBe(droppedBefore + 1));

      doubles.emitAlert.mockReturnValueOnce({ ok: false, channel: 'none', status: 'failed' });
      handler(makeMessage({
        messageId: 'throw-victim',
        chatJid: '15551230203@s.whatsapp.net',
        senderJid: '15551230203@s.whatsapp.net',
      }));
      await waitForStats((stats) => expect(stats.dropped).toBe(droppedBefore + 2));

      doubles.emitAlert.mockImplementationOnce(() => {
        throw new Error('sink unavailable');
      });
      handler(makeMessage({
        messageId: 'outcome-survivor',
        chatJid: '15551230204@s.whatsapp.net',
        senderJid: '15551230204@s.whatsapp.net',
      }));
      await waitForStats((stats) => expect(stats.dropped).toBe(droppedBefore + 3));

      anchor.resolve();
      await waitForIdle();

      expect(getIngestStats().dropped).toBe(droppedBefore + 3);
      expect(doubles.emitAlert).toHaveBeenCalledTimes(3);
      expect(displacementLog('legacy-victim')).toMatchObject({
        displacementIncidentAccepted: false,
        displacementIncidentStatus: 'legacy_accepted_unconfirmed',
      });
      expect(displacementLog('failed-victim')).toMatchObject({
        displacementIncidentAccepted: false,
        displacementIncidentStatus: 'failed',
      });
      expect(displacementLog('throw-victim')).toMatchObject({
        displacementIncidentAccepted: false,
        displacementIncidentStatus: 'threw',
      });

      db.raw.close();
    });
  });
});
