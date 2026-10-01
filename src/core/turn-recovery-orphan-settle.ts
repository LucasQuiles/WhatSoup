/**
 * An orphan recovery transfer: a `transferred_to_recovery_owner` terminal
 * record with NO `turn_recovery_jobs` row. Live finalization writes the record
 * and its job in one transaction, so current finalization cannot produce one.
 * Where a given orphan came from is not established in general. Retention is
 * one known generator: it deletes an aged `completed` job whose selected op is
 * `echoed`/`failed_permanent`/`quarantined`, then keeps the terminal record
 * when a delivery corroboration or disposition link still references it
 * (database-retention.ts). Preventing that is a separate change. The shape
 * this command admits (below) is not that one. Nothing ever repairs an
 * orphan, and `orphan_transfers` and `corrupt_links` count it, so it pins
 * `turn_recovery_integrity` and hides any NEW integrity fault. An
 * UNcorroborated orphan also blocks admission for its scope; a corroborated
 * one does not (OUTSTANDING_RECOVERY_FOR_SCOPE_FROM in turn-recovery-store.ts).
 *
 * Admission is an allowlist. A record is admitted only when ALL hold:
 *   - no job is linked to it;
 *   - its selected op carries the record's conversation, destination and
 *     source seq, and its source inbound (found by that seq) carries the
 *     record's conversation and destination: the same equalities
 *     VALID_RECOVERY_JOB_FROM requires, so the written job is never
 *     link-broken residue. Nothing protects an orphan's inbound identity once
 *     its job is gone, so this is checked, not assumed;
 *   - its source inbound exists and is terminal (`complete` or `failed`), and
 *     is not `complete` with `terminal_reason = 'response_echoed'`: that
 *     is the one source state from which echo settlement would complete a job
 *     (settleEchoedTurnRecoveryJobWithinCallerTransaction);
 *   - its selected op is `maybe_sent` with `is_terminal = 1` and a NULL
 *     `wa_message_id`, so no echo can ever be matched to it (matchEcho). An
 *     empty string counts as a message id: matchEcho selects by exact value;
 *   - the record passes the same valid-corroboration predicate health uses
 *     (validDeliveryCorroborationForTerminalSql). That also freezes the op:
 *     trigger `corroborated_selected_outbound_proof_immutable` aborts any
 *     status change on it, and corroboration rows are append-only;
 *   - no OPEN `inbound_disposition_links` row names its source inbound seq:
 *     a `recovery_pending_operator_catchup` row with no matching
 *     `superseded_by_operator_catchup` row, the open_recoveries predicate in
 *     turn-recovery-store.ts. An open link is a catch-up obligation that a
 *     settle, which forbids replay, must not sit next to.
 * Everything else is refused with a specific reason.
 *
 * Settling reuses the existing schema instead of inventing state (no
 * migration):
 *   - the missing job row is written directly in the settled `exhausted`
 *     state. Every reader defines an orphan as "no linked job", so one row
 *     moves every gauge together: `exhausted` is excluded from outstanding,
 *     admission and `corrupt_links` (link residue lands in the diagnostic
 *     `corrupt_links_settled`), and counts once in `retained_terminal`. Every
 *     claim, requeue, reassign and reclaim transition requires another state,
 *     the supervisor skips `exhausted`, and retention deletes only
 *     `completed` jobs. With the op frozen, the only `exhausted` -> `completed`
 *     path (echo completion) cannot fire. Its RESTRICT key and retain triggers
 *     keep the terminal record, its source inbound and its selected op as
 *     evidence. The shape mirrors the #1749 dead-delivery reclaim
 *     (attempt_count = claim_epoch = 5, no claim);
 *   - an append-only `recovery_plans` row (origin `operator`) is the audit
 *     entry, with a deterministic plan ID per terminal record so a rerun
 *     cannot write a second one (the continuity-gap ledger's pattern). The
 *     job's `replay_safety_proof_id` is that plan ID, which is how
 *     `turn-recovery-operator show` tells a settlement from real exhaustion.
 *
 * The job carries no replayable content: `replay_safe = 0`, the plan ID as its
 * proof ID, and fixed sentinel sender/text values. An `exhausted` job is never
 * claimed, so the sentinels are never sent; they only satisfy NOT NULL
 * identity constraints the original envelope would have filled.
 *
 * Works on a raw connection so the CLI can evaluate through a read-only
 * handle without the migrating Database wrapper.
 */
