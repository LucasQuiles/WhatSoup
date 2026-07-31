import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Database } from '../../src/core/database.ts';
import { createOutboundSendsWriter } from '../../src/core/outbound-sends.ts';
import { makeChannelId } from '../../src/core/transport-refs.ts';
import {
  AuthRequiredError,
  SendAmbiguousError,
} from '../../src/transport/contract/errors.ts';

const transportBase = {
  channelId: makeChannelId('whatsapp', 'outbound-audit-test'),
  operation: 'sendText',
  correlationId: 'synthetic-correlation',
  scope: 'provider' as const,
};

describe('outbound_sends metadata-only audit writer', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('keeps removed raw audit fields out of production writer, reader, and health sources', () => {
    const sources = [
      'src/core/outbound-sends.ts',
      'src/mcp/tools/audit.ts',
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const removed of [
      'chat_jid',
      'profile',
      'text_hash',
      'text_length',
      'transport_message_id',
      'error_text',
    ]) {
      expect(sources).not.toContain(removed);
    }
    expect(sources).not.toContain('createHash');
    expect(sources).not.toContain('errorMessage');

    const healthSource = readFileSync('src/core/health.ts', 'utf8');
    expect(healthSource).not.toContain('latest_successful_transport_id');
    expect(healthSource).not.toContain('transport_message_id AS transport_id');
    expect(healthSource).not.toContain("WHERE status = 'sent'");
  });

  it('writeIntent returns an opaque receipt and stores only bounded intent evidence', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'ignored-compatibility-value' });

    const intent = writer.writeIntent({
      caller: 'mcp',
      targetKind: 'alias',
    });

    expect(intent.id).toBeGreaterThan(0);
    expect(intent.auditReceipt).toMatch(/^[0-9a-f]{32}$/);
    expect(db.raw.prepare('SELECT * FROM outbound_sends WHERE id = ?').get(intent.id)).toEqual({
      id: intent.id,
      audit_receipt: intent.auditReceipt,
      schema_version: 1,
      caller: 'mcp',
      target_kind: 'alias',
      outcome_code: 'intent',
      failure_code: null,
      failure_stage: 'not_started',
      mutation_state: 'not_started',
      retryable: null,
      evidence_coverage: 'typed',
      logical_attempt_count: 1,
      provider_submission_count: 0,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
      completed_at: null,
    });
  });

  it('generates a unique random receipt for each logical attempt', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const receipts = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      receipts.add(writer.writeIntent({ caller: 'health', targetKind: 'chatJid' }).auditReceipt);
    }
    expect(receipts.size).toBe(100);
  });

  it('markSuccess records provider acknowledgement as submitted, not recipient delivery', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const { id } = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });

    writer.markSuccess(id);

    expect(db.raw.prepare(`
      SELECT outcome_code, failure_code, failure_stage, mutation_state,
             retryable, evidence_coverage, logical_attempt_count,
             provider_submission_count, completed_at
      FROM outbound_sends WHERE id = ?
    `).get(id)).toEqual({
      outcome_code: 'submitted',
      failure_code: null,
      failure_stage: 'ack_received',
      mutation_state: 'acknowledged',
      retryable: null,
      evidence_coverage: 'typed',
      logical_attempt_count: 1,
      provider_submission_count: 1,
      completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
    });
  });

  it('markFailure records a typed definite no-send outcome without error prose', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const { id } = writer.writeIntent({ caller: 'health', targetKind: 'alias' });

    writer.markFailure(id, new AuthRequiredError({
      ...transportBase,
      message: 'CANARY-RAW-AUTH-ERROR',
    }));

    const row = db.raw.prepare('SELECT * FROM outbound_sends WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      outcome_code: 'failed_not_sent',
      failure_code: 'transport.auth_required',
      failure_stage: 'not_started',
      mutation_state: 'not_mutated',
      retryable: 0,
      evidence_coverage: 'typed',
      provider_submission_count: 0,
    });
    expect(JSON.stringify(row)).not.toContain('CANARY-RAW-AUTH-ERROR');
  });

  it('markFailure preserves typed transport ambiguity without error prose', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const { id } = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });

    writer.markFailure(id, new SendAmbiguousError({
      ...transportBase,
      message: 'CANARY-RAW-AMBIGUOUS-ERROR',
      phase: 'provider_call_started',
    }));

    const row = db.raw.prepare(`
      SELECT outcome_code, failure_code, failure_stage, mutation_state,
             retryable, evidence_coverage
      FROM outbound_sends WHERE id = ?
    `).get(id);
    expect(row).toEqual({
      outcome_code: 'ambiguous',
      failure_code: 'transport.send_ambiguous',
      failure_stage: 'provider_call_started',
      mutation_state: 'maybe_mutated',
      retryable: 0,
      evidence_coverage: 'typed',
    });
    expect(JSON.stringify(row)).not.toContain('CANARY-RAW-AMBIGUOUS-ERROR');
  });

  it('markFailure keeps an untyped throw honestly ambiguous', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const { id } = writer.writeIntent({ caller: 'rgp', targetKind: 'chatJid' });

    writer.markFailure(id, new Error('CANARY-RAW-UNTYPED-ERROR'));

    expect(db.raw.prepare(`
      SELECT outcome_code, failure_code, failure_stage, mutation_state,
             retryable, evidence_coverage
      FROM outbound_sends WHERE id = ?
    `).get(id)).toEqual({
      outcome_code: 'ambiguous',
      failure_code: 'unknown',
      failure_stage: 'unknown',
      mutation_state: 'unknown',
      retryable: 0,
      evidence_coverage: 'untyped',
    });
  });

  it('outcome markers reject a missing or already terminal row', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const { id } = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
    writer.markSuccess(id);

    expect(() => writer.markFailure(id, new Error('late'))).toThrow(/already finalized/i);
    expect(() => writer.markSuccess(id)).toThrow(/already finalized/i);
    expect(() => writer.markSuccess(999_999)).toThrow(/not found/i);
  });

  it('listRecent returns only the closed projection and filters by exact receipt', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const first = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
    const second = writer.writeIntent({ caller: 'health', targetKind: 'alias' });
    writer.markSuccess(first.id);
    writer.markFailure(second.id, new Error('CANARY-LIST-ERROR'));

    const rows = writer.listRecent({ limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: second.id,
      audit_receipt: second.auditReceipt,
      schema_version: 1,
      caller: 'health',
      target_kind: 'alias',
      outcome_code: 'ambiguous',
      failure_code: 'unknown',
      failure_stage: 'unknown',
      mutation_state: 'unknown',
      retryable: false,
      evidence_coverage: 'untyped',
      logical_attempt_count: 1,
      provider_submission_count: 0,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
      completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
    });
    expect(writer.listRecent({ auditReceipt: first.auditReceipt })).toEqual([
      expect.objectContaining({
        id: first.id,
        audit_receipt: first.auditReceipt,
        outcome_code: 'submitted',
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('CANARY-LIST-ERROR');
  });

  it('listRecent clamps large limits and rejects invalid limits or receipts', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    for (let index = 0; index < 120; index += 1) {
      writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
    }

    expect(writer.listRecent({ limit: 500 })).toHaveLength(100);
    expect(() => writer.listRecent({ limit: 0 })).toThrow(/limit must be at least 1/i);
    expect(() => writer.listRecent({ limit: 1.5 })).toThrow(/limit must be an integer/i);
    expect(() => writer.listRecent({ auditReceipt: 'not-a-receipt' })).toThrow(/auditReceipt/i);
  });

  it('previews and applies age retention only to terminal rows', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const oldSubmitted = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
    const oldAmbiguous = writer.writeIntent({ caller: 'health', targetKind: 'alias' });
    const oldIntent = writer.writeIntent({ caller: 'rgp', targetKind: 'chatJid' });
    const recentSubmitted = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
    writer.markSuccess(oldSubmitted.id);
    writer.markFailure(oldAmbiguous.id, new Error('untyped'));
    writer.markSuccess(recentSubmitted.id);
    db.raw.prepare(`
      UPDATE outbound_sends
      SET created_at = datetime('now', '-40 days'),
          completed_at = CASE
            WHEN outcome_code = 'intent' THEN NULL
            ELSE datetime('now', '-40 days')
          END
      WHERE id IN (?, ?, ?)
    `).run(oldSubmitted.id, oldAmbiguous.id, oldIntent.id);

    expect(writer.maintain({
      mode: 'preview',
      terminalDays: 30,
      terminalMaxRows: 10_000,
    })).toEqual({
      mode: 'preview',
      eligibleRows: 2,
      deletedRows: 0,
    });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM outbound_sends').get()).toEqual({ count: 4 });

    expect(writer.maintain({
      mode: 'apply',
      terminalDays: 30,
      terminalMaxRows: 10_000,
    })).toEqual({
      mode: 'apply',
      eligibleRows: 2,
      deletedRows: 2,
    });
    expect(db.raw.prepare(`
      SELECT id, outcome_code FROM outbound_sends ORDER BY id
    `).all()).toEqual([
      { id: oldIntent.id, outcome_code: 'intent' },
      { id: recentSubmitted.id, outcome_code: 'submitted' },
    ]);
  });

  it('caps terminal rows while preserving every unresolved intent', () => {
    const writer = createOutboundSendsWriter({ db: db.raw });
    const unresolved = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
    for (let index = 0; index < 105; index += 1) {
      const { id } = writer.writeIntent({ caller: 'mcp', targetKind: 'chatJid' });
      writer.markSuccess(id);
    }

    expect(writer.maintain({
      mode: 'apply',
      terminalDays: 365,
      terminalMaxRows: 100,
    })).toEqual({
      mode: 'apply',
      eligibleRows: 5,
      deletedRows: 5,
    });
    expect(db.raw.prepare(`
      SELECT outcome_code, COUNT(*) AS count
      FROM outbound_sends GROUP BY outcome_code ORDER BY outcome_code
    `).all()).toEqual([
      { outcome_code: 'intent', count: 1 },
      { outcome_code: 'submitted', count: 100 },
    ]);
    expect(db.raw.prepare('SELECT outcome_code FROM outbound_sends WHERE id = ?').get(unresolved.id))
      .toEqual({ outcome_code: 'intent' });
  });
});
