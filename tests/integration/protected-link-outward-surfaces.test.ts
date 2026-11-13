/**
 * Every outward projection of stored chat data must redact protected links,
 * including rows written before ingress redaction existed (or by an older
 * deployed build). One stored row carries a protected link in its sender name,
 * content and raw payload, plus a group subject and chat name; each surface
 * below reads that row through its production path and must return the marker
 * instead of any part of the link.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal));
// Each scratch database logs every migration; the rows assert on return values only.
vi.mock('../../src/logger.ts', async () => (await import('../helpers/logger-mock.ts')).loggerMock());

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityObligationStore } from '../../src/core/capability-obligation-store.ts';
import { Database } from '../../src/core/database.ts';
import { withTransaction } from '../../src/core/db-tx.ts';
import { DeferredTurnStore } from '../../src/core/deferred-turn-store.ts';
import { PROTECTED_MESSAGE_MARKER } from '../../src/core/protected-message.ts';
import { formatChatRefForOwner } from '../../src/core/chat-display-name.ts';
import { getRecentMessageText } from '../../src/core/messages.ts';
import { ContactsDirectory } from '../../src/core/mentions.ts';
import { createProfileRegistry } from '../../src/core/profiles.ts';
import { FleetDbReader } from '../../src/fleet/db-reader.ts';
import { handleGetChats, handleGetMessages, handleSearchMessages } from '../../src/fleet/routes/data.ts';
import { handleGetFeed } from '../../src/fleet/routes/feed.ts';
import { registerChatManagementTools } from '../../src/mcp/tools/chat-management.ts';
import { registerMediaTools } from '../../src/mcp/tools/media.ts';
import { registerMessagingTools } from '../../src/mcp/tools/messaging.ts';
import { registerSearchTools } from '../../src/mcp/tools/search.ts';
import { dispatchTurnRecoveryReplayForJob } from '../../src/runtimes/agent/turn-recovery-dispatch.ts';
import { sharedRuntimeApplicationContext } from '../../src/runtimes/agent/turn-provider-text.ts';
import {
  fromPineconeHit,
  fromPineconeHitEntity,
  toPineconeRecord,
} from '../../src/runtimes/chat/providers/pinecone.ts';
import { leasePendingFacts } from '../../src/runtimes/chat/enrichment/fact-export-queue.ts';
import type { TurnRecoveryJobRow } from '../../src/core/turn-recovery-store.ts';
import type { QueuedTurn } from '../../src/runtimes/agent/turn-queue.ts';
import { TEST_LINK_HOST } from '../helpers/protected-delivery-pins.ts';
import { mockReq, mockRes } from '../helpers/http-mocks.ts';
import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';

const LINK = `https://${TEST_LINK_HOST}/s/#v3.${'Q'.repeat(22)}.${'Z'.repeat(43)}`;
// 16 characters: the redacted name fits the 40-character owner render cap,
// while the unredacted name is cut inside the host, which a scanner cannot match.
const SENDER = `Mallory Account ${LINK}`;
const GROUP_NAME = `Team ${LINK}`;
// 95 characters: the redacted content fits the 120-character feed preview,
// while the unredacted content is cut inside the host.
const CONTENT = `${'word '.repeat(19)}${LINK}`;
const RAW = JSON.stringify({ message: { conversation: CONTENT }, pushName: SENDER });

const DM_JID = '15550100001@s.whatsapp.net';
const DM_KEY = '15550100001';
const GROUP_JID = 'protected-group@g.us';
const GROUP_KEY = 'protected-group_at_g.us';
const GROUP_SENDER_JID = '15550100002@s.whatsapp.net';
// A separate contact, so the owner display row keeps resolving through the
// sender-name rung it was built to test.
const CONTACT_JID = '15550100003@s.whatsapp.net';
const CONTACT_PHONE = '15550100003';
const TS = 1_700_000_000;
const SELF = 'self';

let db: Database;
let reader: FleetDbReader;
let logDir: string;

function seed(target: Database): void {
  const insert = target.raw.prepare(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_text,
       content_type, is_from_me, timestamp, raw_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'text', 0, ?, ?)
  `);
  // content_text feeds the full-text index the search surfaces read.
  insert.run(DM_JID, DM_KEY, DM_JID, SENDER, 'dm-protected', CONTENT, CONTENT, TS, RAW);
  insert.run(GROUP_JID, GROUP_KEY, GROUP_SENDER_JID, SENDER, 'group-protected', CONTENT, CONTENT, TS + 1, RAW);
  target.raw.prepare('INSERT INTO groups (jid, subject) VALUES (?, ?)').run(GROUP_JID, GROUP_NAME);
  target.raw.prepare('INSERT INTO chats (jid, conversation_key, name) VALUES (?, ?, ?)')
    .run(GROUP_JID, GROUP_KEY, GROUP_NAME);
  target.raw.prepare(`
    INSERT INTO access_list (subject_type, subject_id, status, display_name, requested_at)
    VALUES ('phone', ?, 'pending', ?, '2026-01-01 00:00:00')
  `).run(DM_KEY, SENDER);
  target.raw.prepare('INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, ?, ?)')
    .run(CONTACT_JID, CONTACT_PHONE, SENDER, SENDER);
}

function routeBody(handler: typeof handleGetChats, url: string): unknown {
  const res = mockRes();
  handler(mockReq({ url }), res, {
    discovery: { getInstance: () => ({ name: SELF, dbPath: '' }) } as never,
    dbReader: reader,
  }, { name: SELF });
  return JSON.parse(res._body);
}

function recoveryJob(scope: 'per_chat' | 'shared' | 'singleton'): TurnRecoveryJobRow {
  return {
    id: 1,
    scope,
    conversation_key: GROUP_KEY,
    delivery_jid: GROUP_JID,
    source_message_id: 'group-protected',
    source_received_at_unix_seconds: TS,
    source_inbound_seq: 1,
    sender_jid: GROUP_SENDER_JID,
    sender_name: SENDER,
    replay_text: CONTENT,
    is_group: 1,
    group_name: GROUP_NAME,
  } as unknown as TurnRecoveryJobRow;
}

async function recoveryReplay(scope: 'per_chat' | 'shared' | 'singleton'): Promise<unknown> {
  const contexts: unknown[] = [];
  const turns: QueuedTurn[] = [];
  const session = {};
  const coordinator = {
    createRuntimeTurnForDispatch: (args: { text: string; source: unknown }) => {
      contexts.push({ text: args.text, source: args.source });
      return {};
    },
    processPerChatTurn: async (_scope: unknown, turn: QueuedTurn) => { turns.push(turn); },
  };
  const target = scope === 'per_chat' ? { scope, mapKey: GROUP_KEY, session } : { scope, session };
  const outcome = await dispatchTurnRecoveryReplayForJob(
    coordinator as never,
    () => GROUP_KEY,
    () => session as never,
    () => 'tool-scope',
    () => true,
    async () => true,
    async (turn) => { turns.push(turn); },
    'global-scope',
    recoveryJob(scope),
    target as never,
  );
  return {
    outcome,
    contexts,
    turns: turns.map((turn) => ({ text: turn.text, senderName: turn.senderName, groupName: turn.groupName })),
    providerMetadata: turns.map((turn) => sharedRuntimeApplicationContext(turn, db)),
  };
}

function pineconeRecord() {
  return {
    id: 'rec-protected',
    text: CONTENT,
    chatJid: GROUP_JID,
    senderJid: GROUP_SENDER_JID,
    senderName: SENDER,
    memoryType: 'user_fact' as const,
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    superseded: '',
    sourceMessagePks: '1',
    claim: CONTENT,
    evidence: CONTENT,
  };
}

/**
 * One capability obligation in its own database, so the due-row and operator
 * rows each read only the obligation they seed.
 */
