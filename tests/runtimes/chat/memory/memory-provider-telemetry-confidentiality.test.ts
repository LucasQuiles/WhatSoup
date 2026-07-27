import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearAlert: vi.fn(),
  emitAlert: vi.fn(),
  listIndexes: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  rerank: vi.fn(),
  searchRecords: vi.fn(),
  upsertRecords: vi.fn(),
}));

vi.mock('@pinecone-database/pinecone', () => ({
  Pinecone: vi.fn(),
}));

vi.mock('../../../../src/config.ts', () => ({
  config: {
    botName: 'q',
    pineconeIndex: 'SYNTHETIC_PRIVATE_INDEX_MARKER',
    pineconeContextTopK: 10,
    pineconeSenderTopK: 5,
    pineconeTopK: 10,
    pineconeRerank: true,
    pineconeRerankTopN: 5,
    enrichmentDedupThreshold: 0.95,
    recencyHalfLifeDays: 36_500,
    maxAgeDays: 36_500,
    memory: {
      pinecone: {
        apiKeyEnv: 'PINECONE_API_KEY',
      },
    },
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => mocks.logger,
}));

vi.mock('../../../../src/lib/emit-alert.ts', () => ({
  clearAlertSourceChecked: mocks.clearAlert,
  emitAlertChecked: mocks.emitAlert,
}));

vi.mock('../../../../src/core/retry.ts', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

import { Pinecone } from '@pinecone-database/pinecone';
import {
  PineconeMemory,
  getPineconeReadiness,
  type MemoryRecord,
} from '../../../../src/runtimes/chat/providers/pinecone.ts';
import * as configModule from '../../../../src/config.ts';

const PRIVATE_MARKERS = [
  'SYNTHETIC_PRIVATE_QUERY_MARKER',
  'SYNTHETIC_PRIVATE_FILTER_MARKER',
  'SYNTHETIC_PRIVATE_RECORD_ID_MARKER',
  'SYNTHETIC_PRIVATE_RECORD_TEXT_MARKER',
  'SYNTHETIC_PRIVATE_RECORD_CHAT_MARKER',
  'SYNTHETIC_PRIVATE_RECORD_SENDER_MARKER',
  'SYNTHETIC_PRIVATE_RECORD_NAME_MARKER',
  'SYNTHETIC_PRIVATE_SOURCE_MARKER',
  'SYNTHETIC_PRIVATE_PROVIDER_ERROR_MARKER',
  'SYNTHETIC_PRIVATE_NESTED_CAUSE_MARKER',
  'SYNTHETIC_PRIVATE_ENTITY_ID_MARKER',
  'SYNTHETIC_PRIVATE_ENTITY_TEXT_MARKER',
  'SYNTHETIC_PRIVATE_RERANK_ERROR_MARKER',
  'SYNTHETIC_PRIVATE_TRACE_MARKER',
  'SYNTHETIC_PRIVATE_INDEX_MARKER',
  'SYNTHETIC_PRIVATE_READINESS_ERROR_MARKER',
  'SYNTHETIC_PRIVATE_PROJECT_MARKER',
  'SYNTHETIC_PRIVATE_HOST_MARKER',
  'SYNTHETIC_PRIVATE_API_KEY_MARKER',
] as const;

function privateRecord(): MemoryRecord {
  return {
    id: 'SYNTHETIC_PRIVATE_RECORD_ID_MARKER',
    text: 'SYNTHETIC_PRIVATE_RECORD_TEXT_MARKER',
    chatJid: 'SYNTHETIC_PRIVATE_RECORD_CHAT_MARKER',
    senderJid: 'SYNTHETIC_PRIVATE_RECORD_SENDER_MARKER',
    senderName: 'SYNTHETIC_PRIVATE_RECORD_NAME_MARKER',
    memoryType: 'user_fact',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    superseded: '',
    sourceMessagePks: 'SYNTHETIC_PRIVATE_SOURCE_MARKER',
  };
}

describe('memory provider telemetry confidentiality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PINECONE_API_KEY = 'SYNTHETIC_PRIVATE_API_KEY_MARKER';
    vi.mocked(Pinecone).mockImplementation(function (
      this: Record<string, unknown>,
    ) {
      this.index = vi.fn().mockReturnValue({
        searchRecords: mocks.searchRecords,
        upsertRecords: mocks.upsertRecords,
      });
      this.inference = { rerank: mocks.rerank };
      this.listIndexes = mocks.listIndexes;
    } as unknown as () => InstanceType<typeof Pinecone>);
  });

  afterEach(() => {
    delete process.env.PINECONE_API_KEY;
  });

  it('keeps provider logs and breaker alerts content-free', async () => {
    const memory = new PineconeMemory();

    mocks.upsertRecords.mockResolvedValueOnce(undefined);
    await memory.upsert([privateRecord()]);

    mocks.searchRecords.mockRejectedValue(
      Object.assign(
        new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR_MARKER'),
        {
          cause: {
            code: 'ENOTFOUND',
            detail: 'SYNTHETIC_PRIVATE_NESTED_CAUSE_MARKER',
          },
        },
      ),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await memory.searchDetailed(
        'SYNTHETIC_PRIVATE_QUERY_MARKER',
        {
          chat_jid: { $eq: 'SYNTHETIC_PRIVATE_FILTER_MARKER' },
        },
        5,
      );
    }
    const failedSearchCalls = [...mocks.searchRecords.mock.calls];

    mocks.searchRecords.mockReset();
    mocks.searchRecords.mockResolvedValueOnce({
      result: {
        hits: [
          {
            _id: 'SYNTHETIC_PRIVATE_ENTITY_ID_MARKER',
            _score: 0.9,
            fields: {
              text: 'SYNTHETIC_PRIVATE_ENTITY_TEXT_MARKER',
              entity_type: 'building',
              source: 'synthetic',
            },
          },
        ],
      },
    });
    mocks.rerank.mockRejectedValueOnce(
      new Error('SYNTHETIC_PRIVATE_RERANK_ERROR_MARKER'),
    );
    await memory.searchEntitiesDetailed(
      'SYNTHETIC_PRIVATE_QUERY_MARKER',
      'SYNTHETIC_PRIVATE_TRACE_MARKER',
    );

    mocks.listIndexes.mockRejectedValueOnce(
      Object.assign(
        new Error('SYNTHETIC_PRIVATE_READINESS_ERROR_MARKER'),
        { cause: { code: 'ECONNREFUSED' } },
      ),
    );
    await getPineconeReadiness('SYNTHETIC_PRIVATE_INDEX_MARKER');

    const mutablePineconeConfig = configModule.config.memory.pinecone as {
      expectedHostSuffix?: string;
      projectId?: string;
    };
    mutablePineconeConfig.projectId = 'SYNTHETIC_PRIVATE_PROJECT_MARKER';
    mutablePineconeConfig.expectedHostSuffix =
      '.SYNTHETIC_PRIVATE_HOST_MARKER';
    mocks.listIndexes.mockResolvedValueOnce({
      indexes: [
        {
          name: 'SYNTHETIC_PRIVATE_INDEX_MARKER',
          host: 'index-SYNTHETIC_PRIVATE_PROJECT_MARKER.SYNTHETIC_PRIVATE_HOST_MARKER',
        },
      ],
    });
    await getPineconeReadiness('SYNTHETIC_PRIVATE_INDEX_MARKER');

    const serializedObservation = JSON.stringify({
      alerts: mocks.emitAlert.mock.calls,
      logs: {
        debug: mocks.logger.debug.mock.calls,
        error: mocks.logger.error.mock.calls,
        info: mocks.logger.info.mock.calls,
        warn: mocks.logger.warn.mock.calls,
      },
    });
    const events = [
      ...mocks.logger.debug.mock.calls,
      ...mocks.logger.error.mock.calls,
      ...mocks.logger.info.mock.calls,
      ...mocks.logger.warn.mock.calls,
    ]
      .map((call) => call[0])
      .filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' &&
          value !== null &&
          value.schema === 'whatsoup-memory-operation-v1',
      );

    for (const marker of PRIVATE_MARKERS) {
      expect(serializedObservation).not.toContain(marker);
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: 'whatsoup-memory-operation-v1',
          operation: 'search',
          status: 'failed',
          failure_code: 'network_error',
          retryable: true,
          attempt: 2,
          result_count: 0,
          scope_kind: 'chat',
          filter_shape: 'chat_eq',
        }),
      ]),
    );
    expect(mocks.emitAlert).toHaveBeenCalledWith(
      'q',
      'pinecone_degraded',
      'Pinecone search circuit breaker tripped',
      expect.stringMatching(
        /^operation=search operation_id=[a-f0-9]{32} failure_code=network_error retryable=true attempt=2$/,
      ),
    );

    expect(mocks.upsertRecords.mock.calls[0][0]).toEqual({
      records: [
        expect.objectContaining({
          _id: 'SYNTHETIC_PRIVATE_RECORD_ID_MARKER',
          text: 'SYNTHETIC_PRIVATE_RECORD_TEXT_MARKER',
        }),
      ],
    });
    expect(failedSearchCalls[0][0]).toEqual({
      query: {
        topK: 5,
        inputs: { text: 'SYNTHETIC_PRIVATE_QUERY_MARKER' },
        filter: {
          chat_jid: { $eq: 'SYNTHETIC_PRIVATE_FILTER_MARKER' },
        },
      },
      fields: ['*'],
    });
    expect(mocks.searchRecords.mock.calls[0][0]).toEqual({
      query: {
        topK: 10,
        inputs: { text: 'SYNTHETIC_PRIVATE_QUERY_MARKER' },
        filter: { source: { $ne: 'archive_db' } },
      },
      fields: ['*'],
    });
  });
});
