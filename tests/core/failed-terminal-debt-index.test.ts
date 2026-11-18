/**
 * The failed-terminal reply-debt selector runs on every supervisor health read
 * and, keyed per aged record, inside the terminal-records retention DELETE.
 * Both must reach debt rows through the partial debt index: no full scan of
 * terminal history or inbound events for this term, and no per-candidate
 * re-run of the whole debt set inside the retention write transaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { AGED_TERMINAL_RECORDS_DELETE_SQL } from '../../src/core/database-retention.ts';
import { TURN_RECOVERY_SUPERVISOR_COUNTS_SQL } from '../../src/core/turn-recovery-store.ts';

const DEBT_INDEX_READ = /^(SCAN|SEARCH) debt_terminal USING (COVERING )?INDEX idx_turn_terminal_failed_reply_debt\b/;
const DEBT_INDEX_PROBE = /^SEARCH debt_terminal USING (COVERING )?INDEX idx_turn_terminal_failed_reply_debt \(inbound_seq=\?\)$/;
const FULL_DEBT_TERM_SCAN = /^SCAN debt_(terminal|source)$/;
const SOURCE_BY_ROW_ID = 'SEARCH debt_source USING INTEGER PRIMARY KEY (rowid=?)';

describe('failed-terminal reply debt query plans', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });
  afterEach(() => db.close());

  function planDetails(sql: string): string[] {
    return (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((step) => step.detail);
  }

  it('reads health debt through the debt index and finds each source by row id', () => {
    const details = planDetails(TURN_RECOVERY_SUPERVISOR_COUNTS_SQL);

    expect(details.filter((detail) => FULL_DEBT_TERM_SCAN.test(detail))).toEqual([]);
    expect(details.filter((detail) => DEBT_INDEX_READ.test(detail))).toHaveLength(1);
    expect(details).toContain(SOURCE_BY_ROW_ID);
  });

  it('probes retention debt by key instead of re-running the debt set per candidate', () => {
    const details = planDetails(AGED_TERMINAL_RECORDS_DELETE_SQL);

    expect(details.filter((detail) => /^(CO-ROUTINE|MATERIALIZE)\b/.test(detail))).toEqual([]);
    expect(details.filter((detail) => FULL_DEBT_TERM_SCAN.test(detail))).toEqual([]);
    expect(details.filter((detail) => DEBT_INDEX_PROBE.test(detail))).toHaveLength(1);
    expect(details).toContain(SOURCE_BY_ROW_ID);
  });
});