import type { DatabaseSync } from 'node:sqlite';
import { allFromStatement } from '../lib/db-query.ts';
import { validDeliveryCorroborationForTerminalSql } from './delivery-corroboration-sql.ts';
import { isGroupJid } from './jid-constants.ts';

type PreparedStatement = ReturnType<DatabaseSync['prepare']>;

export const ORPHAN_TRANSFER_SETTLE_PLAN_PREFIX = 'turn-recovery-orphan-settle:v1:';
export const ORPHAN_TRANSFER_SETTLE_ACTOR = 'turn-recovery-operator-cli';
/** Operator investigation reference (ticket/runbook ref); same shape the promote evidence uses. */
export const ORPHAN_TRANSFER_SETTLE_EVIDENCE_REF_PATTERN = /^[A-Za-z0-9_.:/-]{8,120}$/;

const SETTLED_SENDER_SENTINEL = 'operator-settle:no-sender';
const SETTLED_REPLAY_TEXT_SENTINEL = 'operator-settled orphan recovery transfer; never replayed';
const SETTLE_SUMMARY = 'Operator settled an orphan recovery transfer: no recovery job will replay it';
/** The only selected-op status admitted: an ambiguous send, frozen by corroboration. */
const ADMITTED_DELIVERY_STATUS = 'maybe_sent';
const TERMINAL_INBOUND_STATUSES: ReadonlySet<string> = new Set(['complete', 'failed']);
/** The source state from which echo settlement would complete a recovery job. */
const ECHO_SETTLED_TERMINAL_REASON = 'response_echoed';

export type OrphanTransferSettleRefusal =
  | 'terminal_not_found'
  | 'not_transferred'
  | 'recovery_job_exists'
  | 'owner_identity_conflict'
  | 'settlement_conflict'
  | 'delivery_op_missing'
  | 'delivery_identity_mismatch'
  | 'delivery_status_not_admitted'
  | 'delivery_not_terminal'
  | 'delivery_has_wa_message_id'
  | 'uncorroborated'
  | 'source_inbound_missing'
  | 'source_inbound_identity_mismatch'
  | 'source_inbound_open'
  | 'source_inbound_echo_settled'
  | 'open_disposition_link';

export type OrphanTransferSettleEvaluation =
  | {
    readonly verdict: 'eligible';
    readonly terminalId: number;
    readonly planId: string;
    readonly scope: string;
    readonly inboundSeq: number;
    readonly deliveryKind: string;
    readonly deliveryOpId: number;
    readonly deliveryStatus: string;
    readonly deliveryIsTerminal: boolean;
    readonly deliveryHasWaMessageId: boolean;
    /** Op conversation, chat and source seq equal the record's. */
    readonly deliveryIdentityMatches: boolean;
    /** Source inbound conversation and chat equal the record's conversation and delivery JID. */
    readonly sourceInboundIdentityMatches: boolean;
    readonly sourceInboundStatus: string;
    readonly sourceInboundTerminalReason: string | null;
    readonly corroborated: boolean;
    /** From the delivery JID via isGroupJid; the job's is_group flag. */
    readonly isGroup: boolean;
    // The remaining values the settled job copies from the record and its
    // source inbound (insertSettledJob), read from the same rows the admission
    // checks read, so the operator digest can bind them.
    readonly conversationKey: string;
    readonly deliveryJid: string;
    readonly sourceLogicalTurnId: string;
    readonly sourceManagerId: string;
    readonly sourceGeneration: number;
    readonly sourceMessageId: string | null;
    readonly recoveryOwnerLogicalTurnId: string | null;
    readonly recoveryOwnerManagerId: string | null;
    readonly recoveryOwnerGeneration: number | null;
  }
  | {
    readonly verdict: 'already_settled';
    readonly terminalId: number;
    readonly planId: string;
    readonly jobId: number;
  }
  | {
    readonly verdict: 'refused';
    readonly terminalId: number;
    readonly reason: OrphanTransferSettleRefusal;
  };

export type EligibleOrphanTransferSettle = Extract<OrphanTransferSettleEvaluation, { verdict: 'eligible' }>;

interface TerminalRow {
  id: number;
  scope: string;
  conversation_key: string;
  delivery_jid: string;
  inbound_seq: number | null;
  logical_turn_id: string;
  manager_id: string;
  generation: number;
  inbound_disposition: string;
  delivery_kind: string;
  delivery_op_id: number | null;
  recovery_owner_logical_turn_id: string | null;
  recovery_owner_manager_id: string | null;
  recovery_owner_generation: number | null;
  corroborated: number;
}