function withCapabilityObligation<T>(
  sourceToken: string,
  isGroup: boolean,
  read: (store: CapabilityObligationStore, id: number) => T,
): T {
  const capabilityDb = new Database(':memory:');
  capabilityDb.open();
  try {
    const store = new CapabilityObligationStore(capabilityDb);
    let id = 0;
    withTransaction(capabilityDb, () => {
      id = store.applyDecisionWithinCallerTransaction({
        auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
        obligation: {
          sourceInboundSeq: 1,
          sourceMessageId: 'group-protected',
          conversationKey: GROUP_KEY,
          deliveryJid: GROUP_JID,
          senderJid: GROUP_SENDER_JID,
          senderName: SENDER,
          isGroup,
          groupName: GROUP_NAME,
          scope: 'per_chat',
          originRecoveryJobId: null,
          replayText: CONTENT,
          contentTypeHint: 'text',
          contractVersion: 'test-instance/1',
          requiredCapability: 'child_process_tools',
          capabilityParams: '{"skill":"watch"}',
          inputDigest: 'aa'.repeat(32),
          sourceDigest: 'bb'.repeat(32),
          sourceToken,
          retainedMedia: null,
          creationReason: 'harness_capability_gap',
        },
      }).obligationId!;
    });
    return read(store, id);
  } finally {
    capabilityDb.close();
  }
}

/** A separate database for rows whose production path changes the rows it reads. */
async function withScratchDb<T>(read: (scratch: Database) => T | Promise<T>): Promise<T> {
  const scratch = new Database(':memory:');
  scratch.open();
  try {
    return await read(scratch);
  } finally {
    scratch.close();
  }
}

