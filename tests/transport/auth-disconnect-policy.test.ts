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

  it('returns reconnect/restart-required-flapping when restartRequired reaches the flap threshold', () => {
    expect(decideDisconnectAction(DisconnectReason.restartRequired, { restartRequiredCount: 10 })).toEqual({
      type: 'reconnect',
      reason: 'restart-required-flapping',
      count: 10,
    });
  });

  it('returns reconnect/unknown with statusCode undefined when statusCode is undefined', () => {
    expect(decideDisconnectAction(undefined)).toEqual({
      type: 'reconnect',
      reason: 'unknown',
      statusCode: undefined,
    });
  });

  it('returns reconnect/transient for socket churn codes that must not require QR relink', () => {
    expect(decideDisconnectAction(DisconnectReason.connectionClosed)).toEqual({
      type: 'reconnect',
      reason: 'transient',
      statusCode: DisconnectReason.connectionClosed,
    });
    expect(decideDisconnectAction(DisconnectReason.timedOut)).toEqual({
      type: 'reconnect',
      reason: 'transient',
      statusCode: DisconnectReason.timedOut,
    });
    expect(decideDisconnectAction(DisconnectReason.unavailableService)).toEqual({
      type: 'reconnect',
      reason: 'transient',
      statusCode: DisconnectReason.unavailableService,
    });
    expect(decideDisconnectAction(DisconnectReason.badSession)).toEqual({
      type: 'reconnect',
      reason: 'transient',
      statusCode: DisconnectReason.badSession,
    });
  });

  it('returns reconnect/connection-replaced for duplicate-session conflicts', () => {
    expect(decideDisconnectAction(DisconnectReason.connectionReplaced)).toEqual({
      type: 'reconnect',
      reason: 'connection-replaced',
      statusCode: DisconnectReason.connectionReplaced,
    });
  });

  it('returns reconnect/multidevice-mismatch for recoverable sync mismatch', () => {
    expect(decideDisconnectAction(DisconnectReason.multideviceMismatch)).toEqual({
      type: 'reconnect',
      reason: 'multidevice-mismatch',
      statusCode: DisconnectReason.multideviceMismatch,
    });
  });

  it('returns reconnect/unknown with statusCode preserved for an arbitrary non-mapped code', () => {
    expect(decideDisconnectAction(599)).toEqual({
      type: 'reconnect',
      reason: 'unknown',
      statusCode: 599,
    });
  });
});
