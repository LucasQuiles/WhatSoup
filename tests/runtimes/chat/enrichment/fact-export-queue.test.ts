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
  claimPendingFacts,
  markFactsExported,
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
    expect(colMap.has('fact_id')).toBe(true);
    expect(colMap.get('fact_id')?.notnull).toBe(1);
    expect(colMap.has('chat_jid')).toBe(true);
    expect(colMap.get('chat_jid')?.notnull).toBe(1);
    expect(colMap.has('sender_jid')).toBe(true);
    expect(colMap.has('namespace')).toBe(true);
    expect(colMap.has('payload_json')).toBe(true);
    expect(colMap.get('payload_json')?.notnull).toBe(1);
    expect(colMap.has('status')).toBe(true);
    expect(colMap.has('created_at')).toBe(true);
    expect(colMap.has('exported_at')).toBe(true);
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
        `INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json) VALUES (?, ?, ?)`,
      )
      .run('f1', 'test-chat@s.whatsapp.net', '{}');
    const row = db.raw
      .prepare(`SELECT namespace FROM fact_export_queue WHERE fact_id = ?`)
      .get('f1') as { namespace: string };
    expect(row.namespace).toBe('whatsapp-facts');
  });

  it('status defaults to pending', () => {
    db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json) VALUES (?, ?, ?)`,
      )
      .run('f2', 'test-chat@s.whatsapp.net', '{}');
    const row = db.raw
      .prepare(`SELECT status FROM fact_export_queue WHERE fact_id = ?`)
      .get('f2') as { status: string };
    expect(row.status).toBe('pending');
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
      .prepare(`SELECT fact_id, chat_jid, sender_jid, namespace, status FROM fact_export_queue WHERE fact_id = ?`)
      .get('stable-id-1') as {
        fact_id: string;
        chat_jid: string;
        sender_jid: string | null;
        namespace: string;
        status: string;
      };
    expect(row.fact_id).toBe('stable-id-1');
    expect(row.chat_jid).toBe('test-chat@s.whatsapp.net');
    expect(row.sender_jid).toBe('15550100001@s.whatsapp.net');
    expect(row.namespace).toBe('whatsapp-facts');
    expect(row.status).toBe('pending');
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
      .prepare(`SELECT fact_id, chat_jid, sender_jid, namespace, status FROM fact_export_queue WHERE fact_id = ?`)
      .get('group-fact') as {
        fact_id: string;
        chat_jid: string;
        sender_jid: string | null;
        namespace: string;
        status: string;
      };
    expect(row).toEqual({
      fact_id: 'group-fact',
      chat_jid: 'test-chat@s.whatsapp.net',
      sender_jid: null,
      namespace: 'whatsapp-facts',
      status: 'pending',
    });
  });
});

describe('claimPendingFacts', () => {
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

    const claimed = claimPendingFacts(db, 2);
    expect(claimed).toHaveLength(2);
    expect(claimed[0].factId).toBe('c-1');
    expect(claimed[1].factId).toBe('c-2');
  });

  it('returns parsed payload fields for each claimed row', () => {
    enqueueFacts(db, [makeFact({
      factId: 'parsed-1',
      text: 'Payload echo',
      memoryType: 'self_fact',
      confidence: 0.77,
      sourceMessagePks: [99],
    })]);

    const claimed = claimPendingFacts(db, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].factId).toBe('parsed-1');
    expect(claimed[0].chatJid).toBe('test-chat@s.whatsapp.net');
    expect(claimed[0].namespace).toBe('whatsapp-facts');
    expect(claimed[0].payload.text).toBe('Payload echo');
    expect(claimed[0].payload.memoryType).toBe('self_fact');
    expect(claimed[0].payload.confidence).toBe(0.77);
    expect(claimed[0].payload.sourceMessagePks).toEqual([99]);
  });

  it('does NOT return already-exported rows', () => {
    enqueueFacts(db, [
      makeFact({ factId: 'mixed-1' }),
      makeFact({ factId: 'mixed-2' }),
      makeFact({ factId: 'mixed-3' }),
    ]);
    markFactsExported(db, ['mixed-2']);

    const claimed = claimPendingFacts(db, 10);
    const claimedIds = claimed.map((c) => c.factId).sort();
    expect(claimedIds).toEqual(['mixed-1', 'mixed-3']);
  });

  it('does NOT mutate state — calling twice returns the same rows', () => {
    enqueueFacts(db, [makeFact({ factId: 'readonly-1' }), makeFact({ factId: 'readonly-2' })]);

    const first = claimPendingFacts(db, 10);
    const second = claimPendingFacts(db, 10);
    expect(first.map((f) => f.factId).sort()).toEqual(['readonly-1', 'readonly-2']);
    expect(second.map((f) => f.factId).sort()).toEqual(['readonly-1', 'readonly-2']);
  });

  it('returns an empty array when queue is empty', () => {
    const claimed = claimPendingFacts(db, 10);
    expect(claimed).toEqual([]);
  });

  it('respects limit even when queue is larger', () => {
    const facts = Array.from({ length: 50 }, (_, i) => makeFact({ factId: `bulk-${i}` }));
    enqueueFacts(db, facts);
    const claimed = claimPendingFacts(db, 5);
    expect(claimed).toHaveLength(5);
  });
});

describe('markFactsExported', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('marks rows as exported and sets exported_at', () => {
    enqueueFacts(db, [
      makeFact({ factId: 'exp-1' }),
      makeFact({ factId: 'exp-2' }),
    ]);

    markFactsExported(db, ['exp-1']);

    const row = db.raw
      .prepare(`SELECT fact_id, status, exported_at FROM fact_export_queue WHERE fact_id = ?`)
      .get('exp-1') as { fact_id: string; status: string; exported_at: string | null };
    expect(row).toEqual({
      fact_id: 'exp-1',
      status: 'exported',
      exported_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });

    const otherRow = db.raw
      .prepare(`SELECT fact_id, status, exported_at FROM fact_export_queue WHERE fact_id = ?`)
      .get('exp-2') as { fact_id: string; status: string; exported_at: string | null };
    expect(otherRow).toEqual({
      fact_id: 'exp-2',
      status: 'pending',
      exported_at: null,
    });
  });

  it('does NOT mutate payload_json', () => {
    const fact = makeFact({
      factId: 'payload-untouched',
      text: 'Must not change',
      confidence: 0.88,
    });
    enqueueFacts(db, [fact]);

    const before = db.raw
      .prepare(`SELECT payload_json FROM fact_export_queue WHERE fact_id = ?`)
      .get('payload-untouched') as { payload_json: string };

    markFactsExported(db, ['payload-untouched']);

    const after = db.raw
      .prepare(`SELECT payload_json FROM fact_export_queue WHERE fact_id = ?`)
      .get('payload-untouched') as { payload_json: string };

    expect(after.payload_json).toBe(before.payload_json);
  });

  it('is a no-op for an empty ID list', () => {
    enqueueFacts(db, [makeFact({ factId: 'noop-1' })]);
    markFactsExported(db, []);
    const row = db.raw
      .prepare(`SELECT status FROM fact_export_queue WHERE fact_id = ?`)
      .get('noop-1') as { status: string };
    expect(row.status).toBe('pending');
  });

  it('silently ignores unknown fact IDs', () => {
    enqueueFacts(db, [makeFact({ factId: 'known-1' })]);
    markFactsExported(db, ['unknown-1', 'unknown-2']);

    const row = db.raw
      .prepare(`SELECT status FROM fact_export_queue WHERE fact_id = ?`)
      .get('known-1') as { status: string };
    expect(row.status).toBe('pending');
  });

  it('handles a large batch of IDs in one call', () => {
    const facts = Array.from({ length: 30 }, (_, i) => makeFact({ factId: `batch-${i}` }));
    enqueueFacts(db, facts);
    markFactsExported(db, facts.map((f) => f.factId));

    const pending = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM fact_export_queue WHERE status = 'pending'`)
      .get() as { n: number };
    expect(pending.n).toBe(0);
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

