// The operator instance `q` is held to an explicit Pinecone project like every
// other instance. With no guard in its config it must reach the operator's
// project (OPERATOR_PINECONE_PROJECT_ID); a key that resolves the memory index
// in any other project fails closed, loudly, for reads and writes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGuardLogger, listIndexesMock, upsertRecordsMock, searchRecordsMock } = vi.hoisted(() => ({
  mockGuardLogger: {} as Record<string, ReturnType<typeof vi.fn>>,
  listIndexesMock: vi.fn(),
  upsertRecordsMock: vi.fn(),
  searchRecordsMock: vi.fn(),
}));

vi.mock('@pinecone-database/pinecone', () => ({
  Pinecone: vi.fn(function (this: Record<string, unknown>) {
    this.listIndexes = listIndexesMock;
    this.index = vi.fn(() => ({ upsertRecords: upsertRecordsMock, searchRecords: searchRecordsMock }));
    this.inference = { rerank: vi.fn() };
  }),
}));

// Shaped like the operator host today: botName `q`, no memory.pinecone guard,
// the index left at its default.
vi.mock('../../../../src/config.ts', () => ({
  config: {
    botName: 'q',
    pineconeIndex: 'whatsapp-bot',
    pineconeContextTopK: 10,
    pineconeSenderTopK: 5,
    enrichmentDedupThreshold: 0.95,
    recencyHalfLifeDays: 36500,
    maxAgeDays: 36500,
    memory: { pinecone: { apiKeyEnv: 'OPERATOR_GUARD_PINECONE_API_KEY' } },
  },
}));

vi.mock('../../../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../../../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(mockGuardLogger);
  return { createChildLogger };
});

vi.mock('../../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => null),
}));

import {
  getPineconeReadiness,
  PineconeMemory,
  type MemoryRecord,
} from '../../../../src/runtimes/chat/providers/pinecone.ts';
import { OPERATOR_PINECONE_PROJECT_ID } from '../../../../src/lib/pinecone-project-guard.ts';

const OPERATOR_HOST = `whatsapp-bot-${OPERATOR_PINECONE_PROJECT_ID}.svc.aped-4627-b74a.pinecone.io`;
const OTHER_PROJECT_HOST = 'whatsapp-bot-abc1234.svc.aped-4627-b74a.pinecone.io';

const record: MemoryRecord = {
  id: 'preference_operator_guard',
  text: 'Synthetic operator memory',
  chatJid: 'synthetic-chat@s.whatsapp.net',
  senderJid: 'synthetic-actor@s.whatsapp.net',
  senderName: '',
  memoryType: 'preference',
  confidence: 0.8,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  superseded: 'false',
  sourceMessagePks: '',
};

function indexesAt(host: string) {
  return { indexes: [{ name: 'whatsapp-bot', host }] };
}

function guardRefusalLogged(): boolean {
  return (mockGuardLogger.error?.mock.calls ?? []).some(
    (call) => call[1] === 'Pinecone project guard refused the configured key; memory reads and writes are disabled',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPERATOR_GUARD_PINECONE_API_KEY = 'operator-guard-test-key';
  upsertRecordsMock.mockResolvedValue(undefined);
  searchRecordsMock.mockResolvedValue({ result: { hits: [] } });
});

describe('operator instance Pinecone project check', () => {
  it('refuses the operator instance when its key resolves the index in another project', async () => {
    listIndexesMock.mockResolvedValue(indexesAt(OTHER_PROJECT_HOST));

    await expect(getPineconeReadiness()).resolves.toEqual({
      state: 'project_mismatch',
      index: 'whatsapp-bot',
    });

    const memory = new PineconeMemory();
    await expect(memory.upsert([record])).rejects.toMatchObject({ code: 'PINECONE_UNAVAILABLE' });
    expect(upsertRecordsMock).not.toHaveBeenCalled();
    expect(guardRefusalLogged()).toBe(true);
    const refusal = mockGuardLogger.error!.mock.calls.find(
      (call) => call[1] === 'Pinecone project guard refused the configured key; memory reads and writes are disabled',
    );
    expect(refusal?.[0]).toEqual({ instance: 'q', guard_source: 'operator_default' });
    const errorLogs = JSON.stringify(mockGuardLogger.error!.mock.calls);
    expect(errorLogs).not.toContain('operator-guard-test-key');
    expect(errorLogs).not.toContain('abc1234');
  });

  it('admits the operator instance when its key resolves the index in the operator project', async () => {
    listIndexesMock.mockResolvedValue(indexesAt(OPERATOR_HOST));

    await expect(getPineconeReadiness()).resolves.toEqual({
      state: 'ready',
      index: 'whatsapp-bot',
    });

    // The write is admitted because the project check ran and matched, not
    // because the operator instance skipped it.
    listIndexesMock.mockClear();
    const memory = new PineconeMemory();
    await expect(memory.upsert([record])).resolves.toBeUndefined();
    expect(listIndexesMock).toHaveBeenCalledTimes(1);
    expect(upsertRecordsMock).toHaveBeenCalledTimes(1);
    expect(guardRefusalLogged()).toBe(false);
  });
});
