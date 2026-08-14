import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Logger mock ─────────────────────────────────────────────────────────────
// The enrichment module binds its own `log` at module-load time via
// createChildLogger(). To prove the quarantine path surfaces errors (T1
// I-1 hard-negative contract) we mock the logger module and share a
// stable spy for `.error` across all tests via vi.hoisted — mirroring
// the pattern used in tests/core/workspace-error-handling.test.ts.
const { mockLogError } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    debug: vi.fn(),
  }),
}));

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
  type ExportableFact,
} from '../../../../src/runtimes/chat/enrichment/fact-export-queue.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFact(overrides?: Partial<ExportableFact>): ExportableFact {
  return {
    factId: 'test-chat@s.whatsapp.net:15550100001@s.whatsapp.net:abc123def456',
    chatJid: 'test-chat@s.whatsapp.net',
    senderJid: '15550100001@s.whatsapp.net',
    text: 'Lives in London',
    memoryType: 'user_fact',
    confidence: 0.9,
    senderName: 'TestUser',
    supersedesText: '',
    sourceMessagePks: [1, 2],
    ...overrides,
  };
}

describe('fact_export_queue schema', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('fact_export_queue table exists', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fact_export_queue'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('fact_export_queue');
  });

  it('fact_export_queue has required columns', () => {
    const cols = db.raw.prepare("PRAGMA table_info('fact_export_queue')").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const colMap = new Map(cols.map((c) => [c.name, c]));

    expect(colMap.has('id')).toBe(true);
    expect(colMap.has('fact_uid')).toBe(true);
    expect(colMap.get('fact_uid')?.notnull).toBe(1);
    expect(colMap.has('fact_id')).toBe(true);
    expect(colMap.get('fact_id')?.notnull).toBe(1);
    expect(colMap.has('chat_jid')).toBe(true);
    expect(colMap.get('chat_jid')?.notnull).toBe(1);
    expect(colMap.has('sender_jid')).toBe(true);
    expect(colMap.has('namespace')).toBe(true);
    expect(colMap.has('payload_json')).toBe(true);
    expect(colMap.get('payload_json')?.notnull).toBe(1);
    expect(colMap.has('state')).toBe(true);
    expect(colMap.has('lease_owner')).toBe(true);
    expect(colMap.has('lease_expires_at')).toBe(true);
    expect(colMap.has('attempt_count')).toBe(true);
    expect(colMap.has('failure_code')).toBe(true);
    expect(colMap.has('failure_stage')).toBe(true);
    expect(colMap.has('next_attempt_at')).toBe(true);
    expect(colMap.has('remote_record_id')).toBe(true);
    expect(colMap.has('created_at')).toBe(true);
    expect(colMap.has('exported_at')).toBe(true);
    expect(colMap.has('acked_at')).toBe(true);
    expect(colMap.has('status')).toBe(false);
  });

  it('fact_id has UNIQUE constraint', () => {
    const indexes = db.raw.prepare("PRAGMA index_list('fact_export_queue')").all() as Array<{
      name: string;
      unique: number;
    }>;
    // Check that there's a unique index covering fact_id
    let hasUniqueFactId = false;
    for (const idx of indexes) {
      if (idx.unique === 1) {
        const cols = db.raw
          .prepare(`PRAGMA index_info('${idx.name}')`)
          .all() as Array<{ name: string }>;
        if (cols.length === 1 && cols[0].name === 'fact_id') {
          hasUniqueFactId = true;
        }
      }
    }
    expect(hasUniqueFactId).toBe(true);
  });

  it('namespace defaults to whatsapp-facts', () => {
    db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json) VALUES (?, ?, ?, ?)`,
      )
      .run('fe_test000000000000000001', 'f1', 'test-chat@s.whatsapp.net', '{}');
    const row = db.raw
      .prepare(`SELECT namespace FROM fact_export_queue WHERE fact_id = ?`)
      .get('f1') as { namespace: string };
    expect(row.namespace).toBe('whatsapp-facts');
  });

  it('state defaults to pending and rejects values outside the state machine', () => {
    db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json) VALUES (?, ?, ?, ?)`,
      )
      .run('fe_test000000000000000002', 'f2', 'test-chat@s.whatsapp.net', '{}');
    const row = db.raw
      .prepare(`SELECT state, attempt_count FROM fact_export_queue WHERE fact_id = ?`)
      .get('f2') as { state: string; attempt_count: number };
    expect(row.state).toBe('pending');
    expect(row.attempt_count).toBe(0);

    expect(() => db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('fe_test000000000000000003', 'f3', 'test-chat@s.whatsapp.net', '{}', 'in-flight'),
    ).toThrow(/CHECK/);
  });
});

