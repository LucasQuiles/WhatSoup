// tests/core/background-work-store.test.ts
// Work Ledger + Results Outbox: schema guards, transactional completion, orphan
// sweep, delivery claim, and a REAL kill -9 proof that a dead parent cannot take
// its worker's registration down with it.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  BACKGROUND_WORK_MAX_SUMMARY_BYTES,
  STALE_DELIVERY_NOTICE_MS,
  claimPendingWorkResults,
  completeBackgroundWork,
  describeResultStaleness,
  markBackgroundWorkRunning,
  markWorkResultDelivered,
  registerBackgroundWork,
  releaseWorkResultDelivery,
  renewBackgroundWorkLease,
  sweepOrphanedBackgroundWork,
} from '../../src/core/background-work-store.ts';

const T0 = 1_780_000_000_000;

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function register(db: Database, workId: string, overrides: Record<string, unknown> = {}) {
  return registerBackgroundWork(db, {
    workId,
    parentSessionId: 'session-abc',
    parentPid: 4242,
    conversationKey: '000000000000000000_at_g.us',
    deliveryJid: '000000000000000000@g.us',
    workerKind: 'agent_subagent',
    specDigest: 'sha256:deadbeef',
    summaryLabel: 'LCP tracker export',
    now: T0,
    leaseExpiresAt: T0 + 60_000,
    ...overrides,
  } as Parameters<typeof registerBackgroundWork>[1]);
}

describe('background work ledger — registration', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('registers work bound to a conversation_key, not to the parent session lifetime', () => {
    const row = register(db, 'work-1');
    expect(row.state).toBe('registered');
    expect(row.conversationKey).toBe('000000000000000000_at_g.us');
    expect(row.workId).toBe('work-1');
  });

  it('rejects a duplicate work_id (UNIQUE) so a respawn cannot fork the ledger row', () => {
    register(db, 'work-1');
    expect(() => register(db, 'work-1')).toThrow();
  });

  it('rejects an unsanctioned worker_kind at write time rather than creating an unmanaged class', () => {
    expect(() => register(db, 'work-2', { workerKind: 'operator_script' })).toThrow();
  });

  it('rejects an empty conversation_key — delivery identity is mandatory', () => {
    expect(() => register(db, 'work-3', { conversationKey: '   ' })).toThrow(/conversationKey/);
  });

  it('accepts a null parent pid (spawner could not report one); lease alone governs orphaning', () => {
    const row = register(db, 'work-4', { parentPid: null });
    expect(row.parentPid).toBeNull();
    // The behavioral claim: a pid-less row is still fully sweepable via its lease.
    markBackgroundWorkRunning(db, 'work-4', T0 + 1_000, T0);
    const swept = sweepOrphanedBackgroundWork(db, T0 + 2_000);
    expect(swept.map((w) => w.workId)).toEqual(['work-4']);
    expect(swept[0].state).toBe('orphaned');
  });
});

describe('background work ledger — lease lifecycle', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('starts work and renews its lease while the worker is alive', () => {
    register(db, 'work-1');
    expect(markBackgroundWorkRunning(db, 'work-1', T0 + 60_000, T0)).toBe(true);
    expect(renewBackgroundWorkLease(db, 'work-1', T0 + 120_000, T0 + 30_000)).toBe(true);
  });

  it('refuses to renew a terminal row, so a completed work cannot be resurrected', () => {
    register(db, 'work-1');
    markBackgroundWorkRunning(db, 'work-1', T0 + 60_000, T0);
    completeBackgroundWork(db, {
      workId: 'work-1',
      outcome: 'completed',
      summary: 'done',
      artifactPath: null,
      now: T0 + 10_000,
      deliveryDedupeKey: 'dedupe-1',
    });
    expect(renewBackgroundWorkLease(db, 'work-1', T0 + 999_000, T0 + 20_000)).toBe(false);
  });
});

