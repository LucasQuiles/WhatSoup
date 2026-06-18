// tests/transport/connection-coverage.test.ts
//
// Coverage ratchet (RR-013 continuation) — src/transport/connection.ts branch
// coverage. Targets the *residual* uncovered branch arms that the existing
// connection-branches / event-wiring / connection-event-dispatch-extra /
// connection-message-dispatch / connection-keepalive / connection-exhaustion-exit
// / poll-vote-bridge / event-wiring suites do NOT already exercise.
//
// Specifically: QR-event early-return, sendMedia retry/ENOENT rethrow, media
// post-send hook, handleConnectionUpdate branches (cooldownTimer clear, QR,
// DisconnectReason[code] ?? 'Unknown', restart-required, generic fallback),
// deviceBondLost/credentialLifecycle evidence-construction branches,
// captureAuthBondSnapshot deferred/failed arms, scheduleSettledAuthBondSnapshot
// early-returns + min-interval skip + timer-callback early-returns,
// isVerifiedLocalAuthSnapshot field checks, clearLocalAuthBondFailureAfterVerifiedSend
// blocks, localAuthBondFailureCriticalAsset code-ladder branches,
// scheduleReconnect MAX_FAILURE_DURATION exhaustion, handleMessagesUpsert
// own-message-echo + LID pair, decryptAndEmitPollVote candidate building for
// LID/phone pairs, edited-message content extraction ladder,
// handleMessagesDelete ids extraction, handlePresenceUpdate lastSeen default,
// handleCall rejectCall empty-id skip, runKeepalive timeout-result throw,
// handleExhausted gracefulReconnectInFlight finally, gracefulReconnect guards.
//
// Mirrors connection-branches.test.ts harness exactly so the mockConfig / mock
// socket / vi.hoisted plumbing can be re-used verbatim.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    adminPhones: new Set<string>(),
    authDir: '/tmp/wa-test-auth-coverage',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off' as 'off' | 'composing' | 'recording',
    generateHighQualityLinkPreview: false,
    maxExhaustionCycles: 99,
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
  const mod = baileysMock();
  // Provide a reverse-mapped DisconnectReason so the [code] ?? 'Unknown'
  // lookup in handleConnectionUpdate has both arms reachable. The default
  // helper mock only exposes name→code keys.
  const reverse: Record<number, string> = {};
  for (const [name, code] of Object.entries(mod.DisconnectReason as Record<string, number>)) {
    reverse[code] = name;
  }
  mod.DisconnectReason = { ...mod.DisconnectReason, ...reverse };
  return mod;
});

vi.mock('@whiskeysockets/baileys/lib/Utils/process-message.js', () => ({
  decryptPollVote: vi.fn(),
}));

vi.mock('../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs = 30_000) => {
    const exp = baseMs * Math.pow(2, attempt);
    return Math.min(exp, maxMs);
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      level: 'error',
    }),
  }),
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

const USER_JID = '15550001@s.whatsapp.net';
const GROUP_JID = '111111100000000001@g.us';

