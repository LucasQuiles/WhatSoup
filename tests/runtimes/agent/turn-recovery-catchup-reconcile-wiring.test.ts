import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { TurnRecoverySupervisor } from '../../../src/runtimes/agent/turn-recovery-supervisor.ts';

/**
 * PR2 wiring: the supervisor's runScan() must invoke the (PR1) catch-up
 * reconciler through the durability surface, bounded per cycle, only when the
 * `catchupReconcile` deploy gate is supplied — and a whole-call reconciler
 * failure must not abort the rest of the scan. Everything here runs against a
 * REAL Database + DurabilityEngine + TurnRecoverySupervisor, so the test
 * exercises the exact production path (including the
 * inbound_disposition_closure_validate_insert trigger) with only the socket
 * faked out.
 */
describe('turn-recovery supervisor catch-up reconciliation wiring', () => {
  let db: Database;
  let durability: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  interface Fixture {
    planId: string;
    conversationKey: string;
    sourceSeqs: number[];
    catchupSeq: number;
  }

  /** Mirrors the proven fixture in tests/core/recovery-catchup-reconciler.test.ts. */
  function installCaughtUpGroup(options: {
    planId: string;
    conversationKey?: string;
    chat?: string;
  }): Fixture {
    const raw = db.raw;
    const conversationKey = options.conversationKey ?? `${options.planId}-conversation`;
    const chat = options.chat ?? `${options.planId}@g.us`;
    raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES (?, 'pre_connect_recovery', 'system:test', 'fixture', 'test://fixture')
    `).run(options.planId);
    const sourceSeqs = ['one', 'two'].map((suffix, index) => Number(raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason, failure_class
      ) VALUES (?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `).run(`${options.planId}-source-${suffix}`, conversationKey, chat).lastInsertRowid));
    const insertPending = raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'crash recovery', 'test://fixture', 'system:test')
    `);
    for (const seq of sourceSeqs) insertPending.run(seq, options.planId);
    const catchupSeq = Number(raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason
      ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_sent')
    `).run(`${options.planId}-catchup`, conversationKey, chat).lastInsertRowid);
    const opId = Number(raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, source_inbound_seq,
        is_terminal, replay_policy, echoed_at
      ) VALUES (?, ?, 'text', '{"text":"ACK"}', 'echoed', ?, 1, 'unsafe', datetime('now'))
    `).run(conversationKey, chat, catchupSeq).lastInsertRowid);
    raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, 'catchup-turn',
                'catchup-manager', 1, 'replied', 'finalized_replied',
                'echoed', ?, 1)
    `).run(conversationKey, chat, catchupSeq, catchupSeq, opId);
    return { planId: options.planId, conversationKey, sourceSeqs, catchupSeq };
  }

  /**
   * Still-OPEN source seqs — mirrors the reconciler's own open-group
   * selector exactly: a pending link whose (seq, plan) also has a
   * `superseded_by_operator_catchup` counterpart is closed, regardless of
   * the pending row's own superseded_by_seq bookkeeping.
   */
  function pendingSeqs(): number[] {
    return (db.raw.prepare(`
      SELECT links.inbound_seq AS inbound_seq
      FROM inbound_disposition_links links
      WHERE links.disposition = 'recovery_pending_operator_catchup'
        AND NOT EXISTS (
          SELECT 1 FROM inbound_disposition_links closed
          WHERE closed.inbound_seq = links.inbound_seq
            AND closed.recovery_plan_id = links.recovery_plan_id
            AND closed.disposition = 'superseded_by_operator_catchup'
        )
      ORDER BY links.inbound_seq
    `).all() as Array<{ inbound_seq: number }>).map((row) => row.inbound_seq);
  }

  function closedLinks(): Array<{ inbound_seq: number; superseded_by_seq: number; actor: string }> {
    return db.raw.prepare(`
      SELECT inbound_seq, superseded_by_seq, actor
      FROM inbound_disposition_links
      WHERE disposition = 'superseded_by_operator_catchup'
      ORDER BY inbound_seq
    `).all() as Array<{ inbound_seq: number; superseded_by_seq: number; actor: string }>;
  }

  function makeSupervisor(options?: {
    catchupReconcile?: { groupLimit?: number } | null;
    durabilityOverride?: () => DurabilityEngine;
  }): TurnRecoverySupervisor {
    return new TurnRecoverySupervisor({
      instanceName: 'test-instance',
      durability: () => (options?.durabilityOverride ? options.durabilityOverride() : durability),
      dispatchReplay: vi.fn(async () => ({ kind: 'delivered' }) as const),
      freshOwnerIdentity: () => ({
        logicalTurnId: `wiring-${Date.now()}-${Math.random()}`,
        managerId: 'wiring-manager',
        generation: 1,
      }),
      catchupReconcile: options?.catchupReconcile,
    });
  }

  it('auto-closes a caught-up group during a scan when the gate is on', async () => {
    const fixture = installCaughtUpGroup({ planId: 'wiring-on' });
    const supervisor = makeSupervisor({ catchupReconcile: {} });

    const result = await supervisor.scanOnce();

    expect(result.scanned).toBe(0); // no replay jobs; the reconciler is the only work
    expect(result.catchupReconcileAttempted).toBe(1);
    expect(result.catchupReconcileClosed).toBe(1);
    expect(result.catchupReconcileSkipped).toBe(0);
    expect(pendingSeqs()).toEqual([]);
    expect(closedLinks().map((link) => link.inbound_seq)).toEqual(fixture.sourceSeqs);
    for (const link of closedLinks()) expect(link.superseded_by_seq).toBe(fixture.catchupSeq);
    expect(new Set(closedLinks().map((link) => link.actor))).toEqual(new Set(['auto_reconciler']));
    expect(supervisor.health().lastScanFailureReason).toBeNull();

    // Idempotent: a second scan finds nothing left and reports zeros.
    const second = await supervisor.scanOnce();
    expect(second.catchupReconcileAttempted).toBe(0);
    expect(second.catchupReconcileClosed).toBe(0);
  });

  it('stays on pre-PR2 behavior when the gate is off (default)', async () => {
    const fixture = installCaughtUpGroup({ planId: 'wiring-off' });
    const supervisor = makeSupervisor();

    const result = await supervisor.scanOnce();

    expect(result.catchupReconcileAttempted).toBe(0);
    expect(result.catchupReconcileClosed).toBe(0);
    expect(result.catchupReconcileSkipped).toBe(0);
    expect(pendingSeqs()).toEqual(fixture.sourceSeqs);
    expect(closedLinks()).toEqual([]);
  });

  it('forwards the group limit and drains remaining groups next cycle', async () => {
    installCaughtUpGroup({ planId: 'wiring-lim-a' });
    installCaughtUpGroup({ planId: 'wiring-lim-b' });
    const supervisor = makeSupervisor({ catchupReconcile: { groupLimit: 1 } });

    const first = await supervisor.scanOnce();
    expect(first.catchupReconcileAttempted).toBe(1);
    expect(first.catchupReconcileClosed).toBe(1);
    expect(pendingSeqs().length).toBe(2); // one group of two links still pending

    const second = await supervisor.scanOnce();
    expect(second.catchupReconcileClosed).toBe(1);
    expect(pendingSeqs()).toEqual([]);
  });

  it('survives a whole-call reconciler failure and records a scan failure reason', async () => {
    installCaughtUpGroup({ planId: 'wiring-fail' });
    // Prototype-chain wrapper: every real DurabilityEngine method resolves
    // through the chain untouched; only the reconciler throws.
    const throwingDurability = Object.create(durability) as DurabilityEngine;
    throwingDurability.reconcileOperatorCatchupRecoveries = (): never => {
      throw new Error('schema drift simulated');
    };
    const supervisor = makeSupervisor({
      catchupReconcile: {},
      durabilityOverride: () => throwingDurability,
    });

    const result = await supervisor.scanOnce(); // must resolve, not reject

    expect(result.catchupReconcileAttempted).toBe(0);
    expect(pendingSeqs().length).toBe(2);
    const health = supervisor.health();
    expect(health.lastScanFailureReason).toBe('catchup_reconcile_failed');
    expect(health.consecutiveScanFailures).toBe(1);
  });
});
