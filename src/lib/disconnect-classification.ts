// src/lib/disconnect-classification.ts
//
// The vocabulary of a transport disconnect decision, shared by the transport
// that makes it (src/transport/auth-disconnect-policy.ts), the /health
// projection that carries it (src/core/health.ts) and the fleet consumers that
// read it back out of a health body. It holds no decision logic: the only
// classifier is decideDisconnectAction, and classifyDisconnectAction maps its
// returned action onto these names.
//
// Why the split exists: a 401 alone is not proof that the server removed the
// linked device. Only a stream:error `conflict type="device_removed"` node is.
// An inspected 401 without it earns one bounded reconnect and then parks; a 401
// whose error node was never inspected exits conservatively. Consumers used to
// read every 401 as confirmed revocation, which paged a human for a relink the
// evidence did not support.

import { isRecord } from './type-guards.ts';

export const DISCONNECT_CLASSIFICATIONS = [
  'confirmed_device_removed',
  'ambiguous_401_reconnecting',
  'ambiguous_401_parked',
  'uninspected_401_conservative_exit',
  // Every non-401 decision. Its detail lives in the decision/reason fields.
  'other',
] as const;
export type DisconnectClassification = (typeof DISCONNECT_CLASSIFICATIONS)[number];

/** Why a 401 exited. Carried on the exit action so the mapping never re-reads inputs. */
export const LOGGED_OUT_EXIT_BASES = ['device_removed', 'ambiguous_401_repeated', 'uninspected'] as const;
export type LoggedOutExitBasis = (typeof LOGGED_OUT_EXIT_BASES)[number];

export const DISCONNECT_DECISION_RECORD_VERSION = 1;

/**
 * The transport's last close decision, as carried into the connection snapshot
 * and the authenticated health body (`whatsapp.connection.disconnect_decision`,
 * snake_cased there). Process-local: null at process start and reset to null by
 * every successful connection open.
 */
export interface DisconnectDecisionRecord {
  version: typeof DISCONNECT_DECISION_RECORD_VERSION;
  classification: DisconnectClassification;
  /** `<action>:<reason>[:<basis>]`, the same string the transport logs. */
  decision: string;
  action: 'exit' | 'reconnect';
  reason: string;
  basis: LoggedOutExitBasis | null;
  statusCode: number | null;
  /** True when the caller looked for a stream:error conflict node at all. */
  conflictInspected: boolean;
  /** The conflict `type` attr when one was found; bounded, never the raw node. */
  conflictType: string | null;
  unclassified401RetrySpent: boolean;
  /** When the close was observed; null when the transport did not record it. */
  observedAt: string | null;
}

/**
 * The auth_failure_class each 401 classification reports. Only a confirmed
 * removal keeps the historical `serverside_logout_irreversible` name.
 */
export const AUTH_401_FAILURE_CLASS_BY_CLASSIFICATION = {
  confirmed_device_removed: 'serverside_logout_irreversible',
  ambiguous_401_reconnecting: 'auth_401_ambiguous_retrying',
  ambiguous_401_parked: 'auth_401_ambiguous_parked',
  uninspected_401_conservative_exit: 'auth_401_uninspected_exit',
} as const satisfies Record<Exclude<DisconnectClassification, 'other'>, string>;
export type Auth401FailureClass =
  (typeof AUTH_401_FAILURE_CLASS_BY_CLASSIFICATION)[keyof typeof AUTH_401_FAILURE_CLASS_BY_CLASSIFICATION];

/**
 * Unconfirmed 401 classes that still must not be restarted. The transport has
 * already stopped retrying; a restart would buy a fresh bounded retry, park
 * again and loop. They are NOT confirmed revocation: consumers that claim a
 * server-side removal (relink verdicts, alert confidence) must not use them.
 */
export const NO_RESTART_UNCONFIRMED_401_CLASSES = [
  AUTH_401_FAILURE_CLASS_BY_CLASSIFICATION.ambiguous_401_parked,
  AUTH_401_FAILURE_CLASS_BY_CLASSIFICATION.uninspected_401_conservative_exit,
] as const;

export function auth401FailureClassFor(classification: DisconnectClassification): Auth401FailureClass | null {
  return classification === 'other' ? null : AUTH_401_FAILURE_CLASS_BY_CLASSIFICATION[classification];
}

/** The authenticated /health projection of a record (snake_case, same values). */
export function formatDisconnectDecisionForHealth(
  record: DisconnectDecisionRecord | null,
): Record<string, unknown> | null {
  if (record === null) return null;
  return {
    version: record.version,
    classification: record.classification,
    decision: record.decision,
    action: record.action,
    reason: record.reason,
    basis: record.basis,
    status_code: record.statusCode,
    conflict_inspected: record.conflictInspected,
    conflict_type: record.conflictType,
    unclassified_401_retry_spent: record.unclassified401RetrySpent,
    observed_at: record.observedAt,
  };
}

export type HealthDisconnectDecisionReading =
  /** Legacy payload: no key. Callers fall back to their pre-classification rule. */
  | { kind: 'absent' }
  /** Key present and null: no close observed since process start or the last open. */
  | { kind: 'none' }
  | { kind: 'classified'; classification: DisconnectClassification }
  /** A newer or damaged record. Neither terminal nor healthy. */
  | { kind: 'unknown'; reason: 'malformed' | 'unsupported_version' | 'unrecognized_classification' };

const CLASSIFICATION_SET = new Set<string>(DISCONNECT_CLASSIFICATIONS);

/** Read `disconnect_decision` from a health body's `whatsapp.connection` node. */
export function readHealthDisconnectDecision(connection: unknown): HealthDisconnectDecisionReading {
  if (!isRecord(connection) || !('disconnect_decision' in connection)) return { kind: 'absent' };
  const node = connection['disconnect_decision'];
  if (node === null) return { kind: 'none' };
  if (!isRecord(node)) return { kind: 'unknown', reason: 'malformed' };
  if (node['version'] !== DISCONNECT_DECISION_RECORD_VERSION) {
    return { kind: 'unknown', reason: 'unsupported_version' };
  }
  const classification = node['classification'];
  if (typeof classification !== 'string' || !CLASSIFICATION_SET.has(classification)) {
    return { kind: 'unknown', reason: 'unrecognized_classification' };
  }
  return { kind: 'classified', classification: classification as DisconnectClassification };
}
