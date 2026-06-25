import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

// Mock the dynamic import of Baileys decryptPollVote
const mockDecryptPollVote = vi.fn();
vi.mock('@whiskeysockets/baileys/lib/Utils/process-message.js', () => ({
  decryptPollVote: mockDecryptPollVote,
}));

const { mockConnectionLogger } = vi.hoisted(() => ({
  mockConnectionLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}));
mockConnectionLogger.child.mockReturnValue(mockConnectionLogger);

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['1111']),
    authDir: '/tmp/wa-test-auth',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    autoTyping: 'off',
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => mockConnectionLogger,
}));

import { createHash } from 'node:crypto';
import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA256 hash in raw .toString() format — matches Baileys convention */
function optionHash(name: string): Buffer {
  return createHash('sha256').update(Buffer.from(name)).digest();
}

function makeMockSocket() {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;

  const mockSock = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn(),
    sendPresenceUpdate: vi.fn(),
    end: vi.fn(),
    user: {
      id: '1111:1@s.whatsapp.net',
      lid: '4444:2@lid',
      name: 'QBot',
    },
  };

  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    evProcessCallback(events);
  }

  return { mockSock, emit };
}

// Fixture: LID-addressed poll vote message (matches live capture)
function makePollVoteMessage(opts: {
  pollMsgId: string;
  voterLid: string;
  voterPhone: string;
  fromMe?: boolean;
}) {
  return {
    key: {
      remoteJid: opts.voterLid,
      remoteJidAlt: opts.voterPhone,
      fromMe: opts.fromMe ?? false,
      id: 'VOTE_MSG_ID_123',
      addressingMode: 'lid',
    },
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: {
          remoteJid: opts.voterLid,
          fromMe: true, // we created the poll
          id: opts.pollMsgId,
        },
        vote: {
          encPayload: new Uint8Array(50),
          encIv: new Uint8Array(12),
        },
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('poll vote bridge', () => {
  let cm: ConnectionManager;
  let emit: (events: Record<string, unknown>) => void;
  let mockSock: ReturnType<typeof makeMockSocket>['mockSock'];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    const result = makeMockSocket();
    mockSock = result.mockSock;
    emit = result.emit;
    (makeWASocket as ReturnType<typeof vi.fn>).mockReturnValue(mockSock);

    cm = new ConnectionManager();
    await cm.connect();
    emit({ 'connection.update': { connection: 'open' } });
  });

  afterEach(async () => {
    await cm.shutdown();
    vi.useRealTimers();
  });

  describe('sendPollMessage', () => {
    it('stores messageSecret and option hashes for vote decryption', async () => {
      const secret = new Uint8Array(32).fill(42);
      mockSock.sendMessage.mockResolvedValue({
        key: { id: 'POLL_MSG_001', remoteJid: '3333@lid', fromMe: true },
        message: {
          messageContextInfo: { messageSecret: secret },
          pollCreationMessageV3: {
            name: 'Test poll',
            options: [{ optionName: 'A' }, { optionName: 'B' }],
          },
        },
      });

      const result = await cm.sendPollMessage('3333@lid', 'Test poll', ['A', 'B'], 1);

      expect(result.waMessageId).toBe('POLL_MSG_001');
      expect(result.hasSecret).toBe(true);
    });

    it('returns hasSecret=false when messageSecret is absent', async () => {
      mockSock.sendMessage.mockResolvedValue({
        key: { id: 'POLL_MSG_002', remoteJid: '3333@lid', fromMe: true },
        message: {
          pollCreationMessageV3: {
            name: 'Test poll',
            options: [{ optionName: 'A' }, { optionName: 'B' }],
          },
        },
      });

      const result = await cm.sendPollMessage('3333@lid', 'Test poll', ['A', 'B'], 1);

      expect(result.waMessageId).toBe('POLL_MSG_002');
      expect(result.hasSecret).toBe(false);
    });
  });

  describe('poll vote decryption — LID-first candidate fallback', () => {
    const POLL_MSG_ID = 'POLL_LID_TEST_001';
    const VOTER_LID = '3333@lid';
    const VOTER_PHONE = '2222@s.whatsapp.net';
    const BOT_LID = '4444@lid';
    const BOT_PHONE = '1111@s.whatsapp.net';

    beforeEach(async () => {
      // Set up a tracked poll
      const secret = new Uint8Array(32).fill(99);
      mockSock.sendMessage.mockResolvedValue({
        key: { id: POLL_MSG_ID, remoteJid: VOTER_LID, fromMe: true },
        message: {
          messageContextInfo: { messageSecret: secret },
          pollCreationMessageV3: {
            name: 'Which runtime?',
            options: [{ optionName: 'Node.js' }, { optionName: 'Python' }, { optionName: 'Go' }],
          },
        },
      });
      await cm.sendPollMessage(VOTER_LID, 'Which runtime?', ['Node.js', 'Python', 'Go'], 1);
    });

    it('tries LID JIDs first and emits pollVoteReceived after grace window', async () => {
      // decryptPollVote succeeds on LID candidate
      mockDecryptPollVote.mockImplementation((_vote: any, ctx: any) => {
        if (ctx.voterJid === VOTER_LID && ctx.pollCreatorJid === BOT_LID) {
          return { selectedOptions: [optionHash('Node.js')] };
        }
        throw new Error('Unsupported state or unable to authenticate data');
      });

      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      const voteMsg = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });

      // Wait for async decryption to buffer the vote and schedule the grace timer.
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(1));
      // Vote should NOT be emitted yet (grace window)
      expect(handler).not.toHaveBeenCalled();

      // Advance past 5s grace window
      await vi.advanceTimersByTimeAsync(5_000);

      expect(handler).toHaveBeenCalledWith({
        pollMessageId: POLL_MSG_ID,
        chatJid: VOTER_LID,
        voterJid: VOTER_LID,
        selectedOptions: ['Node.js'],
      });

      // Verify LID was tried (first call)
      expect(mockDecryptPollVote).toHaveBeenCalledTimes(1);
      expect(mockDecryptPollVote.mock.calls[0][1].voterJid).toBe(VOTER_LID);
      expect(mockDecryptPollVote.mock.calls[0][1].pollCreatorJid).toBe(BOT_LID);
    });

    it('falls back to phone JIDs when LID decryption fails', async () => {
      // LID fails, phone succeeds
      mockDecryptPollVote.mockImplementation((_vote: any, ctx: any) => {
        if (ctx.voterJid === VOTER_PHONE && ctx.pollCreatorJid === BOT_PHONE) {
          return { selectedOptions: [optionHash('Python')] };
        }
        throw new Error('Unsupported state or unable to authenticate data');
      });

      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      const voteMsg = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });
      // Wait for async decryption to try both candidates and schedule the grace timer.
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(handler).toHaveBeenCalledWith({
        pollMessageId: POLL_MSG_ID,
        chatJid: VOTER_LID,
        voterJid: VOTER_PHONE,
        selectedOptions: ['Python'],
      });

      // Verify both candidates tried: LID first, then phone
      expect(mockDecryptPollVote).toHaveBeenCalledTimes(2);
      expect(mockDecryptPollVote.mock.calls[0][1].voterJid).toBe(VOTER_LID);
      expect(mockDecryptPollVote.mock.calls[1][1].voterJid).toBe(VOTER_PHONE);
    });

    it('emits pollVoteFailed when all decrypt candidates fail', async () => {
      mockDecryptPollVote.mockImplementation(() => {
        throw new Error('Unsupported state or unable to authenticate data');
      });

      const handler = vi.fn();
      const failed = vi.fn();
      cm.on('pollVoteReceived', handler);
      cm.on('pollVoteFailed', failed);

      const voteMsg = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(handler).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledWith({
        pollMessageId: POLL_MSG_ID,
        chatJid: VOTER_LID,
        reason: 'decrypt_failed',
      });
    });

    it('ignores votes for untracked polls', () => {
      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      const voteMsg = makePollVoteMessage({
        pollMsgId: 'UNKNOWN_POLL_ID',
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });

      expect(handler).not.toHaveBeenCalled();
      expect(mockDecryptPollVote).not.toHaveBeenCalled();
    });

    it('handles multiSelect votes with multiple options', async () => {
      mockDecryptPollVote.mockReturnValue({
        selectedOptions: [optionHash('Node.js'), optionHash('Go')],
      });

      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      const voteMsg = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedOptions: ['Node.js', 'Go'],
        }),
      );
    });

    it('redacts selected poll labels from transport logs', async () => {
      mockDecryptPollVote
        .mockReturnValueOnce({ selectedOptions: [optionHash('Node.js')] })
        .mockReturnValueOnce({ selectedOptions: [optionHash('Go')] });

      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      const vote1 = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });
      emit({ 'messages.upsert': { messages: [vote1], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(2_000);
      const vote2 = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });
      emit({ 'messages.upsert': { messages: [vote2], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(2));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ selectedOptions: ['Go'] }));

      const changedLog = mockConnectionLogger.info.mock.calls.find(([, message]) => message === 'poll vote changed within grace window')?.[0] as Record<string, unknown> | undefined;
      const emittedLog = mockConnectionLogger.info.mock.calls.find(([, message]) => message === 'poll vote decrypted and emitted')?.[0] as Record<string, unknown> | undefined;

      expect(changedLog).toMatchObject({ pollMessageId: POLL_MSG_ID, newOptionCount: 1, prevOptionCount: 1 });
      expect(changedLog).not.toHaveProperty('newOptions');
      expect(changedLog).not.toHaveProperty('prevOptions');
      expect(emittedLog).toMatchObject({ pollMessageId: POLL_MSG_ID, selectedOptionCount: 1, jidType: 'LID' });
      expect(emittedLog).not.toHaveProperty('selectedOptions');
      expect(JSON.stringify([changedLog, emittedLog])).not.toContain('Node.js');
      expect(JSON.stringify([changedLog, emittedLog])).not.toContain('Go');
    });

    // -----------------------------------------------------------------------
    // CHARACTERIZATION (BEAD-019 prep): lock the EXACT candidate-context object
    // passed to decryptPollVote, including ordering and the pollMsgId/pollEncKey
    // fields that the existing tests do not assert.
    // -----------------------------------------------------------------------
    it('passes the exact LID-then-phone candidate contexts to decryptPollVote (full call-args)', async () => {
      // Force BOTH candidates to be tried by failing every attempt, so we can
      // capture the precise context object for each.
      mockDecryptPollVote.mockImplementation(() => {
        throw new Error('Unsupported state or unable to authenticate data');
      });

      cm.on('pollVoteFailed', vi.fn());

      const voteMsg = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(2));

      // Candidate ordering: LID pair tried FIRST.
      const [vote0, ctx0] = mockDecryptPollVote.mock.calls[0];
      const [vote1, ctx1] = mockDecryptPollVote.mock.calls[1];

      // The same encrypted vote object is threaded to every candidate.
      expect(vote0).toBe(voteMsg.message.pollUpdateMessage.vote);
      expect(vote1).toBe(voteMsg.message.pollUpdateMessage.vote);

      // First candidate = LID pair, with the FULL context shape the decryptor sees.
      expect(ctx0).toEqual({
        pollCreatorJid: BOT_LID,
        pollMsgId: POLL_MSG_ID,
        pollEncKey: expect.any(Uint8Array),
        voterJid: VOTER_LID,
      });
      // Second candidate = phone pair.
      expect(ctx1).toEqual({
        pollCreatorJid: BOT_PHONE,
        pollMsgId: POLL_MSG_ID,
        pollEncKey: expect.any(Uint8Array),
        voterJid: VOTER_PHONE,
      });

      // pollEncKey is the stored messageSecret (filled with 99 by this block's beforeEach).
      expect(Array.from(ctx0.pollEncKey as Uint8Array)).toEqual(Array.from(new Uint8Array(32).fill(99)));
      expect(ctx1.pollEncKey).toBe(ctx0.pollEncKey);
    });

    // -----------------------------------------------------------------------
    // CHARACTERIZATION (BEAD-019 prep): an option hash that is NOT in the
    // poll's optionHashes map maps to the literal 'Unknown' fallback.
    // -----------------------------------------------------------------------
    it("emits 'Unknown' for a decrypted option hash absent from the poll's option set", async () => {
      // 'Rust' was never an option of this poll (Node.js/Python/Go) → its hash
      // is absent from stored.optionHashes → fallback to 'Unknown'.
      mockDecryptPollVote.mockReturnValue({
        selectedOptions: [optionHash('Rust')],
      });

      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      const voteMsg = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(handler).toHaveBeenCalledWith({
        pollMessageId: POLL_MSG_ID,
        chatJid: VOTER_LID,
        voterJid: VOTER_LID,
        selectedOptions: ['Unknown'],
      });
    });

    it("emits a known name AND 'Unknown' when a vote mixes a real hash with an absent one", async () => {
      // Multi-select where one hash is a real option ('Go') and one is not ('Rust').
      // Characterizes that mapping is positional and the fallback is per-hash.
      mockDecryptPollVote.mockReturnValue({
        selectedOptions: [optionHash('Go'), optionHash('Rust')],
      });

      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      const voteMsg = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ selectedOptions: ['Go', 'Unknown'] }),
      );
    });

    it('replaces buffered vote when user changes answer within grace window', async () => {
      mockDecryptPollVote.mockReturnValue({
        selectedOptions: [optionHash('Node.js')],
      });

      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      // First vote: Node.js
      const vote1 = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });
      emit({ 'messages.upsert': { messages: [vote1], type: 'notify' } });
      await vi.advanceTimersByTimeAsync(0);

      // Not emitted yet (grace window)
      expect(handler).not.toHaveBeenCalled();

      // 2s later: user changes to Go
      await vi.advanceTimersByTimeAsync(2_000);
      mockDecryptPollVote.mockReturnValue({
        selectedOptions: [optionHash('Go')],
      });
      const vote2 = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_LID,
        voterPhone: VOTER_PHONE,
      });
      emit({ 'messages.upsert': { messages: [vote2], type: 'notify' } });
      await vi.advanceTimersByTimeAsync(0);

      // Still not emitted — grace window restarted
      expect(handler).not.toHaveBeenCalled();

      // Advance remaining 5s
      await vi.advanceTimersByTimeAsync(5_000);

      // Only one emission with the FINAL answer
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedOptions: ['Go'],
        }),
      );
    });
  });

  describe('multi-voter grace window', () => {
    const POLL_MSG_ID = 'POLL_MULTI_VOTER_001';
    const VOTER_A_LID = '3333@lid';
    const VOTER_A_PHONE = '2222@s.whatsapp.net';
    const VOTER_B_LID = '5555@lid';
    const VOTER_B_PHONE = '6666@s.whatsapp.net';
    const BOT_LID = '4444@lid';

    beforeEach(async () => {
      const secret = new Uint8Array(32).fill(77);
      mockSock.sendMessage.mockResolvedValue({
        key: { id: POLL_MSG_ID, remoteJid: VOTER_A_LID, fromMe: true },
        message: {
          messageContextInfo: { messageSecret: secret },
          pollCreationMessageV3: {
            name: 'Favorite language?',
            options: [{ optionName: 'Rust' }, { optionName: 'Go' }, { optionName: 'TypeScript' }],
          },
        },
      });
      await cm.sendPollMessage(VOTER_A_LID, 'Favorite language?', ['Rust', 'Go', 'TypeScript'], 1);
    });

    it('emits independent events for two voters on the same poll without clobbering', async () => {
      // Voter A picks Rust, voter B picks Go — each gets their own grace key
      mockDecryptPollVote.mockImplementation((_vote: any, ctx: any) => {
        if (ctx.voterJid === VOTER_A_LID && ctx.pollCreatorJid === BOT_LID) {
          return { selectedOptions: [optionHash('Rust')] };
        }
        if (ctx.voterJid === VOTER_B_LID && ctx.pollCreatorJid === BOT_LID) {
          return { selectedOptions: [optionHash('Go')] };
        }
        throw new Error('Unsupported state or unable to authenticate data');
      });

      const handler = vi.fn();
      cm.on('pollVoteReceived', handler);

      // Voter A votes
      const voteA = makePollVoteMessage({
        pollMsgId: POLL_MSG_ID,
        voterLid: VOTER_A_LID,
        voterPhone: VOTER_A_PHONE,
      });
      emit({ 'messages.upsert': { messages: [voteA], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(1));

      // Voter B votes 2s later (still within grace window of A)
      await vi.advanceTimersByTimeAsync(2_000);
      const voteB = {
        key: {
          remoteJid: VOTER_B_LID,
          remoteJidAlt: VOTER_B_PHONE,
          fromMe: false,
          id: 'VOTE_MSG_B_123',
          addressingMode: 'lid',
        },
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: {
              remoteJid: VOTER_B_LID,
              fromMe: true,
              id: POLL_MSG_ID,
            },
            vote: {
              encPayload: new Uint8Array(50),
              encIv: new Uint8Array(12),
            },
          },
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
      emit({ 'messages.upsert': { messages: [voteB], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(2));

      // Neither emitted yet — both in their own grace windows
      expect(handler).not.toHaveBeenCalled();

      // Advance 5s — both timers should fire
      await vi.advanceTimersByTimeAsync(5_000);

      expect(handler).toHaveBeenCalledTimes(2);

      const calls = handler.mock.calls.map((c) => c[0]);
      const voteAResult = calls.find((c) => c.voterJid === VOTER_A_LID);
      const voteBResult = calls.find((c) => c.voterJid === VOTER_B_LID);

      expect(voteAResult).toBeDefined();
      expect(voteAResult).toMatchObject({
        pollMessageId: POLL_MSG_ID,
        voterJid: VOTER_A_LID,
        selectedOptions: ['Rust'],
      });

      expect(voteBResult).toBeDefined();
      expect(voteBResult).toMatchObject({
        pollMessageId: POLL_MSG_ID,
        voterJid: VOTER_B_LID,
        selectedOptions: ['Go'],
      });
    });
  });

  // -------------------------------------------------------------------------
  // CHARACTERIZATION (BEAD-019 prep): the creationKey.fromMe branch that
  // selects the poll-creator JID. fromMe === true derives the creator from the
  // bot's own identity (botLid/botJid); fromMe === false derives it from the
  // creationKey's participant/remoteJid fields.
  // -------------------------------------------------------------------------
  describe('poll vote decryption — creationKey.fromMe creator-JID arm', () => {
    const POLL_MSG_ID = 'POLL_FROMME_ARM_001';
    const VOTER_LID = '3333@lid';
    const VOTER_PHONE = '2222@s.whatsapp.net';
    const BOT_LID = '4444@lid';
    const BOT_PHONE = '1111@s.whatsapp.net';
    // Creator identity used only in the fromMe === false arm (a different
    // participant created the poll — e.g. a group poll we did not author).
    const CREATOR_LID = '7777@lid';
    const CREATOR_PHONE = '8888@s.whatsapp.net';

    beforeEach(async () => {
      const secret = new Uint8Array(32).fill(55);
      mockSock.sendMessage.mockResolvedValue({
        key: { id: POLL_MSG_ID, remoteJid: VOTER_LID, fromMe: true },
        message: {
          messageContextInfo: { messageSecret: secret },
          pollCreationMessageV3: {
            name: 'Which runtime?',
            options: [{ optionName: 'Node.js' }, { optionName: 'Python' }],
          },
        },
      });
      await cm.sendPollMessage(VOTER_LID, 'Which runtime?', ['Node.js', 'Python'], 1);
    });

    it('fromMe === true: creator JID derives from the bot identity (botLid then botJid)', async () => {
      mockDecryptPollVote.mockImplementation(() => {
        throw new Error('Unsupported state or unable to authenticate data');
      });
      cm.on('pollVoteFailed', vi.fn());

      const voteMsg = {
        key: {
          remoteJid: VOTER_LID,
          remoteJidAlt: VOTER_PHONE,
          fromMe: false,
          id: 'VOTE_FROMME_TRUE',
          addressingMode: 'lid',
        },
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: {
              remoteJid: VOTER_LID,
              fromMe: true, // we authored the poll → creator = bot identity
              id: POLL_MSG_ID,
            },
            vote: { encPayload: new Uint8Array(50), encIv: new Uint8Array(12) },
          },
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      };

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(2));

      // LID candidate uses the bot LID; phone candidate uses the bot phone.
      expect(mockDecryptPollVote.mock.calls[0][1].pollCreatorJid).toBe(BOT_LID);
      expect(mockDecryptPollVote.mock.calls[1][1].pollCreatorJid).toBe(BOT_PHONE);
    });

    it('fromMe === false: creator JID derives from the creationKey participant fields', async () => {
      mockDecryptPollVote.mockImplementation(() => {
        throw new Error('Unsupported state or unable to authenticate data');
      });
      cm.on('pollVoteFailed', vi.fn());

      const voteMsg = {
        key: {
          remoteJid: VOTER_LID,
          remoteJidAlt: VOTER_PHONE,
          fromMe: false,
          id: 'VOTE_FROMME_FALSE',
          addressingMode: 'lid',
        },
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: {
              // Someone else authored the poll: creator JID comes from these.
              participant: CREATOR_LID,
              participantAlt: CREATOR_PHONE,
              remoteJid: VOTER_LID,
              fromMe: false,
              id: POLL_MSG_ID,
            },
            vote: { encPayload: new Uint8Array(50), encIv: new Uint8Array(12) },
          },
        },
        messageTimestamp: Math.floor(Date.now() / 1000),
      };

      emit({ 'messages.upsert': { messages: [voteMsg], type: 'notify' } });
      await vi.waitFor(() => expect(mockDecryptPollVote).toHaveBeenCalledTimes(2));

      // LID candidate creator = creationKey.participant (normalized);
      // phone candidate creator = creationKey.participantAlt.
      expect(mockDecryptPollVote.mock.calls[0][1].pollCreatorJid).toBe(CREATOR_LID);
      expect(mockDecryptPollVote.mock.calls[0][1].voterJid).toBe(VOTER_LID);
      expect(mockDecryptPollVote.mock.calls[1][1].pollCreatorJid).toBe(CREATOR_PHONE);
      expect(mockDecryptPollVote.mock.calls[1][1].voterJid).toBe(VOTER_PHONE);
    });
  });
});
