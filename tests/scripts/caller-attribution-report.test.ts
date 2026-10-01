/**
 * #3421 step 1: the read-only caller-attribution report.
 *
 * Seeds tool_calls rows through the real DurabilityEngine writer on a real
 * migrated database, then checks the report's exact counts, its window, an
 * empty window, and the dated receipt it writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  TOOL_FAILURE_DISPOSITIONS,
  type ToolCallCallerEvidence,
  type ToolFailureEvidence,
} from '../../src/core/durability-evidence-contract.ts';
import {
  buildCallerAttributionReport,
  getMidTurnCallCounts,
  getMidTurnOutsideCallCounts,
  getSensitiveOutsideCallCounts,
  parseCallerAttributionArgs,
  writeCallerAttributionReceipt,
} from '../../scripts/caller-attribution-report.ts';

const NOW = new Date('2026-09-25T12:00:00.000Z');

const TURN_AGENT: ToolCallCallerEvidence = {
  transport: 'in_process',
  connectionId: null,
  clientName: null,
  clientVersion: null,
  tokenResult: 'not_applicable',
  turnOwned: true,
  actorSource: 'executing_turn',
  toolSensitive: false,
};

function outside(overrides: Partial<ToolCallCallerEvidence>): ToolCallCallerEvidence {
  return {
    transport: 'socket',
    connectionId: 'abc:1',
    clientName: 'probe-client',
    clientVersion: '1.0.0',
    tokenResult: 'absent',
    turnOwned: false,
    actorSource: 'executing_turn',
    toolSensitive: false,
    ...overrides,
  };
}

interface Seed {
  tool: string;
  createdAt: string;
  caller: ToolCallCallerEvidence | null;
  /** Finished through the real writer; absent leaves the row open. */
  finish?: 'admitted' | 'denied';
}

const DENIED: ToolFailureEvidence = {
  failureCode: 'authorization_denied',
  failureStage: 'authorization',
  ...TOOL_FAILURE_DISPOSITIONS.authorization_denied,
  evidenceCoverage: 'complete',
};

function seed(db: Database, rows: Seed[]): void {
  const engine = new DurabilityEngine(db);
  for (const row of rows) {
    const id = engine.recordToolCall('conv-1', row.tool, 'chat', 'safe', undefined, null, row.caller);
    if (row.finish === 'admitted') engine.markToolComplete(id, { isError: false, durationMs: 1 });
    if (row.finish === 'denied') engine.markToolComplete(id, { isError: true, durationMs: 1, failure: DENIED });
    // Only the timestamp is backdated by hand, so rows land on known days.
    db.raw.prepare('UPDATE tool_calls SET created_at = ? WHERE id = ?').run(row.createdAt, id);
  }
}

const ROWS: Seed[] = [
  // Inside the 30-day window.
  { tool: 'list_chats', createdAt: '2026-09-24 10:00:00', caller: TURN_AGENT },
  { tool: 'list_chats', createdAt: '2026-09-24 10:01:00', caller: outside({}) },
  { tool: 'list_chats', createdAt: '2026-09-24 10:02:00', caller: outside({}) },
  { tool: 'send_message', createdAt: '2026-09-24 10:03:00', caller: outside({ clientName: null }) },
  { tool: 'list_chats', createdAt: '2026-09-25 09:00:00', caller: outside({ actorSource: 'none' }) },
  {
    tool: 'logout',
    createdAt: '2026-09-25 09:30:00',
    caller: outside({ toolSensitive: true, actorSource: 'none' }),
    finish: 'admitted',
  },
  {
    tool: 'logout',
    createdAt: '2026-09-25 09:31:00',
    caller: outside({ toolSensitive: true }),
    finish: 'denied',
  },
  // A turn's own sensitive call is not an outside call.
  { tool: 'logout', createdAt: '2026-09-25 09:32:00', caller: { ...TURN_AGENT, toolSensitive: true }, finish: 'admitted' },
  // Legacy row with no attribution: counted nowhere.
  { tool: 'list_chats', createdAt: '2026-09-25 09:40:00', caller: null },
  // Outside the window.
  { tool: 'list_chats', createdAt: '2026-08-20 10:00:00', caller: outside({}) },
];

