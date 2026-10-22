import { nonEmptyString } from '../lib/type-guards.ts';
import {
  NO_RESTART_UNCONFIRMED_401_CLASSES,
  type DisconnectClassification,
  type HealthDisconnectDecisionReading,
} from '../lib/disconnect-classification.ts';

// Logged out with no transport retry left. Mirrors the registry's
// authFailureClasses (src/lib/fault-taxonomy-registry.json). Membership means
// "do not restart, the line is down", NOT "the server confirmed removal": the
// two unconfirmed-401 classes are here so no consumer restart-loops them.
export const TERMINAL_AUTH_FAILURE_CLASSES = [
  'pairing_required',
  'serverside_logout_irreversible',
  ...NO_RESTART_UNCONFIRMED_401_CLASSES,
] as const;

const TERMINAL_AUTH_FAILURE_CLASS_SET = new Set<string>(TERMINAL_AUTH_FAILURE_CLASSES);
const LOGGED_OUT_STATUS_CODE = 401;
const LOGGED_OUT_REASON_KEY = 'loggedout';
// Classifications where the transport has stopped: the line is logged out.
const LOGGED_OUT_CLASSIFICATIONS = new Set<DisconnectClassification>([
  'confirmed_device_removed',
  'ambiguous_401_parked',
  'uninspected_401_conservative_exit',
]);

export interface ExplicitAuthLossSignalInput {
  lastStatusCode: unknown;
  lastDisconnectReason: unknown;
  authFailureClass: unknown;
  /**
   * readHealthDisconnectDecision(whatsapp.connection). Omitted or `absent`
   * means a legacy body, where a raw 401 / loggedOut still counts. When the
   * body carries a decision the raw fields do not: an ambiguous 401 inside its
   * bounded retry is not auth loss, and an unknown future classification
   * stays unknown rather than terminal.
   */
  disconnectDecision?: HealthDisconnectDecisionReading;
}

function normalizedText(value: unknown): string | null {
  return nonEmptyString(value);
}

function normalizedSignalKey(value: unknown): string | null {
  const text = normalizedText(value);
  return text === null ? null : text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isLoggedOutStatusCode(value: unknown): boolean {
  if (typeof value === 'number') return value === LOGGED_OUT_STATUS_CODE;
  const text = normalizedText(value);
  if (text === null || !/^\d+$/.test(text)) return false;
  return Number(text) === LOGGED_OUT_STATUS_CODE;
}

export function isLoggedOutDisconnectReason(value: unknown): boolean {
  return normalizedSignalKey(value) === LOGGED_OUT_REASON_KEY;
}

export function isTerminalAuthFailureClass(value: unknown): boolean {
  const text = normalizedText(value);
  return text !== null && TERMINAL_AUTH_FAILURE_CLASS_SET.has(text.toLowerCase());
}

export function hasExplicitAuthLossSignal(input: ExplicitAuthLossSignalInput): boolean {
  if (isTerminalAuthFailureClass(input.authFailureClass)) return true;
  const decision = input.disconnectDecision ?? { kind: 'absent' };
  if (decision.kind === 'absent') {
    return isLoggedOutStatusCode(input.lastStatusCode) || isLoggedOutDisconnectReason(input.lastDisconnectReason);
  }
  return decision.kind === 'classified' && LOGGED_OUT_CLASSIFICATIONS.has(decision.classification);
}
