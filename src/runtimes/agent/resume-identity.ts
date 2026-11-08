import { toConversationKey } from '../../core/conversation-key.ts';
import type { SessionCheckpointRow } from '../../core/durability.ts';
import {
  parseWhatsAppDeliveryNamespace,
  type WhatsAppDeliveryNamespace,
} from '../../core/jid-constants.ts';
import { isRecord } from '../../lib/type-guards.ts';
import type { TurnIdentity } from './turn-terminal.ts';

export type ResumeDeliveryNamespace = WhatsAppDeliveryNamespace;

export interface PersistedResumeIdentity extends Omit<TurnIdentity, 'inboundSeq'> {
  readonly deliveryNamespace: ResumeDeliveryNamespace;
  readonly inboundSeq: number;
}

const RESUME_SCOPES: ReadonlySet<TurnIdentity['scope']> = new Set([
  'per_chat',
  'shared',
  'singleton',
]);

function isExactNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function resolveResumeIdentity(candidate: unknown): PersistedResumeIdentity | null {
  if (!isRecord(candidate)) return null;

  const {
    scope,
    conversationKey,
    deliveryJid,
    deliveryNamespace,
    inboundSeq,
    logicalTurnId,
    managerId,
    generation,
  } = candidate;

  if (
    !isExactNonemptyString(scope) ||
    !RESUME_SCOPES.has(scope as TurnIdentity['scope']) ||
    !isExactNonemptyString(conversationKey) ||
    !isExactNonemptyString(deliveryJid) ||
    !isExactNonemptyString(deliveryNamespace) ||
    !isPositiveSafeInteger(inboundSeq) ||
    !isExactNonemptyString(logicalTurnId) ||
    !isExactNonemptyString(managerId) ||
    !isPositiveSafeInteger(generation)
  ) {
    return null;
  }

  const parsedNamespace = parseWhatsAppDeliveryNamespace(deliveryJid);
  if (parsedNamespace === null || parsedNamespace !== deliveryNamespace) return null;

  try {
    if (toConversationKey(deliveryJid) !== conversationKey) return null;
  } catch {
    return null;
  }

  return Object.freeze({
    scope: scope as TurnIdentity['scope'],
    conversationKey,
    deliveryJid,
    deliveryNamespace: deliveryNamespace as ResumeDeliveryNamespace,
    inboundSeq,
    logicalTurnId,
    managerId,
    generation,
  });
}

export function completedDeliveryIdentityAdmissionReason(
  checkpoint: SessionCheckpointRow | undefined,
  expectedScope: PersistedResumeIdentity['scope'],
): 'missing' | 'invalid' | 'scope_mismatch' {
  if (checkpoint === undefined) return 'missing';
  const fields = [
    checkpoint.completed_scope,
    checkpoint.completed_delivery_jid,
    checkpoint.completed_delivery_namespace,
    checkpoint.completed_inbound_seq,
    checkpoint.completed_logical_turn_id,
    checkpoint.completed_manager_id,
    checkpoint.completed_generation,
  ];
  if (fields.some((field) => field === null || field === undefined)) return 'missing';
  const identity = resolveResumeIdentity({
    scope: checkpoint.completed_scope,
    conversationKey: checkpoint.conversation_key,
    deliveryJid: checkpoint.completed_delivery_jid,
    deliveryNamespace: checkpoint.completed_delivery_namespace,
    inboundSeq: checkpoint.completed_inbound_seq,
    logicalTurnId: checkpoint.completed_logical_turn_id,
    managerId: checkpoint.completed_manager_id,
    generation: checkpoint.completed_generation,
  });
  if (identity === null) return 'invalid';
  return identity.scope === expectedScope ? 'invalid' : 'scope_mismatch';
}