interface SurfaceCase {
  surface: string;
  probe: () => unknown | Promise<unknown>;
  /** Surfaces that drop a protected name entirely instead of carrying the marker. */
  mustContain?: string;
}

const SURFACES: SurfaceCase[] = [
  {
    surface: 'owner display name (formatChatRefForOwner, DM sender-name rung and group subject)',
    probe: () => [formatChatRefForOwner(db, DM_KEY), formatChatRefForOwner(db, GROUP_KEY)],
  },
  {
    surface: 'fleet db reader getChats',
    probe: () => reader.getChats(SELF, '', { limit: 50, offset: 0 }),
  },
  {
    surface: 'fleet db reader getMessages (content, sender name, raw payload)',
    probe: () => reader.getMessages(SELF, '', { conversationKey: DM_KEY, limit: 10 }),
  },
  {
    surface: 'fleet db reader searchMessages',
    probe: () => reader.searchMessages(SELF, '', { query: 'word', limit: 10 }),
  },
  {
    surface: 'fleet db reader getMessagesByIds and getRecentMessagesByChat',
    probe: () => [
      reader.getMessagesByIds(SELF, '', ['dm-protected']),
      reader.getRecentMessagesByChat(SELF, '', DM_KEY, 'inbound', TS, 3),
    ],
  },
  {
    surface: 'fleet db reader getAccessList',
    probe: () => reader.getAccessList(SELF, ''),
  },
  {
    surface: 'fleet data route chats (names and previews)',
    probe: () => routeBody(handleGetChats, `/api/lines/${SELF}/chats`),
  },
  {
    surface: 'fleet data route messages',
    probe: () => routeBody(handleGetMessages, `/api/lines/${SELF}/messages?conversation_key=${DM_KEY}`),
  },
  {
    surface: 'fleet data route message search',
    probe: () => routeBody(handleSearchMessages, `/api/lines/${SELF}/messages/search?q=word`),
  },
  {
    surface: 'fleet feed (log-derived sender name and database preview)',
    probe: () => {
      const res = mockRes();
      handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, {
        discovery: {
          getInstances: () => new Map([[SELF, { name: SELF, type: 'agent', logDir, dbPath: '' }]]),
        } as never,
        healthPoller: { getStatus: () => null } as never,
        dbReader: reader,
      });
      return JSON.parse(res._body);
    },
  },
  { surface: 'deferred-turn recovery replay, per_chat scope', probe: () => recoveryReplay('per_chat') },
  { surface: 'deferred-turn recovery replay, shared scope', probe: () => recoveryReplay('shared') },
  { surface: 'deferred-turn recovery replay, singleton scope', probe: () => recoveryReplay('singleton') },
  {
    surface: 'Pinecone write boundary (record sent to upsertRecords)',
    probe: () => toPineconeRecord(pineconeRecord()),
  },
  {
    surface: 'Pinecone read boundary (memory and entity hits)',
    probe: () => [
      fromPineconeHit({
        _id: 'rec-protected',
        _score: 0.9,
        fields: { text: CONTENT, sender_name: SENDER, claim: CONTENT, chat_jid: GROUP_JID },
      }),
      fromPineconeHitEntity({
        _id: 'entity-protected',
        _score: 0.9,
        fields: { text: CONTENT, entity_type: 'person', source: 'chat', name: SENDER },
      }),
    ],
  },
  {
    surface: 'getRecentMessageText (handoff summarizer input)',
    probe: () => getRecentMessageText(db, DM_KEY, 10, 64 * 1024),
  },
  {
    surface: 'list_chats tool (chat name and last message)',
    probe: async () => {
      const registry = new ToolRegistry();
      registerChatManagementTools(db, () => null, (tool) => registry.register(tool));
      const result = await registry.call('list_chats', { limit: 50, include_last_message: true }, { tier: 'global' });
      return JSON.parse(result.content[0].text);
    },
  },
  {
    surface: 'contacts directory seeded from stored sender names (mention aliases)',
    probe: () => {
      const directory = new ContactsDirectory();
      directory.observe(DM_JID, SENDER);
      return [...directory.contacts.keys()];
    },
    mustContain: DM_KEY,
  },
  {
    surface: 'deferred-turn obligation claim (replay text, sender and group names)',
    probe: () => {
      const store = new DeferredTurnStore(db);
      store.enqueueDeferredObligation({
        scope: 'per_chat',
        conversationKey: GROUP_KEY,
        deliveryJid: GROUP_JID,
        inboundSeq: 1,
        sourceMessageId: 'group-protected',
        receivedAtUnixSeconds: TS + 1,
        replaySafe: true,
        senderJid: GROUP_SENDER_JID,
        senderName: SENDER,
        text: CONTENT,
        isGroup: true,
        groupName: GROUP_NAME,
        contentType: 'text',
      });
      return store.claimNextEligible('per_chat', {
        conversationKey: GROUP_KEY,
        claimToken: 'claim-protected',
        ttlSeconds: 60,
      });
    },
  },
  // A neutral source token keeps the two due-row cases about the fields the
  // store redacts. A group obligation waits for the drain-approval chain before
  // it is due, so these are not groups; each still stores a group name to cover
  // that field. Each mapper has its own row, so neither can vanish unnoticed.
  {
    surface: 'capability obligation due rows (listDueObligations)',
    probe: () => withCapabilityObligation('https://media.example.test/clip', false, (store) => {
      const due = store.listDueObligations(10);
      expect(due).toHaveLength(1);
      return due;
    }),
  },
  {
    surface: 'capability obligation due rows (dueObligationById)',
    probe: () => withCapabilityObligation('https://media.example.test/clip', false, (store, id) => {
      const result = store.dueObligationById(id);
      expect(result.due).not.toBeNull();
      return result;
    }),
  },
  {
    surface: 'capability obligation operator inspect view (source token)',
    probe: () => withCapabilityObligation(LINK, true, (store, id) => store.operatorInspectObligation(id)),
  },
  {
    surface: 'search_contacts tool (display and notify names)',
    probe: async () => {
      const registry = new ToolRegistry();
      registerSearchTools(db, (tool) => registry.register(tool));
      const result = await registry.call('search_contacts', { query: CONTACT_PHONE }, { tier: 'global' });
      return JSON.parse(result.content[0].text);
    },
  },
  {
    surface: 'reply_message tool (stored content quoted back to WhatsApp)',
    probe: async () => {
      const sent: unknown[] = [];
      const registry = new ToolRegistry();
      registerMessagingTools(registry, {
        connection: {
          sendRaw: async (jid: string, content: unknown) => {
            sent.push({ jid, content });
            return { waMessageId: null };
          },
        } as never,
        db: db.raw,
        dbWrapper: db,
        adminPhones: new Set<string>(),
        instanceName: SELF,
        profiles: createProfileRegistry({}),
      });
      const result = await registry.call(
        'reply_message',
        { messageId: 'dm-protected', text: 'noted' },
        { tier: 'chat-scoped', conversationKey: DM_KEY, deliveryJid: DM_JID },
      );
      return { result: result.content[0].text, sent };
    },
  },
  {
    surface: 'fact export queue lease (payload handed to the export bridge)',
    probe: () => withScratchDb((scratch) => {
      scratch.raw.prepare(`
        INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, sender_jid, namespace, payload_json)
        VALUES ('uid-protected', 'fact-protected', ?, ?, 'facts', ?)
      `).run(GROUP_JID, GROUP_SENDER_JID, JSON.stringify({
        text: CONTENT,
        memoryType: 'user_fact',
        confidence: 0.9,
        senderName: SENDER,
        supersedesText: CONTENT,
        sourceMessagePks: [1],
        claim: CONTENT,
        evidence: CONTENT,
      }));
      const leased = leasePendingFacts(scratch, { owner: 'bridge', limit: 10, leaseSeconds: 60, nowUnixSec: TS });
      expect(leased).toHaveLength(1);
      return leased;
    }),
  },
  {
    // Last row: it adds an audio message the rows above must not read.
    surface: 'transcribe_audio tool (cached stored transcript)',
    probe: async () => {
      db.raw.prepare(`
        INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, message_id, content_text, content_type, is_from_me, timestamp)
        VALUES (?, ?, ?, 'audio-protected', ?, 'audio', 0, ?)
      `).run(DM_JID, DM_KEY, DM_JID, CONTENT, TS + 2);
      const registry = new ToolRegistry();
      registerMediaTools(registry, { connection: {} as never, db, adminPhones: new Set<string>() });
      const result = await registry.call('transcribe_audio', { message_id: 'audio-protected' }, { tier: 'global' });
      return result.content[0].text;
    },
  },
];

describe('protected links in stored rows never reach an outward surface', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    db.open();
    seed(db);
    reader = new FleetDbReader(SELF, db.raw);
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-link-surfaces-'));
    fs.writeFileSync(path.join(logDir, 'current.log'), `${JSON.stringify({
      level: 30,
      time: TS * 1000,
      msg: 'inbound message received',
      chatJid: DM_JID,
      messageId: 'dm-protected',
      senderName: SENDER,
    })}\n`);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it.each(SURFACES)('$surface', async ({ probe, mustContain }) => {
    const serialized = JSON.stringify(await probe());

    // Any surviving part of the link counts: a truncated host is still a leak.
    expect(serialized).not.toContain(TEST_LINK_HOST.slice(0, 6));
    expect(serialized).not.toContain('Q'.repeat(22));
    // The positive check proves the probe reached the stored row at all.
    expect(serialized).toContain(mustContain ?? PROTECTED_MESSAGE_MARKER);
  });
});
