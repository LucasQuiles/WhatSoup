import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListIndexes = vi.fn();
const mockReadinessLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@pinecone-database/pinecone', () => {
  const MockPinecone = vi.fn();
  return { Pinecone: MockPinecone };
});

vi.mock('../../../../src/config.ts', () => ({
  config: {
    pineconeIndex: 'mw-mind',
    pineconeContextTopK: 10,
    pineconeSenderTopK: 5,
    enrichmentDedupThreshold: 0.95,
    memory: {
      pinecone: {
        apiKeyEnv: 'PINECONE_API_KEY',
      },
    },
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => mockReadinessLogger,
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { Pinecone } from '@pinecone-database/pinecone';
import * as configModule from '../../../../src/config.ts';
import { getPineconeReadiness } from '../../../../src/runtimes/chat/providers/pinecone.ts';

describe('getPineconeReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PINECONE_API_KEY;
    vi.mocked(Pinecone).mockReset();
    delete (configModule.config as any).botName;
    delete (configModule.config as any).memory.pinecone.projectId;
    delete (configModule.config as any).memory.pinecone.expectedHostSuffix;
  });

  it('returns disabled when no api key is configured', async () => {
    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'disabled',
      index: 'mw-mind',
    });
  });

  it('returns disabled when the configured index name is empty', async () => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
    await expect(getPineconeReadiness('')).resolves.toEqual({
      state: 'disabled',
      index: '',
    });
  });

  it('returns ready when the configured index exists', async () => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
    vi.mocked(Pinecone).mockImplementation(function (this: Record<string, unknown>) {
      this.listIndexes = mockListIndexes;
    } as unknown as () => Pinecone);
    mockListIndexes.mockResolvedValueOnce({ indexes: [{ name: 'mw-mind' }] });

    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'ready',
      index: 'mw-mind',
    });
  });

  it('returns project_mismatch when the configured project guard does not match the index host', async () => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
    vi.mocked(Pinecone).mockImplementation(function (this: Record<string, unknown>) {
      this.listIndexes = mockListIndexes;
    } as unknown as () => Pinecone);
    (configModule.config as any).memory.pinecone.projectId = 'nf9hzvy';
    mockListIndexes.mockResolvedValueOnce({
      indexes: [{ name: 'mw-mind', host: 'mw-mind-o6fsxb8.svc.aped-4627-b74a.pinecone.io' }],
    });

    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'project_mismatch',
      index: 'mw-mind',
    });
  });

  it('returns project_mismatch for non-q instances with Pinecone enabled and no project guard', async () => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
    (configModule.config as any).botName = 'mini3';

    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'project_mismatch',
      index: 'mw-mind',
    });
    expect(Pinecone).not.toHaveBeenCalled();
  });

  it('returns index_missing when auth works but the configured index is absent', async () => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
    vi.mocked(Pinecone).mockImplementation(function (this: Record<string, unknown>) {
      this.listIndexes = mockListIndexes;
    } as unknown as () => Pinecone);
    mockListIndexes.mockResolvedValueOnce({ indexes: [{ name: 'other-index' }] });

    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'index_missing',
      index: 'mw-mind',
    });
  });

  it('returns auth_failed when listing indexes throws with 401', async () => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
    vi.mocked(Pinecone).mockImplementation(function (this: Record<string, unknown>) {
      this.listIndexes = mockListIndexes;
    } as unknown as () => Pinecone);
    mockListIndexes.mockRejectedValueOnce(
      Object.assign(new Error('SYNTHETIC_PRIVATE_AUTH_ERROR_MARKER'), {
        status: 401,
      }),
    );

    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'auth_failed',
      index: 'mw-mind',
    });
    expect(mockReadinessLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'readiness',
        failure_code: 'auth_failed',
        retryable: false,
      }),
      'memory_operation',
    );
    expect(JSON.stringify(mockReadinessLogger.error.mock.calls)).not.toContain(
      'SYNTHETIC_PRIVATE_AUTH_ERROR_MARKER',
    );
  });

  it('returns network_error when listing indexes fails due to connectivity', async () => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
    vi.mocked(Pinecone).mockImplementation(function (this: Record<string, unknown>) {
      this.listIndexes = mockListIndexes;
    } as unknown as () => Pinecone);
    mockListIndexes.mockRejectedValueOnce(
      Object.assign(new Error('SYNTHETIC_PRIVATE_NETWORK_ERROR_MARKER'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );

    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'network_error',
      index: 'mw-mind',
    });
    expect(mockReadinessLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'readiness',
        failure_code: 'network_error',
        retryable: true,
      }),
      'memory_operation',
    );
    expect(JSON.stringify(mockReadinessLogger.error.mock.calls)).not.toContain(
      'SYNTHETIC_PRIVATE_NETWORK_ERROR_MARKER',
    );
  });
});
