import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Shared logger mock (ratchet-sanctioned helper); config supplies the
// default namespace the queue module reads at enqueue time.
vi.mock('../../../../src/logger.ts', async () => (await import('../../../helpers/logger-mock.ts')).loggerMock());

vi.mock('../../../../src/config.ts', () => ({
  config: {
    memory: {
      pinecone: {
        namespaces: {
          facts: 'whatsapp-facts',
        },
      },
    },
  },
}));

import { Database } from '../../../../src/core/database.ts';
import {
  enqueueFacts,
  leasePendingFacts,
  ackFacts,
  reconcileExpiredLeases,
  shortHash,
  type ExportableFact,
} from '../../../../src/runtimes/chat/enrichment/fact-export-queue.ts';

function makeFact(overrides?: Partial<ExportableFact>): ExportableFact {
  return {
    factId: 'SECRET-CHAT@g.us:SECRET-SENDER@s.whatsapp.net:abc123def456',
    chatJid: 'SECRET-CHAT@g.us',
    senderJid: 'SECRET-SENDER@s.whatsapp.net',
    text: 'SECRET fact text lives here',
    memoryType: 'user_fact',
    confidence: 0.9,
    senderName: 'SECRET Name',
    supersedesText: '',
    sourceMessagePks: [1, 2],
    ...overrides,
  };
}

