import type { DatabaseSync } from 'node:sqlite';
import { assertRecoveryCatchupSchema } from './recovery-catchup-schema.ts';
import { assertOperatorCatchupResolutionSchema, OPERATOR_CATCHUP_PROOF_SQL } from './database-migration-69.ts';

export interface OperatorCatchupResolutionParams {
  planId: string;
  sourceSeq: number;
  opId: number;
  conversationKey?: string;
  actor: string;
  evidenceRef: string;
  originalFulfillmentConfirmed: boolean;
}

function requiredText(value: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > limit) {
    throw new Error('Operator catch-up requires bounded actor and original fulfillment evidence');
  }
  return value.trim();
}

export function inspectOperatorCatchupResolution(raw: DatabaseSync, params: OperatorCatchupResolutionParams) {
  assertRecoveryCatchupSchema(raw);
  assertOperatorCatchupResolutionSchema(raw);
  if (params.originalFulfillmentConfirmed !== true) throw new Error('Original request fulfillment must be confirmed');
  const planId = requiredText(params.planId, 2048);
  const actor = requiredText(params.actor, 2048);
  const evidenceRef = requiredText(params.evidenceRef, 8192);
  if (![params.sourceSeq, params.opId].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Operator catch-up requires positive source and operation IDs');
  }
  const proof = raw.prepare(OPERATOR_CATCHUP_PROOF_SQL).get({
    $planId: planId, $sourceSeq: params.sourceSeq, $opId: params.opId,
  });
  if (!proof) throw new Error('Operator catch-up requires its bound echoed operation');
  const source = raw.prepare('SELECT conversation_key FROM inbound_events WHERE seq = ?').get(params.sourceSeq) as { conversation_key: string };
  if (params.conversationKey !== undefined && params.conversationKey !== source.conversation_key) {
    throw new Error('Operator catch-up conversation does not match its source');
  }
  const existing = raw.prepare(`SELECT outbound_op_id, actor, evidence_ref FROM operator_catchup_resolutions
    WHERE recovery_plan_id = ? AND source_seq = ?`).get(planId, params.sourceSeq) as {
      outbound_op_id: number; actor: string; evidence_ref: string;
    } | undefined;
  if (existing && (existing.outbound_op_id !== params.opId || existing.actor !== actor || existing.evidence_ref !== evidenceRef)) {
    throw new Error('Operator catch-up already resolved with different evidence');
  }
  return { planId, sourceSeq: params.sourceSeq, opId: params.opId, actor, evidenceRef, idempotent: !!existing };
}

export function resolveOperatorCatchup(
  raw: DatabaseSync, params: OperatorCatchupResolutionParams, attest?: () => void,
) {
  raw.prepare('BEGIN IMMEDIATE').run();
  try {
    attest?.();
    const inspected = inspectOperatorCatchupResolution(raw, params);
    const inserted = inspected.idempotent ? 0 : Number(raw.prepare(`
      INSERT INTO operator_catchup_resolutions (recovery_plan_id, source_seq, outbound_op_id, actor, evidence_ref)
      VALUES (?, ?, ?, ?, ?)
    `).run(inspected.planId, inspected.sourceSeq, inspected.opId, inspected.actor, inspected.evidenceRef).changes);
    raw.prepare('COMMIT').run();
    return { ...inspected, inserted };
  } catch (error) {
    raw.prepare('ROLLBACK').run();
    throw error;
  }
}
