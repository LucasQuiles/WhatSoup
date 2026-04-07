import { beforeEach, describe, expect, it } from 'vitest';
import * as groupResolverModule from '../../src/fleet/group-resolver.ts';

describe('group resolver attemptedCache eviction', () => {
  beforeEach(() => {
    (groupResolverModule as any).__resetAttemptedCacheForTests();
  });

  it('prunes expired attemptedCache entries while retaining unexpired ones', () => {
    const groupResolverAny = groupResolverModule as any;
    const now = (10 * 60 * 1000) + (5 * 60 * 1000);

    groupResolverAny.__setAttemptedCacheEntryForTests('stale', 0);
    groupResolverAny.__setAttemptedCacheEntryForTests('fresh', now - (5 * 60 * 1000) + 1);

    groupResolverAny.__pruneAttemptedCacheForTests(now);

    expect(groupResolverAny.__getAttemptedCacheKeysForTests()).toEqual(['fresh']);
  });
});
