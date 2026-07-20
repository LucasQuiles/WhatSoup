/**
 * B2 / QR-143 — the control-plane heal intercept (ingest.ts step 0) was
 * phone-keyed with NO authenticated-transport check. resolvePhoneFromJid
 * collapses `+<peer-digits>@sms` to the SAME bare phone as a real control peer,
 * so a spoofed SMS from a control-peer number could route a forged
 * HEAL_COMPLETE/HEAL_ESCALATE into the heal state machine — flipping
 * heal_reports.state or fabricating a Type-3 row (incident-state corruption).
 *
 * These tests deliberately use the REAL access-list resolver (no
 * `resolvePhoneFromJid` mock) so the `+<peer-digits>@sms → <peer-digits>`
 * collapse genuinely happens: the transport gate is the ONLY thing that flips
 * RED→GREEN. Both directions are proven: authenticated peer INTERCEPTED
 * (preserved), spoofed @sms peer NOT intercepted (new).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

const PEER_PHONE = '15559998888';
const PEER_PN_JID = `${PEER_PHONE}@s.whatsapp.net`; // authenticated
const PEER_SMS_JID = `+${PEER_PHONE}@sms`; // spoofable: same bare digits as the peer

// config mock: controlPeers keyed to PEER_PHONE. access-list is REAL.
vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>([['q', '15559998888']]),
    botName: 'WhatSoup',
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/core/command-router.ts', () => ({
  isAdminMessage: vi.fn().mockReturnValue(false),
  parseAdminCommand: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/admin.ts', () => ({
  handleAdminCommand: vi.fn().mockResolvedValue(undefined),
  handleFallbackCommand: vi.fn().mockResolvedValue(undefined),
  handleGrantCommand: vi.fn().mockResolvedValue(undefined),
  sendApprovalRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/access-policy.ts', () => ({
  shouldRespond: vi.fn().mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' }),
}));

// NOTE: access-list is intentionally NOT mocked — the real resolvePhoneFromJid
// must perform the @sms→digits collapse for the spoof to be genuine.

import { Database } from '../../src/core/database.ts';
import { createIngestHandler } from '../../src/core/ingest.ts';
import { drainIngest } from './_helpers/ingest-drain.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

function makeRuntime(): Runtime {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
  };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(3).toString('hex')}`,
    chatJid: PEER_PN_JID,
    senderJid: PEER_PN_JID,
    senderName: 'Peer',
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

const BOT_JID = '15551230004@s.whatsapp.net';
const HEAL = '[HEAL_COMPLETE] {"reportId":"r1","errorClass":"OOM","result":"fixed"}';

async function runIngest(handler: (msg: IncomingMessage) => void, msg: IncomingMessage): Promise<void> {
  handler(msg);
  await drainIngest();
}

function makeIngest(db: Database, messenger: Messenger, runtime: Runtime) {
  return createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(shouldRespond).mockReturnValue({ respond: true, reason: 'dm_allowed', accessStatus: 'allowed' });
});

describe('B2 control-plane intercept — QR-143 transport gate', () => {
  it('ALLOWS an authenticated control-peer HEAL_COMPLETE to be intercepted (preserved)', async () => {
    const db = makeDb();
    const runtime = makeRuntime();
    const handler = makeIngest(db, makeMessenger(), runtime);

    const msg = makeMsg({ messageId: 'auth-peer-heal', senderJid: PEER_PN_JID, content: HEAL });
    await runIngest(handler, msg);

    // Intercepted: stored in control_messages, NOT messages, NOT dispatched.
    const ctrl = db.raw.prepare('SELECT COUNT(*) AS c FROM control_messages WHERE message_id = ?').get(msg.messageId) as { c: number };
    expect(ctrl.c).toBe(1);
    const inMsgs = db.raw.prepare('SELECT COUNT(*) AS c FROM messages WHERE message_id = ?').get(msg.messageId) as { c: number };
    expect(inMsgs.c).toBe(0);
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
    db.close();
  });

  it('DENIES a spoofed +<peer-digits>@sms HEAL_COMPLETE — NOT intercepted, flows to normal path (new)', async () => {
    const db = makeDb();
    const runtime = makeRuntime();
    const handler = makeIngest(db, makeMessenger(), runtime);

    const msg = makeMsg({ messageId: 'spoof-sms-heal', chatJid: PEER_SMS_JID, senderJid: PEER_SMS_JID, content: HEAL });
    await runIngest(handler, msg);

    // The @sms sender collapses to the peer phone but is NOT WhatsApp-authenticated,
    // so the control intercept must NOT fire: nothing in control_messages, and the
    // message flows through the normal path (shouldRespond consulted).
    const ctrl = db.raw.prepare('SELECT COUNT(*) AS c FROM control_messages WHERE message_id = ?').get(msg.messageId) as { c: number };
    expect(ctrl.c).toBe(0);
    expect(vi.mocked(shouldRespond)).toHaveBeenCalled();
    db.close();
  });
});