describe('enqueueFacts', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a validated fact with a stable ID', () => {
    const fact = makeFact({ factId: 'stable-id-1' });
    const n = enqueueFacts(db, [fact]);
    expect(n.inserted).toBe(1);
    expect(n.attempted).toBe(1);

    const row = db.raw
      .prepare(`SELECT fact_id, fact_uid, chat_jid, sender_jid, namespace, state FROM fact_export_queue WHERE fact_id = ?`)
      .get('stable-id-1') as {
        fact_id: string;
        fact_uid: string;
        chat_jid: string;
        sender_jid: string | null;
        namespace: string;
        state: string;
      };
    expect(row.fact_id).toBe('stable-id-1');
    expect(row.fact_uid).toMatch(/^fe_[0-9a-f]{24}$/);
    expect(row.chat_jid).toBe('test-chat@s.whatsapp.net');
    expect(row.sender_jid).toBe('15550100001@s.whatsapp.net');
    expect(row.namespace).toBe('whatsapp-facts');
    expect(row.state).toBe('pending');
  });

  it('stores the full payload as JSON', () => {
    const fact = makeFact({
      factId: 'payload-test',
      text: 'Prefers morning meetings',
      memoryType: 'preference',
      confidence: 0.82,
      sourceMessagePks: [5, 6, 7],
      promotionReason: 'grounded in source',
      claim: 'User prefers morning meetings',
      evidence: 'said mornings are best',
      warrant: 'direct preference statement',
      confidenceQualifier: 'stated once',
      contradicts: 'old-fact',
    });
    enqueueFacts(db, [fact]);

    const row = db.raw
      .prepare(`SELECT payload_json FROM fact_export_queue WHERE fact_id = ?`)
      .get('payload-test') as { payload_json: string };
    const payload = JSON.parse(row.payload_json);
    expect(payload.text).toBe('Prefers morning meetings');
    expect(payload.memoryType).toBe('preference');
    expect(payload.confidence).toBe(0.82);
    expect(payload.sourceMessagePks).toEqual([5, 6, 7]);
    expect(payload.promotionReason).toBe('grounded in source');
    expect(payload.claim).toBe('User prefers morning meetings');
    expect(payload.evidence).toBe('said mornings are best');
    expect(payload.warrant).toBe('direct preference statement');
    expect(payload.confidenceQualifier).toBe('stated once');
    expect(payload.contradicts).toBe('old-fact');
  });

  it('is idempotent: enqueueing the same factId twice does not duplicate', () => {
    const fact = makeFact({ factId: 'dup-check' });
    const first = enqueueFacts(db, [fact]);
    const second = enqueueFacts(db, [fact]);
    expect(first.inserted).toBe(1);
    expect(first.duplicates).toBe(0);
    expect(second.inserted).toBe(0);
    // Second call is an idempotent duplicate, not a failure.
    expect(second.duplicates).toBe(1);
    expect(second.failed).toBe(0);

    const count = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM fact_export_queue WHERE fact_id = ?`)
      .get('dup-check') as { n: number };
    expect(count.n).toBe(1);
  });

  it('handles an empty array without error', () => {
    const n = enqueueFacts(db, []);
    expect(n.inserted).toBe(0);
    expect(n.attempted).toBe(0);
  });

  it('inserts multiple facts in a single call', () => {
    const facts = [
      makeFact({ factId: 'multi-1', text: 'Fact one' }),
      makeFact({ factId: 'multi-2', text: 'Fact two' }),
      makeFact({ factId: 'multi-3', text: 'Fact three' }),
    ];
    const n = enqueueFacts(db, facts);
    expect(n.inserted).toBe(3);
    expect(n.attempted).toBe(3);
    const count = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM fact_export_queue`)
      .get() as { n: number };
    expect(count.n).toBe(3);
  });

  it('accepts null senderJid (group-level fact)', () => {
    const fact = makeFact({ factId: 'group-fact', senderJid: null });
    enqueueFacts(db, [fact]);
    const row = db.raw
      .prepare(`SELECT fact_id, chat_jid, sender_jid, namespace, state FROM fact_export_queue WHERE fact_id = ?`)
      .get('group-fact') as {
        fact_id: string;
        chat_jid: string;
        sender_jid: string | null;
        namespace: string;
        state: string;
      };
    expect(row).toEqual({
      fact_id: 'group-fact',
      chat_jid: 'test-chat@s.whatsapp.net',
      sender_jid: null,
      namespace: 'whatsapp-facts',
      state: 'pending',
    });
  });
});

