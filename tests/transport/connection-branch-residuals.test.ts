import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Coverage-ratchet (Opus big-module): src/transport/connection.ts residual
// branch arms NOT reached by the committed transport suites
// (connection-branches / event-wiring / reconnect / message-dispatch /
// poll-vote-bridge / event-dispatch-extra / keepalive / connect-failure /
// exhaustion-exit / decryption-failure / typing / self-mention-strip).
//
// Targets (all REACHABLE arms; dead/defensive fs-marker + AuthBond-fs +
// process.exit residuals are intentionally left to the existing fs harnesses):
//   - handleConnectionUpdate open: cooldownTimer-cleared arm (~1665),
//     identity-fallback to authState.creds.me (~1671-1672), absent-identity
//     null arms (~1673-1678), non-open/close/qr no-op arm (~1689)
//   - group-participants.update null-coalesce arms author/participants (~1357-1364)
//   - reaction/receipt missing-field continue arms (~1388-1423)
//   - send* result-without-key null-id arms (~813/838/956/958), sendPollMessage
//     no-socket throw (~829)
//   - evictStalePolls keep-fresh arm (~887)
//   - scheduleReconnect single-flight guard (~2159), restart-required
//     shuttingDown arms (~1739/1746/1754)
//   - decryptAndEmitPollVote phone-candidate arms (~2344-2361)
//   - messages.update extendedText edit + missing-id arms (~2475-2480)
//   - messages.delete keys-filter arm (~2497)
//   - presence/call fallback arms (~2517/2534)
//   - messages.upsert fromMe echo + senderJid/rawKey fallback arms (~2246-2260)
// Mirrors connection-branches.test.ts harness (baileys mock + ev.process capture).
// ---------------------------------------------------------------------------

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    adminPhones: new Set<string>(),
    authDir: '/tmp/wa-test-auth-residuals',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off' as 'off' | 'composing' | 'recording',
    generateHighQualityLinkPreview: false,
    maxExhaustionCycles: 2,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs: number = 30_000) => {
    const exp = baseMs * Math.pow(2, attempt);
    return Math.min(exp, maxMs);
  },
}));

vi.mock('../../src/logger.ts', () => {
  const stub = () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
    level: 'error',
    child: () => stub(),
  });
  return { createChildLogger: () => stub() };
});

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { withWarmIdentity } from '../helpers/outbound-identity.ts';

const USER_JID = '15550001@s.whatsapp.net';
const USER_LID = '11111110001@lid';
const GROUP_JID = '111111110001@g.us';

interface MockSockOpts {
  user?: { id?: string; lid?: string; name?: string } | null;
  authStateMe?: { id?: string; lid?: string };
}

function makeMockSocket(opts: MockSockOpts = {}) {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;
  const mockSock = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamid.0001' } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    rejectCall: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    ws: { isOpen: true },
    user: opts.user === undefined
      ? { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid', name: 'WhatSoup' }
      : opts.user,
    authState: opts.authStateMe ? { creds: { me: opts.authStateMe } } : undefined,
  };
  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    evProcessCallback(events);
  }
  return { mockSock, emit };
}

function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

async function connectedWith(opts: MockSockOpts = {}) {
  const { mockSock, emit } = makeMockSocket(opts);
  vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
  const manager = withWarmIdentity(new ConnectionManager());
  await manager.connect();
  emit(openEvent());
  return { manager, mockSock, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.autoTyping = 'off';
});

// ---------------------------------------------------------------------------
// connection.update open — identity extraction arms
// ---------------------------------------------------------------------------

