import { DisconnectReason } from '@whiskeysockets/baileys';

import {
  DISCONNECT_DECISION_RECORD_VERSION,
  type DisconnectClassification,
  type DisconnectDecisionRecord,
  type LoggedOutExitBasis,
} from '../lib/disconnect-classification.ts';

export type DisconnectAction =
  | { type: 'exit'; reason: 'logged-out'; basis: LoggedOutExitBasis }
  | { type: 'reconnect'; reason: 'auth-401-unclassified'; statusCode: number }
  | { type: 'reconnect'; reason: 'restart-required' }
  | { type: 'reconnect'; reason: 'restart-required-flapping'; count: number }
  | { type: 'reconnect'; reason: 'connection-replaced'; statusCode: number }
  | { type: 'reconnect'; reason: 'multidevice-mismatch'; statusCode: number }
  | { type: 'reconnect'; reason: 'transient'; statusCode: number }
  | { type: 'reconnect'; reason: 'unknown'; statusCode: number | undefined };

export interface DisconnectContext {
  restartRequiredCount?: number;
  /**
   * The `type` attr of the WhatsApp stream:error conflict node, when the caller has
   * inspected `lastDisconnect.error.data` (Baileys preserves the reasonNode there).
   * Presence of this key (even `null`) signals the node was inspected; only
   * `'device_removed'` is a definitively-terminal server revocation. Absence keeps the
   * conservative exit, labelled `basis: 'uninspected'` rather than confirmed.
   */
  conflictType?: string | null;
  /** True once the single bounded reconnect for an ambiguous 401 has already been spent. */
  unclassified401Attempted?: boolean;
}

const RESTART_REQUIRED_FLAP_THRESHOLD = 10;

const TRANSIENT_RECONNECT_CODES = new Set<number>([
  DisconnectReason.connectionClosed,
  DisconnectReason.timedOut,
  DisconnectReason.badSession,
  DisconnectReason.unavailableService,
]);

export function decideDisconnectAction(
  statusCode: number | undefined,
  context: DisconnectContext = {},
): DisconnectAction {
  if (statusCode === DisconnectReason.loggedOut) {
    // P0-D / H15 false-terminal fix: a 401 is definitively terminal ONLY when the
    // WhatsApp stream:error carried a `device_removed` conflict node. When the caller
    // inspected the node (conflictType key present, even null) and it is NOT
    // device_removed, the 401 is ambiguous and may be recoverable — grant exactly ONE
    // bounded reconnect before parking, rather than a false terminal that exits, makes
    // the watchdog refuse restart, and pages a human. No inspection (key absent) keeps
    // the conservative exit for legacy callers. Each exit names its basis so no
    // consumer has to re-derive which of the three it was.
    const inspected = 'conflictType' in context;
    if (!inspected) {
      return { type: 'exit', reason: 'logged-out', basis: 'uninspected' };
    }
    if ((context.conflictType ?? '').toLowerCase() === 'device_removed') {
      return { type: 'exit', reason: 'logged-out', basis: 'device_removed' };
    }
    if (context.unclassified401Attempted) {
      return { type: 'exit', reason: 'logged-out', basis: 'ambiguous_401_repeated' };
    }
    return { type: 'reconnect', reason: 'auth-401-unclassified', statusCode };
  }
  if (statusCode === DisconnectReason.restartRequired) {
    const count = context.restartRequiredCount ?? 0;
    if (count >= RESTART_REQUIRED_FLAP_THRESHOLD) {
      return { type: 'reconnect', reason: 'restart-required-flapping', count };
    }
    return { type: 'reconnect', reason: 'restart-required' };
  }
  if (statusCode === DisconnectReason.connectionReplaced) {
    return { type: 'reconnect', reason: 'connection-replaced', statusCode };
  }
  if (statusCode === DisconnectReason.multideviceMismatch) {
    return { type: 'reconnect', reason: 'multidevice-mismatch', statusCode };
  }
  if (typeof statusCode === 'number' && TRANSIENT_RECONNECT_CODES.has(statusCode)) {
    return { type: 'reconnect', reason: 'transient', statusCode };
  }
  return { type: 'reconnect', reason: 'unknown', statusCode };
}

/**
 * Name the decision for health and alert consumers. Reads the returned action
 * only — never the inputs — so it cannot drift from decideDisconnectAction.
 */
export function classifyDisconnectAction(action: DisconnectAction): DisconnectClassification {
  if (action.type === 'exit') {
    if (action.basis === 'device_removed') return 'confirmed_device_removed';
    if (action.basis === 'ambiguous_401_repeated') return 'ambiguous_401_parked';
    return 'uninspected_401_conservative_exit';
  }
  if (action.reason === 'auth-401-unclassified') return 'ambiguous_401_reconnecting';
  return 'other';
}

export function formatDisconnectDecision(action: DisconnectAction): string {
  return action.type === 'exit'
    ? `${action.type}:${action.reason}:${action.basis}`
    : `${action.type}:${action.reason}`;
}

// A conflict attr is server-supplied text; carry enough to recognise it, no more.
const MAX_CONFLICT_TYPE_LENGTH = 64;

export function buildDisconnectDecisionRecord(
  statusCode: number | undefined,
  context: DisconnectContext,
  action: DisconnectAction,
  observedAtMs: number | null,
): DisconnectDecisionRecord {
  const conflictInspected = 'conflictType' in context;
  const conflictType = typeof context.conflictType === 'string'
    ? context.conflictType.slice(0, MAX_CONFLICT_TYPE_LENGTH)
    : null;
  return {
    version: DISCONNECT_DECISION_RECORD_VERSION,
    classification: classifyDisconnectAction(action),
    decision: formatDisconnectDecision(action),
    action: action.type,
    reason: action.reason,
    basis: action.type === 'exit' ? action.basis : null,
    statusCode: statusCode ?? null,
    conflictInspected,
    conflictType,
    unclassified401RetrySpent: context.unclassified401Attempted === true,
    observedAt: observedAtMs === null ? null : new Date(observedAtMs).toISOString(),
  };
}
