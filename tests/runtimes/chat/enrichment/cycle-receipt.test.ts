import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../../src/core/database.ts';
import {
  readOnlineEnrichmentCycleLedger,
  readLatestEnrichmentCycleReceipt,
  writeEnrichmentCycleReceipt,
} from '../../../../src/runtimes/chat/enrichment/cycle-receipt.ts';

describe('enrichment cycle receipts', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('persists a bounded failed segment receipt without an error string', () => {
    writeEnrichmentCycleReceipt(db, {
      source: 'online',
      status: 'failed',
      failureCode: 'segment_failed',
      stage: 'segment',
      retryable: true,
      evidenceCoverage: 'typed',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      successAt: null,
      messagesSelected: 2,
      messagesSucceeded: 0,
      messagesDeferred: 2,
      messagesTerminal: 0,
      factsExtracted: 0,
      factsQueued: 0,
    });

    expect(readLatestEnrichmentCycleReceipt(db)).toEqual({
      source: 'online',
      status: 'failed',
      failureCode: 'segment_failed',
      stage: 'segment',
      retryable: true,
      evidenceCoverage: 'typed',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      successAt: null,
      messagesSelected: 2,
      messagesSucceeded: 0,
      messagesDeferred: 2,
      messagesTerminal: 0,
      factsExtracted: 0,
      factsQueued: 0,
    });
  });

  it('reads the latest online receipt without being poisoned by a later legacy row', () => {
    writeEnrichmentCycleReceipt(db, {
      source: 'online',
      status: 'completed',
      failureCode: 'none',
      stage: 'none',
      retryable: false,
      evidenceCoverage: 'typed',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      successAt: '2026-07-30T00:00:01.000Z',
      messagesSelected: 1,
      messagesSucceeded: 1,
      messagesDeferred: 0,
      messagesTerminal: 0,
      factsExtracted: 1,
      factsQueued: 1,
    });
    writeEnrichmentCycleReceipt(db, {
      source: 'legacy',
      status: 'legacy_unclassified',
      failureCode: 'legacy_unclassified',
      stage: 'none',
      retryable: false,
      evidenceCoverage: 'legacy_unclassified',
      startedAt: '2026-07-30T00:00:02.000Z',
      completedAt: '2026-07-30T00:00:03.000Z',
      successAt: null,
      messagesSelected: 0,
      messagesSucceeded: 0,
      messagesDeferred: 0,
      messagesTerminal: 0,
      factsExtracted: 0,
      factsQueued: 0,
    });

    expect(readLatestEnrichmentCycleReceipt(db)).toMatchObject({
      source: 'online',
      status: 'completed',
    });
  });

  it('fails closed when the latest online receipt has an invalid timestamp', () => {
    writeEnrichmentCycleReceipt(db, {
      source: 'online',
      status: 'completed',
      failureCode: 'none',
      stage: 'none',
      retryable: false,
      evidenceCoverage: 'typed',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      successAt: '2026-07-30T00:00:01.000Z',
      messagesSelected: 0,
      messagesSucceeded: 0,
      messagesDeferred: 0,
      messagesTerminal: 0,
      factsExtracted: 0,
      factsQueued: 0,
    });
    db.raw.prepare("UPDATE enrichment_runs SET success_at = 'not-a-timestamp' WHERE source = 'online'").run();

    expect(readOnlineEnrichmentCycleLedger(db)).toEqual({ state: 'invalid' });
  });

  it('fails closed when a completed receipt does not account for every selected message', () => {
    writeEnrichmentCycleReceipt(db, {
      source: 'online',
      status: 'completed',
      failureCode: 'none',
      stage: 'none',
      retryable: false,
      evidenceCoverage: 'typed',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      successAt: '2026-07-30T00:00:01.000Z',
      messagesSelected: 1,
      messagesSucceeded: 0,
      messagesDeferred: 0,
      messagesTerminal: 0,
      factsExtracted: 0,
      factsQueued: 0,
    });

    expect(readOnlineEnrichmentCycleLedger(db)).toEqual({ state: 'invalid' });
  });

  it('fails closed when a terminal receipt is missing its completion timestamp', () => {
    writeEnrichmentCycleReceipt(db, {
      source: 'online',
      status: 'completed',
      failureCode: 'none',
      stage: 'none',
      retryable: false,
      evidenceCoverage: 'typed',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      successAt: '2026-07-30T00:00:01.000Z',
      messagesSelected: 0,
      messagesSucceeded: 0,
      messagesDeferred: 0,
      messagesTerminal: 0,
      factsExtracted: 0,
      factsQueued: 0,
    });
    db.raw.prepare('UPDATE enrichment_runs SET completed_at = NULL WHERE source = \'online\'').run();

    expect(readOnlineEnrichmentCycleLedger(db)).toEqual({ state: 'invalid' });
  });

  it('does not promote a malformed earlier success as the last proven success', () => {
    writeEnrichmentCycleReceipt(db, {
      source: 'online',
      status: 'completed',
      failureCode: 'none',
      stage: 'none',
      retryable: false,
      evidenceCoverage: 'typed',
      startedAt: '2026-07-30T00:00:00.000Z',
      completedAt: '2026-07-30T00:00:01.000Z',
      successAt: '2026-07-30T00:00:01.000Z',
      messagesSelected: 0,
      messagesSucceeded: 0,
      messagesDeferred: 0,
      messagesTerminal: 0,
      factsExtracted: 0,
      factsQueued: 0,
    });
    writeEnrichmentCycleReceipt(db, {
      source: 'online',
      status: 'failed',
      failureCode: 'selection_failed',
      stage: 'selection',
      retryable: true,
      evidenceCoverage: 'typed',
      startedAt: '2026-07-30T00:00:02.000Z',
      completedAt: '2026-07-30T00:00:03.000Z',
      successAt: null,
      messagesSelected: 0,
      messagesSucceeded: 0,
      messagesDeferred: 0,
      messagesTerminal: 0,
      factsExtracted: 0,
      factsQueued: 0,
    });
    db.raw.prepare(`
      UPDATE enrichment_runs
      SET status = 'failed', failure_code = 'segment_failed', stage = 'segment'
      WHERE run_id = 1
    `).run();

    expect(readOnlineEnrichmentCycleLedger(db)).toEqual({ state: 'invalid' });
  });
});
