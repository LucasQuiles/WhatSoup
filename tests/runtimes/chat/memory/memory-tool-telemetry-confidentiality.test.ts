import { describe, expect, it, vi } from 'vitest';

const mockToolLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => mockToolLogger,
}));

import {
  registerMemoryWriteTools,
  type MemoryWriter,
} from '../../../../src/mcp/tools/memory-write.ts';
import type {
  SessionContext,
  ToolDeclaration,
} from '../../../../src/mcp/types.ts';

const PRIVATE_MARKERS = [
  'SYNTHETIC_PRIVATE_TOOL_CHAT_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_SENDER_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_TEXT_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_CLAIM_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_EVIDENCE_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_WARRANT_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_CONTRADICTS_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_PROVIDER_ERROR_MARKER',
  'SYNTHETIC_PRIVATE_TOOL_NESTED_CAUSE_MARKER',
] as const;

function registerTool(writer: MemoryWriter): ToolDeclaration {
  const tools: ToolDeclaration[] = [];
  registerMemoryWriteTools((tool) => tools.push(tool), () => writer);
  return tools.find((tool) => tool.name === 'memory_write')!;
}

const privateSession: SessionContext = {
  tier: 'chat-scoped',
  conversationKey: 'SYNTHETIC_PRIVATE_TOOL_CHAT_MARKER',
  deliveryJid: 'SYNTHETIC_PRIVATE_TOOL_CHAT_MARKER',
  actorJid: 'SYNTHETIC_PRIVATE_TOOL_SENDER_MARKER',
};

const privateParams = {
  chatJid: 'SYNTHETIC_PRIVATE_TOOL_CHAT_MARKER',
  text: 'SYNTHETIC_PRIVATE_TOOL_TEXT_MARKER',
  memory_type: 'preference',
  claim: 'SYNTHETIC_PRIVATE_TOOL_CLAIM_MARKER',
  evidence: 'SYNTHETIC_PRIVATE_TOOL_EVIDENCE_MARKER',
  warrant: 'SYNTHETIC_PRIVATE_TOOL_WARRANT_MARKER',
  contradicts: 'SYNTHETIC_PRIVATE_TOOL_CONTRADICTS_MARKER',
};

describe('memory tool telemetry confidentiality', () => {
  it('returns only opaque operation evidence and stable failures', async () => {
    vi.clearAllMocks();
    const successUpsert = vi.fn().mockResolvedValue(undefined);
    const success = await registerTool({
      upsert: successUpsert,
    }).handler(privateParams, privateSession);

    const failureUpsert = vi.fn().mockRejectedValue(
      Object.assign(
        new Error('SYNTHETIC_PRIVATE_TOOL_PROVIDER_ERROR_MARKER'),
        {
          code: 'PINECONE_UNAVAILABLE',
          cause: {
            detail: 'SYNTHETIC_PRIVATE_TOOL_NESTED_CAUSE_MARKER',
          },
        },
      ),
    );
    const failure = await registerTool({
      upsert: failureUpsert,
    }).handler(privateParams, privateSession);

    expect(success).toEqual({
      operation_id: expect.stringMatching(/^[a-f0-9]{32}$/),
      status: 'written',
      memory_type: 'preference',
    });
    expect(success).not.toHaveProperty('id');
    expect(failure).toMatchObject({
      error: 'memory_write failed',
      code: 'provider_unavailable',
      retryable: true,
      operation_id: expect.stringMatching(/^[a-f0-9]{32}$/),
    });

    const successOperationId = (success as { operation_id: string })
      .operation_id;
    const failureOperationId = (failure as { operation_id: string })
      .operation_id;
    expect(successUpsert.mock.calls[0]?.[1]).toEqual({
      operationId: successOperationId,
      operation: 'memory_write',
    });
    expect(failureUpsert.mock.calls[0]?.[1]).toEqual({
      operationId: failureOperationId,
      operation: 'memory_write',
    });

    const serializedObservation = JSON.stringify({
      failure,
      logs: {
        debug: mockToolLogger.debug.mock.calls,
        error: mockToolLogger.error.mock.calls,
        info: mockToolLogger.info.mock.calls,
        warn: mockToolLogger.warn.mock.calls,
      },
      success,
    });
    for (const marker of PRIVATE_MARKERS) {
      expect(serializedObservation).not.toContain(marker);
    }
  });
});
