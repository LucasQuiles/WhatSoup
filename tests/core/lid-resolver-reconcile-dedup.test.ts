/**
 * #1781 — L6 LID reconciliation must (a) bound its scan of the historical
 * `messages` table instead of full-scanning it every sweep, and (b) stop
 * re-warning the same never-resolvable LID cohort every 30 minutes.
 *
 * These tests exercise `reconcileLidMappings` with a caller-provided,
 * cross-sweep state object. They are written RED-first: on origin/main the
 * function takes only (db, authDir), full-scans `messages` every call, warns on
 * every non-empty set, and returns no `newUnresolvedLids` delta — so the
 * assertions below fail.
 *
 * REPO-HYGIENE: all LID fixtures use reserved 1111112N bare-digit ranges.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Replace ONLY createChildLogger so every module shares one spy-backed child;
// default/errorLikeSerializers/flushLogger stay real (importActual) so the real
// Database construction path is untouched.
vi.mock('../../src/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logger.ts')>();
  const child: Record<string, ReturnType<typeof vi.fn>> & { child?: unknown } = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
  };
  child.child = () => child;
  return { ...actual, createChildLogger: () => child };
});

import { Database } from '../../src/core/database.ts';
import { reconcileLidMappings } from '../../src/core/lid-resolver.ts';
import { createChildLogger } from '../../src/logger.ts';

const L6_WARN = 'L6: new unresolved LIDs found during reconciliation';

const LID_A = '11111120';
const LID_B = '11111121';
const LID_OLD = '11111122';
const LID_NEW = '11111123';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

let msgSeq = 0;
function insertLidMessage(db: Database, lid: string): void {
  msgSeq += 1;
  db.raw
    .prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`${lid}@lid`, `${lid}@lid`, `${lid}@lid`, `m-${msgSeq}`, msgSeq);
}

function maxPk(db: Database): number {
  const row = db.raw.prepare('SELECT MAX(pk) AS m FROM messages').get() as { m: number | null };
  return row.m ?? 0;
}

function freshState(lastMaxPk = 0): { lastMaxPk: number; knownUnresolvedLids: Set<string> } {
  return { lastMaxPk, knownUnresolvedLids: new Set<string>() };
}

// Count only the L6 warns emitted during reconcile (Database migrations may log
// other warns during db.open(); tests clear the spy before the reconcile call).
function l6WarnCount(): number {
  const warn = createChildLogger('t').warn as ReturnType<typeof vi.fn>;
  return warn.mock.calls.filter((c) => c[1] === L6_WARN).length;
}
function clearWarn(): void {
  (createChildLogger('t').warn as ReturnType<typeof vi.fn>).mockClear();
}

describe('reconcileLidMappings — #1781 dedup + bounded scan', () => {
  let db: Database;
  const dir = ''; // authDir unused: no auth files, hydration is a no-op here.

  beforeEach(() => {
    db = freshDb();
    clearWarn();
  });
  afterEach(() => {
    db.close();
  });

  it('returns the per-sweep delta of newly-appeared unresolvable LIDs', () => {
    const state = freshState();
    insertLidMessage(db, LID_A);

    const pass1 = reconcileLidMappings(db, dir, state);
    expect(pass1.newUnresolvedLids).toEqual([LID_A]);
    expect(pass1.unresolvedLids).toContain(LID_A);
  });

  it('does NOT re-warn an already-known unresolvable LID on a later sweep', () => {
    const state = freshState();
    insertLidMessage(db, LID_A);

    reconcileLidMappings(db, dir, state);
    expect(l6WarnCount()).toBe(1); // warned once for LID_A

    // Second sweep, no new messages: LID_A is already known → must NOT re-warn.
    const pass2 = reconcileLidMappings(db, dir, state);
    expect(l6WarnCount()).toBe(1); // still 1 — no spam
    expect(pass2.newUnresolvedLids).toEqual([]); // empty delta
    expect(pass2.unresolvedLids).toContain(LID_A); // cohort still tracked
  });

  it('warns only on the delta when the cohort grows', () => {
    const state = freshState();
    insertLidMessage(db, LID_A);
    reconcileLidMappings(db, dir, state);
    clearWarn();

    insertLidMessage(db, LID_B);
    const pass2 = reconcileLidMappings(db, dir, state);
    expect(pass2.newUnresolvedLids).toEqual([LID_B]); // only the new one
    expect(l6WarnCount()).toBe(1);
    const warn = createChildLogger('t').warn as ReturnType<typeof vi.fn>;
    const l6call = warn.mock.calls.find((c) => c[1] === L6_WARN)!;
    expect(l6call[0]).toMatchObject({ lids: [LID_B] });
  });

  it('bounds the scan by the high-water mark — a pre-HWM untracked LID is not re-scanned', () => {
    // Seed a message for LID_OLD, advance the HWM past it, but deliberately do
    // NOT track LID_OLD in the carried cohort. A bounded (pk > lastMaxPk) scan
    // must skip LID_OLD entirely; a full-table scan would surface it as "new".
    insertLidMessage(db, LID_OLD);
    const state = freshState(maxPk(db));

    insertLidMessage(db, LID_NEW); // strictly higher pk than the HWM
    const out = reconcileLidMappings(db, dir, state);

    expect(out.newUnresolvedLids).toEqual([LID_NEW]); // LID_OLD skipped by the bound
    expect(out.unresolvedLids).toContain(LID_NEW);
    expect(out.unresolvedLids).not.toContain(LID_OLD);
    expect(l6WarnCount()).toBe(1);
    expect(state.lastMaxPk).toBe(maxPk(db)); // HWM advanced to the newest row
  });

  it('still resolves a resolvable LID: it leaves the cohort once a mapping exists', () => {
    const state = freshState();
    insertLidMessage(db, LID_A);
    const pass1 = reconcileLidMappings(db, dir, state);
    expect(pass1.unresolvedLids).toContain(LID_A);

    // A mapping arrives (simulating an L1–L5 write). The next sweep must drop
    // LID_A from the unresolvable cohort — reconciliation's real job.
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run(LID_A, '15550009@s.whatsapp.net');

    const pass2 = reconcileLidMappings(db, dir, state);
    expect(pass2.unresolvedLids).not.toContain(LID_A); // resolved → left the cohort
    expect(pass2.newUnresolvedLids).toEqual([]);
  });
});
