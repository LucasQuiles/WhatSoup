import { describe, expect, it, vi } from 'vitest';

import {
  findPineconeIndex,
  hasPineconeProjectGuard,
  matchesPineconeProjectGuard,
  pineconeIndexesFromListResult,
  pineconeProjectGuardError,
} from '../../src/lib/pinecone-project-guard.ts';

describe('pinecone project guard helpers', () => {
  it('treats missing guard as unrestricted', () => {
    expect(hasPineconeProjectGuard({})).toBe(false);
    expect(matchesPineconeProjectGuard(undefined, {})).toBe(true);
  });

  it('requires every configured host guard to match', () => {
    const guard = {
      projectId: 'proj123',
      expectedHostSuffix: '.svc.us-east-1-aws.pinecone.io',
    };

    expect(matchesPineconeProjectGuard('index-proj123.svc.us-east-1-aws.pinecone.io', guard)).toBe(true);
    expect(matchesPineconeProjectGuard('index-other.svc.us-east-1-aws.pinecone.io', guard)).toBe(false);
    expect(matchesPineconeProjectGuard('index-proj123.svc.us-west-2-aws.pinecone.io', guard)).toBe(false);
    expect(matchesPineconeProjectGuard(undefined, guard)).toBe(false);
  });

  it('normalizes malformed listIndexes results to an empty list', () => {
    expect(pineconeIndexesFromListResult(null)).toEqual([]);
    expect(pineconeIndexesFromListResult({ indexes: 'bad' })).toEqual([]);
    expect(findPineconeIndex({ indexes: [{ name: 'target', host: 'host' }] }, 'target')).toEqual({
      name: 'target',
      host: 'host',
    });
  });

  it('does not list indexes when no guard is configured', async () => {
    const client = { listIndexes: vi.fn() };

    await expect(pineconeProjectGuardError(client, 'target', {}, {
      missingIndex: () => 'missing',
      projectMismatch: () => 'mismatch',
    })).resolves.toBeNull();
    expect(client.listIndexes).not.toHaveBeenCalled();
  });

  it('uses caller-owned messages for missing and mismatched indexes', async () => {
    await expect(pineconeProjectGuardError({
      listIndexes: vi.fn().mockResolvedValue({ indexes: [] }),
    }, 'target', { expectedHostSuffix: '.ok' }, {
      missingIndex: (indexName) => `missing ${indexName}`,
      projectMismatch: (indexName) => `mismatch ${indexName}`,
    })).resolves.toBe('missing target');

    await expect(pineconeProjectGuardError({
      listIndexes: vi.fn().mockResolvedValue({ indexes: [{ name: 'target', host: 'target.bad' }] }),
    }, 'target', { expectedHostSuffix: '.ok' }, {
      missingIndex: (indexName) => `missing ${indexName}`,
      projectMismatch: (indexName) => `mismatch ${indexName}`,
    })).resolves.toBe('mismatch target');
  });

  it('returns null when the index exists and matches the configured guard', async () => {
    const client = {
      listIndexes: vi.fn().mockResolvedValue({
        indexes: [{ name: 'target', host: 'index-proj123.svc.us-east-1-aws.pinecone.io' }],
      }),
    };
    await expect(pineconeProjectGuardError(client, 'target', {
      projectId: 'proj123',
      expectedHostSuffix: '.svc.us-east-1-aws.pinecone.io',
    }, {
      missingIndex: (indexName) => `missing ${indexName}`,
      projectMismatch: (indexName) => `mismatch ${indexName}`,
    })).resolves.toBeNull();
    expect(client.listIndexes).toHaveBeenCalledOnce();
  });
});