interface LinkedJobRow {
  id: number;
  state: string;
  assigned_owner_manager_id: string;
  replay_safety_proof_id: string | null;
}

interface DeliveryRow {
  status: string;
  is_terminal: number;
  wa_message_id: string | null;
  conversation_key: string;
  chat_jid: string;
  source_inbound_seq: number | null;
}

interface InboundRow {
  message_id: string | null;
  processing_status: string;
  terminal_reason: string | null;
  conversation_key: string;
  chat_jid: string;
}

export function orphanTransferSettlePlanId(terminalId: number): string {
  return `${ORPHAN_TRANSFER_SETTLE_PLAN_PREFIX}${terminalId}`;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`OrphanTransferSettler: ${name} must be a positive integer`);
  }
  return value;
}

export class OrphanTransferSettler {
  private readonly selectOrphans: PreparedStatement;
  private readonly selectTerminal: PreparedStatement;
  private readonly selectLinkedJob: PreparedStatement;
  private readonly selectPlan: PreparedStatement;
  private readonly selectDelivery: PreparedStatement;
  private readonly selectInbound: PreparedStatement;
  private readonly selectOpenDispositionLink: PreparedStatement;
  private readonly insertPlan: PreparedStatement;
  private readonly insertSettledJob: PreparedStatement;

  constructor(raw: DatabaseSync) {
    // The same orphan predicate as getTurnRecoverySupervisorCounts.
    this.selectOrphans = raw.prepare(
      `SELECT terminal.id AS id
       FROM turn_terminal_records terminal
       LEFT JOIN turn_recovery_jobs linked ON linked.terminal_record_id = terminal.id
       WHERE terminal.inbound_disposition = 'transferred_to_recovery_owner'
         AND linked.id IS NULL
       ORDER BY terminal.id ASC
       LIMIT ?`,
    );
    this.selectTerminal = raw.prepare(
      `SELECT terminal.id, terminal.scope, terminal.conversation_key, terminal.delivery_jid,
              terminal.inbound_seq,
              terminal.logical_turn_id,
              terminal.manager_id, terminal.generation, terminal.inbound_disposition,
              terminal.delivery_kind, terminal.delivery_op_id,
              terminal.recovery_owner_logical_turn_id, terminal.recovery_owner_manager_id,
              terminal.recovery_owner_generation,
              CASE WHEN ${validDeliveryCorroborationForTerminalSql('terminal')} THEN 1 ELSE 0 END
                AS corroborated
       FROM turn_terminal_records terminal
       WHERE terminal.id = ?`,
    );
    this.selectLinkedJob = raw.prepare(
      `SELECT id, state, assigned_owner_manager_id, replay_safety_proof_id
       FROM turn_recovery_jobs WHERE terminal_record_id = ?`,
    );
    this.selectPlan = raw.prepare(
      `SELECT origin, actor FROM recovery_plans WHERE plan_id = ?`,
    );
    this.selectDelivery = raw.prepare(
      `SELECT status, is_terminal, wa_message_id, conversation_key, chat_jid, source_inbound_seq
       FROM outbound_ops WHERE id = ?`,
    );
    this.selectInbound = raw.prepare(
      `SELECT message_id, processing_status, terminal_reason, conversation_key, chat_jid
       FROM inbound_events WHERE seq = ?`,
    );
    // The open_recoveries predicate of getTurnRecoverySupervisorCounts
    // (turn-recovery-store.ts), restricted to one source seq. It is mirrored,
    // not shared: there it is inline in that query's CTE, as it is in the
    // migration triggers and recovery-catchup-closure.ts.
    this.selectOpenDispositionLink = raw.prepare(
      `SELECT 1 AS found
       FROM inbound_disposition_links pending
       WHERE pending.inbound_seq = ?
         AND pending.disposition = 'recovery_pending_operator_catchup'
         AND NOT EXISTS (
           SELECT 1
           FROM inbound_disposition_links closure
           WHERE closure.inbound_seq = pending.inbound_seq
             AND closure.recovery_plan_id = pending.recovery_plan_id
             AND closure.disposition = 'superseded_by_operator_catchup'
         )
       LIMIT 1`,
    );
    this.insertPlan = raw.prepare(
      `INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
       VALUES (?, 'operator', ?, ?, ?)`,
    );
    // Envelope columns come from the record and its source inbound, so the
    // job's proof link matches exactly what live enqueue would have written.
    // evaluate() returns every column copied here so the operator digest can
    // bind it; keep the two lists in step.
    this.insertSettledJob = raw.prepare(
      `INSERT INTO turn_recovery_jobs (
         terminal_record_id, scope, conversation_key, delivery_jid,
         source_inbound_seq, source_inbound_seq_key,
         source_logical_turn_id, source_manager_id, source_generation, source_message_id,
         owner_logical_turn_id, owner_manager_id, owner_generation,
         assigned_owner_logical_turn_id, assigned_owner_manager_id, assigned_owner_generation,
         replay_safe, replay_safety_proof_id, sender_jid, sender_name, replay_text,
         is_group, group_name,
         state, attempt_count, claim_epoch
       )
       SELECT
         t.id, t.scope, t.conversation_key, t.delivery_jid,
         t.inbound_seq, t.inbound_seq,
         t.logical_turn_id, t.manager_id, t.generation,
         i.message_id,
         t.recovery_owner_logical_turn_id, t.recovery_owner_manager_id, t.recovery_owner_generation,
         'operator-orphan-settle-' || t.id, ?, 1,
         0, ?, ?, NULL, ?,
         ?, NULL,
         'exhausted', 5, 5
       FROM turn_terminal_records t
       JOIN inbound_events i ON i.seq = t.inbound_seq
       WHERE t.id = ?
         AND t.inbound_disposition = 'transferred_to_recovery_owner'
         AND NOT EXISTS (SELECT 1 FROM turn_recovery_jobs j WHERE j.terminal_record_id = t.id)
       RETURNING id`,
    );
  }

