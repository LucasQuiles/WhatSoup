import { DisconnectReason } from '@whiskeysockets/baileys';

export type DisconnectAction =
  | { type: 'exit'; reason: 'logged-out' }
  | { type: 'reconnect'; reason: 'restart-required' }
  | { type: 'reconnect'; reason: 'restart-required-flapping'; count: number }
  | { type: 'reconnect'; reason: 'unknown'; statusCode: number | undefined };

interface DisconnectContext {
  restartRequiredCount?: number;
}

const RESTART_REQUIRED_FLAP_THRESHOLD = 10;

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
  return { type: 'reconnect', reason: 'unknown', statusCode };
}
