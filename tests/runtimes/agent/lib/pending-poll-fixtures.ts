/**
 * Pending-poll persistence fixtures for the AgentRuntime poll-hardening tests.
 * Pure: a real in-memory Database, a serialized PendingPollQuestion payload and a
 * raw pending_polls row insert. No hoisted mocks, no runtime state.
 */
import { Database as RealDatabase } from '../../../../src/core/database.ts';
import { serializePendingPoll, type PendingPollQuestion } from '../../../../src/runtimes/agent/runtime.ts';

export function makeRealDb(): RealDatabase {
  const db = new RealDatabase(':memory:');
  db.open();
  return db;
}

export function buildPayload(overrides: Partial<PendingPollQuestion>): string {
  const pending: PendingPollQuestion = {
    questions: [{
      question: 'Pick',
      header: 'H',
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
      multiSelect: false,
    }],
    toolId: 'tool-x',
    chatJid: 'chat@g.us',
    chatJidAliases: new Set(['chat@g.us']),
    mode: 'poll',
    pollMessageIdToQuestionIndex: new Map([['POLL_X', 0]]),
    currentQuestionIndex: 0,
    answersCollected: {},
    createdAt: 1_700_000_000_000,
    resolution: 'first-vote-wins',
    timeoutMs: 3_600_000,
    votesByQuestion: new Map(),
    adminJids: null,
    source: 'askuser',
    sentPollMessageIds: ['POLL_X'],
    ...overrides,
  };
  return JSON.stringify(serializePendingPoll(pending));
}

export function insertRow(
  db: RealDatabase,
  mapKey: string,
  chatJid: string,
  hardClosesAt: number | null,
  payload: string,
): void {
  db.raw.prepare(
    `INSERT INTO pending_polls (map_key, chat_jid, tool_id, source, resolution, payload, created_at, closes_at, hard_closes_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(mapKey, chatJid, mapKey, 'askuser', 'first-vote-wins', payload, 1_700_000_000_000, hardClosesAt, hardClosesAt);
}
