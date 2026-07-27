import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearAlert: vi.fn(),
  emitAlert: vi.fn(),
  listIndexes: vi.fn(),
  loggers: new Map<
    string,
    {
      debug: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    }
  >(),
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
    pineconeIndex: 'SYNTHETIC_PRIVATE_BOOTSTRAP_INDEX_MARKER',
    pineconeContextTopK: 10,
    pineconeSenderTopK: 5,
    pineconeSelfFactTopK: 3,
    pineconeTopK: 10,
    pineconeRerank: false,
    pineconeRerankTopN: 5,
    pineconeSearchMode: 'memory',
    enrichmentDedupThreshold: 0.95,
    recencyHalfLifeDays: 36_500,
    maxAgeDays: 36_500,
    memory: {
      pinecone: {
        apiKeyEnv: 'PINECONE_API_KEY',
        namespaces: {
          facts: 'SYNTHETIC_PRIVATE_FACT_NAMESPACE_MARKER',
          chunks: 'SYNTHETIC_PRIVATE_CHUNK_NAMESPACE_MARKER',
          summaries: 'SYNTHETIC_PRIVATE_SUMMARY_NAMESPACE_MARKER',
        },
      },
    },
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: (component: string) => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    mocks.loggers.set(component, logger);
    return logger;
  },
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
  buildMemoryReadinessLogFields,
} from '../../../../src/lib/memory-operation-telemetry.ts';
import {
  registerMemoryWriteTools,
} from '../../../../src/mcp/tools/memory-write.ts';
import type {
  SessionContext,
  ToolDeclaration,
} from '../../../../src/mcp/types.ts';
import { loadContext } from '../../../../src/runtimes/chat/context.ts';
import {
  getPineconeReadiness,
  PineconeMemory,
} from '../../../../src/runtimes/chat/providers/pinecone.ts';

const PRIVATE_MARKERS = [
  'SYNTHETIC_PRIVATE_API_KEY_MARKER',
  'SYNTHETIC_PRIVATE_BOOTSTRAP_INDEX_MARKER',
  'SYNTHETIC_PRIVATE_CHAT_MARKER',
  'SYNTHETIC_PRIVATE_SENDER_MARKER',
  'SYNTHETIC_PRIVATE_QUERY_MARKER',
  'SYNTHETIC_PRIVATE_RESULT_ID_MARKER',
  'SYNTHETIC_PRIVATE_RESULT_TEXT_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_TEXT_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_CLAIM_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_EVIDENCE_MARKER',
  'SYNTHETIC_PRIVATE_PROVIDER_ERROR_MARKER',
  'SYNTHETIC_PRIVATE_NESTED_CAUSE_MARKER',
  'SYNTHETIC_PRIVATE_TRACE_MARKER',
  'SYNTHETIC_PRIVATE_FACT_NAMESPACE_MARKER',
  'SYNTHETIC_PRIVATE_CHUNK_NAMESPACE_MARKER',
  'SYNTHETIC_PRIVATE_SUMMARY_NAMESPACE_MARKER',
] as const;

const privateSession: SessionContext = {
  tier: 'chat-scoped',
  conversationKey: 'SYNTHETIC_PRIVATE_CHAT_MARKER',
  deliveryJid: 'SYNTHETIC_PRIVATE_CHAT_MARKER',
  actorJid: 'SYNTHETIC_PRIVATE_SENDER_MARKER',
};

function registerTool(memory: PineconeMemory): ToolDeclaration {
  const tools: ToolDeclaration[] = [];
  registerMemoryWriteTools((tool) => tools.push(tool), () => memory);
  return tools.find((tool) => tool.name === 'memory_write')!;
}

function allLogCalls() {
  return [...mocks.loggers.entries()].map(([component, logger]) => ({
    component,
    debug: logger.debug.mock.calls,
    error: logger.error.mock.calls,
    info: logger.info.mock.calls,
    warn: logger.warn.mock.calls,
  }));
}

