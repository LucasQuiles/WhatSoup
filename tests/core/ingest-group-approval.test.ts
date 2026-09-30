/**
 * #3566: contact-approval requests from group strangers.
 *
 * Runs the REAL access policy (shouldRespond) and access list against a temp
 * database, with only the admin side effects mocked, so the ingest gate is
 * exercised with the exact TriggerResult the policy produces. In strict group
 * mode (groupSenderPolicy 'allowlisted_only') an unknown sender only produces
 * an approval request when they @mentioned the bot; direct chats keep asking;
 * the status broadcast never asks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

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

import { Database } from '../../src/core/database.ts';
import { createIngestHandler } from '../../src/core/ingest.ts';
import { drainIngest } from './_helpers/ingest-drain.ts';
import { resolvePhoneFromJid } from '../../src/core/access-list.ts';
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import { sendApprovalRequest } from '../../src/core/admin.ts';
import { config } from '../../src/config.ts';

const mockSendApprovalRequest = vi.mocked(sendApprovalRequest);

const BOT_JID = '15550356609@s.whatsapp.net';
const UNKNOWN_SENDER = '15550356601@s.whatsapp.net';
const ALLOWED_SENDER = '15550356602@s.whatsapp.net';
const GROUP_JID = '111111100003566@g.us';

type MutableConfig = { groupSenderPolicy: string; accessMode: string; adminPhones: Set<string> };
const mutableConfig = config as unknown as MutableConfig;
const savedConfig = {
  groupSenderPolicy: mutableConfig.groupSenderPolicy,
  accessMode: mutableConfig.accessMode,
  adminPhones: mutableConfig.adminPhones,
};

const tempDbPaths: string[] = [];
const openDbs: Database[] = [];

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function makeDb(): Database {
  const path = join(tmpdir(), `ingest-group-approval-${randomBytes(4).toString('hex')}.db`);
  tempDbPaths.push(path);
  const db = new Database(path);
  db.open();
  openDbs.push(db);
  db.raw.prepare(
    `INSERT OR IGNORE INTO access_list (subject_type, subject_id, status, display_name, requested_at)
     VALUES ('phone', ?, 'allowed', 'Allowed', datetime('now'))`,
  ).run(resolvePhoneFromJid(ALLOWED_SENDER, db));
  return db;
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(4).toString('hex')}`,
    chatJid: UNKNOWN_SENDER,
    senderJid: UNKNOWN_SENDER,
    senderName: 'Stranger',
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

function makeIngest() {
  const db = makeDb();
  const messenger: Messenger = {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
  const runtime: Runtime = {
    start: vi.fn().mockResolvedValue(undefined),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
  };
  const journalInbound = vi.fn().mockReturnValue(7);
  const markInboundSkipped = vi.fn();
  const durability = {
    journalInbound,
    markInboundSkipped,
    matchEcho: vi.fn(),
    getInboundReceivedAtUnixSeconds: vi.fn().mockReturnValue(undefined),
  } as unknown as Parameters<typeof createIngestHandler>[5];
  const handler = createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null, durability);
  return { db, runtime, handler, journalInbound, markInboundSkipped };
}

async function runIngest(handler: (msg: IncomingMessage) => void, msg: IncomingMessage): Promise<void> {
  handler(msg);
  await drainIngest();
}

function setGroupSenderPolicy(policy: 'allowlisted_only' | 'any_member'): void {
  mutableConfig.groupSenderPolicy = policy;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAdminMessage).mockReturnValue(false);
  vi.mocked(parseAdminCommand).mockReturnValue(null);
  mockSendApprovalRequest.mockResolvedValue(undefined);
  mutableConfig.accessMode = 'allowlist';
  mutableConfig.adminPhones = new Set<string>();
});

afterEach(() => {
  mutableConfig.groupSenderPolicy = savedConfig.groupSenderPolicy;
  mutableConfig.accessMode = savedConfig.accessMode;
  mutableConfig.adminPhones = savedConfig.adminPhones;
  for (const db of openDbs.splice(0)) db.close();
  for (const p of tempDbPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) unlinkIfPresent(p + suffix);
  }
});

describe('#3566: approval requests from group strangers need an @mention', () => {
  it('strict group + unknown sender + no mention: no approval request, still stored and journaled as access_denied', async () => {
    setGroupSenderPolicy('allowlisted_only');
    const { db, runtime, handler, journalInbound, markInboundSkipped } = makeIngest();
    const msg = makeMsg({ chatJid: GROUP_JID, isGroup: true });

    await runIngest(handler, msg);

    expect(mockSendApprovalRequest).not.toHaveBeenCalled();
    expect(runtime.handleMessage).not.toHaveBeenCalled();
    const stored = db.raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE message_id = ?').get(msg.messageId) as { n: number };
    expect(stored.n).toBe(1);
    expect(journalInbound).toHaveBeenCalledWith(msg.messageId, '111111100003566_at_g.us', GROUP_JID, 'none');
    expect(markInboundSkipped).toHaveBeenCalledWith(7, 'access_denied');
  });

  it('strict group + unknown sender + @mention of the bot: approval request as before', async () => {
    setGroupSenderPolicy('allowlisted_only');
    const { db, runtime, handler, markInboundSkipped } = makeIngest();
    const msg = makeMsg({ chatJid: GROUP_JID, isGroup: true, mentionedJids: [BOT_JID], content: '@bot hi' });

    await runIngest(handler, msg);

    expect(mockSendApprovalRequest).toHaveBeenCalledTimes(1);
    const [, , phone, name, preview] = mockSendApprovalRequest.mock.calls[0]!;
    expect(phone).toBe(resolvePhoneFromJid(UNKNOWN_SENDER, db));
    expect(name).toBe('Stranger');
    expect(preview).toBe('@bot hi');
    expect(runtime.handleMessage).not.toHaveBeenCalled();
    expect(markInboundSkipped).toHaveBeenCalledWith(7, 'access_denied');
  });

  it('strict group + unknown sender mentioning someone else: no approval request', async () => {
    setGroupSenderPolicy('allowlisted_only');
    const { handler } = makeIngest();
    const msg = makeMsg({ chatJid: GROUP_JID, isGroup: true, mentionedJids: ['15550356603@s.whatsapp.net'] });

    await runIngest(handler, msg);

    expect(mockSendApprovalRequest).not.toHaveBeenCalled();
  });

  it('non-strict group (any_member): an unknown sender never produces an approval request, mentioned or not', async () => {
    setGroupSenderPolicy('any_member');
    const { runtime, handler } = makeIngest();

    await runIngest(handler, makeMsg({ chatJid: GROUP_JID, isGroup: true }));
    expect(runtime.handleMessage).not.toHaveBeenCalled();

    await runIngest(handler, makeMsg({ chatJid: GROUP_JID, isGroup: true, mentionedJids: [BOT_JID] }));
    expect(runtime.handleMessage).toHaveBeenCalledTimes(1);

    expect(mockSendApprovalRequest).not.toHaveBeenCalled();
  });

  it('direct chat + unknown sender: approval request as before (strict group policy does not affect DMs)', async () => {
    setGroupSenderPolicy('allowlisted_only');
    const { db, runtime, handler } = makeIngest();

    await runIngest(handler, makeMsg());

    expect(mockSendApprovalRequest).toHaveBeenCalledTimes(1);
    expect(mockSendApprovalRequest.mock.calls[0]![2]).toBe(resolvePhoneFromJid(UNKNOWN_SENDER, db));
    expect(runtime.handleMessage).not.toHaveBeenCalled();
  });

  it('status@broadcast from an unknown sender never produces an approval request', async () => {
    setGroupSenderPolicy('allowlisted_only');
    const { runtime, handler } = makeIngest();

    // The parser marks status posts non-response-worthy; the ingest gate must
    // hold even for a status row that reaches the unknown-DM policy branch.
    await runIngest(handler, makeMsg({ chatJid: 'status@broadcast', isResponseWorthy: false }));
    await runIngest(handler, makeMsg({ chatJid: 'status@broadcast', isResponseWorthy: true }));

    expect(mockSendApprovalRequest).not.toHaveBeenCalled();
    expect(runtime.handleMessage).not.toHaveBeenCalled();
  });

  it('allowed sender is unchanged: dispatched in a strict group with a mention and in a DM, no approval request', async () => {
    setGroupSenderPolicy('allowlisted_only');
    const { runtime, handler } = makeIngest();

    await runIngest(handler, makeMsg({ chatJid: GROUP_JID, senderJid: ALLOWED_SENDER, isGroup: true, mentionedJids: [BOT_JID] }));
    await runIngest(handler, makeMsg({ chatJid: ALLOWED_SENDER, senderJid: ALLOWED_SENDER }));

    expect(runtime.handleMessage).toHaveBeenCalledTimes(2);
    expect(mockSendApprovalRequest).not.toHaveBeenCalled();
  });
});