describe('caller-attribution report (#3421 step 1)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('counts mid-turn outside calls per day and client, with the mid-turn denominator', () => {
    seed(db, ROWS);
    const since = '2026-08-26 12:00:00';
    expect(getMidTurnOutsideCallCounts(db.raw, since)).toEqual([
      { day: '2026-09-24', clientName: null, count: 1 },
      { day: '2026-09-24', clientName: 'probe-client', count: 2 },
      { day: '2026-09-25', clientName: 'probe-client', count: 1 },
    ]);
    expect(getMidTurnCallCounts(db.raw, since)).toEqual([
      { day: '2026-09-24', count: 4 },
      { day: '2026-09-25', count: 2 },
    ]);
  });

  it('counts sensitive outside calls by outcome, excluding the turn\'s own calls', () => {
    seed(db, ROWS);
    expect(getSensitiveOutsideCallCounts(db.raw, '2026-08-26 12:00:00')).toEqual([
      { toolName: 'logout', outcomeCode: 'failure', failureCode: 'authorization_denied', count: 1 },
      { toolName: 'logout', outcomeCode: 'success', failureCode: null, count: 1 },
    ]);
  });

  it('builds the report over the window ending now, with attribution coverage', () => {
    seed(db, ROWS);
    expect(buildCallerAttributionReport(db.raw, { now: NOW, windowDays: 30 })).toEqual({
      report: 'caller-attribution',
      issue: 3421,
      generatedAt: '2026-09-25T12:00:00.000Z',
      windowDays: 30,
      since: '2026-08-26 12:00:00',
      toolCalls: { total: 9, attributed: 8 },
      midTurnOutsideCalls: [
        { day: '2026-09-24', clientName: null, count: 1 },
        { day: '2026-09-24', clientName: 'probe-client', count: 2 },
        { day: '2026-09-25', clientName: 'probe-client', count: 1 },
      ],
      midTurnCalls: [
        { day: '2026-09-24', count: 4 },
        { day: '2026-09-25', count: 2 },
      ],
      sensitiveOutsideCalls: [
        { toolName: 'logout', outcomeCode: 'failure', failureCode: 'authorization_denied', count: 1 },
        { toolName: 'logout', outcomeCode: 'success', failureCode: null, count: 1 },
      ],
    });
  });

  it('reports an empty window as zero counts, not an error', () => {
    seed(db, ROWS);
    const report = buildCallerAttributionReport(db.raw, { now: new Date('2026-12-31T00:00:00.000Z'), windowDays: 1 });
    expect(report).toMatchObject({
      toolCalls: { total: 0, attributed: 0 },
      midTurnOutsideCalls: [],
      midTurnCalls: [],
      sensitiveOutsideCalls: [],
    });
  });

  it('writes a dated receipt from a read-only open of the database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wa-caller-report-'));
    const dbPath = join(dir, 'bot.db');
    const fileDb = new Database(dbPath);
    fileDb.open();
    seed(fileDb, ROWS.slice(0, 2));
    fileDb.close();
    const outDir = join(dir, 'out');

    const written = writeCallerAttributionReceipt({ dbPath, outDir, windowDays: 30, now: NOW });

    expect(written).toBe(join(outDir, 'caller-attribution-2026-09-25.json'));
    expect(readdirSync(outDir)).toEqual(['caller-attribution-2026-09-25.json']);
    const receipt = JSON.parse(readFileSync(written, 'utf8')) as Record<string, unknown>;
    expect(receipt['toolCalls']).toEqual({ total: 2, attributed: 2 });
    expect(receipt['midTurnOutsideCalls']).toEqual([{ day: '2026-09-24', clientName: 'probe-client', count: 1 }]);
  });

  it('keeps the window inside the 30-day tool_calls retention', () => {
    expect(parseCallerAttributionArgs(['--db', '/x/bot.db', '--out-dir', '/x/out'])).toEqual({
      dbPath: '/x/bot.db',
      outDir: '/x/out',
      windowDays: 30,
    });
    expect(parseCallerAttributionArgs(['--db', 'a', '--out-dir', 'b', '--window-days', '7']).windowDays).toBe(7);
    expect(() => parseCallerAttributionArgs(['--db', 'a', '--out-dir', 'b', '--window-days', '31']))
      .toThrow(/window-days must be an integer from 1 to 30/);
    expect(() => parseCallerAttributionArgs(['--out-dir', 'b'])).toThrow(/--db is required/);
  });
});
