import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    expect(n).toBe(1);

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
  });

  it('is idempotent: enqueueing the same factId twice does not duplicate', () => {
    const fact = makeFact({ factId: 'dup-check' });
    const first = enqueueFacts(db, [fact]);
    const second = enqueueFacts(db, [fact]);
    expect(first).toBe(1);
    expect(second).toBe(0);

    const count = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM fact_export_queue WHERE fact_id = ?`)
      .get('dup-check') as { n: number };
    expect(count.n).toBe(1);
  });

  it('handles an empty array without error', () => {
    const n = enqueueFacts(db, []);
    expect(n).toBe(0);
  });

  it('inserts multiple facts in a single call', () => {
    const facts = [
      makeFact({ factId: 'multi-1', text: 'Fact one' }),
      makeFact({ factId: 'multi-2', text: 'Fact two' }),
      makeFact({ factId: 'multi-3', text: 'Fact three' }),
    ];
    const n = enqueueFacts(db, facts);
    expect(n).toBe(3);
    const count = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM fact_export_queue`)
      .get() as { n: number };
    expect(count.n).toBe(3);
  });

  it('accepts null senderJid (group-level fact)', () => {
    const fact = makeFact({ factId: 'group-fact', senderJid: null });
    enqueueFacts(db, [fact]);
    const row = db.raw
      .prepare(`SELECT sender_jid FROM fact_export_queue WHERE fact_id = ?`)
      .get('group-fact') as { sender_jid: string | null };
    expect(row.sender_jid).toBeNull();
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
      .prepare(`SELECT status, exported_at FROM fact_export_queue WHERE fact_id = ?`)
      .get('exp-1') as { status: string; exported_at: string | null };
    expect(row.status).toBe('exported');
    expect(row.exported_at).not.toBeNull();

    const otherRow = db.raw
      .prepare(`SELECT status, exported_at FROM fact_export_queue WHERE fact_id = ?`)
      .get('exp-2') as { status: string; exported_at: string | null };
    expect(otherRow.status).toBe('pending');
    expect(otherRow.exported_at).toBeNull();
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