describe('background work ledger — transactional completion', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('writes the terminal state and the outbox row together', () => {
    register(db, 'work-1');
    markBackgroundWorkRunning(db, 'work-1', T0 + 60_000, T0);
    const { work, result } = completeBackgroundWork(db, {
      workId: 'work-1',
      outcome: 'completed',
      summary: 'export finished: 412 rows',
      artifactPath: '/tmp/export.csv',
      now: T0 + 5_000,
      deliveryDedupeKey: 'dedupe-1',
    });
    expect(work.state).toBe('completed');
    expect(work.leaseExpiresAt).toBeNull();
    expect(result.deliveryState).toBe('pending');
    expect(result.summary).toBe('export finished: 412 rows');
    expect(result.recovered).toBe(false);
  });

  it('derives recovered=true when the work had already been swept to orphaned', () => {
    register(db, 'work-1');
    markBackgroundWorkRunning(db, 'work-1', T0 + 1_000, T0);
    sweepOrphanedBackgroundWork(db, T0 + 2_000);
    const { result } = completeBackgroundWork(db, {
      workId: 'work-1',
      outcome: 'completed',
      summary: 'finished after parent died',
      artifactPath: null,
      now: T0 + 3_000,
      deliveryDedupeKey: 'dedupe-1',
    });
    expect(result.recovered).toBe(true);
  });

  it('rejects a second completion of the same work (no double delivery)', () => {
    register(db, 'work-1');
    markBackgroundWorkRunning(db, 'work-1', T0 + 60_000, T0);
    const args = {
      workId: 'work-1',
      outcome: 'completed' as const,
      summary: 'done',
      artifactPath: null,
      now: T0 + 5_000,
      deliveryDedupeKey: 'dedupe-1',
    };
    completeBackgroundWork(db, args);
    expect(() => completeBackgroundWork(db, { ...args, deliveryDedupeKey: 'dedupe-2' })).toThrow(
      /already terminal/,
    );
  });

  it('rejects a duplicate delivery_dedupe_key across different work', () => {
    register(db, 'work-1');
    register(db, 'work-2');
    markBackgroundWorkRunning(db, 'work-1', T0 + 60_000, T0);
    markBackgroundWorkRunning(db, 'work-2', T0 + 60_000, T0);
    completeBackgroundWork(db, {
      workId: 'work-1', outcome: 'completed', summary: 'a', artifactPath: null,
      now: T0 + 1_000, deliveryDedupeKey: 'shared-key',
    });
    expect(() => completeBackgroundWork(db, {
      workId: 'work-2', outcome: 'completed', summary: 'b', artifactPath: null,
      now: T0 + 2_000, deliveryDedupeKey: 'shared-key',
    })).toThrow();
  });

  it('rolls back entirely when the outbox insert fails — no completed row without a result', () => {
    register(db, 'work-1');
    register(db, 'work-2');
    markBackgroundWorkRunning(db, 'work-1', T0 + 60_000, T0);
    markBackgroundWorkRunning(db, 'work-2', T0 + 60_000, T0);
    completeBackgroundWork(db, {
      workId: 'work-1', outcome: 'completed', summary: 'a', artifactPath: null,
      now: T0 + 1_000, deliveryDedupeKey: 'shared-key',
    });
    expect(() => completeBackgroundWork(db, {
      workId: 'work-2', outcome: 'completed', summary: 'b', artifactPath: null,
      now: T0 + 2_000, deliveryDedupeKey: 'shared-key',
    })).toThrow();

    // work-2 must still be running (rolled back), NOT completed-with-no-result.
    const row = db.raw.prepare('SELECT state FROM background_work WHERE work_id = ?')
      .get('work-2') as { state: string };
    expect(row.state).toBe('running');
    const orphanResults = db.raw
      .prepare('SELECT COUNT(*) AS n FROM work_results WHERE work_id = ?')
      .get('work-2') as { n: number };
    expect(orphanResults.n).toBe(0);
  });

  it('rejects an oversized summary rather than truncating it into the outbox', () => {
    register(db, 'work-1');
    markBackgroundWorkRunning(db, 'work-1', T0 + 60_000, T0);
    expect(() => completeBackgroundWork(db, {
      workId: 'work-1',
      outcome: 'completed',
      summary: 'x'.repeat(BACKGROUND_WORK_MAX_SUMMARY_BYTES + 1),
      artifactPath: null,
      now: T0 + 1_000,
      deliveryDedupeKey: 'dedupe-1',
    })).toThrow(/summary/);
  });
});

