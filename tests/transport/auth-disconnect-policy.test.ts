import { describe, it, expect } from 'vitest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { decideDisconnectAction } from '../../src/transport/auth-disconnect-policy.ts';

describe('decideDisconnectAction', () => {
  it('returns exit/logged-out when statusCode is DisconnectReason.loggedOut', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut)).toEqual({
      type: 'exit',
      reason: 'logged-out',
    });
  });

  it('returns reconnect/restart-required when statusCode is DisconnectReason.restartRequired', () => {
    expect(decideDisconnectAction(DisconnectReason.restartRequired)).toEqual({
      type: 'reconnect',
      reason: 'restart-required',
    });
  });

  it('returns reconnect/unknown with statusCode undefined when statusCode is undefined', () => {
    expect(decideDisconnectAction(undefined)).toEqual({
      type: 'reconnect',
      reason: 'unknown',
      statusCode: undefined,
    });
  });

  it('returns reconnect/unknown with statusCode preserved for an arbitrary non-mapped code', () => {
    expect(decideDisconnectAction(DisconnectReason.connectionClosed)).toEqual({
      type: 'reconnect',
      reason: 'unknown',
      statusCode: DisconnectReason.connectionClosed,
    });
  });
});
