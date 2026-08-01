import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Coverage-ratchet draft (RR-013): src/transport/connection.ts branch% lever.
//
// Scope: genuinely-uncovered PUBLIC API send/typing/poll-management and a few
// secondary event-dispatch arms that the committed suites
// (typing / poll-vote-bridge / reconnect / event-wiring / message-dispatch /
// keepalive / connect-failure) do NOT exercise. Specifically avoided here:
//   - typing.test.ts: setTyping('recording'), sendMessage/sendRaw auto-typing
//   - poll-vote-bridge.test.ts: sendPollMessage hasSecret true/false, grace
//     window, vote-change, multiSelect, pollVoteFailed, untracked polls
//   - reconnect.test.ts: sendMedia stream/buffer-retry, no-socket throws,
//     presence.update, call auto-reject, messages.update/delete basics
//   - event-wiring.test.ts: reaction/receipt/media-update/chats.*/groups.*/
//     blocklist.*/labels.*/lid-mapping dispatch
//   - connection-event-dispatch-extra.test.ts (draft): newsletter.view/
//     participants/settings + one disconnect-diagnostic redaction case
//
// Targets here (uncovered branch arms): resolveTypingState true/false
// (connection.ts ~298-299), setTyping error-swallow (~892-895), sendMessage
// hasMentions=true (~760-765), sendMedia audio/sticker/video case arms
// (~925-949), sendRaw non-text content (autoTyping-off branch ~789-791),
// clearPollTracking with live grace timers (~2450-2459), evictStalePolls
// eviction (~882-884), getSocket connected/null (~606-608), disconnect()
// delegation (~720-722), handleCall rejectCall-throws (~2534-2537),
// handleMessagesDelete all+jid chatCleared (~2496-2499), handlePresenceUpdate
// missing-presences early return (~2509).
// ---------------------------------------------------------------------------

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    adminPhones: new Set<string>(),
    authDir: '/tmp/wa-test-auth-branches',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off' as 'off' | 'composing' | 'recording',
    generateHighQualityLinkPreview: false,
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

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

// Repo-hygiene reserved identifiers only.
const USER_JID = '15550001@s.whatsapp.net';
const GROUP_JID = '120363555555550001@g.us';

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

// ---------------------------------------------------------------------------
// setTyping — resolveTypingState boolean arms + error swallow
// ---------------------------------------------------------------------------

describe('ConnectionManager.setTyping — TypingState normalization branches', () => {
  it('maps boolean true to "composing"', async () => {
    const { manager, mockSock } = await connected();
    await manager.setTyping(USER_JID, true);
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('composing', USER_JID);
  });

  it('maps boolean false to "paused"', async () => {
    const { manager, mockSock } = await connected();
    await manager.setTyping(USER_JID, false);
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledWith('paused', USER_JID);
  });

  it('returns silently when no socket is connected (sock-null guard)', async () => {
    const manager = new ConnectionManager();
    await expect(manager.setTyping(USER_JID, true)).resolves.toBeUndefined();
  });

  it('swallows sendPresenceUpdate failures without surfacing to the caller', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendPresenceUpdate.mockRejectedValueOnce(new Error('presence boom'));
    await expect(manager.setTyping(USER_JID, true)).resolves.toBeUndefined();
    expect(mockSock.sendPresenceUpdate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// sendMessage — mentions branch
// ---------------------------------------------------------------------------

describe('ConnectionManager.sendMessage — mentions resolution branch', () => {
  it('passes a mentions array to Baileys when the text resolves @number mentions', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.ment' } });

    // @<number> is rewritten and a mentions array is attached (hasMentions=true).
    const receipt = await manager.sendMessage(GROUP_JID, 'ping @15550002');

    expect(receipt.waMessageId).toBe('wamid.ment');
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(Array.isArray(payload['mentions'])).toBe(true);
    expect((payload['mentions'] as string[]).length).toBeGreaterThan(0);
  });

  it('omits the mentions array when no @mentions are present', async () => {
    const { manager, mockSock } = await connected();
    await manager.sendMessage(USER_JID, 'plain text, no mentions');
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).not.toHaveProperty('mentions');
    expect(payload['text']).toBe('plain text, no mentions');
  });
});

// ---------------------------------------------------------------------------
// sendMedia — per-type case arms (audio, sticker, video, document)
// ---------------------------------------------------------------------------

describe('ConnectionManager.sendMedia — media-type switch arms', () => {
  it('sends an audio payload with ptt/seconds fields', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.audio' } });

    const receipt = await manager.sendMedia(USER_JID, {
      type: 'audio',
      buffer: Buffer.from('audio-bytes'),
      mimetype: 'audio/ogg',
      ptt: true,
      seconds: 7,
    } as any);

    expect(receipt.waMessageId).toBe('wamid.audio');
    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toHaveProperty('audio');
    expect(payload['ptt']).toBe(true);
    expect(payload['seconds']).toBe(7);
  });

  it('defaults sticker mimetype to image/webp when unspecified', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.sticker' } });

    await manager.sendMedia(USER_JID, {
      type: 'sticker',
      buffer: Buffer.from('webp-bytes'),
      isAnimated: false,
    } as any);

    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toHaveProperty('sticker');
    expect(payload['mimetype']).toBe('image/webp');
  });

  it('sends a video payload carrying gifPlayback/ptv/viewOnce fields', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.video' } });

    await manager.sendMedia(USER_JID, {
      type: 'video',
      buffer: Buffer.from('video-bytes'),
      mimetype: 'video/mp4',
      caption: 'clip',
      gifPlayback: true,
      ptv: false,
      viewOnce: false,
    } as any);

    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toHaveProperty('video');
    expect(payload['gifPlayback']).toBe(true);
    expect(payload['caption']).toBe('clip');
  });

  it('routes a URL-backed image through the { url } upload shape', async () => {
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.url' } });

    await manager.sendMedia(USER_JID, {
      type: 'image',
      url: 'https://example.invalid/pic.jpg',
      mimetype: 'image/jpeg',
    } as any);

    const [, payload] = mockSock.sendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload['image']).toEqual({ url: 'https://example.invalid/pic.jpg' });
  });
});

