/**
 * #3754: a scheduled agent job's synthetic inbound owes no user a reply, so
 * crash recovery must fail it without enrolling it as a user-facing operator
 * catch-up, and its loss must stay visible (#2144) in the windowed
 * scheduled-turns-lost count. Each recovery arm is checked with a synthetic
 * source and a real-user control on the same path. The window, query plan and
 * id parity live in scheduled-turns-lost.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  DurabilityEngine,
  type TurnRecoveryOwnerIdentity,
} from '../../src/core/durability.ts';
import { DurabilityRecoveryEvidence } from '../../src/core/durability-recovery-evidence.ts';
import { closeOperatorCatchupRecovery } from '../../src/core/recovery-catchup-closure.ts';
import { scheduledJobInboundMessageId } from '../../src/core/synthetic-turn-source.ts';
import { getTurnRecoveryHealthDetails } from '../../src/runtimes/agent/turn-recovery-dispatch.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const emitAlert = vi.hoisted(() => vi.fn(() => true));
const clearAlertSource = vi.hoisted(() => vi.fn(() => true));
const gateQuarantineClear = vi.hoisted(() => vi.fn(() => ({ action: 'clear' })));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert,
  emitAlertChecked: emitAlert,
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource,
  clearAlertSourceChecked: clearAlertSource,
}));

vi.mock('../../src/lib/fleet-health-gate.ts', () => ({ gateQuarantineClear }));

const SYNTHETIC_ID = scheduledJobInboundMessageId(7, 1_780_000_000, 11);
const OWNER: TurnRecoveryOwnerIdentity = {
  logicalTurnId: 'turn-synthetic-owner',
  managerId: 'manager-synthetic',
  generation: 7,
};
const CONVERSATION_KEY = '15550137540';
const DELIVERY_JID = '15550137540:5@s.whatsapp.net';

describe('synthetic scheduled-job catch-up enrollment (#3754)', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    emitAlert.mockClear();
    clearAlertSource.mockClear();
    gateQuarantineClear.mockClear();
  });

  afterEach(() => db.close());

  const inboundRow = (seq: number) => db.raw.prepare(`
    SELECT processing_status, failure_class, continuity_candidate_reason
    FROM inbound_events WHERE seq = ?
  `).get(seq);
  const linkReasons = (seq: number) => (db.raw.prepare(`
    SELECT reason FROM inbound_disposition_links
    WHERE inbound_seq = ? AND disposition = 'recovery_pending_operator_catchup'
  `).all(seq) as Array<{ reason: string }>).map((row) => row.reason);
  const backdate = (seq: number, column: 'received_at' | 'completed_at', modifier: string) =>
    db.raw.prepare(`UPDATE inbound_events SET ${column} = datetime('now', ?) WHERE seq = ?`).run(modifier, seq);
  const journal = (messageId: string) =>
    engine.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');

  /** A transferred_to_recovery_owner record whose selected op is failed_permanent. */
  function transferredWithDeadDelivery(messageId: string): number {
    const inboundSeq = journal(messageId);
    // Chronology first: migration 47 rejects received_at rewrites once a job links the inbound.
    backdate(inboundSeq, 'received_at', '-10 minutes');
    const opId = engine.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'text',
      payload: JSON.stringify({ text: `selected delivery ${messageId}` }),
      sourceInboundSeq: inboundSeq,
      replayPolicy: 'unsafe',
      isTerminal: true,
    });
    engine.markMaybeSent(opId, 'outbound governor ceiling exceeded');
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq,
        logicalTurnId: `turn-source-${inboundSeq}`,
        managerId: 'manager-source',
        generation: 3,
      },
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'delivery_unknown', opId },
    };
    const envelope: TurnRecoveryReplayEnvelope = {
      sourceMessageId: messageId,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550137541:9@s.whatsapp.net',
      senderName: 'Owner Reclaim Fixture',
      text: `owner reclaim fixture ${inboundSeq}`,
      isGroup: false,
    };
    engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, OWNER),
      recoveryJob: toTurnRecoveryJobPersistence(result, OWNER, envelope),
    });
    engine.markFailedPermanent(opId, 'outbound governor ceiling exceeded');
    return inboundSeq;
  }

  describe('pre-connect recovery arm', () => {
    it('fails a crashed synthetic turn without enrolling it and counts the loss', () => {
      const seq = journal(SYNTHETIC_ID);

      const stats = engine.preConnectRecovery();

      expect(inboundRow(seq)).toEqual({
        processing_status: 'failed',
        failure_class: 'crash_recovery',
        continuity_candidate_reason: 'crash_reclaim_no_terminal_outbound',
      });
      expect(linkReasons(seq)).toEqual([]);
      expect(stats.openRecoveries).toBe(0);
      expect(engine.getTurnRecoverySupervisorCounts()).toMatchObject({
        openRecoveries: 0,
        openRecoveriesSynthetic: 0,
        scheduledTurnsLost: 1,
      });
    });

    it('still enrolls a crashed real-user turn and does not count it as a lost scheduled turn', () => {
      const seq = journal('wamid-precon-user');

      const stats = engine.preConnectRecovery();

      const counts = engine.getTurnRecoverySupervisorCounts();
      expect(inboundRow(seq)).toMatchObject({ processing_status: 'failed', failure_class: 'crash_recovery' });
      expect(linkReasons(seq)).toEqual(['crash_reclaim_no_terminal_outbound']);
      expect(stats.openRecoveries).toBe(1);
      expect(counts.openRecoveries).toBe(1);
      // `?? 0` keeps the control valid on main, where the count does not exist;
      // not.toBeNull() still fails here if the count read failed (null).
      expect(counts.scheduledTurnsLost).not.toBeNull();
      expect(counts.scheduledTurnsLost ?? 0).toBe(0);
    });

    it('fails closed when a real-user enrollment inserts no row', () => {
      const seq = journal('wamid-precon-ignored');
      db.raw.exec(`
        CREATE TRIGGER ignore_pending_link
        BEFORE INSERT ON inbound_disposition_links
        BEGIN
          SELECT RAISE(IGNORE);
        END
      `);

      expect(() => engine.preConnectRecovery())
        .toThrow('Pending operator catch-up disposition was not recorded exactly once');
      expect(inboundRow(seq)).toEqual({
        processing_status: 'processing',
        failure_class: null,
        continuity_candidate_reason: null,
      });
    });
  });

  describe('stuck-inbound stale reclaim arm', () => {
    it('fails a stale synthetic turn without enrolling it and counts the loss', () => {
      const seq = journal(SYNTHETIC_ID);
      backdate(seq, 'received_at', '-25 hours');

      const result = engine.sweepStuckInbound();

      expect(result.failedStale).toBe(1);
      expect(inboundRow(seq)).toMatchObject({ processing_status: 'failed', failure_class: 'stale_reclaim' });
      expect(linkReasons(seq)).toEqual([]);
      expect(engine.getTurnRecoverySupervisorCounts()).toMatchObject({
        openRecoveries: 0,
        scheduledTurnsLost: 1,
      });
    });

    it('still enrolls a stale real-user turn', () => {
      const seq = journal('wamid-stale-user');
      backdate(seq, 'received_at', '-25 hours');

      const result = engine.sweepStuckInbound();
      const counts = engine.getTurnRecoverySupervisorCounts();

      expect(result.failedStale).toBe(1);
      expect(linkReasons(seq)).toEqual(['stale_reclaim']);
      expect(counts.openRecoveries).toBe(1);
      expect(counts.scheduledTurnsLost).not.toBeNull();
      expect(counts.scheduledTurnsLost ?? 0).toBe(0);
    });

    it('fails the synthetic turn and enrolls the real user in one sweep', () => {
      // One pass over both kinds: the sink must judge each seq by its own row,
      // or the synthetic row also skips the real user's enrollment.
      const syntheticSeq = journal(SYNTHETIC_ID);
      const userSeq = journal('wamid-stale-mixed-user');
      backdate(syntheticSeq, 'received_at', '-25 hours');
      backdate(userSeq, 'received_at', '-25 hours');

      const result = engine.sweepStuckInbound();
      const counts = engine.getTurnRecoverySupervisorCounts();

      expect(result.failedStale).toBe(2);
      expect(linkReasons(syntheticSeq)).toEqual([]);
      expect(linkReasons(userSeq)).toEqual(['stale_reclaim']);
      expect(counts.openRecoveries).toBe(1);
      expect(counts.scheduledTurnsLost).toBe(1);
    });
  });

  describe('recovery-owner reclaim arm', () => {
    it('fails an owner-reclaimed synthetic turn without enrolling it and counts the loss', () => {
      const seq = transferredWithDeadDelivery(SYNTHETIC_ID);

      const result = engine.sweepStuckInbound();

      expect(result.reclaimedRecoveryOwned).toBe(1);
      expect(inboundRow(seq)).toMatchObject({
        processing_status: 'failed',
        failure_class: 'recovery_owner_reclaimed',
      });
      expect(linkReasons(seq)).toEqual([]);
      expect(engine.getTurnRecoverySupervisorCounts()).toMatchObject({
        openRecoveries: 0,
        scheduledTurnsLost: 1,
      });
    });

    it('still enrolls an owner-reclaimed real-user turn', () => {
      const seq = transferredWithDeadDelivery('wamid-owner-user');

      const result = engine.sweepStuckInbound();
      const counts = engine.getTurnRecoverySupervisorCounts();

      expect(result.reclaimedRecoveryOwned).toBe(1);
      expect(linkReasons(seq)).toEqual(['recovery_owner_reclaimed']);
      expect(counts.openRecoveries).toBe(1);
      expect(counts.scheduledTurnsLost).not.toBeNull();
      expect(counts.scheduledTurnsLost ?? 0).toBe(0);
    });
  });

  describe('open catch-up split', () => {
    // The closure trigger needs the catch-up reply in the source's chat, so
    // these sources use the plain chat address the closure fixtures use.
    const CHAT_JID = `${CONVERSATION_KEY}@s.whatsapp.net`;
    const failedSource = (messageId: string) => {
      const seq = engine.journalInbound(messageId, CONVERSATION_KEY, CHAT_JID, 'agent');
      engine.markInboundFailed(seq, 'crash_recovery');
      return seq;
    };
    // Links written before #3754 still exist; append them directly, as the old
    // enrollment did, so the split is checked on real rows.
    const pendingLink = (seq: number, planId: string) => {
      db.raw.prepare(`
        INSERT OR IGNORE INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
        VALUES (?, 'operator', 'test-suite', 'pre-fix residue', NULL)
      `).run(planId);
      db.raw.prepare(`
        INSERT INTO inbound_disposition_links (
          inbound_seq, recovery_plan_id, disposition, superseded_by_seq, reason, evidence_ref, actor
        ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL, 'test-open', NULL, 'test-suite')
      `).run(seq, planId);
    };
    /**
     * Closes planId's link on sourceSeq through the production closure path: a
     * later echoed reply in the same chat, built as the closure tests build it.
     * Returns the number of closure rows written.
     */
    function closeLink(planId: string, sourceSeq: number, label: string): number {
      const catchupSeq = Number(db.raw.prepare(`
        INSERT INTO inbound_events (
          message_id, conversation_key, chat_jid, processing_status, completed_at, terminal_reason
        ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_sent')
      `).run(`wamid-split-${label}-catchup`, CONVERSATION_KEY, CHAT_JID).lastInsertRowid);
      const opId = Number(db.raw.prepare(`
        INSERT INTO outbound_ops (
          conversation_key, chat_jid, op_type, payload, status, source_inbound_seq,
          is_terminal, replay_policy, echoed_at
        ) VALUES (?, ?, 'text', '{"text":"ACK"}', 'echoed', ?, 1, 'unsafe', datetime('now'))
      `).run(CONVERSATION_KEY, CHAT_JID, catchupSeq).lastInsertRowid);
      db.raw.prepare(`
        INSERT INTO turn_terminal_records (
          scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
          logical_turn_id, manager_id, generation, attempt_kind,
          inbound_disposition, delivery_kind, delivery_op_id,
          reply_guarantee_disarmed
        ) VALUES ('per_chat', ?, ?, ?, ?, ?, 'catchup-manager', 1, 'replied',
                  'finalized_replied', 'echoed', ?, 1)
      `).run(CONVERSATION_KEY, CHAT_JID, catchupSeq, catchupSeq, `catchup-turn-${label}`, opId);
      return closeOperatorCatchupRecovery(db, {
        planId,
        conversationKey: CONVERSATION_KEY,
        expectedSourceSeqs: [sourceSeq],
        catchupSeq,
        actor: 'operator:test',
        evidenceRef: `test://split-${label}`,
      }).inserted;
    }
    /**
     * Pending, open and user-facing open links counted in JS from the raw
     * rows, apart from the CTE's SQL. User-facing means the source message id
     * does not start with the exact (case-sensitive) synthetic prefix.
     */
    function rawLinks(): { pending: number; open: number; userFacingOpen: number } {
      const rows = db.raw.prepare(`
        SELECT inbound_seq, recovery_plan_id, disposition FROM inbound_disposition_links
      `).all() as Array<{ inbound_seq: number; recovery_plan_id: string; disposition: string }>;
      const messageIds = new Map((db.raw.prepare('SELECT seq, message_id FROM inbound_events').all() as Array<{
        seq: number;
        message_id: string;
      }>).map((row) => [row.seq, row.message_id]));
      const key = (row: { inbound_seq: number; recovery_plan_id: string }) => `${row.inbound_seq}/${row.recovery_plan_id}`;
      const closed = new Set(rows.filter((row) => row.disposition === 'superseded_by_operator_catchup').map(key));
      const pending = rows.filter((row) => row.disposition === 'recovery_pending_operator_catchup');
      const open = pending.filter((row) => !closed.has(key(row)));
      const userFacingOpen = open.filter((row) => !(messageIds.get(row.inbound_seq) ?? '').startsWith('agentjob-'));
      return { pending: pending.length, open: open.length, userFacingOpen: userFacingOpen.length };
    }

    it('reports pre-fix synthetic residue apart from user-facing catch-ups in both selectors', () => {
      const syntheticSeq = failedSource(SYNTHETIC_ID);
      const userSeq = failedSource('wamid-split-user');
      const lookalikeSeq = failedSource('AGENTJOB-7-1780000000-occ12');
      const closedSyntheticSeq = failedSource(scheduledJobInboundMessageId(7, 1_780_000_100, 13));
      const closedUserSeq = failedSource('wamid-split-closed-user');
      for (const seq of [syntheticSeq, userSeq, lookalikeSeq]) pendingLink(seq, 'plan-3754-open');
      pendingLink(closedSyntheticSeq, 'plan-3754-closed-synthetic');
      pendingLink(closedUserSeq, 'plan-3754-closed-user');
      const closures = [
        closeLink('plan-3754-closed-synthetic', closedSyntheticSeq, 'synthetic'),
        closeLink('plan-3754-closed-user', closedUserSeq, 'user'),
      ];

      const counts = engine.getTurnRecoverySupervisorCounts();
      const raw = rawLinks();

      expect(closures).toEqual([1, 1]);
      expect(raw).toEqual({ pending: 5, open: 3, userFacingOpen: 2 });
      // Closed links count nowhere; the uppercase lookalike is not the minted
      // shape, so it stays user-facing.
      expect(counts.openRecoveries).toBe(raw.userFacingOpen);
      expect(engine.getHealthStats().openRecoveries).toBe(raw.userFacingOpen);
      expect(counts.openRecoveriesSynthetic).toBe(1);
      expect((counts.openRecoveries) + (counts.openRecoveriesSynthetic ?? -1)).toBe(raw.open);
    });

    it('reports zero in both buckets on an empty database', () => {
      const counts = engine.getTurnRecoverySupervisorCounts();

      expect(counts.openRecoveries).toBe(0);
      expect(counts.openRecoveriesSynthetic).toBe(0);
      expect(counts.scheduledTurnsLost).toBe(0);
    });
  });

  describe('first terminal wins for a scheduled-turn loss row', () => {
    const writtenRow = (seq: number) => db.raw.prepare(`
      SELECT processing_status, failure_class, terminal_reason FROM inbound_events WHERE seq = ?
    `).get(seq);
    // Each seq-keyed writer as a late runtime path calls it, and the row main
    // leaves when that writer rewrites a stale_reclaim failure.
    const writers = [
      {
        writer: 'markTurnDone',
        write: (seq: number) => engine.markTurnDone(seq),
        mainRow: { processing_status: 'turn_done', failure_class: 'stale_reclaim', terminal_reason: 'error' },
      },
      {
        writer: 'markInboundComplete',
        write: (seq: number) => engine.markInboundComplete(seq, 'response_sent'),
        mainRow: { processing_status: 'complete', failure_class: 'stale_reclaim', terminal_reason: 'response_sent' },
      },
      {
        writer: 'markInboundFailed',
        write: (seq: number) => engine.markInboundFailed(seq, 'session_spawn_failed'),
        mainRow: { processing_status: 'failed', failure_class: 'session_spawn_failed', terminal_reason: 'error' },
      },
      {
        writer: 'markInboundSkipped',
        write: (seq: number) => engine.markInboundSkipped(seq, 'empty_content'),
        mainRow: { processing_status: 'complete', failure_class: 'stale_reclaim', terminal_reason: 'empty_content' },
      },
    ];

    it.each(writers)('keeps a stale-reclaimed synthetic row when $writer runs late', ({ write }) => {
      const seq = journal(SYNTHETIC_ID);
      backdate(seq, 'received_at', '-25 hours');
      expect(engine.sweepStuckInbound().failedStale).toBe(1);

      write(seq);

      expect(engine.getTurnRecoverySupervisorCounts().scheduledTurnsLost).toBe(1);
      expect(writtenRow(seq)).toEqual({ processing_status: 'failed', failure_class: 'stale_reclaim', terminal_reason: 'error' });
      expect(engine.isInboundSweepReclaimed(seq)).toBe(true);
    });

    it.each(writers)('still lets $writer rewrite a real-user row in the same state', ({ write, mainRow }) => {
      // Unlinked on purpose: a swept real-user row carries a disposition link,
      // and migration 41's trigger already freezes a linked row on main.
      const seq = journal('wamid-late-writer-user');
      engine.markInboundFailed(seq, 'stale_reclaim');

      write(seq);

      expect(writtenRow(seq)).toEqual(mainRow);
    });

    it('leaves a synthetic failure with no failure class writable', () => {
      const seq = journal(SYNTHETIC_ID);
      engine.markInboundFailed(seq, 'stale_reclaim');
      db.raw.prepare('UPDATE inbound_events SET failure_class = NULL WHERE seq = ?').run(seq);

      engine.markInboundFailed(seq, 'session_spawn_failed');

      expect(writtenRow(seq)).toMatchObject({ processing_status: 'failed', failure_class: 'session_spawn_failed' });
    });

    it('keeps the row lost when its reply, submitted before the sweep, echoes after it', () => {
      // Legacy echo completion: markEchoed completes the source of a terminal op
      // that no terminal record owns, through completeInbound. Before #3754 the
      // swept synthetic row carried a disposition link, so migration 41's trigger
      // aborted that write and the echo rolled back with it. The writer guard
      // makes the write a no-op instead, so the echo commits.
      const seq = journal(SYNTHETIC_ID);
      backdate(seq, 'received_at', '-25 hours');
      const opId = engine.createOutboundOp({
        conversationKey: CONVERSATION_KEY,
        chatJid: DELIVERY_JID,
        opType: 'text',
        payload: JSON.stringify({ text: 'scheduled job reply' }),
        sourceInboundSeq: seq,
        replayPolicy: 'unsafe',
        isTerminal: true,
      });
      engine.markSending(opId);
      engine.markSubmitted(opId, 'wamid-late-echo-reply');
      expect(engine.sweepStuckInbound().failedStale).toBe(1);

      expect(() => engine.markEchoed(opId)).not.toThrow();

      expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId)).toEqual({ status: 'echoed' });
      expect(writtenRow(seq)).toEqual({ processing_status: 'failed', failure_class: 'stale_reclaim', terminal_reason: 'error' });
      expect(engine.getTurnRecoverySupervisorCounts().scheduledTurnsLost).toBe(1);
    });
  });

  describe('scheduled-turns-lost read failure', () => {
    it('reports null for the lost-turn count and keeps the other counts', () => {
      const userSeq = journal('wamid-count-failure-user');
      engine.preConnectRecovery();
      const failing = vi.spyOn(DurabilityRecoveryEvidence.prototype, 'countScheduledTurnsLost')
        .mockImplementation(() => {
          throw new Error('scheduled-turns-lost read failed');
        });
      try {
        const counts = engine.getTurnRecoverySupervisorCounts();
        const details = getTurnRecoveryHealthDetails(engine);

        expect(linkReasons(userSeq)).toEqual(['crash_reclaim_no_terminal_outbound']);
        expect(counts.scheduledTurnsLost).toBeNull();
        expect(counts.openRecoveries).toBe(1);
        expect(details.turnRecoveryScheduledTurnsLost).toBeNull();
        expect(details.turnRecoveryOpenRecoveries).toBe(1);
      } finally {
        failing.mockRestore();
      }
    });
  });
});