describe('background work ledger — orphan sweep', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('collects running work whose lease expired', () => {
    register(db, 'work-1');
    markBackgroundWorkRunning(db, 'work-1', T0 + 1_000, T0);
    const swept = sweepOrphanedBackgroundWork(db, T0 + 5_000);
    expect(swept.map((w) => w.workId)).toEqual(['work-1']);
    expect(swept[0].state).toBe('orphaned');
  });

  it('leaves a slow-but-renewing worker alone', () => {
    register(db, 'work-1');
    markBackgroundWorkRunning(db, 'work-1', T0 + 1_000, T0);
    renewBackgroundWorkLease(db, 'work-1', T0 + 100_000, T0 + 500);
    expect(sweepOrphanedBackgroundWork(db, T0 + 5_000)).toEqual([]);
  });

  it('never touches registered-but-not-started or already-terminal work', () => {
    register(db, 'registered-only');
    register(db, 'finished');
    markBackgroundWorkRunning(db, 'finished', T0 + 1_000, T0);
    completeBackgroundWork(db, {
      workId: 'finished', outcome: 'completed', summary: 'done', artifactPath: null,
      now: T0 + 500, deliveryDedupeKey: 'dedupe-1',
    });
    expect(sweepOrphanedBackgroundWork(db, T0 + 999_000)).toEqual([]);
  });
});

describe('background work ledger — delivery claim', () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  function completed(workId: string, producedAt: number) {
    register(db, workId);
    markBackgroundWorkRunning(db, workId, producedAt + 60_000, T0);
    return completeBackgroundWork(db, {
      workId, outcome: 'completed', summary: `result ${workId}`, artifactPath: null,
      now: producedAt, deliveryDedupeKey: `dedupe-${workId}`,
    });
  }

  it('claims oldest-first and marks rows delivering so a second tick cannot re-claim them', () => {
    completed('work-late', T0 + 9_000);
    completed('work-early', T0 + 1_000);
    const first = claimPendingWorkResults(db, 10, T0 + 10_000);
    expect(first.map((r) => r.workId)).toEqual(['work-early', 'work-late']);
    expect(first[0].deliveryAttempts).toBe(1);
    expect(claimPendingWorkResults(db, 10, T0 + 11_000)).toEqual([]);
  });

  it('marks a claimed result delivered', () => {
    const { result } = completed('work-1', T0 + 1_000);
    claimPendingWorkResults(db, 10, T0 + 2_000);
    expect(markWorkResultDelivered(db, result.id, T0 + 3_000)).toBe(true);
    expect(markWorkResultDelivered(db, result.id, T0 + 4_000)).toBe(false);
  });

  it('returns a retryable failure to pending, and a permanent one to failed', () => {
    const { result: a } = completed('work-a', T0 + 1_000);
    const { result: b } = completed('work-b', T0 + 2_000);
    claimPendingWorkResults(db, 10, T0 + 3_000);

    expect(releaseWorkResultDelivery(db, a.id, true)).toBe(true);
    expect(releaseWorkResultDelivery(db, b.id, false)).toBe(true);

    const reclaimed = claimPendingWorkResults(db, 10, T0 + 4_000);
    expect(reclaimed.map((r) => r.workId)).toEqual(['work-a']);
    expect(reclaimed[0].deliveryAttempts).toBe(2);
  });
});