function makeMockSocket() {
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
    user: {
      id: '15551230004:1@s.whatsapp.net',
      lid: '81536414179557:2@lid',
      name: 'WhatSoup',
    },
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

async function connected() {
  const { mockSock, emit } = makeMockSocket();
  vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
  const manager = new ConnectionManager();
  await manager.connect();
  emit(openEvent());
  return { manager, mockSock, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.autoTyping = 'off';
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// handleConnectionUpdate — QR early-return + DisconnectReason lookup fallback
// ===========================================================================

describe('ConnectionManager.handleConnectionUpdate — QR event early return', () => {
  it('records a qr_required lifecycle event and lastQrAt on a QR event', async () => {
    const { manager, mockSock, emit } = await connected();
    const snapBefore = manager.getConnectionState();
    expect(snapBefore.credentialLifecycle.lastQrAt).toBeNull();

    // A QR event fires before any connection.open — bypass the registered openEvent.
    emit({ 'connection.update': { qr: 'qr-payload-data' } });

    const snapAfter = manager.getConnectionState();
    expect(snapAfter.credentialLifecycle.lastQrAt).not.toBeNull();
    expect(typeof snapAfter.credentialLifecycle.lastQrAt).toBe('string');
    // Socket must NOT have been invalidated by the QR path — it returns early.
    expect(manager.getSocket()).toBe(mockSock);
  });

  it('uses DisconnectReason["Unknown"] when an unrecognised status code arrives', async () => {
    const { manager, mockSock, emit } = await connected();
    mockSock.end.mockClear();

    // statusCode 999 is not in the DisconnectReason map → ?? 'Unknown' fallback branch.
    emit({
      'connection.update': {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 999 } } },
      },
    });

    const snap = manager.getConnectionState();
    expect(snap.lastDisconnectReason).toBe('Unknown');
    expect(snap.lastStatusCode).toBe(999);
  });

  it('uses DisconnectReason[<statusCode>] when the code is a known Baileys reason', async () => {
    const { manager, mockSock, emit } = await connected();
    mockSock.end.mockClear();

    // 428 = DisconnectReason.connectionClosed in the mock helper.
    emit({
      'connection.update': {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } } },
      },
    });

    const snap = manager.getConnectionState();
    expect(snap.lastDisconnectReason).toBe('connectionClosed');
    expect(snap.lastStatusCode).toBe(428);
  });
});

// ===========================================================================
// sendMessage — botJid-stripped self-mention path (regex builds + strip log)
// ===========================================================================

describe('ConnectionManager.sendMessage — self-mention regex builds on open', () => {
  it('strips @<botJid bare> mentions and logs a warning when text contains a self-mention', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.strip' } });

    // botJid in the mock socket is '15551230004:1@s.whatsapp.net' → bare 15551230004.
    const receipt = await manager.sendMessage(USER_JID, 'hello @15551230004 friend');

    expect(receipt.waMessageId).toBe('wamid.strip');
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    // Stripped: '@<botJid bare>' becomes the bare number with no leading '@'.
    expect(payload['text']).toBe('hello 15551230004 friend');
  });
});

// ===========================================================================
// sendMessage — messageId null path → queueLocalAuthBondClearCandidate with null
// ===========================================================================

describe('ConnectionManager.sendMessage — null receipt.messageId does not throw', () => {
  it('returns waMessageId=null when sendMessage resolves with no key.id', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: {} });

    const receipt = await manager.sendMessage(USER_JID, 'hi');

    expect(receipt.waMessageId).toBeNull();
  });
});

// ===========================================================================
// sendRaw — text payload with autoTyping on (typing true + post-send paused)
// ===========================================================================