describe('fact export lease lifecycle (#2567 slice 1)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  function seedOne(): string {
    const result = enqueueFacts(db, [makeFact()]);
    expect(result.inserted).toBe(1);
    const row = db.raw
      .prepare('SELECT fact_uid FROM fact_export_queue LIMIT 1')
      .get() as { fact_uid: string };
    return row.fact_uid;
  }

  it('F1: two claimers cannot both receive the same active lease', () => {
    seedOne();
    const a = leasePendingFacts(db, { owner: 'worker-a', limit: 10, leaseSeconds: 300, nowUnixSec: 1000 });
    const b = leasePendingFacts(db, { owner: 'worker-b', limit: 10, leaseSeconds: 300, nowUnixSec: 1001 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('F2: expired lease reconciles to retry_wait with backoff, then re-leases with incremented attempt', () => {
    seedOne();
    const a = leasePendingFacts(db, { owner: 'worker-a', limit: 10, leaseSeconds: 10, nowUnixSec: 1000 });
    expect(a).toHaveLength(1);
    expect(a[0].attemptCount).toBe(1);

    // Not yet expired: reconcile is a no-op and the row stays leased.
    const early = reconcileExpiredLeases(db, { nowUnixSec: 1005 });
    expect(early.expired).toBe(0);

    const late = reconcileExpiredLeases(db, { nowUnixSec: 1011, backoffBaseSeconds: 60 });
    expect(late.expired).toBe(1);
    const row = db.raw
      .prepare('SELECT state, next_attempt_at, lease_owner FROM fact_export_queue')
      .get() as { state: string; next_attempt_at: number; lease_owner: string | null };
    expect(row.state).toBe('retry_wait');
    expect(row.lease_owner).toBeNull();
    expect(row.next_attempt_at).toBeGreaterThan(1011);

    // Before the backoff elapses the row is not leasable.
    const tooSoon = leasePendingFacts(db, { owner: 'worker-b', limit: 10, leaseSeconds: 300, nowUnixSec: 1012 });
    expect(tooSoon).toHaveLength(0);

    const again = leasePendingFacts(db, {
      owner: 'worker-b', limit: 10, leaseSeconds: 300, nowUnixSec: row.next_attempt_at + 1,
    });
    expect(again).toHaveLength(1);
    expect(again[0].attemptCount).toBe(2);
  });

  it('F3: acknowledgement from a stale owner returns lease_lost and does not disturb the new lease', () => {
    const uid = seedOne();
    leasePendingFacts(db, { owner: 'worker-a', limit: 10, leaseSeconds: 10, nowUnixSec: 1000 });
    reconcileExpiredLeases(db, { nowUnixSec: 1011, backoffBaseSeconds: 0 });
    const b = leasePendingFacts(db, { owner: 'worker-b', limit: 10, leaseSeconds: 300, nowUnixSec: 1012 });
    expect(b).toHaveLength(1);

    const acks = ackFacts(db, {
      owner: 'worker-a',
      acks: [{ factUid: uid, outcome: 'exported' }],
      nowUnixSec: 1013,
    });
    expect(acks).toEqual([{ factUid: uid, result: 'lease_lost' }]);
    const row = db.raw
      .prepare('SELECT state, lease_owner FROM fact_export_queue')
      .get() as { state: string; lease_owner: string | null };
    expect(row.state).toBe('leased');
    expect(row.lease_owner).toBe('worker-b');
  });

  it('F4: unknown and already-terminal acknowledgements return explicit per-ID outcomes', () => {
    const uid = seedOne();
    leasePendingFacts(db, { owner: 'worker-a', limit: 10, leaseSeconds: 300, nowUnixSec: 1000 });
    const first = ackFacts(db, {
      owner: 'worker-a',
      acks: [
        { factUid: uid, outcome: 'exported', remoteRecordId: 'remote-1' },
        { factUid: 'fe_does_not_exist_000000', outcome: 'exported' },
      ],
      nowUnixSec: 1001,
    });
    expect(first).toEqual([
      { factUid: uid, result: 'acknowledged' },
      { factUid: 'fe_does_not_exist_000000', result: 'unknown' },
    ]);

    const second = ackFacts(db, {
      owner: 'worker-a',
      acks: [{ factUid: uid, outcome: 'exported' }],
      nowUnixSec: 1002,
    });
    expect(second).toEqual([{ factUid: uid, result: 'already_terminal' }]);

    const row = db.raw
      .prepare('SELECT state, remote_record_id FROM fact_export_queue')
      .get() as { state: string; remote_record_id: string | null };
    expect(row.state).toBe('exported');
    expect(row.remote_record_id).toBe('remote-1');
  });

  it('F5: retry exhaustion is terminal — the row is never re-leased', () => {
    const uid = seedOne();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const leased = leasePendingFacts(db, {
        owner: 'worker-a', limit: 10, leaseSeconds: 300, nowUnixSec: 1000 * attempt,
      });
      expect(leased).toHaveLength(1);
      ackFacts(db, {
        owner: 'worker-a',
        acks: [{ factUid: uid, outcome: 'failed', failureCode: 'remote_unavailable', retryable: true }],
        nowUnixSec: 1000 * attempt + 1,
        maxAttempts: 2,
        backoffBaseSeconds: 0,
      });
    }
    const row = db.raw
      .prepare('SELECT state, failure_code FROM fact_export_queue')
      .get() as { state: string; failure_code: string | null };
    expect(row.state).toBe('retry_exhausted');
    expect(row.failure_code).toBe('remote_unavailable');

    const after = leasePendingFacts(db, { owner: 'worker-b', limit: 10, leaseSeconds: 300, nowUnixSec: 99999 });
    expect(after).toHaveLength(0);

    const ack = ackFacts(db, {
      owner: 'worker-b',
      acks: [{ factUid: uid, outcome: 'exported' }],
      nowUnixSec: 99999,
    });
    expect(ack).toEqual([{ factUid: uid, result: 'already_terminal' }]);
  });

  it('F6: non-retryable failure is terminal with its failure code preserved', () => {
    const uid = seedOne();
    leasePendingFacts(db, { owner: 'worker-a', limit: 10, leaseSeconds: 300, nowUnixSec: 1000 });
    const acks = ackFacts(db, {
      owner: 'worker-a',
      acks: [{ factUid: uid, outcome: 'failed', failureCode: 'remote_rejected', retryable: false }],
      nowUnixSec: 1001,
    });
    expect(acks).toEqual([{ factUid: uid, result: 'acknowledged' }]);
    const row = db.raw
      .prepare('SELECT state, failure_code FROM fact_export_queue')
      .get() as { state: string; failure_code: string | null };
    expect(row.state).toBe('retry_exhausted');
    expect(row.failure_code).toBe('remote_rejected');
  });

  it('F7: fact_uid is opaque — no chat scope, sender scope, or content hash leaks; salt varies per database', () => {
    const uid = seedOne();
    expect(uid).toMatch(/^fe_[0-9a-f]{24}$/);
    expect(uid).not.toContain('SECRET');
    expect(uid).not.toContain('g.us');
    expect(uid).not.toContain('s.whatsapp.net');
    expect(uid).not.toContain(shortHash(makeFact().text));

    // The wire shape exposes only the opaque uid — never the legacy fact_id.
    const db2 = new Database(':memory:');
    db2.open();
    try {
      enqueueFacts(db2, [makeFact()]);
      const uid2 = (db2.raw
        .prepare('SELECT fact_uid FROM fact_export_queue LIMIT 1')
        .get() as { fact_uid: string }).fact_uid;
      expect(uid2).not.toBe(uid);
    } finally {
      db2.close();
    }

    const leased = leasePendingFacts(db, { owner: 'worker-a', limit: 10, leaseSeconds: 300, nowUnixSec: 1000 });
    expect(leased).toHaveLength(1);
    expect(leased[0].factUid).toBe(uid);
    expect('factId' in (leased[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('F8: invalid payload rows quarantine at lease time and do not occupy the wire batch', () => {
    seedOne();
    db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, sender_jid, namespace, payload_json)
         VALUES ('fe_corrupt0000000000000000', 'corrupt-row', 'SECRET-CHAT@g.us', NULL, 'whatsapp-facts', 'not-json')`,
      )
      .run();
    const leased = leasePendingFacts(db, { owner: 'worker-a', limit: 10, leaseSeconds: 300, nowUnixSec: 1000 });
    expect(leased).toHaveLength(1);
    const row = db.raw
      .prepare("SELECT state, failure_code FROM fact_export_queue WHERE fact_id = 'corrupt-row'")
      .get() as { state: string; failure_code: string | null };
    expect(row.state).toBe('quarantined');
    expect(row.failure_code).toBe('payload_invalid');
  });
});
