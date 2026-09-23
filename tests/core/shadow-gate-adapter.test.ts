/**
 * Unit tests for the shadow-gate ingest adapter: each input feature's
 * true / false / unknown paths, the obligation lookup against real stored
 * rows, OVERRUN / E_THROW classification, and the recorder lifecycle
 * (mode off never touches the database; creation failure latches).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from '../../src/core/types.ts';

vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  const logger = singletonLoggerMock();
  return { createChildLogger: () => logger };
});

// The grant resolver and key canonicalizer delegate to the mocked resolver, so a
// throwing resolver reaches every feature that depends on it.
vi.mock('../../src/core/access-list.ts', async () => {
  const { isAuthenticatedSenderJid, isLidJid } = await import('../../src/core/jid-constants.ts');
  const { toConversationKey } = await import('../../src/core/conversation-key.ts');
  const resolvePhoneFromJid = vi.fn((jid: string, _db?: unknown) => jid.split('@')[0]);
  return {
    resolvePhoneFromJid,
    resolvePhoneFromJidForGrant: vi.fn((jid: string, db: unknown) =>
      isAuthenticatedSenderJid(jid) ? resolvePhoneFromJid(jid, db) : null),
    canonicalConversationKey: vi.fn((jid: string, db: unknown) =>
      isLidJid(jid) ? resolvePhoneFromJid(jid, db) : toConversationKey(jid)),
  };
});

import { Database } from '../../src/core/database.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';
import { resolvePhoneFromJid } from '../../src/core/access-list.ts';
import { MAX_SHADOW_TEXT_UTF16 } from '../../src/core/shadow-gate-features.ts';
import {
  buildShadowGateInput,
  evaluateShadowGateForMessage,
  getShadowGateRecorder,
  getShadowGateStats,
  startShadowGateAttempt,
  __resetShadowGateForTests,
} from '../../src/core/shadow-gate-adapter.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { config } from '../../src/config.ts';

const tmp = trackTmpDirs('shadow-gate-adapter-');

const BOT_JID = '15551230004@s.whatsapp.net';
const BOT_LID = '15559876543@lid';
const SENDER = '15551230008@s.whatsapp.net';
const GROUP = '555123000000000012@g.us';
const GROUP_KEY = '555123000000000012_at_g.us';
const T = 1_780_000_000;

const MANAGED_KEYS = ['shadowGate', 'botErrorsJid', 'adminPhones', 'siblingPhones'] as const;
let saved: Map<string, PropertyDescriptor | undefined>;

function setConfigProp(key: string, value: unknown): void {
  Object.defineProperty(config, key, { configurable: true, writable: true, value });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePhoneFromJid).mockImplementation((jid: string) => jid.split('@')[0]);
  saved = new Map(MANAGED_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(config, k)]));
  setConfigProp('botErrorsJid', null);
  setConfigProp('adminPhones', new Set(['15550000009']));
  setConfigProp('siblingPhones', new Set<string>());
  setConfigProp('shadowGate', { mode: 'off', eventsDir: null });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await __resetShadowGateForTests();
  for (const [key, d] of saved) {
    if (d) Object.defineProperty(config, key, d);
    else delete (config as Record<string, unknown>)[key];
  }
});

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-adapter-1',
    chatJid: GROUP,
    senderJid: SENDER,
    senderName: 'Alice',
    content: 'hello there',
    contentType: 'text',
    isFromMe: false,
    isGroup: true,
    mentionedJids: [],
    timestamp: T,
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

const botJid = () => BOT_JID;
const botLid = () => BOT_LID;

function build(msg: IncomingMessage, db: Database = makeDb(), getBotJid: () => string = botJid) {
  return buildShadowGateInput(msg, db, getBotJid, botLid, config);
}

function seed(db: Database, opts: { fromMe: boolean; content: string | null; timestamp: number; key?: string }): void {
  storeMessageIfNew(db, {
    chatJid: GROUP,
    conversationKey: opts.key ?? GROUP_KEY,
    senderJid: opts.fromMe ? BOT_JID : SENDER,
    senderName: null,
    messageId: `seed-${Math.random().toString(36).slice(2)}`,
    content: opts.content,
    contentType: 'text',
    isFromMe: opts.fromMe,
    timestamp: opts.timestamp,
    quotedMessageId: null,
  });
}

// ===========================================================================

describe('buildShadowGateInput — features', () => {
  it('chatKind, contentType, quoted and featureVersion', () => {
    expect(build(makeMsg())).toMatchObject({ chatKind: 'group', contentType: 'text', quoted: false, featureVersion: 1 });
    expect(build(makeMsg({ isGroup: false, chatJid: SENDER })).chatKind).toBe('dm');
    expect(build(makeMsg({ quotedMessageId: 'q1' })).quoted).toBe(true);
    expect(build(makeMsg({ contentType: 'image', content: null })).contentType).toBe('image');
  });

  it('isOwner: true for an authenticated admin, false otherwise, unknown when resolution throws', () => {
    setConfigProp('adminPhones', new Set(['15551230008']));
    expect(build(makeMsg()).isOwner).toBe(true);
    // A spoofable @sms sender never clears the owner check.
    expect(build(makeMsg({ senderJid: '15551230008@sms' })).isOwner).toBe(false);
    setConfigProp('adminPhones', new Set(['15550000009']));
    expect(build(makeMsg()).isOwner).toBe(false);
    vi.mocked(resolvePhoneFromJid).mockImplementation(() => {
      throw new Error('resolve failed');
    });
    expect(build(makeMsg()).isOwner).toBe('unknown');
  });

  it('isBotSender: sibling in a group only; unknown when resolution throws', () => {
    setConfigProp('siblingPhones', new Set(['15551230008']));
    expect(build(makeMsg()).isBotSender).toBe(true);
    expect(build(makeMsg({ isGroup: false, chatJid: SENDER })).isBotSender).toBe(false);
    setConfigProp('siblingPhones', new Set<string>());
    expect(build(makeMsg()).isBotSender).toBe(false);
    setConfigProp('siblingPhones', new Set(['15551230008']));
    vi.mocked(resolvePhoneFromJid).mockImplementation(() => {
      throw new Error('resolve failed');
    });
    expect(build(makeMsg()).isBotSender).toBe('unknown');
  });

  it('mentionedSelf: JID, bare number and LID match; others do not; unknown without a bot JID', () => {
    expect(build(makeMsg({ mentionedJids: [BOT_JID] })).mentionedSelf).toBe(true);
    expect(build(makeMsg({ mentionedJids: ['15551230004@lid'] })).mentionedSelf).toBe(true);
    expect(build(makeMsg({ mentionedJids: [BOT_LID] })).mentionedSelf).toBe(true);
    expect(build(makeMsg({ mentionedJids: ['15551239999@s.whatsapp.net'] })).mentionedSelf).toBe(false);
    expect(build(makeMsg({ mentionedJids: [] })).mentionedSelf).toBe(false);
    expect(build(makeMsg({ mentionedJids: [BOT_JID] }), makeDb(), () => '').mentionedSelf).toBe('unknown');
    const throwing = () => {
      throw new Error('socket gone');
    };
    expect(build(makeMsg({ mentionedJids: [BOT_JID] }), makeDb(), throwing).mentionedSelf).toBe('unknown');
  });

  it('isControlChat: false when unset, true only for the bot-errors chat', () => {
    expect(build(makeMsg()).isControlChat).toBe(false);
    setConfigProp('botErrorsJid', GROUP);
    expect(build(makeMsg()).isControlChat).toBe(true);
    setConfigProp('botErrorsJid', '555123000000000099@g.us');
    expect(build(makeMsg()).isControlChat).toBe(false);
  });

  it('text: normalized raw content, mention token intact, truncation flagged', () => {
    const input = build(makeMsg({ content: '  @15551230004 ship it  ' }));
    expect(input.text).toBe('@15551230004 ship it');
    expect(input.truncated).toBe(false);
    expect(build(makeMsg({ content: null, contentType: 'image' })).text).toBeNull();
    const long = build(makeMsg({ content: 'a'.repeat(MAX_SHADOW_TEXT_UTF16 + 10) }));
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(MAX_SHADOW_TEXT_UTF16);
  });
});

describe('buildShadowGateInput — pendingObligation / contextStatus', () => {
  it('first message in chat: false / known', () => {
    expect(build(makeMsg())).toMatchObject({ pendingObligation: false, contextStatus: 'known' });
  });

  it('previous bot message with ? or ？: true / known', () => {
    const db = makeDb();
    seed(db, { fromMe: true, content: 'Deploy now?', timestamp: T - 5 });
    expect(build(makeMsg(), db)).toMatchObject({ pendingObligation: true, contextStatus: 'known' });
    const db2 = makeDb();
    seed(db2, { fromMe: true, content: '今デプロイしますか？', timestamp: T - 5 });
    expect(build(makeMsg(), db2).pendingObligation).toBe(true);
  });

  it('only the most recent earlier row counts', () => {
    const db = makeDb();
    seed(db, { fromMe: true, content: 'Deploy now?', timestamp: T - 20 });
    seed(db, { fromMe: true, content: 'Deployed.', timestamp: T - 10 });
    // Same-second and later rows are not "previous".
    seed(db, { fromMe: true, content: 'Anything else?', timestamp: T });
    seed(db, { fromMe: true, content: 'Later?', timestamp: T + 5 });
    expect(build(makeMsg(), db)).toMatchObject({ pendingObligation: false, contextStatus: 'known' });
  });

  it('a human question or a bot statement is not an obligation', () => {
    const db = makeDb();
    seed(db, { fromMe: false, content: 'anyone there?', timestamp: T - 5 });
    expect(build(makeMsg(), db).pendingObligation).toBe(false);
    const db2 = makeDb();
    seed(db2, { fromMe: true, content: null, timestamp: T - 5 });
    expect(build(makeMsg(), db2).pendingObligation).toBe(false);
  });

  it('scopes to the conversation key (explicit key overrides the chat-JID default)', () => {
    const db = makeDb();
    seed(db, { fromMe: true, content: 'Deploy now?', timestamp: T - 5, key: 'other-key' });
    expect(build(makeMsg(), db).pendingObligation).toBe(false);
    expect(buildShadowGateInput(makeMsg(), db, botJid, botLid, config, 'other-key').pendingObligation).toBe(true);
  });

  it('a database failure yields unknown / unknown', () => {
    const broken = {
      get raw(): never {
        throw new Error('database closed');
      },
    } as unknown as Database;
    expect(buildShadowGateInput(makeMsg(), broken, botJid, botLid, config)).toMatchObject({
      pendingObligation: 'unknown',
      contextStatus: 'unknown',
      isOwner: false,
    });
  });
});

describe('evaluateShadowGateForMessage', () => {
  it('OK with a verdict inside the budget', () => {
    const result = evaluateShadowGateForMessage(makeMsg({ isGroup: false, chatJid: SENDER }), makeDb(), botJid, botLid, config);
    expect(result).toMatchObject({ status: 'OK', reason: null, verdict: 'SPAWN', ruleId: 'S02_DM', chatScope: 'dm' });
    expect(result.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('OVERRUN keeps the computed verdict', () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      t += 6;
      return t;
    });
    const result = evaluateShadowGateForMessage(makeMsg(), makeDb(), botJid, botLid, config);
    expect(result).toMatchObject({ status: 'ERROR', reason: 'OVERRUN', chatScope: 'group' });
    expect(result.verdict).not.toBeNull();
    expect(result.ruleId).not.toBeNull();
    expect(result.tookMs).toBe(6);
  });

  it('E_THROW with null verdict when input build throws', () => {
    const msg = makeMsg();
    Object.defineProperty(msg, 'content', {
      get() {
        throw new Error('boom');
      },
    });
    expect(evaluateShadowGateForMessage(msg, makeDb(), botJid, botLid, config)).toMatchObject({
      status: 'ERROR',
      reason: 'E_THROW',
      verdict: null,
      ruleId: null,
      chatScope: 'group',
    });
  });
});

describe('recorder lifecycle', () => {
  function touchRecordingDb(): { db: Database; touched: string[] } {
    const touched: string[] = [];
    const db = new Proxy({}, {
      get(_target, prop) {
        touched.push(String(prop));
        return undefined;
      },
    }) as unknown as Database;
    return { db, touched };
  }

  it('mode off: no recorder, no attempt, and the database is never touched', () => {
    const { db, touched } = touchRecordingDb();
    expect(getShadowGateRecorder(db, config)).toBeNull();
    expect(startShadowGateAttempt(makeMsg(), GROUP_KEY, db, botJid, botLid, config)).toBeNull();
    expect(touched).toEqual([]);
    expect(Object.values(getShadowGateStats()).every((v) => v === 0)).toBe(true);
  });

  it('creation failure latches disabled until reset', () => {
    let reads = 0;
    setConfigProp('shadowGate', {
      mode: 'shadow',
      get eventsDir() {
        reads += 1;
        throw new Error('bad section');
      },
    });
    const db = makeDb();
    expect(getShadowGateRecorder(db, config)).toBeNull();
    expect(getShadowGateRecorder(db, config)).toBeNull();
    expect(startShadowGateAttempt(makeMsg(), GROUP_KEY, db, botJid, botLid, config)).toBeNull();
    expect(reads).toBe(1);
  });

  it('creates one recorder, settles once, and counts journal failures', async () => {
    const dir = join(tmp.make('rec'), 'events');
    setConfigProp('shadowGate', { mode: 'shadow', eventsDir: dir });
    const db = makeDb();
    const first = getShadowGateRecorder(db, config);
    expect(first).not.toBeNull();
    expect(getShadowGateRecorder(db, config)).toBe(first);

    const a = startShadowGateAttempt(makeMsg({ messageId: 'msg-a' }), GROUP_KEY, db, botJid, botLid, config)!;
    a.settle(7);
    a.settle(8);
    a.journalFailed();
    const b = startShadowGateAttempt(makeMsg({ messageId: 'msg-b' }), GROUP_KEY, db, botJid, botLid, config)!;
    b.journalFailed();
    b.settle(9);
    expect(getShadowGateStats()).toMatchObject({ evaluated: 2, recorded: 1, journalFailures: 1 });

    await __resetShadowGateForTests();
    expect(existsSync(dir)).toBe(true);
    const lines = readdirSync(dir)
      .filter((f) => f.endsWith('.ndjson'))
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const verdicts = lines.filter((e) => e.event === 'shadow_gate_verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ messageId: 'msg-a', inboundSeq: 7, databaseLineage: 'memory' });
  });
});
