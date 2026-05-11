import { describe, expect, it } from 'vitest';

import { deferred } from './deferred.ts';

describe('deferred', () => {
  it('exposes a promise controlled by resolve', async () => {
    const pending = deferred<string>();

    pending.resolve('done');

    await expect(pending.promise).resolves.toBe('done');
  });

  it('exposes a promise controlled by reject', async () => {
    const pending = deferred<void>();
    const error = new Error('failed');

    pending.reject(error);

    await expect(pending.promise).rejects.toBe(error);
  });
});
