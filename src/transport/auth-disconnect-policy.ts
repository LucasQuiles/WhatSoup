import { DisconnectReason } from '@whiskeysockets/baileys';

export type DisconnectAction =
  | { type: 'exit'; reason: 'logged-out' }
  | { type: 'reconnect'; reason: 'auth-401-unclassified'; statusCode: number }
  | { type: 'reconnect'; reason: 'restart-required' }
  | { type: 'reconnect'; reason: 'restart-required-flapping'; count: number }
  | { type: 'reconnect'; reason: 'connection-replaced'; statusCode: number }
  | { type: 'reconnect'; reason: 'multidevice-mismatch'; statusCode: number }
  | { type: 'reconnect'; reason: 'transient'; statusCode: number }
  | { type: 'reconnect'; reason: 'unknown'; statusCode: number | undefined };

interface DisconnectContext {
  restartRequiredCount?: number;
  /**
   * The `type` attr of the WhatsApp stream:error conflict node, when the caller has
   * inspected `lastDisconnect.error.data` (Baileys preserves the reasonNode there).
   * Presence of this key (even `null`) signals the node was inspected; only
   * `'device_removed'` is a definitively-terminal server revocation. Absence keeps the
   * conservative exit for legacy callers (e.g. health classifyDisconnect).
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
    // the conservative exit for legacy callers.
    const inspected = 'conflictType' in context;
    if (!inspected) {
      return { type: 'exit', reason: 'logged-out' };
    }
    if ((context.conflictType ?? '').toLowerCase() === 'device_removed') {
      return { type: 'exit', reason: 'logged-out' };
    }
    if (context.unclassified401Attempted) {
      return { type: 'exit', reason: 'logged-out' };
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
