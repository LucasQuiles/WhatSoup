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
});