function uidOf(db: Database, factId: string): string {
  return (db.raw
    .prepare('SELECT fact_uid FROM fact_export_queue WHERE fact_id = ?')
    .get(factId) as { fact_uid: string }).fact_uid;
}

const LEASE = { owner: 'test-worker', limit: 10, leaseSeconds: 300, nowUnixSec: 1000 };

describe('leasePendingFacts', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('returns up to limit pending rows, ordered by id', () => {
    const facts = [
      makeFact({ factId: 'c-1' }),
      makeFact({ factId: 'c-2' }),
      makeFact({ factId: 'c-3' }),
      makeFact({ factId: 'c-4' }),
    ];
    enqueueFacts(db, facts);

    const leased = leasePendingFacts(db, { ...LEASE, limit: 2 });
    expect(leased).toHaveLength(2);
    expect(leased[0].factUid).toBe(uidOf(db, 'c-1'));
    expect(leased[1].factUid).toBe(uidOf(db, 'c-2'));
  });

  it('returns parsed payload fields for each leased row', () => {
    enqueueFacts(db, [makeFact({
      factId: 'parsed-1',
      text: 'Payload echo',
      memoryType: 'self_fact',
      confidence: 0.77,
      sourceMessagePks: [99],
    })]);

    const leased = leasePendingFacts(db, LEASE);
    expect(leased).toHaveLength(1);
    expect(leased[0].factUid).toBe(uidOf(db, 'parsed-1'));
    expect(leased[0].chatJid).toBe('test-chat@s.whatsapp.net');
    expect(leased[0].namespace).toBe('whatsapp-facts');
    expect(leased[0].payload.text).toBe('Payload echo');
    expect(leased[0].payload.memoryType).toBe('self_fact');
    expect(leased[0].payload.confidence).toBe(0.77);
    expect(leased[0].payload.sourceMessagePks).toEqual([99]);
  });

  it('does NOT return already-exported rows', () => {
    enqueueFacts(db, [
      makeFact({ factId: 'mixed-1' }),
      makeFact({ factId: 'mixed-2' }),
      makeFact({ factId: 'mixed-3' }),
    ]);
    db.raw
      .prepare(`UPDATE fact_export_queue SET state = 'exported' WHERE fact_id = 'mixed-2'`)
      .run();

    const leased = leasePendingFacts(db, LEASE);
    const leasedUids = leased.map((c) => c.factUid).sort();
    expect(leasedUids).toEqual([uidOf(db, 'mixed-1'), uidOf(db, 'mixed-3')].sort());
  });

  it('DOES mutate state — a second claimer sees nothing while leases are live', () => {
    enqueueFacts(db, [makeFact({ factId: 'fenced-1' }), makeFact({ factId: 'fenced-2' })]);

    const first = leasePendingFacts(db, LEASE);
    const second = leasePendingFacts(db, { ...LEASE, owner: 'other-worker', nowUnixSec: 1001 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);
  });

  it('returns an empty array when queue is empty', () => {
    const leased = leasePendingFacts(db, LEASE);
    expect(leased).toEqual([]);
  });

  it('respects limit even when queue is larger', () => {
    const facts = Array.from({ length: 50 }, (_, i) => makeFact({ factId: `bulk-${i}` }));
    enqueueFacts(db, facts);
    const leased = leasePendingFacts(db, { ...LEASE, limit: 5 });
    expect(leased).toHaveLength(5);
  });
});

