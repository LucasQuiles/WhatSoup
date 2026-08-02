// Intended repo path: tests/transport/connection-event-dispatch-extra.test.ts
//
// Additive coverage for src/transport/connection.ts that the existing
// event-wiring.test.ts does not reach:
//
//   1. Untested newsletter event branches (uncovered lines 1565-1592):
//        - newsletter.view
//        - newsletter-participants.update
//        - newsletter-settings.update
//   2. The per-event catch(err) error-logging arms (e.g. lines 1399/1423/1437/1447/
//      1457/1467/1490/1501/1512/1527/1539/1552/1562/1572/1582/1592). These fire only
//      when a downstream emit listener throws; covered by attaching a throwing listener
//      and asserting dispatch is isolated (one bad handler does not abort the batch).
//   3. SECURITY-SENSITIVE: the deep `redactDiagnosticValue` branches (uncovered lines
//      349, 356, 363-372, 380) reached via a `connection.update` close carrying a rich
//      `lastDisconnect.error`. Asserts secrets/JIDs/phone-numbers are redacted AND
//      benign fields are preserved, observable through getConnectionState().
//
// Mirrors event-wiring.test.ts harness (baileys mock + ev.process callback capture).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth',
    dbPath: ':memory:',
    mediaDir: '/tmp',
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

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

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
    user: { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid', name: 'WhatSoup' },
  };
  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    evProcessCallback(events);
  }
  return { mockSock, emit };
}