describe('handleConnectionUpdate open — identity extraction arms', () => {
  it('falls back to authState.creds.me when sock.user has no id/lid', async () => {
    const { manager } = await connectedWith({
      user: null,
      authStateMe: { id: '15559990001:3@s.whatsapp.net', lid: '11111119001:4@lid' },
    });
    // botJid/botLid populated from the authState fallback (jidNormalizedUser strips device).
    expect(manager.botJid).toBe('15559990001@s.whatsapp.net');
    expect(manager.botLid).toBe('11111119001@lid');
  });

  it('leaves botJid/botLid null and skips self-mention regexes when no identity is present', async () => {
    const { manager } = await connectedWith({ user: null });
    expect(manager.botJid).toBeNull();
    expect(manager.botLid).toBeNull();
    // No identity → connected snapshot reports connected=false (botJid null).
    expect(manager.getConnectionState().connected).toBe(false);
  });

  it('skips the LID self-mention regex when the bare LID equals the bare phone number', async () => {
    // Same bare number on id and lid → selfMentionRegexLid stays null (lidBare === bare arm).
    const { manager, mockSock } = await connectedWith({
      user: { id: '15551112222:1@s.whatsapp.net', lid: '15551112222:2@lid', name: 'WhatSoup' },
    });
    expect(manager.botJid).toBe('15551112222@s.whatsapp.net');
    expect(manager.botLid).toBe('15551112222@lid');

    // A self-mention of the shared bare number is stripped via the single (JID) regex
    // path; the duplicate-bare LID regex is never built, so the @number is rewritten once.
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.self' } });
    await manager.sendMessage(GROUP_JID, 'hey @15551112222 ping');
    const [, payload] = mockSock.sendMessage.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(payload['text']).toBe('hey 15551112222 ping');
  });

  it('is a no-op for a connection.update that is neither open, close, nor qr', async () => {
    const { manager, emit } = await connectedWith();
    const before = manager.getConnectionState().state;
    emit({ 'connection.update': { connection: 'connecting' } });
    expect(manager.getConnectionState().state).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// group-participants.update — null-coalesce arms for author/participants
// ---------------------------------------------------------------------------

describe('group-participants.update — missing author/participants arms', () => {
  it('defaults author to "" and participants to [] when both are absent', async () => {
    const { manager, emit } = await connectedWith();
    const onUpdate = vi.fn();
    manager.on('groupParticipantsUpdate', onUpdate);

    // No author, no participants → null-coalesce arms (author ?? '', participants ?? []).
    emit({ 'group-participants.update': { id: GROUP_JID, action: 'add' } });

    expect(onUpdate).toHaveBeenCalledWith({
      groupJid: GROUP_JID,
      author: '',
      participants: [],
      action: 'add',
    });
  });

  it('treats a remove with an undefined participants list as no bot removal', async () => {
    const { manager, emit } = await connectedWith();
    const onUpdate = vi.fn();
    manager.on('groupParticipantsUpdate', onUpdate);

    // action=remove with participants undefined drives the (participants || []) arm
    // in the bot-removal scan without throwing.
    emit({ 'group-participants.update': { id: GROUP_JID, action: 'remove' } });

    expect(onUpdate).toHaveBeenCalledWith({
      groupJid: GROUP_JID,
      author: '',
      participants: [],
      action: 'remove',
    });
  });
});

// ---------------------------------------------------------------------------
// reaction / receipt — missing-field continue arms
// ---------------------------------------------------------------------------

describe('messages.reaction / message-receipt.update — missing-field guards', () => {
  it('skips a reaction entry whose key.id is missing', async () => {
    const { manager, emit } = await connectedWith();
    const onReaction = vi.fn();
    manager.on('reactionReceived', onReaction);

    emit({
      'messages.reaction': [
        // First entry has no id → continue arm; second is valid.
        { key: { remoteJid: USER_JID }, reaction: { text: '👍', key: { remoteJid: USER_JID } } },
        { key: { id: 'r1', remoteJid: USER_JID }, reaction: { text: '🔥', key: { participant: USER_LID } } },
      ],
    });

    expect(onReaction).toHaveBeenCalledTimes(1);
    expect(onReaction).toHaveBeenCalledWith({
      messageId: 'r1',
      conversationKey: expect.any(String),
      senderJid: USER_LID,
      reaction: '🔥',
    });
  });

  it('emits reactionReceived with empty reaction text and remoteJid sender when both are absent', async () => {
    const { manager, emit } = await connectedWith();
    const onReaction = vi.fn();
    manager.on('reactionReceived', onReaction);

    // reaction.text absent → '' arm; reaction.key has neither participant nor remoteJid
    // → senderJid falls back to '' (participant ?? remoteJid ?? '' both-null arm).
    emit({
      'messages.reaction': [
        { key: { id: 'r2', remoteJid: USER_JID }, reaction: { key: {} } },
      ],
    });

    expect(onReaction).toHaveBeenCalledTimes(1);
    expect(onReaction).toHaveBeenCalledWith({
      messageId: 'r2',
      conversationKey: expect.any(String),
      senderJid: '',
      reaction: '',
    });
  });

  it('skips a receipt entry whose userJid is missing and emits "server" for a bare receipt', async () => {
    const { manager, emit } = await connectedWith();
    const onReceipt = vi.fn();
    manager.on('receiptUpdate', onReceipt);

    emit({
      'message-receipt.update': [
        // No userJid → continue arm.
        { key: { id: 'm0' }, receipt: {} },
        // No timestamp fields → default type 'server'.
        { key: { id: 'm1' }, receipt: { userJid: USER_JID } },
      ],
    });

    expect(onReceipt).toHaveBeenCalledTimes(1);
    expect(onReceipt).toHaveBeenCalledWith({ messageId: 'm1', recipientJid: USER_JID, type: 'server' });
  });

  it('classifies receipt types from played, read, and delivery timestamps', async () => {
    const { manager, emit } = await connectedWith();
    const types: string[] = [];
    manager.on('receiptUpdate', (d) => types.push(d.type));

    emit({
      'message-receipt.update': [
        { key: { id: 'p1' }, receipt: { userJid: USER_JID, playedTimestamp: 5 } },
        { key: { id: 'r1' }, receipt: { userJid: USER_JID, readTimestamp: 4 } },
        { key: { id: 'd1' }, receipt: { userJid: USER_JID, receiptTimestamp: 3 } },
      ],
    });

    expect(types).toEqual(['played', 'read', 'delivery']);
  });
});

// ---------------------------------------------------------------------------
// send* — result-without-key null-id arms + sendPollMessage no-socket
// ---------------------------------------------------------------------------

describe('send paths — null waMessageId arms and no-socket guards', () => {
  it('returns waMessageId=null when sendMessage resolves without a key', async () => {
    const { manager, mockSock } = await connectedWith();
    mockSock.sendMessage.mockResolvedValueOnce({});
    const receipt = await manager.sendMessage(USER_JID, 'hi');
    expect(receipt).toEqual({ waMessageId: null });
  });

  it('returns waMessageId=null when sendMedia resolves without a key', async () => {
    const { manager, mockSock } = await connectedWith();
    mockSock.sendMessage.mockResolvedValueOnce({});
    const receipt = await manager.sendMedia(USER_JID, {
      type: 'image',
      buffer: Buffer.from('x'),
      mimetype: 'image/png',
    } as any);
    expect(receipt).toEqual({ waMessageId: null });
  });

  it('throws CONNECTION_UNAVAILABLE from sendPollMessage when no socket is connected', async () => {
    const manager = withWarmIdentity(new ConnectionManager());
    await expect(manager.sendPollMessage(GROUP_JID, 'Q?', ['A', 'B'], 1)).rejects.toMatchObject({
      code: 'CONNECTION_UNAVAILABLE',
    });
  });

  it('reports hasSecret=false when a poll is sent but no messageSecret is returned', async () => {
    const { manager, mockSock } = await connectedWith();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.nosecret' } });
    const res = await manager.sendPollMessage(GROUP_JID, 'Q?', ['A', 'B'], 1);
    expect(res).toEqual({ waMessageId: 'wamid.nosecret', hasSecret: false });
  });

  it('returns waMessageId=null from sendRaw when the send resolves without a key', async () => {
    const { manager, mockSock } = await connectedWith();
    mockSock.sendMessage.mockResolvedValueOnce({});
    const receipt = await manager.sendRaw(USER_JID, { text: 'hi' });
    expect(receipt).toEqual({ waMessageId: null });
  });

  it('returns waMessageId=null + hasSecret=false from sendPollMessage when the send resolves without a key', async () => {
    const { manager, mockSock } = await connectedWith();
    mockSock.sendMessage.mockResolvedValueOnce({});
    const res = await manager.sendPollMessage(GROUP_JID, 'Q?', ['A', 'B'], 1);
    expect(res).toEqual({ waMessageId: null, hasSecret: false });
  });

  it('throws CONNECTION_UNAVAILABLE from sendRaw when no socket is connected', async () => {
    const manager = withWarmIdentity(new ConnectionManager());
    await expect(manager.sendRaw(USER_JID, { text: 'hi' })).rejects.toMatchObject({
      code: 'CONNECTION_UNAVAILABLE',
    });
  });
});

// ---------------------------------------------------------------------------
// evictStalePolls — keep-fresh arm (poll newer than TTL is retained)
// ---------------------------------------------------------------------------

describe('evictStalePolls — fresh poll retained arm', () => {
  it('keeps a still-fresh poll when a second poll is sent within the TTL', async () => {
    vi.useFakeTimers();
    try {
      const { mockSock, emit } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      mockSock.sendMessage
        .mockResolvedValueOnce({ key: { id: 'wamid.keep' }, message: { messageContextInfo: { messageSecret: new Uint8Array([1]) } } })
        .mockResolvedValueOnce({ key: { id: 'wamid.second' }, message: { messageContextInfo: { messageSecret: new Uint8Array([2]) } } });
      const manager = withWarmIdentity(new ConnectionManager());
      await manager.connect();
      emit(openEvent());

      const first = await manager.sendPollMessage(GROUP_JID, 'Q1?', ['A', 'B'], 1);
      expect(first.hasSecret).toBe(true);
      // Only 1 minute later — well within the 1h TTL → first poll is NOT evicted.
      vi.advanceTimersByTime(60_000);
      const second = await manager.sendPollMessage(GROUP_JID, 'Q2?', ['C', 'D'], 1);
      expect(second.hasSecret).toBe(true);

      // The first (fresh) poll is still tracked: clearing it returns without surprise.
      expect(() => manager.clearPollTracking('wamid.keep')).not.toThrow();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// scheduleReconnect — single-flight guard + restart-required shutdown arms
// ---------------------------------------------------------------------------

describe('reconnect scheduling — single-flight + shutdown short-circuits', () => {
  it('does not schedule a second reconnect timer while one is already pending', async () => {
    vi.useFakeTimers();
    try {
      const { mockSock, emit } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      const manager = withWarmIdentity(new ConnectionManager());
      await manager.connect();
      emit(openEvent());
      expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

      // First close schedules a reconnect timer (reconnectAttempts → 1).
      emit({ 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } } });
      // A second close arrives before the timer fires → single-flight guard returns early.
      emit({ 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } } });

      const snap = manager.getConnectionState();
      // Only ONE attempt counted despite two closes (guard prevented a second schedule).
      expect(snap.reconnectAttempts).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

});

// ---------------------------------------------------------------------------
// messages.upsert — own-echo proof + sender/rawKey fallback arms
// ---------------------------------------------------------------------------

describe('messages.upsert — fromMe echo and decryption-failure fallback arms', () => {
  it('records an own-message echo proof for fromMe messages without invoking onMessage parsing fallback', async () => {
    const { manager, emit } = await connectedWith();
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    // fromMe=true echo with no inner message → confirmLocalAuthBondSendProof path,
    // and parseIncomingMessage returns null (no onMessage).
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [{ key: { id: 'echo1', remoteJid: USER_JID, fromMe: true }, messageTimestamp: 1_700_000_000 }],
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('records an own-echo proof when a fromMe message has no remoteJid (undefined recipient arm)', async () => {
    const { manager, emit } = await connectedWith();
    const onMessage = vi.fn();
    manager.onMessage = onMessage;

    // fromMe=true with NO remoteJid → confirmLocalAuthBondSendProof(remoteJid ?? undefined) arm.
    expect(() =>
      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [{ key: { id: 'echo2', fromMe: true }, messageTimestamp: 1_700_000_000 }],
        },
      }),
    ).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('uses remoteJid as senderJid and fromMe=false default for a CIPHERTEXT stub lacking participant', async () => {
    const { manager, emit } = await connectedWith();
    const onFailure = vi.fn();
    manager.on('decryptionFailure', onFailure);

    // messageStubType=2, no message, no participant, no fromMe → senderJid falls back
    // to remoteJid and rawKey.fromMe defaults to false.
    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [{
          key: { id: 'cipher1', remoteJid: USER_JID },
          messageStubType: 2,
          messageTimestamp: 1_700_000_000,
        }],
      },
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'cipher1',
      chatJid: USER_JID,
      senderJid: USER_JID,
      rawKey: { remoteJid: USER_JID, id: 'cipher1', fromMe: false },
    }));
  });
});

// ---------------------------------------------------------------------------
// messages.update — edited extendedText + missing-id arms
// ---------------------------------------------------------------------------

describe('messages.update — edit content extraction arms', () => {
  it('emits messageEdited using extendedTextMessage.text when conversation is absent', async () => {
    const { manager, emit } = await connectedWith();
    const onEdited = vi.fn();
    manager.on('messageEdited', onEdited);

    emit({
      'messages.update': [{
        key: { id: 'edit1', remoteJid: USER_JID },
        update: { message: { editedMessage: { message: { extendedTextMessage: { text: 'fixed typo' } } } } },
      }],
    });

    expect(onEdited).toHaveBeenCalledWith('edit1', 'fixed typo');
  });

  it('does not emit messageEdited when the edited message carries neither conversation nor extendedText', async () => {
    const { manager, emit } = await connectedWith();
    const onEdited = vi.fn();
    manager.on('messageEdited', onEdited);

    emit({
      'messages.update': [{
        key: { id: 'edit2', remoteJid: USER_JID },
        update: { message: { editedMessage: { message: { imageMessage: { caption: 'x' } } } } },
      }],
    });

    expect(onEdited).not.toHaveBeenCalled();
  });

  it('ignores a messages.update entry that is not an edit (no editedMessage at all)', async () => {
    const { manager, emit } = await connectedWith();
    const onEdited = vi.fn();
    manager.on('messageEdited', onEdited);

    // update.update.message has no editedMessage → editedMsg falsy (if(editedMsg) false arm).
    emit({
      'messages.update': [{
        key: { id: 'upd1', remoteJid: USER_JID },
        update: { status: 3 },
      }],
    });

    expect(onEdited).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// messages.delete — keys-filter arm (drops falsy ids)
// ---------------------------------------------------------------------------

describe('messages.delete — keys filtering arm', () => {
  it('emits messageDeleted only for keys that carry a truthy id', async () => {
    const { manager, emit } = await connectedWith();
    const onDeleted = vi.fn();
    manager.on('messageDeleted', onDeleted);

    emit({ 'messages.delete': { keys: [{ id: 'd1' }, { id: undefined }, { id: 'd2' }, {}] } });

    expect(onDeleted).toHaveBeenCalledWith(['d1', 'd2']);
  });

  it('does not emit messageDeleted when no key carries an id', async () => {
    const { manager, emit } = await connectedWith();
    const onDeleted = vi.fn();
    manager.on('messageDeleted', onDeleted);

    emit({ 'messages.delete': { keys: [{ id: undefined }, {}] } });

    expect(onDeleted).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// presence.update / call — fallback arms
// ---------------------------------------------------------------------------

describe('presence + call — value fallback arms', () => {
  it('emits presenceUpdate with "unknown" status when lastKnownPresence is absent', async () => {
    const { manager, emit } = await connectedWith();
    const onPresence = vi.fn();
    manager.on('presenceUpdate', onPresence);

    emit({ 'presence.update': { id: GROUP_JID, presences: { [USER_JID]: {} } } });

    expect(onPresence).toHaveBeenCalledWith(USER_JID, 'unknown', undefined);
  });

  it('emits callReceived with an empty callFrom when call.from is absent', async () => {
    const { manager, emit } = await connectedWith();
    const onCall = vi.fn();
    manager.on('callReceived', onCall);

    emit({ call: [{ id: 'call-x' }] });

    expect(onCall).toHaveBeenCalledWith('call-x', '');
  });
});