  /** Orphan transfer terminal IDs, oldest first. Writes nothing. */
  orphanTerminalIds(limit = 200): number[] {
    positiveInteger('limit', limit);
    return allFromStatement<{ id: number }>(this.selectOrphans, limit).map((row) => row.id);
  }

  evaluate(terminalId: number): OrphanTransferSettleEvaluation {
    positiveInteger('terminalId', terminalId);
    const planId = orphanTransferSettlePlanId(terminalId);
    const refused = (reason: OrphanTransferSettleRefusal): OrphanTransferSettleEvaluation => ({
      verdict: 'refused', terminalId, reason,
    });
    const terminal = this.selectTerminal.get(terminalId) as TerminalRow | undefined;
    if (!terminal) return refused('terminal_not_found');
    if (terminal.inbound_disposition !== 'transferred_to_recovery_owner' || terminal.inbound_seq === null) {
      return refused('not_transferred');
    }

    const plan = this.selectPlan.get(planId) as { origin: string; actor: string } | undefined;
    const job = this.selectLinkedJob.get(terminalId) as LinkedJobRow | undefined;
    if (job) {
      const ours = job.state === 'exhausted'
        && job.assigned_owner_manager_id === ORPHAN_TRANSFER_SETTLE_ACTOR
        && job.replay_safety_proof_id === planId;
      if (!ours) return refused('recovery_job_exists');
      if (plan?.origin !== 'operator' || plan.actor !== ORPHAN_TRANSFER_SETTLE_ACTOR) {
        return refused('settlement_conflict');
      }
      return { verdict: 'already_settled', terminalId, planId, jobId: job.id };
    }
    // Plans are append-only and written with the job, so a plan without its
    // job is state this command did not produce.
    if (plan) return refused('settlement_conflict');

    // The job table's owner-separation CHECK would abort the insert.
    if (
      terminal.recovery_owner_logical_turn_id === terminal.logical_turn_id
      && terminal.recovery_owner_manager_id === terminal.manager_id
      && terminal.recovery_owner_generation === terminal.generation
    ) {
      return refused('owner_identity_conflict');
    }

    const delivery = terminal.delivery_op_id === null
      ? undefined
      : this.selectDelivery.get(terminal.delivery_op_id) as DeliveryRow | undefined;
    if (!delivery || terminal.delivery_op_id === null) return refused('delivery_op_missing');
    const deliveryIdentityMatches = delivery.conversation_key === terminal.conversation_key
      && delivery.chat_jid === terminal.delivery_jid
      && delivery.source_inbound_seq === terminal.inbound_seq;
    if (!deliveryIdentityMatches) return refused('delivery_identity_mismatch');
    // pending/sending/submitted are live queue work; echoed and the terminal
    // failures are shapes this command was not reviewed for.
    if (delivery.status !== ADMITTED_DELIVERY_STATUS) return refused('delivery_status_not_admitted');
    if (delivery.is_terminal !== 1) return refused('delivery_not_terminal');
    // An op with a provider message id can still be echo-matched (matchEcho).
    // matchEcho selects by exact value, so '' is a message id too.
    const hasWaMessageId = delivery.wa_message_id !== null;
    if (hasWaMessageId) return refused('delivery_has_wa_message_id');
    if (terminal.corroborated !== 1) return refused('uncorroborated');

    const inbound = this.selectInbound.get(terminal.inbound_seq) as InboundRow | undefined;
    if (!inbound) return refused('source_inbound_missing');
    const sourceInboundIdentityMatches = inbound.conversation_key === terminal.conversation_key
      && inbound.chat_jid === terminal.delivery_jid;
    if (!sourceInboundIdentityMatches) return refused('source_inbound_identity_mismatch');
    if (!TERMINAL_INBOUND_STATUSES.has(inbound.processing_status)) return refused('source_inbound_open');
    if (
      inbound.processing_status === 'complete'
      && inbound.terminal_reason === ECHO_SETTLED_TERMINAL_REASON
    ) {
      return refused('source_inbound_echo_settled');
    }
    // An open catch-up obligation on the source must not sit next to a settle
    // that forbids replay.
    if (this.selectOpenDispositionLink.get(terminal.inbound_seq) !== undefined) {
      return refused('open_disposition_link');
    }

    return {
      verdict: 'eligible',
      terminalId,
      planId,
      scope: terminal.scope,
      inboundSeq: terminal.inbound_seq,
      deliveryKind: terminal.delivery_kind,
      deliveryOpId: terminal.delivery_op_id,
      deliveryStatus: delivery.status,
      deliveryIsTerminal: delivery.is_terminal === 1,
      deliveryHasWaMessageId: hasWaMessageId,
      deliveryIdentityMatches,
      sourceInboundIdentityMatches,
      sourceInboundStatus: inbound.processing_status,
      sourceInboundTerminalReason: inbound.terminal_reason,
      corroborated: terminal.corroborated === 1,
      isGroup: isGroupJid(terminal.delivery_jid),
      conversationKey: terminal.conversation_key,
      deliveryJid: terminal.delivery_jid,
      sourceLogicalTurnId: terminal.logical_turn_id,
      sourceManagerId: terminal.manager_id,
      sourceGeneration: terminal.generation,
      sourceMessageId: inbound.message_id,
      recoveryOwnerLogicalTurnId: terminal.recovery_owner_logical_turn_id,
      recoveryOwnerManagerId: terminal.recovery_owner_manager_id,
      recoveryOwnerGeneration: terminal.recovery_owner_generation,
    };
  }