describe('ackFacts', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('marks leased rows as exported and sets exported_at/acked_at', () => {
    enqueueFacts(db, [
      makeFact({ factId: 'exp-1' }),
      makeFact({ factId: 'exp-2' }),
    ]);
    leasePendingFacts(db, LEASE);

    const results = ackFacts(db, {
      owner: LEASE.owner,
      acks: [{ factUid: uidOf(db, 'exp-1'), outcome: 'exported' }],
      nowUnixSec: 1001,
    });
    expect(results).toEqual([{ factUid: uidOf(db, 'exp-1'), result: 'acknowledged' }]);

    const row = db.raw
      .prepare(`SELECT state, exported_at, acked_at FROM fact_export_queue WHERE fact_id = ?`)
      .get('exp-1') as { state: string; exported_at: string | null; acked_at: number | null };
    expect(row.state).toBe('exported');
    expect(row.exported_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.acked_at).toBe(1001);

    const otherRow = db.raw
      .prepare(`SELECT state, exported_at FROM fact_export_queue WHERE fact_id = ?`)
      .get('exp-2') as { state: string; exported_at: string | null };
    expect(otherRow).toEqual({ state: 'leased', exported_at: null });
  });

  it('does NOT mutate payload_json', () => {
    const fact = makeFact({
      factId: 'payload-untouched',
      text: 'Must not change',
      confidence: 0.88,
    });
    enqueueFacts(db, [fact]);
    leasePendingFacts(db, LEASE);

    const before = db.raw
      .prepare(`SELECT payload_json FROM fact_export_queue WHERE fact_id = ?`)
      .get('payload-untouched') as { payload_json: string };

    ackFacts(db, {
      owner: LEASE.owner,
      acks: [{ factUid: uidOf(db, 'payload-untouched'), outcome: 'exported' }],
      nowUnixSec: 1001,
    });

    const after = db.raw
      .prepare(`SELECT payload_json FROM fact_export_queue WHERE fact_id = ?`)
      .get('payload-untouched') as { payload_json: string };

    expect(after.payload_json).toBe(before.payload_json);
  });

  it('is a no-op for an empty ack list', () => {
    enqueueFacts(db, [makeFact({ factId: 'noop-1' })]);
    const results = ackFacts(db, { owner: LEASE.owner, acks: [], nowUnixSec: 1001 });
    expect(results).toEqual([]);
    const row = db.raw
      .prepare(`SELECT state FROM fact_export_queue WHERE fact_id = ?`)
      .get('noop-1') as { state: string };
    expect(row.state).toBe('pending');
  });

  it('reports unknown fact uids explicitly instead of silently ignoring them', () => {
    enqueueFacts(db, [makeFact({ factId: 'known-1' })]);
    leasePendingFacts(db, LEASE);
    const results = ackFacts(db, {
      owner: LEASE.owner,
      acks: [
        { factUid: 'fe_unknown00000000000000001', outcome: 'exported' },
        { factUid: 'fe_unknown00000000000000002', outcome: 'exported' },
      ],
      nowUnixSec: 1001,
    });
    expect(results.map((r) => r.result)).toEqual(['unknown', 'unknown']);

    const row = db.raw
      .prepare(`SELECT state FROM fact_export_queue WHERE fact_id = ?`)
      .get('known-1') as { state: string };
    expect(row.state).toBe('leased');
  });

  it('handles a large batch of acks in one call', () => {
    const facts = Array.from({ length: 30 }, (_, i) => makeFact({ factId: `batch-${i}` }));
    enqueueFacts(db, facts);
    const leased = leasePendingFacts(db, { ...LEASE, limit: 30 });
    const results = ackFacts(db, {
      owner: LEASE.owner,
      acks: leased.map((l) => ({ factUid: l.factUid, outcome: 'exported' as const })),
      nowUnixSec: 1001,
    });
    expect(results.every((r) => r.result === 'acknowledged')).toBe(true);

    const notExported = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM fact_export_queue WHERE state != 'exported'`)
      .get() as { n: number };
    expect(notExported.n).toBe(0);
  });
});

// ─── T1 hardening: transactional accounting + payload guard ──────────────────
//
// These tests were added in the Phase 3 closeout task T1 to drive the
// enqueueFacts return type from bare number → { attempted, inserted, duplicates, failed }
// and to require an all-or-nothing transaction wrapping the per-row insert
// loop. They also assert that claimPendingFacts does NOT silently skip
// corrupted payload_json rows; such rows must be surfaced as quarantined so
// the downstream exporter can observe and remediate them.

describe('enqueueFacts — transactional accounting (T1)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('returns {attempted, inserted, duplicates, failed} with correct accounting on mixed batch', () => {
    // Seed 1 pre-existing row so a later insert with the same fact_id counts
    // as a duplicate (INSERT OR IGNORE → 0 changes, idempotent success).
    enqueueFacts(db, [makeFact({ factId: 'seeded-dup' })]);

    // Mixed batch of 4 new attempts:
    //  - 3 genuinely new rows
    //  - 1 that collides with the seed → idempotent duplicate, not a failure
    const facts = [
      makeFact({ factId: 'new-1' }),
      makeFact({ factId: 'new-2' }),
      makeFact({ factId: 'new-3' }),
      makeFact({ factId: 'seeded-dup' }), // duplicate of pre-seeded row
    ];

    const result = enqueueFacts(db, facts);
    // Accounting object shape
    expect(result).toEqual({
      attempted: 4, // total rows handed to enqueueFacts in this call
      inserted: 3,  // 3 new rows successfully written
      duplicates: 1, // 1 idempotent duplicate (pre-existing)
      failed: 0,    // 0 hard errors
    });

    // Queue should now contain: seed + 3 new = 4 rows
    const count = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM fact_export_queue`)
      .get() as { n: number };
    expect(count.n).toBe(4);
  });

  it('empty-array call returns zeroed accounting object', () => {
    const result = enqueueFacts(db, []);
    expect(result).toEqual({
      attempted: 0,
      inserted: 0,
      duplicates: 0,
      failed: 0,
    });
  });

  it('transaction rolls back on mid-batch insert failure — nothing is committed', () => {
    // Seed one row before the batch to prove rollback does NOT destroy
    // prior state — only the failed batch's inserts are reverted.
    enqueueFacts(db, [makeFact({ factId: 'pre-existing', text: 'Untouched by rollback' })]);

    // Monkey-patch db.raw.prepare so that the INSERT OR IGNORE statement
    // throws on the 2nd invocation (the 2nd row in our batch). Earlier
    // rows in the same batch must be rolled back because the whole
    // batch is wrapped in BEGIN/COMMIT/ROLLBACK.
    const originalPrepare = db.raw.prepare.bind(db.raw);
    const prepareSpy = vi.spyOn(db.raw, 'prepare').mockImplementation((sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes('INSERT OR IGNORE INTO fact_export_queue')) {
        let callCount = 0;
        return {
          ...stmt,
          run: (...args: unknown[]) => {
            callCount += 1;
            if (callCount === 2) {
              throw new Error('simulated hard DB error on 2nd insert');
            }
            return (stmt as { run: (...args: unknown[]) => unknown }).run(...args);
          },
        } as typeof stmt;
      }
      return stmt;
    });

    const batch = [
      makeFact({ factId: 'txn-1', text: 'Row 1 — should roll back' }),
      makeFact({ factId: 'txn-2', text: 'Row 2 — triggers the error' }),
      makeFact({ factId: 'txn-3', text: 'Row 3 — never reached in commit' }),
    ];

    // The transaction must throw on hard DB error so the whole batch rolls back.
    expect(() => enqueueFacts(db, batch)).toThrow(/simulated hard DB error/);

    prepareSpy.mockRestore();

    // Pre-existing row survives rollback
    const seedRow = db.raw
      .prepare(`SELECT fact_id FROM fact_export_queue WHERE fact_id = ?`)
      .get('pre-existing') as { fact_id: string } | undefined;
    expect(seedRow?.fact_id).toBe('pre-existing');

    // None of the batch rows were committed (all rolled back)
    const batchRows = db.raw
      .prepare(`SELECT fact_id FROM fact_export_queue WHERE fact_id IN ('txn-1', 'txn-2', 'txn-3')`)
      .all() as Array<{ fact_id: string }>;
    expect(batchRows).toHaveLength(0);
  });
});

