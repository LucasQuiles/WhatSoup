import { DisconnectReason } from '@whiskeysockets/baileys';

export type DisconnectAction =
  | { type: 'exit'; reason: 'logged-out' }
  | { type: 'reconnect'; reason: 'restart-required' }
  | { type: 'reconnect'; reason: 'restart-required-flapping'; count: number }
  | { type: 'reconnect'; reason: 'connection-replaced'; statusCode: number }
  | { type: 'reconnect'; reason: 'multidevice-mismatch'; statusCode: number }
  | { type: 'reconnect'; reason: 'transient'; statusCode: number }
  | { type: 'reconnect'; reason: 'unknown'; statusCode: number | undefined };

interface DisconnectContext {
  restartRequiredCount?: number;
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
    return { type: 'exit', reason: 'logged-out' };
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