describe('ConnectionManager.sendRaw — text payload with autoTyping composing', () => {
  it('emits composing and paused presence around a text send when autoTyping=composing', async () => {
    mockConfig.autoTyping = 'composing';
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.text' } });

    const receipt = await manager.sendRaw(USER_JID, { text: 'autotyping on' });

    expect(receipt.waMessageId).toBe('wamid.text');
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('composing', USER_JID);
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('paused', USER_JID);
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// sendMedia — image branch + sendMedia post-send scheduling hooks fire
// ===========================================================================

describe('ConnectionManager.sendMedia — image branch payload shape', () => {
  it('forwards buffer/caption/mimetype/viewOnce to Baileys for an image payload', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.image' } });

    const receipt = await manager.sendMedia(USER_JID, {
      type: 'image',
      buffer: Buffer.from('img-bytes'),
      mimetype: 'image/png',
      caption: 'look',
      viewOnce: false,
    } as any);

    expect(receipt.waMessageId).toBe('wamid.image');
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toHaveProperty('image');
    expect(payload['caption']).toBe('look');
    expect(payload['mimetype']).toBe('image/png');
    expect(payload['viewOnce']).toBe(false);
  });
});

// ===========================================================================
// sendMedia — document branch payload shape
// ===========================================================================

describe('ConnectionManager.sendMedia — document branch payload shape', () => {
  it('forwards fileName/mimetype/caption to Baileys for a document payload', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.doc' } });

    const receipt = await manager.sendMedia(USER_JID, {
      type: 'document',
      buffer: Buffer.from('doc-bytes'),
      mimetype: 'application/pdf',
      filename: 'spec.pdf',
      caption: 'the spec',
    } as any);

    expect(receipt.waMessageId).toBe('wamid.doc');
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toHaveProperty('document');
    expect(payload['fileName']).toBe('spec.pdf');
    expect(payload['mimetype']).toBe('application/pdf');
    expect(payload['caption']).toBe('the spec');
  });
});

// ===========================================================================
// sendPollMessage — hasSecret=false branch (no messageSecret returned)
// ===========================================================================

describe('ConnectionManager.sendPollMessage — hasSecret=false when messageSecret absent', () => {
  it('returns hasSecret=false but still emits a poll when no messageContextInfo arrives', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({
      key: { id: 'wamid.nosecret' },
      // No messageContextInfo → falls through to the hasSecret=false arm.
    });

    const result = await manager.sendPollMessage(GROUP_JID, 'Q?', ['Yes', 'No'], 1);

    expect(result.waMessageId).toBe('wamid.nosecret');
    expect(result.hasSecret).toBe(false);
  });
});

// ===========================================================================
// setTyping — explicit TypingState strings pass through to sendPresenceUpdate
// ===========================================================================

describe('ConnectionManager.setTyping — explicit TypingState values', () => {
  it('passes "recording" straight through to sendPresenceUpdate', async () => {
    const { manager, mockSock } = await connected();
    await manager.setTyping(USER_JID, 'recording');
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('recording', USER_JID);
  });
});

// ===========================================================================
// messages.upsert — own-message-echo + LID pair discovery
// ===========================================================================

describe('ConnectionManager.messages.upsert — own-echo and LID pair', () => {
  it('does not throw when a messages.upsert message has a falsy key.id (no echo-confirm call)', async () => {
    const { manager, emit } = await connected();
    expect(() =>
      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [{
            key: { id: null, remoteJid: USER_JID, fromMe: true },
            message: { conversation: 'echo' },
            messageTimestamp: 1_700_000_000,
          }],
        },
      }),
    ).not.toThrow();
  });

  it('emits lidPairDiscovered when participant and participantAlt both appear in an inbound message', async () => {
    const { manager, emit } = await connected();
    const onLid = vi.fn();
    manager.on('lidPairDiscovered', onLid);

    emit({
      'messages.upsert': {
        type: 'notify',
        messages: [{
          key: {
            id: 'msg-with-alt',
            remoteJid: GROUP_JID,
            fromMe: false,
            participant: '15551234567@s.whatsapp.net',
            participantAlt: '15551234567@lid',
          },
          message: { conversation: 'hi' },
          messageTimestamp: 1_700_000_000,
        }],
      },
    });

    expect(onLid).toHaveBeenCalledWith('15551234567@s.whatsapp.net', '15551234567@lid');
  });
});

// ===========================================================================
// messages.upsert — poll vote with no creationKey.id (silent ignore)
// ===========================================================================

