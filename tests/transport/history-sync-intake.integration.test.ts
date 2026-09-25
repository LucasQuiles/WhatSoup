// End-to-end proof that history sync from our own primary reaches SQLite.
//
// Chain under test (real code at every hop except the network):
//   Baileys decodeMessageNode  → peer-routed self stanza, fromMe classification
//   Baileys processMessage     → self-only guard + history download/processing
//   ConnectionManager          → messaging-history.set → 'historyMessages'
//   processHistoryBatch        → real SQLite rows
// main.ts wires 'historyMessages' to processHistoryBatch(db, messages, log);
// tests/main-bootstrap.test.ts pins that wiring, so this test calls it the
// same way instead of booting the whole process.
//
// The history payload is delivered inline (initialHistBootstrapInlinePayload)
// so no media download is needed; Baileys takes the inline branch before any
// transfer for every sync type. FULL batches are excluded exactly as the live
// socket excludes them: shouldProcessHistoryMsg is computed from Baileys'
// default shouldSyncHistoryMessage and PROCESSABLE_HISTORY_TYPES, mirroring
// Socket/chats.js.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth-history-intake',
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-history-intake/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

const log = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock('../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../helpers/logger-mock.ts');
  return { createChildLogger: hoistedLoggerMock(log).createChildLogger };
});

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { Database } from '../../src/core/database.ts';
import { processHistoryBatch, type HistoryInput } from '../../src/core/history-sync.ts';
// Real vendored Baileys, imported by path so the module mock above (which
// stands in for the live socket) does not replace it.
import { proto } from '../../node_modules/@whiskeysockets/baileys/WAProto/index.js';
import { decodeMessageNode } from '../../node_modules/@whiskeysockets/baileys/lib/Utils/decode-wa-message.js';
import processMessage from '../../node_modules/@whiskeysockets/baileys/lib/Utils/process-message.js';
import {
  DEFAULT_CONNECTION_CONFIG,
  PROCESSABLE_HISTORY_TYPES,
} from '../../node_modules/@whiskeysockets/baileys/lib/Defaults/index.js';

// Synthetic identities in the repo's reserved fixture ranges.
const ME_PN_USER = '15550001111';
const ME_LID_USER = '11111110001';
const ME_ID = `${ME_PN_USER}:7@s.whatsapp.net`;
const ME_LID = `${ME_LID_USER}:7@lid`;
const DM_JID = '15550003333@s.whatsapp.net';
const GROUP_JID = '120000000000000001@g.us';
const GROUP_MEMBER = '15550004444@s.whatsapp.net';

const SyncType = proto.HistorySync.HistorySyncType;

interface Selected {
  id: string;
  chat: string;
  participant?: string;
  text: string;
  ts: number;
}

const SELECTED: Selected[] = [
  { id: 'HISTRECOVER0001', chat: DM_JID, text: 'sent while the line was unlinked', ts: 1_790_000_100 },
  { id: 'HISTRECOVER0002', chat: GROUP_JID, participant: GROUP_MEMBER, text: 'group message during gap', ts: 1_790_000_200 },
];

function historyPayload(syncType: number, selected: readonly Selected[]): Uint8Array {
  const byChat = new Map<string, Selected[]>();
  for (const s of selected) byChat.set(s.chat, [...(byChat.get(s.chat) ?? []), s]);
  return deflateSync(
    proto.HistorySync.encode({
      syncType,
      conversations: [...byChat.entries()].map(([id, msgs]) => ({
        id,
        messages: msgs.map((s) => ({
          message: {
            key: { remoteJid: s.chat, fromMe: false, id: s.id, participant: s.participant },
            message: { conversation: s.text },
            messageTimestamp: s.ts,
          },
        })),
      })),
    }).finish(),
  );
}

function selfNotification(syncType: number, selected: readonly Selected[]) {
  // Peer-routed from our own primary: `from` is our LID, no `recipient`.
  const stanza = {
    tag: 'message',
    attrs: { id: `NOTIF${syncType}`, t: '1790000300', from: `${ME_LID_USER}@lid` },
    content: [],
  };
  const { fullMessage } = decodeMessageNode(stanza, ME_ID, ME_LID);
  return {
    key: fullMessage.key,
    messageTimestamp: 1_790_000_300,
    message: {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
        historySyncNotification: {
          syncType,
          initialHistBootstrapInlinePayload: historyPayload(syncType, selected),
        },
      },
    },
  };
}

/** Mirrors Socket/chats.js: which notifications the live socket processes. */
function liveSocketWouldProcess(syncType: number): boolean {
  return (
    DEFAULT_CONNECTION_CONFIG.shouldSyncHistoryMessage({ syncType }) !== false &&
    PROCESSABLE_HISTORY_TYPES.includes(syncType)
  );
}

const silentLogger = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return silentLogger;
  },
};

/** Runs real processMessage and forwards what it emits to the live socket's event loop. */
async function deliverThroughBaileys(
  notification: ReturnType<typeof selfNotification>,
  syncType: number,
  forward: (events: Record<string, unknown>) => void,
): Promise<void> {
  const context = {
    shouldProcessHistoryMsg: liveSocketWouldProcess(syncType),
    placeholderResendCache: undefined,
    ev: {
      emit: (name: string, data: unknown) => {
        forward({ [name]: data });
        return true;
      },
    },
    creds: { me: { id: ME_ID, lid: ME_LID }, processedHistoryMessages: [] },
    signalRepository: {
      lidMapping: { getLIDForPN: async () => null, storeLIDPNMappings: async () => {} },
    },
    keyStore: { get: async () => ({}), set: async () => {} },
    logger: silentLogger,
    options: {},
    getMessage: async () => undefined,
  } as unknown as Parameters<typeof processMessage>[1];
  await processMessage(notification, context);
}

