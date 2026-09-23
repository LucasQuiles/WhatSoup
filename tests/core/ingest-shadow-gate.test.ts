/**
 * Ingest wiring of the logged-only shadow gate.
 *
 * Invariants under test: the gate never changes behaviour (the message passed to
 * runtime.handleMessage and every journalInbound argument match a mode-off
 * baseline, including on evaluation and sink failures); mode `off` does no
 * shadow work; only messages that reach dispatch are evaluated; the recorded
 * verdict carries the journalled inbound seq.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, Messenger } from '../../src/core/types.ts';
import type { Runtime } from '../../src/runtimes/types.ts';

vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  const logger = singletonLoggerMock();
  return { createChildLogger: () => logger };
});

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

vi.mock('../../src/core/access-list.ts', async () => {
  const { isAuthenticatedSenderJid } = await import('../../src/core/jid-constants.ts');
  const resolvePhoneFromJid = vi.fn((jid: string, _db?: unknown) => jid.split('@')[0]);
  return {
    extractLocal: vi.fn((jid: string) => jid.split('@')[0]),
    resolvePhoneFromJid,
    resolvePhoneFromJidForGrant: vi.fn((jid: string, db: unknown) =>
      isAuthenticatedSenderJid(jid) ? resolvePhoneFromJid(jid, db) : null),
    lookupAccess: vi.fn(),
    insertPending: vi.fn(),
    updateAccess: vi.fn(),
  };
});

// Forces the adapter's input build to throw (E_THROW) without touching ingest's
// own reads of the message.
const featureFaults = vi.hoisted(() => ({ throwOnNormalize: false }));
vi.mock('../../src/core/shadow-gate-features.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/shadow-gate-features.ts')>();
  return {
    ...actual,
    normalizeShadowText: (raw: string | null | undefined) => {
      if (featureFaults.throwOnNormalize) throw new Error('forced input build failure');
      return actual.normalizeShadowText(raw);
    },
  };
});

import { Database } from '../../src/core/database.ts';
import { createIngestHandler } from '../../src/core/ingest.ts';
import { getShadowGateStats, __resetShadowGateForTests } from '../../src/core/shadow-gate-adapter.ts';
import { __setShadowRulesPathForTests } from '../../src/core/shadow-gate.ts';
import { createChildLogger } from '../../src/logger.ts';
import type { singletonLoggerMock } from '../helpers/logger-mock.ts';
import { shouldRespond } from '../../src/core/access-policy.ts';
import { isAdminMessage, parseAdminCommand } from '../../src/core/command-router.ts';
import { drainIngest } from './_helpers/ingest-drain.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { config } from '../../src/config.ts';

const tmp = trackTmpDirs('ingest-shadow-gate-');
// The singleton from the logger vi.mock factory, retyped to its Mock shape.
const logFns = createChildLogger('ingest') as unknown as ReturnType<typeof singletonLoggerMock>;

const BOT_JID = '15551230004@s.whatsapp.net';
const SENDER = '15551230008@s.whatsapp.net';
const GROUP = '555123000000000011@g.us';
const FIRST_SEQ = 100;

// ---------------------------------------------------------------------------
// config save/restore
// ---------------------------------------------------------------------------

const MANAGED_KEYS = ['shadowGate', 'botErrorsJid', 'adminPhones', 'siblingPhones', 'pausedChats', 'botName'] as const;
let savedDescriptors: Map<string, PropertyDescriptor | undefined>;
let savedHome: string | undefined;

function setConfigProp(key: string, value: unknown): void {
  Object.defineProperty(config, key, { configurable: true, writable: true, value });
}

function restoreConfigProp(key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(config, key, descriptor);
  else delete (config as Record<string, unknown>)[key];
}

beforeEach(() => {
  vi.clearAllMocks();
  featureFaults.throwOnNormalize = false;
  savedDescriptors = new Map(MANAGED_KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(config, k)]));
  savedHome = process.env.HOME;
  // A default-path recorder must never write under the real home directory.
  process.env.HOME = tmp.make('home');
  setConfigProp('botErrorsJid', null);
  setConfigProp('adminPhones', new Set(['15550000009']));
  setConfigProp('siblingPhones', new Set<string>());
  setConfigProp('pausedChats', new Set<string>());
  setConfigProp('shadowGate', { mode: 'off', eventsDir: null });
});

afterEach(async () => {
  await __resetShadowGateForTests();
  __setShadowRulesPathForTests(null);
  for (const [key, descriptor] of savedDescriptors) restoreConfigProp(key, descriptor);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

// ---------------------------------------------------------------------------
// harness
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

let msgCounter = 0;

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  msgCounter += 1;
  return {
    // Digits glued to letters: never a standalone phone-length run the validator rejects.
    messageId: `MSGID${msgCounter}`,
    chatJid: SENDER,
    senderJid: SENDER,
    senderName: 'Alice',
    content: 'hello there',
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: 1_780_000_000,
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

function makeDurability() {
  let next = FIRST_SEQ;
  return {
    // Incrementing, so a seq threading bug cannot hide behind a constant.
    journalInbound: vi.fn(() => next++),
    getInboundReceivedAtUnixSeconds: vi.fn().mockReturnValue(1_780_000_000),
    markInboundSkipped: vi.fn(),
    markInboundFailed: vi.fn(),
    markInboundFailedIfProcessing: vi.fn(),
    matchEcho: vi.fn(),
  };
}

function makeIngest() {
  const db = makeDb();
  const durability = makeDurability();
  const handled: IncomingMessage[] = [];
  const runtime: Runtime = {
    start: vi.fn().mockResolvedValue(undefined),
    // Snapshot at call time: the argument's state when dispatch happened.
    handleMessage: vi.fn(async (m: IncomingMessage) => {
      handled.push(structuredClone(m));
    }),
    getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setDurability: vi.fn(),
  };
  const handler = createIngestHandler(
    db,
    makeMessenger(),
    runtime,
    () => BOT_JID,
    () => null,
    durability as unknown as Parameters<typeof createIngestHandler>[5],
  );
  return { db, durability, runtime, handler, handled };
}

async function runIngest(handler: (msg: IncomingMessage) => void, msg: IncomingMessage): Promise<void> {
  handler(msg);
  await drainIngest();
}

/** Run one message through a fresh pipeline; return what dispatch and the journal saw. */
async function observe(msg: IncomingMessage) {
  const { durability, handler, handled } = makeIngest();
  await runIngest(handler, msg);
  const journal = durability.journalInbound.mock.calls.map((args: unknown[]) => {
    // The fifth argument is the wall-clock ingress second; compare its type only.
    const copy = [...args];
    if (copy.length > 4) {
      expect(typeof copy[4]).toBe('number');
      copy[4] = '<ingress-seconds>';
    }
    return copy;
  });
  return { handled, journal };
}

