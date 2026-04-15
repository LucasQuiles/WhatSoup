import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListIndexes = vi.fn();

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
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { Pinecone } from '@pinecone-database/pinecone';
import { getPineconeReadiness } from '../../../../src/runtimes/chat/providers/pinecone.ts';

describe('getPineconeReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PINECONE_API_KEY;
  });

  it('returns disabled when no api key is configured', async () => {
    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'disabled',
      index: 'mw-mind',
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

  it('returns auth_failed when listing indexes throws', async () => {
    process.env.PINECONE_API_KEY = 'pcsk-test';
    vi.mocked(Pinecone).mockImplementation(function (this: Record<string, unknown>) {
      this.listIndexes = mockListIndexes;
    } as unknown as () => Pinecone);
    mockListIndexes.mockRejectedValueOnce(new Error('401 unauthorized'));

    await expect(getPineconeReadiness('mw-mind')).resolves.toEqual({
      state: 'auth_failed',
      index: 'mw-mind',
    });
  });
});
