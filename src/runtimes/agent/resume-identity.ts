import { toConversationKey } from '../../core/conversation-key.ts';
import {
  parseWhatsAppDeliveryNamespace,
  type WhatsAppDeliveryNamespace,
} from '../../core/jid-constants.ts';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