describe('leasePendingFacts — corrupted payload guard (T1)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('surfaces corrupted payload_json at log.error with fact_uid, not silently returned as {}', () => {
    // Contract (T1 I-1 hard negative): corrupted payload_json rows MUST
    // be omitted from the leased result AND the quarantine MUST emit a
    // log.error bearing the offending opaque factUid — never the
    // identity-bearing fact_id and never payload prose.
    mockLogError.mockClear();

    // Insert a malformed row directly so the payload_json is not valid JSON.
    db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json) VALUES (?, ?, ?, ?)`,
      )
      .run('fe_corrupt00000000000000t1', 'corrupt-1', 'test-chat@s.whatsapp.net', '{this is not valid json');

    // A normally-structured row goes alongside so we verify the guard does
    // not nuke adjacent good rows.
    enqueueFacts(db, [makeFact({ factId: 'healthy-1', text: 'Good payload' })]);

    // Optional runId propagation — only assert it if the env var is set,
    // matching the implementation's conditional spread.
    const runId = process.env.MW_MIND_RUN_ID;

    const leased = leasePendingFacts(db, LEASE);

    // Good row is returned with parsed payload.
    const goodRow = leased.find((c) => c.factUid === uidOf(db, 'healthy-1'));
    expect(goodRow).toMatchObject({
      payload: { text: 'Good payload' },
    });

    // Hard negative: the corrupt row MUST NOT appear in the leased result.
    expect(leased.some((c) => c.factUid === 'fe_corrupt00000000000000t1')).toBe(false);

    // Hard positive: the quarantine path MUST have emitted log.error with
    // the offending factUid — this is the audit-trail contract.
    const errorCalls = mockLogError.mock.calls.filter((call) => {
      const [ctx] = call as [unknown, unknown];
      return (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>).factUid === 'fe_corrupt00000000000000t1'
      );
    });
    expect(errorCalls.length).toBeGreaterThan(0);

    // Every error call carries the row id (so operators can SELECT on id),
    // carries runId iff the env var is present, and NEVER carries the
    // legacy fact_id or payload content.
    for (const call of errorCalls) {
      const [ctx] = call as [Record<string, unknown>, string];
      expect(typeof ctx.rowId).toBe('number');
      expect('factId' in ctx).toBe(false);
      if (runId) {
        expect(ctx.runId).toBe(runId);
      } else {
        expect('runId' in ctx).toBe(false);
      }
    }

    // The row must still exist for operator triage — quarantined with an
    // explicit failure code, never deleted.
    const stillThere = db.raw
      .prepare(`SELECT state, failure_code FROM fact_export_queue WHERE fact_id = ?`)
      .get('corrupt-1') as { state: string; failure_code: string | null } | undefined;
    expect(stillThere).toEqual({ state: 'quarantined', failure_code: 'payload_invalid' });
  });

  it('rejects payload_json that parses as JSON but fails zod validation', () => {
    // Contract (T1 I-1 hard negative): a syntactically-valid but
    // semantically-invalid payload (JSON object missing required fields)
    // MUST be quarantined — omitted from the leased result AND surfaced
    // at log.error with the offending factUid.
    mockLogError.mockClear();

    db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json) VALUES (?, ?, ?, ?)`,
      )
      .run('fe_schemabad000000000000t1', 'schema-bad-1', 'test-chat@s.whatsapp.net', '{"unexpected":"shape"}');

    // Adjacent healthy row
    enqueueFacts(db, [makeFact({ factId: 'healthy-2', text: 'Fine' })]);

    const leased = leasePendingFacts(db, LEASE);

    // Healthy row is still returned
    const healthy = leased.find((c) => c.factUid === uidOf(db, 'healthy-2'));
    expect(healthy).toMatchObject({
      payload: { text: 'Fine' },
    });

    // Hard negative: the schema-bad row MUST NOT appear in the leased result.
    expect(leased.some((c) => c.factUid === 'fe_schemabad000000000000t1')).toBe(false);

    // Hard positive: log.error bears the factUid; zod issue details (which
    // can embed payload-derived prose) are deliberately NOT logged.
    const errorCalls = mockLogError.mock.calls.filter((call) => {
      const [ctx] = call as [unknown, unknown];
      return (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>).factUid === 'fe_schemabad000000000000t1'
      );
    });
    expect(errorCalls.length).toBeGreaterThan(0);
    for (const call of errorCalls) {
      const [ctx] = call as [Record<string, unknown>, string];
      expect(typeof ctx.rowId).toBe('number');
      expect('issues' in ctx).toBe(false);
      expect('factId' in ctx).toBe(false);
    }

    const row = db.raw
      .prepare(`SELECT state, failure_code FROM fact_export_queue WHERE fact_id = ?`)
      .get('schema-bad-1') as { state: string; failure_code: string | null };
    expect(row).toEqual({ state: 'quarantined', failure_code: 'payload_invalid' });
  });
});

