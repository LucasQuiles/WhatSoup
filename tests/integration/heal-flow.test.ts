/**
 * Integration tests for the end-to-end heal control flow.
 *
 * Uses a real in-memory Database (with migrations), mocked config with
 * controlPeers, mocked messenger, and creates a real ingest handler.
 *
 * Covers:
 *   12.1.1  Control message from peer → control_messages, NOT messages
 *   12.1.2  Non-peer control prefix → messages (normal chat)
 *   12.1.3  LOOPS_HEAL creates heal_reports row with state='attempt_1'
 *   12.1.4  HEAL_COMPLETE resolves heal_reports
 *   12.1.5  Duplicate error class suppressed
 *   12.1.6  Queued report dequeued after completion
 *   12.1.7  Global valve blocks 6th report
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

// ---------------------------------------------------------------------------
// Module mocks — registered before any imports of mocked modules
// vi.mock factories are hoisted, so constants used in factory bodies must be
// inlined (cannot reference module-level variables from outer scope).
// ---------------------------------------------------------------------------

// Constants used outside vi.mock factories (safe to declare here)
const PEER_PHONE = '15559998888';
const PEER_JID = `${PEER_PHONE}@s.whatsapp.net`;
const NON_PEER_JID = '19991234567@s.whatsapp.net';
const BOT_JID = '18455943112@s.whatsapp.net';

vi.mock('../../src/config.ts', () => ({
  config: {
    // PEER_PHONE inlined: '15559998888'
    controlPeers: new Map<string, string>([['q', '15559998888']]),
    adminPhones: new Set<string>(),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-6',
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5',
      fallback: 'gpt-5.4',
    },
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/core/command-router.ts', () => ({
  isAdminMessage: vi.fn().mockReturnValue(false),
  parseAdminCommand: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/core/admin.ts', () => ({
  handleAdminCommand: vi.fn().mockResolvedValue(undefined),
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

// Mock sendTracked so tests don't attempt real network sends
vi.mock('../../src/core/durability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/durability.ts')>();
  return {
    ...actual,
    sendTracked: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import { createIngestHandler } from '../../src/core/ingest.ts';
import {
  emitHealReport,
  handleHealComplete,
  dequeueNextReport,
  checkGlobalValve,
} from '../../src/core/heal.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: `msg-${randomBytes(4).toString('hex')}`,
    chatJid: `${PEER_PHONE}@s.whatsapp.net`,
    senderJid: PEER_JID,
    senderName: 'QPeer',
    content: 'hello',
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

async function runIngest(handler: (msg: IncomingMessage) => void, msg: IncomingMessage): Promise<void> {
  handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeIngest(db: Database, messenger: Messenger, runtime: Runtime) {
  return createIngestHandler(db, messenger, runtime, () => BOT_JID, () => null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 12.1.1  Control message from peer → stored in control_messages, NOT messages
// ---------------------------------------------------------------------------

describe('12.1.1: control message from trusted peer routing', () => {
  it('stores control message in control_messages and NOT in messages', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const msgId = `ctrl-${randomBytes(4).toString('hex')}`;
    const payload = JSON.stringify({
      reportId: 'r1',
      errorClass: 'crash__oom',
      result: 'fixed',
      diagnosis: 'restarted service',
    });
    const msg = makeMsg({
      messageId: msgId,
      senderJid: PEER_JID,
      content: `[HEAL_COMPLETE] ${payload}`,
    });

    await runIngest(handler, msg);

    // Must be in control_messages
    const ctrlRow = db.raw.prepare(
      `SELECT * FROM control_messages WHERE message_id = ?`,
    ).get(msgId) as Record<string, unknown> | undefined;
    expect(ctrlRow).toBeDefined();
    expect(ctrlRow?.direction).toBe('inbound');
    expect(ctrlRow?.peer_jid).toBe(PEER_JID);
    expect(ctrlRow?.protocol).toBe('HEAL_COMPLETE');

    // Must NOT be in messages
    const msgRow = db.raw.prepare(
      `SELECT * FROM messages WHERE message_id = ?`,
    ).get(msgId) as Record<string, unknown> | undefined;
    expect(msgRow).toBeUndefined();

    // Runtime must not be dispatched
    expect(vi.mocked(runtime.handleMessage)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 12.1.2  Non-peer control prefix → messages (normal chat)
// ---------------------------------------------------------------------------

describe('12.1.2: control-prefixed message from non-peer goes to messages', () => {
  it('routes control-prefixed message from non-peer through the normal messages path', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const runtime = makeRuntime();
    const handler = makeIngest(db, messenger, runtime);

    const msgId = `nonpeer-${randomBytes(4).toString('hex')}`;
    const msg = makeMsg({
      messageId: msgId,
      senderJid: NON_PEER_JID,
      chatJid: NON_PEER_JID,
      content: '[HEAL_COMPLETE] {"reportId":"r99","errorClass":"crash__x","result":"fixed","diagnosis":"test"}',
    });

    await runIngest(handler, msg);

    // Must be in messages (normal path)
    const msgRow = db.raw.prepare(
      `SELECT * FROM messages WHERE message_id = ?`,
    ).get(msgId) as Record<string, unknown> | undefined;
    expect(msgRow).toBeDefined();

    // Must NOT be in control_messages
    const ctrlRow = db.raw.prepare(
      `SELECT * FROM control_messages WHERE message_id = ?`,
    ).get(msgId) as Record<string, unknown> | undefined;
    expect(ctrlRow).toBeUndefined();

    // Runtime dispatched normally
    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 12.1.3  emitHealReport creates heal_reports row with state='attempt_1'
// ---------------------------------------------------------------------------

describe('12.1.3: emitHealReport persists heal_reports row', () => {
  it('creates a heal_reports row with state=attempt_1 when no active report exists', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      chatJid: '1234@s.whatsapp.net',
      exitCode: 1,
      stderr: 'TypeError: cannot read property of undefined',
    });

    expect(reportId).not.toBeNull();

    const row = db.raw.prepare(
      `SELECT * FROM heal_reports WHERE report_id = ?`,
    ).get(reportId) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row?.state).toBe('attempt_1');
    expect(row?.error_type).toBe('crash');
    expect(row?.attempt_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12.1.4  HEAL_COMPLETE resolves heal_reports
// ---------------------------------------------------------------------------

describe('12.1.4: HEAL_COMPLETE resolves heal_reports row', () => {
  it('transitions heal_reports.state to resolved after handleHealComplete', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    // Create a report
    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'RangeError: stack overflow',
    });
    expect(reportId).not.toBeNull();

    // Resolve it
    handleHealComplete(db, {
      reportId: reportId!,
      errorClass: 'crash__RangeError__stack_overflow',
      result: 'fixed',
      diagnosis: 'Stack guard added',
    });

    const row = db.raw.prepare(
      `SELECT state FROM heal_reports WHERE report_id = ?`,
    ).get(reportId) as { state: string } | undefined;
    expect(row?.state).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// 12.1.5  Duplicate error class suppressed
// ---------------------------------------------------------------------------

describe('12.1.5: duplicate error class is suppressed', () => {
  it('returns null when a report for the same error class is already active', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const first = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'SyntaxError: unexpected token',
    });
    expect(first).not.toBeNull();

    // Same error hint → same errorClass → suppressed
    const second = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'SyntaxError: unexpected token',
    });
    expect(second).toBeNull();

    // Only one row in DB
    const count = (db.raw.prepare(
      `SELECT COUNT(*) as cnt FROM heal_reports`,
    ).get() as { cnt: number }).cnt;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12.1.6  Queued report dequeued after completion
// ---------------------------------------------------------------------------

describe('12.1.6: queued report is dequeued after prior report completes', () => {
  it('dequeues next queued report and transitions it to attempt_1', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    // Create report A (occupies the active slot)
    const reportIdA = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'Error: report A',
    });
    expect(reportIdA).not.toBeNull();

    // Create report B with a different error class while A is active → gets queued
    const reportIdB = emitHealReport(
      db,
      messenger,
      null,
      { type: 'crash', stderr: 'Error: report B unique' },
      reportIdA, // activeControlReportId → forces 'queued' state
    );
    expect(reportIdB).not.toBeNull();

    // Verify B is queued
    const rowBBefore = db.raw.prepare(
      `SELECT state FROM heal_reports WHERE report_id = ?`,
    ).get(reportIdB) as { state: string } | undefined;
    expect(rowBBefore?.state).toBe('queued');

    // Resolve report A
    handleHealComplete(db, {
      reportId: reportIdA!,
      errorClass: 'crash__Error__report_A',
      result: 'fixed',
      diagnosis: 'Fixed A',
    });

    // Dequeue — should return B and transition it to attempt_1
    const dequeued = dequeueNextReport(db);
    expect(dequeued).not.toBeNull();
    expect(dequeued?.report_id).toBe(reportIdB);

    // Verify B's state in DB is now attempt_1
    const rowBAfter = db.raw.prepare(
      `SELECT state FROM heal_reports WHERE report_id = ?`,
    ).get(reportIdB) as { state: string } | undefined;
    expect(rowBAfter?.state).toBe('attempt_1');
  });
});

// ---------------------------------------------------------------------------
// 12.1.7  Global valve blocks 6th report
// ---------------------------------------------------------------------------

describe('12.1.7: global valve blocks reports beyond the limit', () => {
  it('blocks the 6th report with a different error class within the same hour', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    // Create 5 reports with distinct error classes to fill the valve
    for (let i = 0; i < 5; i++) {
      const id = emitHealReport(db, messenger, null, {
        type: 'crash',
        stderr: `UniqueError_${randomUUID().slice(0, 8)}: valve fill ${i}`,
      });
      expect(id).not.toBeNull();
    }

    // Global valve should now be closed
    expect(checkGlobalValve(db)).toBe(false);

    // 6th report should be suppressed by the valve
    const sixth = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: `AnotherUniqueError_${randomUUID().slice(0, 8)}: sixth attempt`,
    });
    expect(sixth).toBeNull();

    // Only 5 rows in heal_reports
    const count = (db.raw.prepare(
      `SELECT COUNT(*) as cnt FROM heal_reports`,
    ).get() as { cnt: number }).cnt;
    expect(count).toBe(5);
  });
});