describe('connection event dispatch — newsletter + error isolation', () => {
  let cm: ConnectionManager;
  let emit: (events: Record<string, unknown>) => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { mockSock, emit: mockEmit } = makeMockSocket();
    emit = mockEmit;
    (makeWASocket as ReturnType<typeof vi.fn>).mockReturnValue(mockSock);
    cm = new ConnectionManager();
    await cm.connect();
    emit({ 'connection.update': { connection: 'open' } });
  });

  afterEach(async () => {
    await cm.shutdown();
    vi.useRealTimers();
  });

  it('re-emits newsletter.view payloads', () => {
    const handler = vi.fn();
    cm.on('newsletterView', handler);
    const payload = { id: '12345@newsletter', count: 3 };
    emit({ 'newsletter.view': payload });
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('re-emits newsletter-participants.update payloads', () => {
    const handler = vi.fn();
    cm.on('newsletterParticipantsUpdate', handler);
    const payload = { id: '12345@newsletter', participants: ['a@lid'] };
    emit({ 'newsletter-participants.update': payload });
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('re-emits newsletter-settings.update payloads', () => {
    const handler = vi.fn();
    cm.on('newsletterSettingsUpdate', handler);
    const payload = { id: '12345@newsletter', settings: { mute: true } };
    emit({ 'newsletter-settings.update': payload });
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('isolates a throwing listener so the event batch does not abort (catch arm)', () => {
    // A listener that throws drives the per-event try/catch error-logging branch.
    cm.on('chatsDelete', () => { throw new Error('boom from listener'); });
    const after = vi.fn();
    cm.on('chatsUpsert', after);

    // chats.delete handler throws and is caught; chats.upsert in the SAME batch
    // must still dispatch — proving the catch arm isolates failures.
    expect(() => emit({
      'chats.delete': ['x@s.whatsapp.net'],
      'chats.upsert': [{ id: 'y@s.whatsapp.net' }],
    })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('QR-134: a throwing messages.upsert is caught so the batch continues (no crash)', async () => {
    const groupHandler = vi.fn();
    cm.on('groupParticipantsUpdate', groupHandler);

    // contactsArrayMessage.contacts as a NON-array makes parseIncomingMessage throw a
    // synchronous TypeError (('str' ?? []).map is not a function) — the class of parser
    // throw QR-134 guards. Without the wrap this rejects the async ev.process callback
    // -> Node unhandledRejection -> main.ts shutdown; with it, the throw is logged and
    // the rest of the batch (group-participants) still dispatches.
    const throwingMsg = {
      key: { remoteJid: 'sender@s.whatsapp.net', id: 'M1' },
      message: { contactsArrayMessage: { contacts: 'not-an-array' } },
    };
    emit({
      'messages.upsert': { messages: [throwingMsg], type: 'notify' },
      'group-participants.update': { id: 'grp@g.us', action: 'add', participants: ['member@s.whatsapp.net'], author: 'admin@s.whatsapp.net' },
    });
    await new Promise((r) => setImmediate(r)); // let the async ev.process callback settle

    // Batch survived the caught messages.upsert throw -> the later dispatch still ran.
    expect(groupHandler).toHaveBeenCalledTimes(1);
  });

  it('QR-134: a throwing call event is caught so a later dispatch (reaction) still runs', async () => {
    const reactionHandler = vi.fn();
    cm.on('reactionReceived', reactionHandler);

    // `call: 42` is non-iterable, so handleCall's `for (const call of calls)` throws a
    // TypeError. Without the metadata-dispatch wrap this aborts the whole ev.process
    // callback -> the reaction dispatch (a few lines later) never runs; with it, the
    // throw is caught and messages.reaction still dispatches.
    emit({
      call: 42,
      'messages.reaction': [{
        key: { id: 'R1', remoteJid: 'chat@s.whatsapp.net' },
        reaction: { text: '\u{1F44D}', key: { participant: 'sender@s.whatsapp.net' } },
      }],
    });
    await new Promise((r) => setImmediate(r));

    expect(reactionHandler).toHaveBeenCalledTimes(1);
  });
});

describe('connection diagnostics redaction (security-sensitive)', () => {
  let cm: ConnectionManager;
  let emit: (events: Record<string, unknown>) => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const { mockSock, emit: mockEmit } = makeMockSocket();
    emit = mockEmit;
    (makeWASocket as ReturnType<typeof vi.fn>).mockReturnValue(mockSock);
    cm = new ConnectionManager();
    await cm.connect();
    emit({ 'connection.update': { connection: 'open' } });
  });

  afterEach(async () => {
    await cm.shutdown();
    vi.useRealTimers();
  });

  it('redacts JIDs, phone numbers, and sensitive keys in lastDisconnect diagnostics', () => {
    // Build an Error with extra own-properties (drives the Error own-prop loop),
    // a sensitive key (token), a JID, a bare phone number, a deeply-nested object,
    // and a large array (drives array truncation), plus a benign field that must survive.
    const err = new Error('disconnect from 15555550123@s.whatsapp.net') as Error & Record<string, unknown>;
    err.token = 'super-secret-value';
    err.contactNumber = '15557654321';
    err.benignField = 'keep-me';
    err.bigArray = Array.from({ length: 50 }, (_, i) => i);
    err.nested = { a: { b: { c: { d: { e: { f: { g: 'too-deep' } } } } } } };

    emit({
      'connection.update': {
        connection: 'close',
        lastDisconnect: {
          error: err,
          date: new Date(),
        },
      },
    });

    const snap = cm.getConnectionState();
    const diag = JSON.stringify(snap.credentialLifecycle.lastDisconnectDiagnostic);

    // Sensitive key value must be redacted, not present verbatim.
    expect(diag).not.toContain('super-secret-value');
    expect(diag).toContain('<redacted>');
    // Raw JID and bare phone numbers must be hashed/redacted.
    expect(diag).not.toContain('15555550123@s.whatsapp.net');
    expect(diag).not.toContain('15557654321');
    // Benign content survives.
    expect(diag).toContain('keep-me');
    // Array truncation marker appears for the >30 element array.
    expect(diag).toMatch(/<truncated:\d+>/);
    // Depth guard fires somewhere in the deeply-nested object.
    expect(diag).toContain('<max-depth>');
  });
});