describe('leasePendingFacts — quarantine state persistence', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('flips corrupt rows to state=quarantined so they stop occupying the pending queue head', () => {
    // Failure mode this prevents: skipped-but-still-pending rows accumulate
    // at the head of the ORDER BY id queue; once `limit` corrupt rows pile
    // up, every leased batch is all garbage and export silently stops.
    db.raw
      .prepare(`INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json) VALUES (?, ?, ?, ?)`)
      .run('fe_corrupthead0000000000t1', 'corrupt-head', 'test-chat@s.whatsapp.net', '{broken');
    db.raw
      .prepare(`INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json) VALUES (?, ?, ?, ?)`)
      .run('fe_schemabadhead00000000t1', 'schema-bad-head', 'test-chat@s.whatsapp.net', '{"unexpected":"shape"}');
    enqueueFacts(db, [makeFact({ factId: 'healthy-tail', text: 'Behind the corrupt rows' })]);

    // With limit=2 both slots are eaten by the corrupt head rows unless
    // they leave 'pending' after being observed once.
    const first = leasePendingFacts(db, { ...LEASE, limit: 2 });
    expect(first).toEqual([]);

    const states = db.raw
      .prepare(`SELECT fact_id, state FROM fact_export_queue ORDER BY id`)
      .all() as Array<{ fact_id: string; state: string }>;
    expect(states).toEqual([
      { fact_id: 'corrupt-head', state: 'quarantined' },
      { fact_id: 'schema-bad-head', state: 'quarantined' },
      { fact_id: 'healthy-tail', state: 'pending' },
    ]);

    // The second lease now reaches the healthy row instead of re-reading garbage.
    const second = leasePendingFacts(db, { ...LEASE, limit: 2, nowUnixSec: 1001 });
    expect(second.map((c) => c.factUid)).toEqual([uidOf(db, 'healthy-tail')]);
  });
});