describe('background work ledger — delivery honesty', () => {
  it('always marks a recovered result and states its age', () => {
    const text = describeResultStaleness({ recovered: true, producedAt: T0 }, T0 + 7_200_000);
    expect(text).toBe('[recovered result · produced 2h ago]');
  });

  it('marks a merely-delayed result with its age', () => {
    const text = describeResultStaleness(
      { recovered: false, producedAt: T0 },
      T0 + STALE_DELIVERY_NOTICE_MS,
    );
    expect(text).toBe('[delayed result · produced 5m ago]');
  });

  it('adds no qualifier to a fresh result from a live parent', () => {
    expect(describeResultStaleness({ recovered: false, producedAt: T0 }, T0 + 1_000)).toBeNull();
  });
});

/**
 * The durability acceptance test. Everything above runs in-process; this one
 * proves the actual claim: a worker's registration survives its parent being
 * SIGKILLed, which is precisely what the 30-minute hard-watchdog wave did to
 * a production instance's process trees.
 *
 * No wall-clock sleeps: the child announces readiness on stdout and the parent
 * waits on the real 'exit' event, so every wait is condition-based.
 */
describe('background work ledger — survives kill -9 of the parent', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bgwork-kill9-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('keeps the registration after SIGKILL, sweeps it orphaned, and marks the late result recovered', async () => {
    const dbPath = join(dir, 'bot.db');
    const childPath = join(dir, 'child.ts');
    writeFileSync(
      childPath,
      `
import { Database } from ${JSON.stringify(join(process.cwd(), 'src/core/database.ts'))};
import {
  registerBackgroundWork,
  markBackgroundWorkRunning,
} from ${JSON.stringify(join(process.cwd(), 'src/core/background-work-store.ts'))};

const db = new Database(${JSON.stringify(dbPath)});
db.open();
const now = Date.now();
registerBackgroundWork(db, {
  workId: 'work-killed',
  parentSessionId: 'doomed-session',
  parentPid: process.pid,
  conversationKey: 'lcp_at_g.us',
  deliveryJid: 'lcp@g.us',
  workerKind: 'agent_subagent',
  specDigest: 'sha256:abc',
  summaryLabel: 'long browser automation',
  now,
  leaseExpiresAt: now + 1000,
});
markBackgroundWorkRunning(db, 'work-killed', now + 1000, now);
db.close();
console.log('READY');
// Hang forever: only SIGKILL ends this process.
setInterval(() => {}, 1000);
`,
      'utf8',
    );

    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', childPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const ready = new Promise<void>((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += String(d);
        if (buf.includes('READY')) resolve();
      });
      let err = '';
      child.stderr.on('data', (d) => { err += String(d); });
      child.on('exit', (code) => reject(new Error(`child exited early (${code}): ${err}`)));
    });
    await ready;

    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;

    // The parent is gone. Its work must still be here.
    const db = new Database(dbPath);
    db.open();
    try {
      const row = db.raw
        .prepare('SELECT work_id, state, conversation_key FROM background_work WHERE work_id = ?')
        .get('work-killed') as { work_id: string; state: string; conversation_key: string };
      expect(row.state).toBe('running');
      expect(row.conversation_key).toBe('lcp_at_g.us');

      // Lease outlived its holder → the sweep collects it.
      const swept = sweepOrphanedBackgroundWork(db, Date.now() + 60_000);
      expect(swept.map((w) => w.workId)).toEqual(['work-killed']);

      // A result arriving afterwards is honestly marked as recovered.
      const { result } = completeBackgroundWork(db, {
        workId: 'work-killed',
        outcome: 'completed',
        summary: 'browser export finished after the parent died',
        artifactPath: null,
        now: Date.now() + 61_000,
        deliveryDedupeKey: 'dedupe-killed',
      });
      expect(result.recovered).toBe(true);
      expect(result.deliveryState).toBe('pending');
      expect(result.conversationKey).toBe('lcp_at_g.us');
      expect(describeResultStaleness(result, result.producedAt + 3_600_000)).toBe(
        '[recovered result · produced 1h ago]',
      );
    } finally {
      db.close();
    }
  });
});
