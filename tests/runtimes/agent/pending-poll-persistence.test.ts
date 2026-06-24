import { describe, expect, it } from 'vitest';

import type { Database } from '../../../src/core/database.ts';
import { PendingPollPersistence } from '../../../src/runtimes/agent/pending-poll-persistence.ts';

describe('PendingPollPersistence', () => {
  it('increments errors when loadRows cannot read pending_polls', () => {
    const db = {
      raw: {
        prepare: () => {
          throw new Error('select failed');
        },
      },
    } as unknown as Database;

    const persistence = new PendingPollPersistence(db);

    expect(persistence.loadRows()).toEqual([]);
    expect(persistence.errors).toBe(1);
  });
});
