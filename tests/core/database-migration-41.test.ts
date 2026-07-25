import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, CURRENT_SCHEMA_MIGRATION } from '../../src/core/database.ts';

describe('migration 41 recovery evidence', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('installs the additive plan, disposition, corroboration, and run linkage schema', () => {
    expect(CURRENT_SCHEMA_MIGRATION).toBe(46);
    for (const table of [
      'recovery_plans',
      'inbound_disposition_links',
      'turn_delivery_corroboration',
    ]) {
      expect(db.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table)).toEqual({ name: table });
    }
    const runColumns = db.raw.prepare("PRAGMA table_info('recovery_runs')").all() as Array<{ name: string }>;
    expect(runColumns.map((column) => column.name)).toContain('recovery_plan_id');
    expect(db.raw.prepare('SELECT version FROM schema_migrations WHERE version = 41').get())
      .toEqual({ version: 41 });
  });

  it('accepts ID-ordered same-second corroboration and rejects invalid proof', () => {
    const fixture = installCorroborationFixture();
    expect(() => db.raw.prepare(`
      INSERT INTO turn_delivery_corroboration (
        terminal_record_id, corroborating_op_id, basis, actor
      ) VALUES (?, ?, 'same_source_later_echoed_op', 'test')
    `).run(fixture.terminalRecordId, fixture.laterOpId)).not.toThrow();

    expect(() => db.raw.prepare(`
      INSERT INTO turn_delivery_corroboration (
        terminal_record_id, corroborating_op_id, basis, actor
      ) VALUES (?, ?, 'same_source_later_echoed_op', 'test')
    `).run(fixture.terminalRecordId, fixture.crossChatOpId)).toThrow('invalid delivery corroboration');
    expect(() => db.raw.prepare(`
      UPDATE outbound_ops SET payload = '{"changed":true}' WHERE id = ?
    `).run(fixture.laterOpId)).toThrow('corroborating outbound proof is immutable');
    expect(() => db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?')
      .run(fixture.laterOpId)).toThrow('corroborating outbound proof must be retained');
  });

  it.each([
    ['a different terminal inbound sequence', (fixture: CorroborationFixture) => {
      db.raw.prepare(`
        UPDATE turn_terminal_records
        SET inbound_seq = inbound_seq + 1000,
            inbound_seq_key = inbound_seq_key + 1000
        WHERE id = ?
      `).run(fixture.terminalRecordId);
    }],
    ['a null terminal inbound sequence', (fixture: CorroborationFixture) => {
      db.raw.prepare(`
        UPDATE turn_terminal_records SET inbound_seq = NULL, inbound_seq_key = -1
        WHERE id = ?
      `).run(fixture.terminalRecordId);
    }],
    ['a different terminal conversation', (fixture: CorroborationFixture) => {
      db.raw.prepare(`
        UPDATE turn_terminal_records SET conversation_key = 'other-conversation'
        WHERE id = ?
      `).run(fixture.terminalRecordId);
    }],
    ['a different terminal delivery JID', (fixture: CorroborationFixture) => {
      db.raw.prepare(`
        UPDATE turn_terminal_records SET delivery_jid = 'other@g.us'
        WHERE id = ?
      `).run(fixture.terminalRecordId);
    }],
    ['a different terminal conversation and delivery JID', (fixture: CorroborationFixture) => {
      db.raw.prepare(`
        UPDATE turn_terminal_records
        SET conversation_key = 'other-conversation', delivery_jid = 'other@g.us'
        WHERE id = ?
      `).run(fixture.terminalRecordId);
    }],
    ['a selected outbound that is not terminal', (fixture: CorroborationFixture) => {
      db.raw.prepare('UPDATE outbound_ops SET is_terminal = 0 WHERE id = ?')
        .run(fixture.selectedOpId);
    }],
  ] as const)('rejects corroboration when selected outbound is bound to %s', (_case, mismatch) => {
    const fixture = installCorroborationFixture();
    mismatch(fixture);

    expect(() => db.raw.prepare(`
      INSERT INTO turn_delivery_corroboration (
        terminal_record_id, corroborating_op_id, basis, actor
      ) VALUES (?, ?, 'same_source_later_echoed_op', 'test')
    `).run(fixture.terminalRecordId, fixture.laterOpId))
      .toThrow('invalid delivery corroboration');
  });

  it.each([
    ['cross-conversation target', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE inbound_events SET conversation_key = 'other-conversation' WHERE seq = ?`)
        .run(fixture.targetSeq);
    }],
    ['cross-chat target', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE inbound_events SET chat_jid = 'other@g.us' WHERE seq = ?`)
        .run(fixture.targetSeq);
    }],
    ['incomplete target status', (fixture: ClosureFixture) => {
      db.raw.prepare(`
        UPDATE inbound_events
        SET processing_status = 'processing', completed_at = NULL
        WHERE seq = ?
      `).run(fixture.targetSeq);
    }],
    ['missing target completion timestamp', (fixture: ClosureFixture) => {
      db.raw.prepare('UPDATE inbound_events SET completed_at = NULL WHERE seq = ?')
        .run(fixture.targetSeq);
    }],
    ['non-replied terminal disposition', (fixture: ClosureFixture) => {
      db.raw.prepare(`
        UPDATE turn_terminal_records SET inbound_disposition = 'failed_terminal'
        WHERE id = ?
      `).run(fixture.terminalRecordId);
    }],
    ['cross-conversation terminal', (fixture: ClosureFixture) => {
      db.raw.prepare(`
        UPDATE turn_terminal_records SET conversation_key = 'other-conversation'
        WHERE id = ?
      `).run(fixture.terminalRecordId);
    }],
    ['cross-chat terminal', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE turn_terminal_records SET delivery_jid = 'other@g.us' WHERE id = ?`)
        .run(fixture.terminalRecordId);
    }],
    ['cross-source selected outbound', (fixture: ClosureFixture) => {
      db.raw.prepare('UPDATE outbound_ops SET source_inbound_seq = source_inbound_seq + 1000 WHERE id = ?')
        .run(fixture.selectedOpId);
    }],
    ['cross-conversation selected outbound', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE outbound_ops SET conversation_key = 'other-conversation' WHERE id = ?`)
        .run(fixture.selectedOpId);
    }],
    ['cross-chat selected outbound', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE outbound_ops SET chat_jid = 'other@g.us' WHERE id = ?`)
        .run(fixture.selectedOpId);
    }],
    ['selected outbound without delivery proof', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE outbound_ops SET status = 'submitted', echoed_at = NULL WHERE id = ?`)
        .run(fixture.selectedOpId);
    }],
    ['non-terminal selected outbound', (fixture: ClosureFixture) => {
      db.raw.prepare('UPDATE outbound_ops SET is_terminal = 0 WHERE id = ?')
        .run(fixture.selectedOpId);
    }],
  ] as const)('rejects an unproven closure with a %s', (_case, invalidate) => {
    const fixture = installClosureFixture();
    invalidate(fixture);

    expect(() => insertClosure(fixture)).toThrow('invalid operator catch-up closure');
  });

  it('rejects a closure without a matching pending source and plan', () => {
    const fixture = installClosureFixture(false);
    expect(() => insertClosure(fixture)).toThrow('invalid operator catch-up closure');
  });

  it('accepts a fully linked closure and permits only one closure per source and plan', () => {
    const fixture = installClosureFixture();
    expect(() => insertClosure(fixture)).not.toThrow();

    const secondTarget = installClosureTarget(fixture.conversationKey, fixture.chatJid, 'second');
    expect(() => insertClosure({ ...fixture, ...secondTarget }))
      .toThrow('invalid operator catch-up closure');
  });

  it('retains corroboration as replay-blocking evidence without authorizing a new closure', () => {
    const fixture = installClosureFixture();
    db.raw.prepare(`
      UPDATE turn_terminal_records
      SET delivery_kind = 'delivery_unknown', reply_guarantee_disarmed = 0
      WHERE id = ?
    `).run(fixture.terminalRecordId);
    db.raw.prepare(`
      UPDATE outbound_ops SET status = 'maybe_sent', echoed_at = NULL WHERE id = ?
    `).run(fixture.selectedOpId);
    const corroboratingOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, source_inbound_seq,
        is_terminal, replay_policy, echoed_at
      ) VALUES (?, ?, 'text', '{}', 'echoed', ?, 0, 'unsafe', datetime('now'))
    `).run(fixture.conversationKey, fixture.chatJid, fixture.targetSeq).lastInsertRowid);
    db.raw.prepare(`
      INSERT INTO turn_delivery_corroboration (
        terminal_record_id, corroborating_op_id, basis, actor
      ) VALUES (?, ?, 'same_source_later_echoed_op', 'test')
    `).run(fixture.terminalRecordId, corroboratingOpId);

    expect(() => insertClosure(fixture)).toThrow('invalid operator catch-up closure');
  });

  it.each([
    ['terminal identity', (fixture: ClosureFixture) => {
      db.raw.prepare(`
        UPDATE turn_terminal_records SET conversation_key = 'rewritten-conversation'
        WHERE id = ?
      `).run(fixture.terminalRecordId);
    }, 'operator catch-up terminal proof is immutable'],
    ['terminal delivery kind', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE turn_terminal_records SET delivery_kind = 'enqueued' WHERE id = ?`)
        .run(fixture.terminalRecordId);
    }, 'operator catch-up terminal proof is immutable'],
    ['terminal deletion', (fixture: ClosureFixture) => {
      db.raw.prepare('DELETE FROM turn_terminal_records WHERE id = ?')
        .run(fixture.terminalRecordId);
    }, 'operator catch-up terminal proof must be retained'],
    ['selected outbound identity', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE outbound_ops SET chat_jid = 'rewritten@g.us' WHERE id = ?`)
        .run(fixture.selectedOpId);
    }, 'operator catch-up selected outbound proof is immutable'],
    ['selected outbound status', (fixture: ClosureFixture) => {
      db.raw.prepare(`UPDATE outbound_ops SET status = 'failed_permanent' WHERE id = ?`)
        .run(fixture.selectedOpId);
    }, 'operator catch-up selected outbound proof is immutable'],
    ['selected outbound deletion', (fixture: ClosureFixture) => {
      db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?').run(fixture.selectedOpId);
    }, 'operator catch-up selected outbound proof must be retained'],
  ] as const)('retains direct echoed closure proof against %s mutation', (
    _case,
    mutate,
    expectedError,
  ) => {
    const fixture = installClosureFixture();
    insertClosure(fixture);

    expect(() => mutate(fixture)).toThrow(expectedError);
  });

  it.each([
    ['terminal delivery kind', (fixture: CorroborationFixture) => {
      db.raw.prepare(`UPDATE turn_terminal_records SET delivery_kind = 'echoed' WHERE id = ?`)
        .run(fixture.terminalRecordId);
    }, 'corroborated terminal proof is immutable'],
    ['terminal selected operation', (fixture: CorroborationFixture) => {
      db.raw.prepare('UPDATE turn_terminal_records SET delivery_op_id = ? WHERE id = ?')
        .run(fixture.laterOpId, fixture.terminalRecordId);
    }, 'corroborated terminal proof is immutable'],
    ['terminal record deletion', (fixture: CorroborationFixture) => {
      db.raw.prepare('DELETE FROM turn_terminal_records WHERE id = ?')
        .run(fixture.terminalRecordId);
    }, 'corroborated terminal proof must be retained'],
    ['selected outbound identity', (fixture: CorroborationFixture) => {
      db.raw.prepare(`UPDATE outbound_ops SET chat_jid = 'rewritten@g.us' WHERE id = ?`)
        .run(fixture.selectedOpId);
    }, 'corroborated selected outbound proof is immutable'],
    ['selected outbound delivery state', (fixture: CorroborationFixture) => {
      db.raw.prepare(`UPDATE outbound_ops SET status = 'failed_permanent' WHERE id = ?`)
        .run(fixture.selectedOpId);
    }, 'corroborated selected outbound proof is immutable'],
    ['selected outbound deletion', (fixture: CorroborationFixture) => {
      db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?').run(fixture.selectedOpId);
    }, 'corroborated selected outbound proof must be retained'],
  ] as const)('retains the %s after corroboration', (_case, mutate, expectedError) => {
    const fixture = installCorroborationFixture();
    db.raw.prepare(`
      INSERT INTO turn_delivery_corroboration (
        terminal_record_id, corroborating_op_id, basis, actor
      ) VALUES (?, ?, 'same_source_later_echoed_op', 'test')
    `).run(fixture.terminalRecordId, fixture.laterOpId);

    expect(() => mutate(fixture)).toThrow(expectedError);
  });

  it('enforces pending-link uniqueness, nullability, and append-only source proof', () => {
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES ('plan-41', 'pre_connect_recovery', 'test', 'fixture')
    `).run();
    const sourceSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason, failure_class
      ) VALUES ('source-41', 'conversation-41', 'chat@g.us', 'failed',
                datetime('now'), 'error', 'crash_recovery')
    `).run().lastInsertRowid);
    const insert = db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, actor
      ) VALUES (?, 'plan-41', 'recovery_pending_operator_catchup', NULL,
                'crash recovery', 'test')
    `);
    insert.run(sourceSeq);
    expect(() => insert.run(sourceSeq)).toThrow(/UNIQUE/);
    expect(() => db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, actor
      ) VALUES (?, 'plan-41', 'superseded_by_operator_catchup', NULL,
                'invalid', 'test')
    `).run(sourceSeq)).toThrow(/CHECK/);
    expect(() => db.raw.prepare(`
      UPDATE inbound_events SET message_id = 'rewritten' WHERE seq = ?
    `).run(sourceSeq)).toThrow('disposition inbound proof is immutable');
    expect(() => db.raw.prepare('DELETE FROM inbound_disposition_links WHERE inbound_seq = ?')
      .run(sourceSeq)).toThrow('inbound_disposition_links is append-only');
  });

  function installCorroborationFixture(): {
    terminalRecordId: number;
    selectedOpId: number;
    laterOpId: number;
    crossChatOpId: number;
  } {
    const inboundSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status)
      VALUES ('corroboration-41', 'conversation-41', 'chat@g.us', 'processing')
    `).run().lastInsertRowid);
    const selectedOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at,
        source_inbound_seq, is_terminal, replay_policy
      ) VALUES ('conversation-41', 'chat@g.us', 'text', '{}', 'maybe_sent',
                '2026-07-13 04:00:00', ?, 1, 'unsafe')
    `).run(inboundSeq).lastInsertRowid);
    const laterOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at,
        echoed_at, source_inbound_seq, replay_policy
      ) VALUES ('conversation-41', 'chat@g.us', 'text', '{}', 'echoed',
                '2026-07-13 04:00:00', '2026-07-13 04:00:00', ?, 'unsafe')
    `).run(inboundSeq).lastInsertRowid);
    const crossChatOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at,
        echoed_at, source_inbound_seq, replay_policy
      ) VALUES ('other-conversation', 'other@g.us', 'text', '{}', 'echoed',
                '2026-07-13 04:00:00', '2026-07-13 04:00:00', ?, 'unsafe')
    `).run(inboundSeq).lastInsertRowid);
    const terminalRecordId = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', 'conversation-41', 'chat@g.us', ?, ?,
                'turn-41', 'manager-41', 1, 'failed', 'failed_terminal',
                'delivery_unknown', ?, 0)
    `).run(inboundSeq, inboundSeq, selectedOpId).lastInsertRowid);
    return { terminalRecordId, selectedOpId, laterOpId, crossChatOpId };
  }

  interface ClosureFixture {
    planId: string;
    conversationKey: string;
    chatJid: string;
    sourceSeq: number;
    targetSeq: number;
    terminalRecordId: number;
    selectedOpId: number;
  }

  type CorroborationFixture = ReturnType<typeof installCorroborationFixture>;

  function installClosureFixture(withPending = true): ClosureFixture {
    const planId = 'plan-41-closure';
    const conversationKey = 'conversation-41-closure';
    const chatJid = 'closure@g.us';
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES (?, 'operator', 'test', 'closure fixture')
    `).run(planId);
    const sourceSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason, failure_class
      ) VALUES ('source-41-closure', ?, ?, 'failed', datetime('now'),
                'error', 'crash_recovery')
    `).run(conversationKey, chatJid).lastInsertRowid);
    if (withPending) {
      db.raw.prepare(`
        INSERT INTO inbound_disposition_links (
          inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
          reason, actor
        ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                  'pending operator catch-up', 'test')
      `).run(sourceSeq, planId);
    }
    return {
      planId,
      conversationKey,
      chatJid,
      sourceSeq,
      ...installClosureTarget(conversationKey, chatJid, 'first'),
    };
  }

  function installClosureTarget(
    conversationKey: string,
    chatJid: string,
    suffix: string,
  ): Pick<ClosureFixture, 'targetSeq' | 'terminalRecordId' | 'selectedOpId'> {
    const targetSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason
      ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_echoed')
    `).run(`target-41-closure-${suffix}`, conversationKey, chatJid).lastInsertRowid);
    const selectedOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        source_inbound_seq, is_terminal, replay_policy, echoed_at
      ) VALUES (?, ?, 'text', '{}', 'echoed', ?, 1, 'unsafe', datetime('now'))
    `).run(conversationKey, chatJid, targetSeq).lastInsertRowid);
    const terminalRecordId = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, ?, 'manager-41-closure', 1,
                'replied', 'finalized_replied', 'echoed', ?, 1)
    `).run(
      conversationKey,
      chatJid,
      targetSeq,
      targetSeq,
      `turn-41-closure-${suffix}`,
      selectedOpId,
    ).lastInsertRowid);
    return { targetSeq, terminalRecordId, selectedOpId };
  }

  function insertClosure(fixture: ClosureFixture): void {
    db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
                'operator catch-up complete', 'test://migration-41-closure', 'test')
    `).run(fixture.sourceSeq, fixture.planId, fixture.targetSeq);
  }
});