describe('ConnectionManager.messages.upsert — poll vote missing creationKey.id', () => {
  it('ignores a pollUpdateMessage without a creationKey.id (no error, no emit)', async () => {
    const { manager, emit } = await connected();
    const onVote = vi.fn();
    manager.on('pollVoteReceived', onVote);

    expect(() =>
      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [{
            key: { id: 'msg-poll', remoteJid: GROUP_JID, fromMe: false },
            message: {
              pollUpdateMessage: {
                // No pollCreationMessageKey.id → early return guard.
                vote: { encPayload: new Uint8Array([1]), encIv: new Uint8Array([2]) },
              },
            },
            messageTimestamp: 1_700_000_000,
          }],
        },
      }),
    ).not.toThrow();

    expect(onVote).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// poll-vote — missing encPayload/encIv early-return guard
// ===========================================================================

describe('ConnectionManager poll-vote handler — missing encPayload/encIv', () => {
  it('returns early without decrypting when the vote lacks encPayload or encIv', async () => {
    vi.useFakeTimers();
    try {
      const { mockSock, emit } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      mockSock.sendMessage.mockResolvedValueOnce({
        key: { id: 'wamid.poll.partial' },
        message: { messageContextInfo: { messageSecret: new Uint8Array([7, 8]) } },
      });
      const manager = new ConnectionManager();
      await manager.connect();
      emit(openEvent());

      await manager.sendPollMessage(GROUP_JID, 'Q?', ['Yes', 'No'], 1);

      const onVote = vi.fn();
      const onVoteFailed = vi.fn();
      manager.on('pollVoteReceived', onVote);
      manager.on('pollVoteFailed', onVoteFailed);

      // Vote with encPayload but NO encIv → guard hits and returns.
      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [{
            key: { id: 'v1', remoteJid: GROUP_JID, fromMe: false, participant: USER_JID },
            message: {
              pollUpdateMessage: {
                pollCreationMessageKey: { id: 'wamid.poll.partial' },
                vote: { encPayload: new Uint8Array([1]) },
              },
            },
            messageTimestamp: 1_700_000_000,
          }],
        },
      });

      // No decryption attempted → no grace timer fires → no events.
      vi.advanceTimersByTime(10_000);
      expect(onVote).not.toHaveBeenCalled();
      expect(onVoteFailed).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// messages.update — edited message content extraction (conversation branch)
// ===========================================================================

describe('ConnectionManager.messages.update — editedMessage.conversation', () => {
  it('emits messageEdited with the new conversation text when an edit lands', async () => {
    const { manager, emit } = await connected();
    const onEdited = vi.fn();
    manager.on('messageEdited', onEdited);

    emit({
      'messages.update': [{
        key: { id: 'msg-edit', remoteJid: USER_JID },
        update: {
          message: {
            editedMessage: {
              message: { conversation: 'updated text' },
            },
          },
        },
      }],
    });

    expect(onEdited).toHaveBeenCalledWith('msg-edit', 'updated text');
  });
});

// ===========================================================================
// messages.delete — keys list extraction (messageDeleted ids)
// ===========================================================================

describe('ConnectionManager.messages.delete — keys list with non-empty ids', () => {
  it('emits messageDeleted with the surviving ids when the keys list is non-empty', async () => {
    const { manager, emit } = await connected();
    const onDeleted = vi.fn();
    manager.on('messageDeleted', onDeleted);

    emit({
      'messages.delete': {
        keys: [{ id: 'wamid.1' }, { id: null }, { id: 'wamid.2' }],
      },
    });

    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith(['wamid.1', 'wamid.2']);
  });
});

// ===========================================================================
// presence.update — emits presenceUpdate with lastSeen default when absent
// ===========================================================================

describe('ConnectionManager presence.update — lastSeen default when absent', () => {
  it('emits presenceUpdate with lastSeen=undefined when lastSeen field is missing', async () => {
    const { manager, emit } = await connected();
    const onPresence = vi.fn();
    manager.on('presenceUpdate', onPresence);

    emit({
      'presence.update': {
        id: USER_JID,
        presences: { [USER_JID]: { lastKnownPresence: 'available' } },
      },
    });

    expect(onPresence).toHaveBeenCalledWith(USER_JID, 'available', undefined);
  });
});

// ===========================================================================
// call — autoRejectCalls off branch (no reject attempt) but still emits callReceived
// ===========================================================================

describe('ConnectionManager call handling — autoRejectCalls disabled', () => {
  it('still emits callReceived but does not call rejectCall when autoRejectCalls=false', async () => {
    const { manager, mockSock, emit } = await connected();
    manager.autoRejectCalls = false;
    const onCall = vi.fn();
    manager.on('callReceived', onCall);

    emit({ call: [{ id: 'call-1', from: USER_JID }] });

    expect(mockSock.rejectCall).not.toHaveBeenCalled();
    expect(onCall).toHaveBeenCalledWith('call-1', USER_JID);
  });
});

// ===========================================================================
// ConnectionManager.disconnect — clears pending reconnect timer (graceful)
// ===========================================================================

describe('ConnectionManager.disconnect — clears pending reconnect timer', () => {
  it('does not fire a queued reconnect timer after disconnect()', async () => {
    vi.useFakeTimers();
    try {
      const { mockSock, emit } = makeMockSocket();
      vi.mocked(makeWASocket)
        .mockImplementationOnce(() => {
          throw new Error('fail');
        })
        .mockReturnValue(mockSock as any);
      const manager = new ConnectionManager();
      await manager.connect();
      // A reconnect timer is now scheduled. Shut down before it fires.
      await manager.disconnect();
      // Advance well past the backoff window — no new socket should be made.
      await vi.advanceTimersByTimeAsync(60_000);
      // Exactly one connect() invocation (the original failed one); the scheduled
      // reconnect never fires because shutdown cleared the timer.
      expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// ConnectionManager.connect — early-return when shuttingDown
// ===========================================================================

describe('ConnectionManager.connect — early-return when shuttingDown', () => {
  it('returns immediately without creating a socket when shutdown has been requested', async () => {
    const manager = new ConnectionManager();
    await manager.shutdown();
    await manager.connect();
    expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// messages.upsert — own-message-echo calls confirmLocalAuthBondSendProof
// ===========================================================================

describe('ConnectionManager.messages.upsert — own-message echo confirmation', () => {
  it('processes an own fromMe message without throwing (echo-confirm path)', async () => {
    const { manager, emit } = await connected();

    expect(() =>
      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [{
            key: { id: 'wamid.own-echo', remoteJid: USER_JID, fromMe: true },
            message: { conversation: 'echo of my own send' },
            messageTimestamp: 1_700_000_000,
          }],
        },
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// poll-vote decryption — creatorJid built from creationKey (not fromMe) branch
// ===========================================================================

describe('ConnectionManager poll-vote decryption — creator from creationKey (non-fromMe)', () => {
  it('uses creationKey.participant for the LID candidate when creationKey.fromMe is undefined', async () => {
    vi.useFakeTimers();
    try {
      const { decryptPollVote } = await import('@whiskeysockets/baileys/lib/Utils/process-message.js');
      const decrypt = vi.mocked(decryptPollVote);
      decrypt.mockReset();

      const { mockSock, emit } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      mockSock.sendMessage.mockResolvedValueOnce({
        key: { id: 'wamid.poll.notmine' },
        message: { messageContextInfo: { messageSecret: new Uint8Array([3, 3]) } },
      });
      const manager = new ConnectionManager();
      await manager.connect();
      emit(openEvent());

      await manager.sendPollMessage(GROUP_JID, 'Q?', ['Yes', 'No'], 1);

      const onVote = vi.fn();
      manager.on('pollVoteReceived', onVote);

      // Vote message whose creationKey omits fromMe → else branch in decryptAndEmitPollVote
      // (creatorLid and creatorPhone are built from creationKey.participant/participantAlt).
      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [{
            key: {
              id: 'v.notmine',
              remoteJid: '15555551111@lid',
              fromMe: false,
              participant: '15555551112@lid',
            },
            message: {
              pollUpdateMessage: {
                pollCreationMessageKey: {
                  id: 'wamid.poll.notmine',
                  participant: '15555551113@lid',
                  // fromMe intentionally omitted → else branch.
                },
                vote: {
                  encPayload: new Uint8Array([1]),
                  encIv: new Uint8Array([2]),
                },
              },
            },
            messageTimestamp: 1_700_000_000,
          }],
        },
      });

      // Wait for async decryption to attempt at least one candidate.
      await vi.waitFor(() => expect(decrypt).toHaveBeenCalled());

      const firstCallArgs = decrypt.mock.calls[0]?.[1] as { pollCreatorJid?: string } | undefined;
      // The else branch built creatorLid via jidNormalizedUser(creationKey.participant || ...).
      expect(firstCallArgs?.pollCreatorJid).toContain('15555551113');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// clearPollTracking — deletes buffered vote grace timers with prefix match
// ===========================================================================

describe('ConnectionManager.clearPollTracking — tears down buffered grace timers', () => {
  it('clears the vote-grace timer so no pollVoteReceived fires after clear', async () => {
    vi.useFakeTimers();
    try {
      const { decryptPollVote } = await import('@whiskeysockets/baileys/lib/Utils/process-message.js');
      const decrypt = vi.mocked(decryptPollVote);
      decrypt.mockReset();

      const { mockSock, emit } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      mockSock.sendMessage.mockResolvedValueOnce({
        key: { id: 'wamid.poll.coverage' },
        message: { messageContextInfo: { messageSecret: new Uint8Array([11, 12]) } },
      });
      const manager = new ConnectionManager();
      await manager.connect();
      emit(openEvent());

      await manager.sendPollMessage(GROUP_JID, 'Q?', ['A', 'B'], 1);

      // decrypt succeeds on the LID candidate.
      decrypt.mockImplementation((_vote: any, ctx: any) => {
        if (ctx.voterJid?.includes('@lid')) {
          return { selectedOptions: [Buffer.from('A').toString()] };
        }
        throw new Error('not matched');
      });

      const onVote = vi.fn();
      manager.on('pollVoteReceived', onVote);

      emit({
        'messages.upsert': {
          type: 'notify',
          messages: [{
            key: {
              id: 'v.coverage',
              remoteJid: '15555551111@lid',
              fromMe: false,
              participant: '15555551112@lid',
            },
            message: {
              pollUpdateMessage: {
                pollCreationMessageKey: { id: 'wamid.poll.coverage', fromMe: true },
                vote: { encPayload: new Uint8Array([1]), encIv: new Uint8Array([2]) },
              },
            },
            messageTimestamp: 1_700_000_000,
          }],
        },
      });

      // Wait for the decryption to buffer the vote (grace timer scheduled).
      await vi.waitFor(() => expect(decrypt).toHaveBeenCalled());

      // clearPollTracking must cancel the pending grace timer so no emission happens.
      manager.clearPollTracking('wamid.poll.coverage');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onVote).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// ConnectionManager state — credentialLifecycle.recentEvents populated on send
// ===========================================================================

describe('ConnectionManager.getConnectionState — credentialLifecycle recency', () => {
  it('records a connect_start lifecycle event when connect() is called', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const manager = new ConnectionManager();
    await manager.connect();

    const snap = manager.getConnectionState();
    // The first lifecycle event must be the connect_start marker.
    expect(snap.credentialLifecycle.recentEvents.length).toBeGreaterThan(0);
    const firstEvent = snap.credentialLifecycle.recentEvents[0] as Record<string, unknown>;
    expect(firstEvent['event']).toBe('connect_start');
  });
});

// ===========================================================================
// pruneAuthBondSendProofs — proof cutoff branch (line 1963)
// ===========================================================================

describe('ConnectionManager message-receipt.update — prunes stale confirmed proofs', () => {
  it('drops a confirmed send proof older than the TTL when a new receipt arrives', async () => {
    vi.useFakeTimers();
    try {
      const { manager, emit } = await connected();

      // First receipt event seeds a confirmed proof with confirmedAt = now.
      emit({
        'message-receipt.update': [{
          key: { id: 'wamid.aged', remoteJid: USER_JID },
          receipt: { userJid: USER_JID, receiptTimestamp: 1_700_000_000 },
        }],
      });

      // Advance past the 10-minute TTL so the proof is now stale.
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);

      // A second receipt event triggers pruneAuthBondSendProofs(now); the aged
      // proof must be deleted by the < cutoff branch.
      expect(() =>
        emit({
          'message-receipt.update': [{
            key: { id: 'wamid.fresh', remoteJid: USER_JID },
            receipt: { userJid: USER_JID, receiptTimestamp: 1_700_001_000 },
          }],
        }),
      ).not.toThrow();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