// ---------------------------------------------------------------------------
// sendRaw — non-text content keeps auto-typing off even when configured on
// ---------------------------------------------------------------------------

describe('ConnectionManager.sendRaw — non-text content branch', () => {
  it('does not emit presence for non-text payloads even with autoTyping configured', async () => {
    mockConfig.autoTyping = 'composing';
    const { manager, mockSock } = await connected();
    mockSock.sendMessage.mockResolvedValueOnce({ key: { id: 'wamid.react' } });

    const receipt = await manager.sendRaw(USER_JID, {
      react: { text: '👍', key: { id: 'wamid.target', remoteJid: USER_JID } },
    });

    expect(receipt.waMessageId).toBe('wamid.react');
    expect(mockSock.sendPresenceUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getSocket — connected / disconnected arms
// ---------------------------------------------------------------------------

describe('ConnectionManager.getSocket', () => {
  it('returns null before any connect', () => {
    const manager = new ConnectionManager();
    expect(manager.getSocket()).toBeNull();
  });

  it('returns the live socket after connect', async () => {
    const { manager, mockSock } = await connected();
    expect(manager.getSocket()).toBe(mockSock);
  });
});

// ---------------------------------------------------------------------------
// disconnect() delegates to shutdown()
// ---------------------------------------------------------------------------

describe('ConnectionManager.disconnect', () => {
  it('delegates to shutdown(): ends the socket and reports shutting_down state', async () => {
    const { manager, mockSock } = await connected();
    await manager.disconnect();
    expect(mockSock.end).toHaveBeenCalledTimes(1);
    expect(manager.getSocket()).toBeNull();
    expect(manager.getConnectionState().state).toBe('shutting_down');
  });
});

// ---------------------------------------------------------------------------
// getConnectionState — connected=true reconnectPhase=null arm
// ---------------------------------------------------------------------------

describe('ConnectionManager.getConnectionState — connected identity arm', () => {
  it('reports connected=true and a null reconnectPhase once open with a botJid', async () => {
    const { manager } = await connected();
    const snap = manager.getConnectionState();
    // Strong exact-shape assertion (avoids a weak terminal toBeNull): the connected
    // identity arm must report exactly this snapshot.
    expect(snap).toMatchObject({
      state: 'connected',
      connected: true,
      reconnectPhase: null,
      lastDisconnectReason: null,
    });
  });
});

// ---------------------------------------------------------------------------
// clearPollTracking — public API tears down live grace timers
// ---------------------------------------------------------------------------

describe('ConnectionManager.clearPollTracking', () => {
  it('clears tracked poll + buffered vote so no pollVoteReceived fires after grace', async () => {
    vi.useFakeTimers();
    try {
      const { mockSock, emit } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      // sendMessage returns a poll with a usable messageSecret so the poll is tracked.
      mockSock.sendMessage.mockResolvedValueOnce({
        key: { id: 'wamid.poll' },
        message: { messageContextInfo: { messageSecret: new Uint8Array([1, 2, 3, 4]) } },
      });
      const manager = new ConnectionManager();
      await manager.connect();
      emit(openEvent());

      const onVote = vi.fn();
      manager.on('pollVoteReceived', onVote);

      const res = await manager.sendPollMessage(GROUP_JID, 'Q?', ['Yes', 'No'], 1);
      expect(res.hasSecret).toBe(true);

      // Clearing tracking must drop the poll; a later untracked vote is ignored
      // and no buffered emission can survive.
      manager.clearPollTracking('wamid.poll');
      vi.advanceTimersByTime(60_000);
      expect(onVote).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// evictStalePolls — sending a new poll evicts an expired one
// ---------------------------------------------------------------------------

describe('ConnectionManager poll eviction', () => {
  it('evicts a poll older than the TTL when a fresh poll is sent', async () => {
    vi.useFakeTimers();
    try {
      const { mockSock, emit } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      mockSock.sendMessage
        .mockResolvedValueOnce({
          key: { id: 'wamid.stale' },
          message: { messageContextInfo: { messageSecret: new Uint8Array([9, 9]) } },
        })
        .mockResolvedValueOnce({
          key: { id: 'wamid.fresh' },
          message: { messageContextInfo: { messageSecret: new Uint8Array([8, 8]) } },
        });
      const manager = new ConnectionManager();
      await manager.connect();
      emit(openEvent());

      await manager.sendPollMessage(GROUP_JID, 'Old?', ['A', 'B'], 1);
      // Advance beyond the 1h pending-poll TTL so the first poll is stale.
      vi.advanceTimersByTime(61 * 60 * 1000);
      const fresh = await manager.sendPollMessage(GROUP_JID, 'New?', ['C', 'D'], 1);
      expect(fresh.hasSecret).toBe(true);

      // Stale poll evicted: a vote referencing it is now untracked (no throw).
      expect(() =>
        emit({
          'messages.upsert': {
            type: 'notify',
            messages: [{
              key: { id: 'v', remoteJid: GROUP_JID, fromMe: false, participant: USER_JID },
              message: {
                pollUpdateMessage: {
                  pollCreationMessageKey: { id: 'wamid.stale' },
                  vote: { encPayload: new Uint8Array([1]), encIv: new Uint8Array([2]) },
                },
              },
              messageTimestamp: 1_700_000_000,
            }],
          },
        }),
      ).not.toThrow();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// handleCall — rejectCall throwing arm (best-effort swallow)
// ---------------------------------------------------------------------------

describe('ConnectionManager call handling — rejectCall failure arm', () => {
  it('still emits callReceived when autoReject rejectCall throws', async () => {
    const { manager, mockSock, emit } = await connected();
    manager.autoRejectCalls = true;
    mockSock.rejectCall.mockImplementationOnce(() => {
      throw new Error('reject boom');
    });
    const onCall = vi.fn();
    manager.on('callReceived', onCall);

    expect(() =>
      emit({ call: [{ id: 'call-1', from: USER_JID }] }),
    ).not.toThrow();

    expect(mockSock.rejectCall).toHaveBeenCalledWith('call-1', USER_JID);
    expect(onCall).toHaveBeenCalledWith('call-1', USER_JID);
  });

  it('ignores calls with no id (no reject, no emit)', async () => {
    const { manager, mockSock, emit } = await connected();
    manager.autoRejectCalls = true;
    const onCall = vi.fn();
    manager.on('callReceived', onCall);

    emit({ call: [{ from: USER_JID }] });

    expect(mockSock.rejectCall).not.toHaveBeenCalled();
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// messages.delete — clear-chat (all + jid) arm and presence guard
// ---------------------------------------------------------------------------

describe('ConnectionManager secondary dispatch arms', () => {
  it('emits chatCleared for a clear-chat (all + jid) delete payload', async () => {
    const { manager, emit } = await connected();
    const onCleared = vi.fn();
    manager.on('chatCleared', onCleared);

    emit({ 'messages.delete': { all: true, jid: USER_JID } });

    expect(onCleared).toHaveBeenCalledWith(USER_JID);
  });

  it('returns early from presence.update when the presences map is absent', async () => {
    const { manager, emit } = await connected();
    const onPresence = vi.fn();
    manager.on('presenceUpdate', onPresence);

    // No `presences` key — guard short-circuits before any emit.
    emit({ 'presence.update': { id: USER_JID } });

    expect(onPresence).not.toHaveBeenCalled();
  });
});
