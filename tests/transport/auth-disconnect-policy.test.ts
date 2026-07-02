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

describe('decideDisconnectAction — 401 conflict-aware split (P0-D / H15 false-terminal fix)', () => {
  // WhatsApp sends the logout verdict as <stream:error code="401"><conflict type="..."/></stream:error>.
  // Baileys preserves the conflict node at lastDisconnect.error.data (socket.js: data: reasonNode).
  // Only a real device_removed conflict is a definitively-terminal server revocation; a bare/other 401
  // may be recoverable, so it earns exactly ONE bounded reconnect before parking — instead of being a
  // false terminal that exits + makes the watchdog refuse restart + pages a human (the H15 bug).

  it('a 401 carrying a device_removed conflict node is definitively terminal', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: 'device_removed' })).toEqual({
      type: 'exit',
      reason: 'logged-out',
    });
  });

  it('an ambiguous 401 (conflict node absent / null) earns exactly one bounded reconnect, not a false terminal', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: null })).toEqual({
      type: 'reconnect',
      reason: 'auth-401-unclassified',
      statusCode: DisconnectReason.loggedOut,
    });
  });

  it('a non-device_removed conflict on a 401 is treated as ambiguous (bounded reconnect, not terminal)', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: 'replaced' })).toEqual({
      type: 'reconnect',
      reason: 'auth-401-unclassified',
      statusCode: DisconnectReason.loggedOut,
    });
  });

  it('parks terminal once the single bounded reconnect for an ambiguous 401 is exhausted', () => {
    expect(
      decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: null, unclassified401Attempted: true }),
    ).toEqual({ type: 'exit', reason: 'logged-out' });
  });

  it('device_removed stays terminal even after an attempt flag — never wastes a reconnect on the proven case', () => {
    expect(
      decideDisconnectAction(DisconnectReason.loggedOut, {
        conflictType: 'device_removed',
        unclassified401Attempted: true,
      }),
    ).toEqual({ type: 'exit', reason: 'logged-out' });
  });

  it('backward compatible: a 401 with no conflict context still exits (health classifyDisconnect path)', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut)).toEqual({
      type: 'exit',
      reason: 'logged-out',
    });
  });
});
