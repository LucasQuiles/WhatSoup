import { describe, it, expect } from 'vitest';
import {
  serializePendingPoll,
  deserializePendingPoll,
  type PendingPollQuestion,
} from '../../../src/runtimes/agent/runtime.ts';

// Build a richly-populated PendingPollQuestion so the round-trip exercises every
// non-trivial field (Maps, Sets, nested Maps, optional fields).
function makePending(): PendingPollQuestion {
  const pending: PendingPollQuestion = {
    questions: [
      {
        question: 'Pick one',
        header: 'Test',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
        multiSelect: false,
      },
      {
        question: 'Pick another',
        header: 'Second',
        options: [
          { label: 'X', description: '' },
          { label: 'Y', description: '' },
        ],
        multiSelect: true,
      },
    ],
    toolId: 'tool-abc',
    chatJid: 'test-group@g.us',
    chatJidAliases: new Set(['test-group@g.us', '12345@lid']),
    mode: 'poll',
    pollMessageIdToQuestionIndex: new Map([
      ['POLL_MSG_1', 0],
      ['POLL_MSG_2', 1],
    ]),
    currentQuestionIndex: 0,
    answersCollected: { 0: 'A' },
    createdAt: 1_700_000_000_000,
    softExpiryTimer: undefined,
    hardExpiryTimer: undefined,
    resolution: 'admin-wins',
    timeoutMs: 3_600_000,
    votesByQuestion: new Map([
      [
        0,
        new Map([
          [
            'voter-1@s.whatsapp.net',
            {
              voterJid: 'voter-1@s.whatsapp.net',
              selectedOptions: ['A'],
              isAdmin: true,
              timestamp: 1_700_000_001_000,
            },
          ],
          [
            'voter-2@s.whatsapp.net',
            {
              voterJid: 'voter-2@s.whatsapp.net',
              selectedOptions: ['B'],
              isAdmin: false,
              timestamp: 1_700_000_002_000,
            },
          ],
        ]),
      ],
    ]),
    adminJids: new Set(['admin-1@s.whatsapp.net', 'admin-2@s.whatsapp.net']),
    awaitResolve: undefined,
    awaitReject: undefined,
    resolvedAt: undefined,
    source: 'askuser',
    sentPollMessageIds: ['POLL_MSG_1', 'POLL_MSG_2'],
  };
  return pending;
}

describe('serializePendingPoll / deserializePendingPoll', () => {
  it('round-trips all persisted fields through JSON.stringify and back', () => {
    const original = makePending();
    const serialized = serializePendingPoll(original);
    const roundTripped = JSON.parse(JSON.stringify(serialized));
    const restored = deserializePendingPoll(roundTripped);

    expect(restored.questions).toEqual(original.questions);
    expect(restored.toolId).toBe(original.toolId);
    expect(restored.chatJid).toBe(original.chatJid);
    expect(Array.from(restored.chatJidAliases).sort()).toEqual(
      Array.from(original.chatJidAliases).sort(),
    );
    expect(restored.mode).toBe(original.mode);
    expect(Array.from(restored.pollMessageIdToQuestionIndex.entries())).toEqual(
      Array.from(original.pollMessageIdToQuestionIndex.entries()),
    );
    expect(restored.currentQuestionIndex).toBe(original.currentQuestionIndex);
    expect(restored.answersCollected).toEqual(original.answersCollected);
    expect(restored.createdAt).toBe(original.createdAt);
    expect(restored.resolution).toBe(original.resolution);
    expect(restored.timeoutMs).toBe(original.timeoutMs);
    expect(restored.source).toBe(original.source);
    expect(restored.sentPollMessageIds).toEqual(original.sentPollMessageIds);

    // Nested Map<number, Map<string, PollVote>>
    expect(restored.votesByQuestion.size).toBe(original.votesByQuestion.size);
    const restoredQ0Votes = restored.votesByQuestion.get(0)!;
    const originalQ0Votes = original.votesByQuestion.get(0)!;
    expect(restoredQ0Votes.size).toBe(originalQ0Votes.size);
    expect(restoredQ0Votes.get('voter-1@s.whatsapp.net')).toEqual(
      originalQ0Votes.get('voter-1@s.whatsapp.net'),
    );
    expect(restoredQ0Votes.get('voter-2@s.whatsapp.net')).toEqual(
      originalQ0Votes.get('voter-2@s.whatsapp.net'),
    );

    expect(Array.from(restored.adminJids!).sort()).toEqual(
      Array.from(original.adminJids!).sort(),
    );
  });

  it('preserves null adminJids (DM polls have no admin concept)', () => {
    const original = makePending();
    original.adminJids = null;
    const serialized = serializePendingPoll(original);
    const restored = deserializePendingPoll(JSON.parse(JSON.stringify(serialized)));
    expect(restored.adminJids).toBeNull();
  });

  it('drops non-serializable fields (timers, awaiters) on round-trip', () => {
    // The live object may carry timer handles and promise callbacks that cannot
    // survive serialization. The restored copy should have them as undefined —
    // the rehydrate path re-arms timers, and the awaiter's original promise is
    // gone after restart anyway. Use opaque shapes (cast through unknown) so
    // the test never actually schedules a wall-clock callback.
    const noopFn = (): void => {};
    const fakeTimer = { ref: noopFn, unref: noopFn } as unknown as ReturnType<typeof setTimeout>;
    const original = makePending();
    original.softExpiryTimer = fakeTimer;
    original.hardExpiryTimer = fakeTimer;
    original.awaitResolve = noopFn;
    original.awaitReject = noopFn;

    const serialized = serializePendingPoll(original);
    const restored = deserializePendingPoll(JSON.parse(JSON.stringify(serialized)));
    expect(restored.softExpiryTimer).toBeUndefined();
    expect(restored.hardExpiryTimer).toBeUndefined();
    expect(restored.awaitResolve).toBeUndefined();
    expect(restored.awaitReject).toBeUndefined();
  });

  it('handles empty ballot (no votes yet)', () => {
    const original = makePending();
    original.votesByQuestion = new Map();
    const serialized = serializePendingPoll(original);
    const restored = deserializePendingPoll(JSON.parse(JSON.stringify(serialized)));
    expect(restored.votesByQuestion.size).toBe(0);
  });

  it('handles textFallback mode polls', () => {
    const original = makePending();
    original.mode = 'textFallback';
    original.pollMessageIdToQuestionIndex = new Map();
    const serialized = serializePendingPoll(original);
    const restored = deserializePendingPoll(JSON.parse(JSON.stringify(serialized)));
    expect(restored.mode).toBe('textFallback');
    expect(restored.pollMessageIdToQuestionIndex.size).toBe(0);
  });
});