describe('memory telemetry cross-surface confidentiality', () => {
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

  it('keeps tool, provider, context, alert, and bootstrap observations content-free', async () => {
    const memory = new PineconeMemory();

    mocks.upsertRecords.mockResolvedValueOnce(undefined);
    const toolResponse = await registerTool(memory).handler(
      {
        chatJid: 'SYNTHETIC_PRIVATE_CHAT_MARKER',
        text: 'SYNTHETIC_PRIVATE_TOOL_TEXT_MARKER',
        memory_type: 'preference',
        claim: 'SYNTHETIC_PRIVATE_TOOL_CLAIM_MARKER',
        evidence: 'SYNTHETIC_PRIVATE_TOOL_EVIDENCE_MARKER',
      },
      privateSession,
    );

    mocks.searchRecords.mockResolvedValue({
      result: {
        hits: [
          {
            _id: 'SYNTHETIC_PRIVATE_RESULT_ID_MARKER',
            _score: 0.91,
            fields: {
              text: 'SYNTHETIC_PRIVATE_RESULT_TEXT_MARKER',
              chat_jid: 'SYNTHETIC_PRIVATE_CHAT_MARKER',
              sender_jid: 'SYNTHETIC_PRIVATE_SENDER_MARKER',
              memory_type: 'preference',
              confidence: 0.91,
              created_at: '2026-07-27T00:00:00.000Z',
              updated_at: '2026-07-27T00:00:00.000Z',
              superseded: 'false',
              source_message_pks: '',
            },
          },
        ],
      },
    });
    await loadContext(
      memory,
      'SYNTHETIC_PRIVATE_CHAT_MARKER',
      'SYNTHETIC_PRIVATE_SENDER_MARKER',
      'SYNTHETIC_PRIVATE_QUERY_MARKER',
      'SYNTHETIC_PRIVATE_TRACE_MARKER',
    );
    const successfulSearchCalls = [...mocks.searchRecords.mock.calls];

    mocks.searchRecords.mockReset();
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
          chat_jid: { $eq: 'SYNTHETIC_PRIVATE_CHAT_MARKER' },
        },
        5,
        'SYNTHETIC_PRIVATE_TRACE_MARKER',
      );
    }

    mocks.listIndexes.mockRejectedValueOnce(
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
    const readiness = await getPineconeReadiness(
      'SYNTHETIC_PRIVATE_BOOTSTRAP_INDEX_MARKER',
    );
    const bootstrapFields = buildMemoryReadinessLogFields(readiness.state);

    const observation = {
      alerts: mocks.emitAlert.mock.calls,
      bootstrapFields,
      logs: allLogCalls(),
      toolResponse,
    };
    const serializedObservation = JSON.stringify(observation);

    for (const marker of PRIVATE_MARKERS) {
      expect(serializedObservation).not.toContain(marker);
    }

    expect(toolResponse).toEqual({
      operation_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      status: 'written',
      memory_type: 'preference',
    });
    const operationId = (toolResponse as { operation_id: string }).operation_id;
    const providerLogger = mocks.loggers.get('pinecone-provider')!;
    const providerEvents = [
      ...providerLogger.debug.mock.calls,
      ...providerLogger.error.mock.calls,
      ...providerLogger.info.mock.calls,
      ...providerLogger.warn.mock.calls,
    ].map((call) => call[0]);
    expect(providerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: 'whatsoup-memory-operation-v1',
          operation_id: operationId,
          operation: 'memory_write',
          stage: 'write',
          status: 'completed',
          failure_code: 'none',
        }),
      ]),
    );
    expect(mocks.loggers.get('conversation')?.info).toHaveBeenCalledWith(
      {
        query_intent: 'hybrid',
        routed_namespace_count: 3,
        scope_coverage: ['chat', 'sender', 'self'],
        result_count: 1,
        score_buckets: { high: 1, medium: 0, low: 0 },
      },
      'context retrieval complete',
    );
    expect(bootstrapFields).toEqual({
      pineconeReadiness: 'network_error',
    });
    expect(mocks.emitAlert).toHaveBeenCalledWith(
      'q',
      'pinecone_degraded',
      'Pinecone search circuit breaker tripped',
      expect.stringMatching(
        /^operation=search operation_id=[a-f0-9]{32} failure_code=network_error retryable=true attempt=2$/,
      ),
    );

    expect(mocks.upsertRecords.mock.calls[0]?.[0]).toEqual({
      records: [
        expect.objectContaining({
          text: 'SYNTHETIC_PRIVATE_TOOL_TEXT_MARKER',
          chat_jid: 'SYNTHETIC_PRIVATE_CHAT_MARKER',
          sender_jid: 'SYNTHETIC_PRIVATE_SENDER_MARKER',
          claim: 'SYNTHETIC_PRIVATE_TOOL_CLAIM_MARKER',
          evidence: 'SYNTHETIC_PRIVATE_TOOL_EVIDENCE_MARKER',
        }),
      ],
    });
    expect(successfulSearchCalls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            query: expect.objectContaining({
              inputs: {
                text: 'SYNTHETIC_PRIVATE_QUERY_MARKER',
              },
            }),
          }),
        ],
      ]),
    );
  });
});