function shadowMode(eventsDir: string | null): void {
  setConfigProp('shadowGate', { mode: 'shadow', eventsDir });
}

/** Close the recorder (flushing the sink) and read every recorded line. */
async function readEvents(dir: string): Promise<Record<string, unknown>[]> {
  await __resetShadowGateForTests();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const verdictsOf = (events: Record<string, unknown>[]) => events.filter((e) => e.event === 'shadow_gate_verdict');
const coverageOf = (events: Record<string, unknown>[]) => events.filter((e) => e.event === 'shadow_gate_coverage');

// ===========================================================================

describe('ingest shadow gate — mode off', () => {
  it('(a) does no shadow work: no directory, zero stats, dispatch as usual', async () => {
    const eventsDir = join(tmp.make('off'), 'events');
    setConfigProp('shadowGate', { mode: 'off', eventsDir });
    const msg = makeMsg();

    const { handled, journal } = await observe(msg);

    expect(existsSync(eventsDir)).toBe(false);
    expect(Object.values(getShadowGateStats()).every((v) => v === 0)).toBe(true);
    expect(handled).toHaveLength(1);
    expect(handled[0].inboundSeq).toBe(FIRST_SEQ);
    expect(journal).toEqual([[msg.messageId, SENDER.split('@')[0], SENDER, 'object', '<ingress-seconds>']]);
  });

  it('(a) does not warm the rules at handler creation', () => {
    const corrupt = join(tmp.make('off-rules'), 'rules.json');
    writeFileSync(corrupt, '{ not json');
    __setShadowRulesPathForTests(corrupt);
    makeIngest();
    const codes = vi.mocked(logFns.warn).mock.calls.map((call) => (call[0] as { code?: string }).code);
    expect(codes).not.toContain('shadow_gate_rules_unavailable');
  });

  it('(a) treats an absent shadowGate section (partial config mocks) as off', async () => {
    setConfigProp('shadowGate', undefined);
    const { handled } = await observe(makeMsg());
    expect(handled).toHaveLength(1);
    expect(getShadowGateStats().evaluated).toBe(0);
  });
});

describe('ingest shadow gate — mode shadow', () => {
  it('warms the rules once at handler creation, before any message', () => {
    const corrupt = join(tmp.make('warm-rules'), 'rules.json');
    writeFileSync(corrupt, '{ not json');
    __setShadowRulesPathForTests(corrupt);
    shadowMode(join(tmp.make('warm'), 'events'));
    makeIngest();
    const shadowWarnings = vi.mocked(logFns.warn).mock.calls.filter((call) => call[1] === 'shadow gate warning');
    expect(shadowWarnings).toEqual([[{ code: 'shadow_gate_rules_unavailable' }, 'shadow gate warning']]);
    expect(getShadowGateStats().evaluated).toBe(0);
  });

  it('(b) records one verdict carrying the journalled seq and message id, plus an armed marker', async () => {
    const eventsDir = join(tmp.make('shadow'), 'events');
    shadowMode(eventsDir);
    // WhatsApp-style id passes the event id charset.
    const msg = makeMsg({ messageId: '3EB0C767D26A8B4F1A2B' });

    const { handled } = await observe(msg);
    expect(getShadowGateStats()).toMatchObject({ evaluated: 1, recorded: 1, invalid: 0 });
    const events = await readEvents(eventsDir);

    const verdicts = verdictsOf(events);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      messageId: '3EB0C767D26A8B4F1A2B',
      inboundSeq: FIRST_SEQ,
      chatScope: 'dm',
      verdict: 'SPAWN',
      ruleId: 'S02_DM',
      authority: 'advisory_only',
    });
    expect(verdicts[0].inboundSeq).toBe(handled[0].inboundSeq);
    expect(coverageOf(events).map((e) => e.marker)).toContain('armed');
    // No message text, JID or phone number reaches the file.
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('hello there');
    expect(raw).not.toContain('15551230008');
  });

  it('records inboundSeq null when ingest runs without durability', async () => {
    const eventsDir = join(tmp.make('nodur'), 'events');
    shadowMode(eventsDir);
    const runtime: Runtime = {
      start: vi.fn().mockResolvedValue(undefined),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      getHealthSnapshot: vi.fn().mockReturnValue({ status: 'healthy', details: {} }),
      shutdown: vi.fn().mockResolvedValue(undefined),
      setDurability: vi.fn(),
    };
    const handler = createIngestHandler(makeDb(), makeMessenger(), runtime, () => BOT_JID, () => null);
    await runIngest(handler, makeMsg());

    expect(vi.mocked(runtime.handleMessage)).toHaveBeenCalledOnce();
    const verdicts = verdictsOf(await readEvents(eventsDir));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ inboundSeq: null, status: 'OK', verdict: 'SPAWN', ruleId: 'S02_DM' });
  });

  it('defaults the events dir under HOME and sanitizes a bot name containing a space', async () => {
    setConfigProp('botName', 'My Bot');
    shadowMode(null);
    await observe(makeMsg());

    const dir = join(process.env.HOME!, '.config', 'whatsoup', 'instances', 'My Bot');
    const events = await readEvents(dir);
    expect(verdictsOf(events)).toHaveLength(1);
    expect(events.every((e) => e.instance === 'My_Bot')).toBe(true);
  });

  it('(c) records E_THROW when input build throws, dispatch unchanged', async () => {
    const eventsDir = join(tmp.make('throw'), 'events');
    shadowMode(eventsDir);
    featureFaults.throwOnNormalize = true;

    const { handled } = await observe(makeMsg());

    expect(handled).toHaveLength(1);
    const verdicts = verdictsOf(await readEvents(eventsDir));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ status: 'ERROR', reason: 'E_THROW', verdict: null, ruleId: null });
  });

  it('(d) an unwritable events dir does not throw and does not change dispatch', async () => {
    const blocker = join(tmp.make('blocked'), 'not-a-dir');
    writeFileSync(blocker, 'x');
    shadowMode(join(blocker, 'events'));

    const { handled } = await observe(makeMsg());

    expect(handled).toHaveLength(1);
    expect(getShadowGateStats().evaluated).toBe(1);
    await expect(__resetShadowGateForTests()).resolves.toBeUndefined();
  });

  it('counts a journalInbound failure without recording a verdict; ingest behaves as in mode off', async () => {
    const journalError = new Error('journal down');
    const msg = makeMsg({ messageId: 'msg-jfail' });
    async function runWithFailingJournal() {
      vi.mocked(logFns.error).mockClear();
      const { durability, handler, runtime } = makeIngest();
      durability.journalInbound.mockImplementationOnce(() => {
        throw journalError;
      });
      await runIngest(handler, structuredClone(msg));
      return {
        handleCalls: vi.mocked(runtime.handleMessage).mock.calls.length,
        errorLogs: vi.mocked(logFns.error).mock.calls,
      };
    }

    const baseline = await runWithFailingJournal();
    const eventsDir = join(tmp.make('jfail'), 'events');
    shadowMode(eventsDir);
    const observed = await runWithFailingJournal();

    // The rethrown error reaches the same outer catch with the same object.
    expect(observed).toEqual(baseline);
    expect(observed.handleCalls).toBe(0);
    expect(observed.errorLogs).toEqual([
      [{ err: journalError, messageId: 'msg-jfail' }, 'unhandled error in ingest handler'],
    ]);
    expect(getShadowGateStats()).toMatchObject({ evaluated: 1, recorded: 0, journalFailures: 1 });
    expect(verdictsOf(await readEvents(eventsDir))).toHaveLength(0);
  });

  it('a corrupt rules file records one E_THROW per message; recorder writes, dispatch unchanged', async () => {
    const corrupt = join(tmp.make('rules'), 'rules.json');
    writeFileSync(corrupt, '{ not json');
    const base = makeMsg({ messageId: 'msg-rules', chatJid: GROUP, isGroup: true, content: 'ok' });

    const baseline = await observe(structuredClone(base));
    const eventsDir = join(tmp.make('corrupt-rules'), 'events');
    shadowMode(eventsDir);
    __setShadowRulesPathForTests(corrupt);
    const first = await observe(structuredClone(base));
    const second = await observe({ ...structuredClone(base), messageId: 'msg-rules-2' });

    expect(first.handled).toEqual(baseline.handled);
    expect(first.journal).toEqual(baseline.journal);
    expect(second.handled).toHaveLength(1);
    expect(getShadowGateStats()).toMatchObject({ evaluated: 2, recorded: 2, invalid: 0 });
    const events = await readEvents(eventsDir);
    const verdicts = verdictsOf(events);
    expect(verdicts.map((v) => v.messageId)).toEqual(['msg-rules', 'msg-rules-2']);
    for (const v of verdicts) {
      expect(v).toMatchObject({ status: 'ERROR', reason: 'E_THROW', verdict: null, ruleId: null });
      expect(v.rulesSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(coverageOf(events).map((e) => e.marker)).toContain('armed');
  });

  describe('(e) early-return paths are not instrumented', () => {
    it('paused chat', async () => {
      const eventsDir = join(tmp.make('paused'), 'events');
      shadowMode(eventsDir);
      setConfigProp('pausedChats', new Set([GROUP]));

      const { handled } = await observe(makeMsg({ chatJid: GROUP, isGroup: true }));

      expect(handled).toHaveLength(0);
      expect(getShadowGateStats().evaluated).toBe(0);
      expect(verdictsOf(await readEvents(eventsDir))).toHaveLength(0);
    });

    it('access denied', async () => {
      const eventsDir = join(tmp.make('denied'), 'events');
      shadowMode(eventsDir);
      vi.mocked(shouldRespond).mockReturnValueOnce({ respond: false, reason: 'not_mentioned' });

      const { handled } = await observe(makeMsg());

      expect(handled).toHaveLength(0);
      expect(getShadowGateStats().evaluated).toBe(0);
      expect(verdictsOf(await readEvents(eventsDir))).toHaveLength(0);
    });

    it('admin command', async () => {
      const eventsDir = join(tmp.make('admin'), 'events');
      shadowMode(eventsDir);
      vi.mocked(isAdminMessage).mockReturnValue(true);
      vi.mocked(parseAdminCommand).mockReturnValue({ action: 'allow', subjectType: 'phone', subjectId: '15551230009' });
      try {
        const { handled } = await observe(makeMsg({ content: 'allow 15551230009' }));
        expect(handled).toHaveLength(0);
      } finally {
        vi.mocked(isAdminMessage).mockReturnValue(false);
        vi.mocked(parseAdminCommand).mockReturnValue(null);
      }
      expect(getShadowGateStats().evaluated).toBe(0);
      expect(verdictsOf(await readEvents(eventsDir))).toHaveLength(0);
    });
  });

  it('(f) dispatch argument and journal arguments match a mode-off baseline in every scenario', async () => {
    const base = makeMsg({ messageId: 'msg-fixed-f', chatJid: GROUP, isGroup: true, content: 'status update' });
    const fresh = () => structuredClone(base);

    setConfigProp('shadowGate', { mode: 'off', eventsDir: null });
    const baseline = await observe(fresh());
    expect(baseline.handled).toHaveLength(1);

    const scenarios: Array<[string, () => void]> = [
      ['shadow', () => shadowMode(join(tmp.make('f-shadow'), 'events'))],
      ['e_throw', () => {
        shadowMode(join(tmp.make('f-throw'), 'events'));
        featureFaults.throwOnNormalize = true;
      }],
      ['unwritable', () => {
        const blocker = join(tmp.make('f-blocked'), 'file');
        writeFileSync(blocker, 'x');
        shadowMode(join(blocker, 'events'));
      }],
    ];
    for (const [name, arrange] of scenarios) {
      await __resetShadowGateForTests();
      featureFaults.throwOnNormalize = false;
      arrange();
      const observed = await observe(fresh());
      expect(observed.handled, name).toEqual(baseline.handled);
      expect(observed.journal, name).toEqual(baseline.journal);
      expect(getShadowGateStats().evaluated, name).toBe(1);
    }
  });

  describe('(g) rule outcomes from real stored context', () => {
    async function groupReplyAfterBot(botText: string): Promise<Record<string, unknown>> {
      const eventsDir = join(tmp.make('g'), 'events');
      shadowMode(eventsDir);
      const { handler } = makeIngest();
      await runIngest(handler, makeMsg({
        chatJid: GROUP, isGroup: true, isFromMe: true, senderJid: BOT_JID,
        content: botText, timestamp: 1_780_000_000,
      }));
      await runIngest(handler, makeMsg({
        chatJid: GROUP, isGroup: true, content: 'ok', timestamp: 1_780_000_010,
      }));
      const verdicts = verdictsOf(await readEvents(eventsDir));
      expect(verdicts).toHaveLength(1);
      return verdicts[0];
    }

    it('a group reply after a bot question is an obligation', async () => {
      const verdict = await groupReplyAfterBot('Want me to deploy it now?');
      expect(verdict).toMatchObject({ chatScope: 'group', verdict: 'SPAWN', ruleId: 'S08_OBLIGATION' });
    });

    it('a group ack after a bot statement is status-only', async () => {
      const verdict = await groupReplyAfterBot('Deployed the fix.');
      expect(verdict).toMatchObject({ chatScope: 'group', verdict: 'SUPPRESS', ruleId: 'X02_STATUS_ONLY' });
    });
  });
});