  /**
   * Settle an eligible orphan inside the caller's transaction: the audit plan
   * row, then the settled job row. Throws (so the caller rolls back) unless
   * exactly one job row was written.
   */
  applyWithinCallerTransaction(settle: EligibleOrphanTransferSettle, evidenceRef: string): { jobId: number } {
    if (!ORPHAN_TRANSFER_SETTLE_EVIDENCE_REF_PATTERN.test(evidenceRef)) {
      throw new Error('OrphanTransferSettler: evidence reference has an invalid shape');
    }
    const evidence = `orphan-transfer-settle:v1;terminal=${settle.terminalId}`
      + `;op=${settle.deliveryOpId};ref=${evidenceRef}`;
    this.insertPlan.run(settle.planId, ORPHAN_TRANSFER_SETTLE_ACTOR, SETTLE_SUMMARY, evidence);
    const inserted = allFromStatement<{ id: number }>(
      this.insertSettledJob,
      ORPHAN_TRANSFER_SETTLE_ACTOR,
      settle.planId,
      SETTLED_SENDER_SENTINEL,
      SETTLED_REPLAY_TEXT_SENTINEL,
      settle.isGroup ? 1 : 0,
      settle.terminalId,
    );
    if (inserted.length !== 1) {
      throw new Error('OrphanTransferSettler: the settled recovery job was not written');
    }
    return { jobId: inserted[0]!.id };
  }
}