function makeMockSocket() {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;
  const mockSock = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn(),
    end: vi.fn(),
    user: { id: ME_ID, lid: ME_LID, name: 'WhatSoup' },
  };
  const emit = (events: Record<string, unknown>) => {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    evProcessCallback(events);
  };
  return { mockSock, emit };
}

describe('history sync intake: own primary → SQLite', () => {
  let cm: ConnectionManager;
  let emit: (events: Record<string, unknown>) => void;
  let sendMessage: ReturnType<typeof vi.fn>;
  let db: Database;
  let dbPath: string;
  let liveMessages: unknown[];
  let batches: ReturnType<typeof processHistoryBatch>[];

  beforeEach(async () => {
    vi.clearAllMocks();
    const socket = makeMockSocket();
    emit = socket.emit;
    sendMessage = socket.mockSock.sendMessage;
    (makeWASocket as ReturnType<typeof vi.fn>).mockReturnValue(socket.mockSock);

    dbPath = join(tmpdir(), `whatsoup-history-intake-${randomBytes(4).toString('hex')}.db`);
    db = new Database(dbPath);
    db.open();

    cm = new ConnectionManager();
    liveMessages = [];
    cm.onMessage = (msg) => {
      liveMessages.push(msg);
    };
    batches = [];
    cm.on('historyMessages', (messages) => {
      batches.push(processHistoryBatch(db, messages as HistoryInput[]));
    });
    await cm.connect();
    emit({ 'connection.update': { connection: 'open' } });
  });

  afterEach(async () => {
    await cm.shutdown();
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  });

  function storedRows() {
    return db.raw
      .prepare(
        `SELECT message_id, chat_jid, conversation_key, sender_jid, content, content_type, is_from_me, timestamp
         FROM messages WHERE message_id IN (${SELECTED.map(() => '?').join(',')}) ORDER BY timestamp`,
      )
      .all(...SELECTED.map((s) => s.id)) as Array<Record<string, unknown>>;
  }

  function countRows(table: string): number {
    return (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  it.each([
    ['RECENT', SyncType.RECENT],
    ['ON_DEMAND', SyncType.ON_DEMAND],
  ])('stores exactly the selected %s messages without admitting or answering them', async (_label, syncType) => {
    await deliverThroughBaileys(selfNotification(syncType, SELECTED), syncType, emit);

    expect(storedRows()).toEqual([
      expect.objectContaining({
        message_id: 'HISTRECOVER0001',
        chat_jid: DM_JID,
        sender_jid: DM_JID,
        content: 'sent while the line was unlinked',
        content_type: 'text',
        is_from_me: 0,
        timestamp: 1_790_000_100,
      }),
      expect.objectContaining({
        message_id: 'HISTRECOVER0002',
        chat_jid: GROUP_JID,
        sender_jid: GROUP_MEMBER,
        content: 'group message during gap',
        content_type: 'text',
        is_from_me: 0,
        timestamp: 1_790_000_200,
      }),
    ]);
    expect(batches).toEqual([{ inserted: 2, upgraded: 0, placeholders: 0, skipped: 0, noop: 0, failed: 0 }]);

    // Historical ingestion is storage only: no live admission, no agent turn, no reply.
    expect(liveMessages).toEqual([]);
    expect(countRows('inbound_events')).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('treats a repeated batch as an idempotent no-op and reports it as such', async () => {
    await deliverThroughBaileys(selfNotification(SyncType.RECENT, SELECTED), SyncType.RECENT, emit);
    const firstRows = storedRows();
    await deliverThroughBaileys(selfNotification(SyncType.RECENT, SELECTED), SyncType.RECENT, emit);

    expect(storedRows()).toEqual(firstRows);
    expect(batches[1]).toEqual({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 0, noop: 2, failed: 0 });
  });

  it('does not flag our own notification as a guard drop when it arrives through messages.upsert', async () => {
    const notification = selfNotification(SyncType.RECENT, SELECTED);
    emit({ 'messages.upsert': { messages: [notification], type: 'notify' } });
    await deliverThroughBaileys(notification, SyncType.RECENT, emit);

    const guardWarnings = log.warn.mock.calls.filter(([, msg]) => String(msg).includes('not marked as ours'));
    expect(guardWarnings).toEqual([]);
    expect(storedRows()).toHaveLength(2);
  });

  it('flags a history notification from another sender as dropped by the self-only guard', async () => {
    const spoofStanza = {
      tag: 'message',
      attrs: { id: 'NOTIFSPOOF', t: '1790000300', from: '15550005555@s.whatsapp.net' },
      content: [],
    };
    const { fullMessage } = decodeMessageNode(spoofStanza, ME_ID, ME_LID);
    const spoof = { ...selfNotification(SyncType.RECENT, SELECTED), key: fullMessage.key };
    emit({ 'messages.upsert': { messages: [spoof], type: 'notify' } });
    await deliverThroughBaileys(spoof, SyncType.RECENT, emit);

    expect(log.warn).toHaveBeenCalledWith(
      { syncType: SyncType.RECENT },
      'history sync notification is not marked as ours; the self-only guard drops it',
    );
    expect(batches).toEqual([]);
    expect(storedRows()).toEqual([]);
  });

  it('excludes FULL history exactly as the live socket does', async () => {
    expect(liveSocketWouldProcess(SyncType.FULL)).toBe(false);
    await deliverThroughBaileys(selfNotification(SyncType.FULL, SELECTED), SyncType.FULL, emit);

    expect(batches).toEqual([]);
    expect(storedRows()).toEqual([]);
  });
});
