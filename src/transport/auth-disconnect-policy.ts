import { DisconnectReason } from '@whiskeysockets/baileys';

export type DisconnectAction =
  | { type: 'exit'; reason: 'logged-out' }
  | { type: 'reconnect'; reason: 'restart-required' }
  | { type: 'reconnect'; reason: 'unknown'; statusCode: number | undefined };

export function decideDisconnectAction(statusCode: number | undefined): DisconnectAction {
  if (statusCode === DisconnectReason.loggedOut) {
    return { type: 'exit', reason: 'logged-out' };
  }
  if (statusCode === DisconnectReason.restartRequired) {
    return { type: 'reconnect', reason: 'restart-required' };
  }
  return { type: 'reconnect', reason: 'unknown', statusCode };
}