describe('claimPendingFacts — corrupted payload guard (T1)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('surfaces corrupted payload_json at log.error with fact_id, not silently returned as {}', () => {
    // Contract (T1 I-1 hard negative): corrupted payload_json rows MUST
    // be omitted from the claimed result AND the quarantine MUST emit a
    // log.error bearing the offending factId. This test asserts BOTH —
    // no conditional-guard gating — so a regression that started
    // returning `{}` payloads (the pre-T1 silent fallback) would make
    // one of the assertions below fail rather than be skipped.

    // Reset the shared logger spy so we only see errors from this test.
    mockLogError.mockClear();

    // Insert a malformed row directly so the payload_json is not valid JSON.
    db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json) VALUES (?, ?, ?)`,
      )
      .run('corrupt-1', 'test-chat@s.whatsapp.net', '{this is not valid json');

    // A normally-structured row goes alongside so we verify the guard does
    // not nuke adjacent good rows.
    enqueueFacts(db, [makeFact({ factId: 'healthy-1', text: 'Good payload' })]);

    // Optional runId propagation — only assert it if the env var is set,
    // matching the implementation's conditional spread.
    const runId = process.env.MW_MIND_RUN_ID;

    const claimed = claimPendingFacts(db, 10);

    // Good row is returned with parsed payload.
    const goodRow = claimed.find((c) => c.factId === 'healthy-1');
    expect(goodRow).toMatchObject({
      factId: 'healthy-1',
      payload: { text: 'Good payload' },
    });

    // Hard negative: the corrupt row MUST NOT appear in the claimed result.
    expect(claimed.find((c) => c.factId === 'corrupt-1')).toBeUndefined();
    // And the claimed array MUST NOT contain ANY row with the corrupt fact_id
    // under any shape (including a resurfaced empty-object payload).
    expect(claimed.some((c) => c.factId === 'corrupt-1')).toBe(false);

    // Hard positive: the quarantine path MUST have emitted log.error with
    // the offending factId — this is the audit-trail contract. Without it,
    // operators have no way to triage corrupted rows.
    const errorCalls = mockLogError.mock.calls.filter((call) => {
      const [ctx] = call as [unknown, unknown];
      return (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>).factId === 'corrupt-1'
      );
    });
    expect(errorCalls.length).toBeGreaterThan(0);

    // Payload shape: every error call for this factId carries the row id
    // too (so operators can SELECT on id), and carries runId iff the env
    // var is present at call time.
    for (const call of errorCalls) {
      const [ctx] = call as [Record<string, unknown>, string];
      expect(typeof ctx.rowId).toBe('number');
      if (runId) {
        expect(ctx.runId).toBe(runId);
      } else {
        expect('runId' in ctx).toBe(false);
      }
    }

    // Additionally: the row must still exist in the DB so an operator
    // can inspect it. claimPendingFacts is read-only; the audit is in
    // sqlite_master + the explicit log path, not row deletion.
    const stillThere = db.raw
      .prepare(`SELECT fact_id FROM fact_export_queue WHERE fact_id = ?`)
      .get('corrupt-1') as { fact_id: string } | undefined;
    expect(stillThere?.fact_id).toBe('corrupt-1');
  });

  it('rejects payload_json that parses as JSON but fails zod validation', () => {
    // Contract (T1 I-1 hard negative): a syntactically-valid but
    // semantically-invalid payload (JSON object missing required fields)
    // MUST be quarantined — omitted from the claimed result AND surfaced
    // at log.error with the offending factId.

    mockLogError.mockClear();

    db.raw
      .prepare(
        `INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json) VALUES (?, ?, ?)`,
      )
      .run('schema-bad-1', 'test-chat@s.whatsapp.net', '{"unexpected":"shape"}');

    // Adjacent healthy row
    enqueueFacts(db, [makeFact({ factId: 'healthy-2', text: 'Fine' })]);

    const runId = process.env.MW_MIND_RUN_ID;

    const claimed = claimPendingFacts(db, 10);

    // Healthy row is still returned
    const healthy = claimed.find((c) => c.factId === 'healthy-2');
    expect(healthy).toMatchObject({
      factId: 'healthy-2',
      payload: { text: 'Fine' },
    });

    // Hard negative: the schema-bad row MUST NOT appear in the claimed result.
    expect(claimed.find((c) => c.factId === 'schema-bad-1')).toBeUndefined();
    expect(claimed.some((c) => c.factId === 'schema-bad-1')).toBe(false);

    // Hard positive: the quarantine path MUST have emitted log.error
    // bearing the offending factId and the zod issues array.
    const errorCalls = mockLogError.mock.calls.filter((call) => {
      const [ctx] = call as [unknown, unknown];
      return (
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as Record<string, unknown>).factId === 'schema-bad-1'
      );
    });
    expect(errorCalls.length).toBeGreaterThan(0);

    for (const call of errorCalls) {
      const [ctx] = call as [Record<string, unknown>, string];
      expect(typeof ctx.rowId).toBe('number');
      // zod failure path carries the issues array for operator triage.
      expect(Array.isArray(ctx.issues)).toBe(true);
      if (runId) {
        expect(ctx.runId).toBe(runId);
      } else {
        expect('runId' in ctx).toBe(false);
      }
    }
  });
});
