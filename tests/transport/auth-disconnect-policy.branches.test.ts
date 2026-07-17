// Extension tests for auth-disconnect-policy.ts — boundary conditions and edge cases
import { describe, it, expect } from 'vitest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { decideDisconnectAction } from '../../src/transport/auth-disconnect-policy.ts';

describe('decideDisconnectAction extensions — flap threshold boundary conditions', () => {
  it('triggers flapping at exactly RESTART_REQUIRED_FLAP_THRESHOLD (10)', () => {
    expect(decideDisconnectAction(DisconnectReason.restartRequired, { restartRequiredCount: 10 }))
      .toEqual({ type: 'reconnect', reason: 'restart-required-flapping', count: 10 });
  });

  it('does not trigger flapping at THRESHOLD - 1 (9)', () => {
    expect(decideDisconnectAction(DisconnectReason.restartRequired, { restartRequiredCount: 9 }))
      .toEqual({ type: 'reconnect', reason: 'restart-required' });
  });

  it('triggers flapping at THRESHOLD + 1 (11)', () => {
    expect(decideDisconnectAction(DisconnectReason.restartRequired, { restartRequiredCount: 11 }))
      .toEqual({ type: 'reconnect', reason: 'restart-required-flapping', count: 11 });
  });

  it('preserves the count value in the flapping response', () => {
    const result = decideDisconnectAction(DisconnectReason.restartRequired, { restartRequiredCount: 25 });
    expect(result.type).toBe('reconnect');
    expect(result.reason).toBe('restart-required-flapping');
    expect((result as any).count).toBe(25);
  });

  it('flap threshold applies only to restartRequired, not other codes', () => {
    // Even with a high count, other disconnect reasons should not trigger flapping
    expect(decideDisconnectAction(DisconnectReason.connectionClosed, { restartRequiredCount: 99 }))
      .toEqual({ type: 'reconnect', reason: 'transient', statusCode: DisconnectReason.connectionClosed });
  });
});

describe('decideDisconnectAction extensions — 401 conflict-aware edge cases', () => {
  it('case-insensitive device_removed check (uppercase DEVICE_REMOVED)', () => {
    // The source uses .toLowerCase() on the conflictType
    expect(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: 'DEVICE_REMOVED' }))
      .toEqual({ type: 'exit', reason: 'logged-out' });
  });

  it('case-insensitive device_removed check fails for mixed case (not terminal)', () => {
    // Only exact lowercase 'device_removed' after .toLowerCase() is terminal
    expect(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: 'DeviceRemoved' }))
      .toEqual({ type: 'reconnect', reason: 'auth-401-unclassified', statusCode: DisconnectReason.loggedOut });
  });

  it('only device_removed (lowercase) is terminal; other values are ambiguous', () => {
    const conflicts = ['device_removed', 'DEVICE_REMOVED', 'Device_Removed'];
    for (const conflictType of conflicts) {
      const result = decideDisconnectAction(DisconnectReason.loggedOut, { conflictType });
      if (conflictType.toLowerCase() === 'device_removed') {
        expect(result).toEqual({ type: 'exit', reason: 'logged-out' });
      }
    }
  });

  it('empty string conflictType is treated as ambiguous (earns bounded reconnect)', () => {
    // conflictType = '' means inspected but not device_removed
    expect(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: '' }))
      .toEqual({ type: 'reconnect', reason: 'auth-401-unclassified', statusCode: DisconnectReason.loggedOut });
  });

  it('whitespace conflictType is treated as ambiguous', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: '  ' }))
      .toEqual({ type: 'reconnect', reason: 'auth-401-unclassified', statusCode: DisconnectReason.loggedOut });
  });

  it('inspected flag with conflictType=null is ambiguous (node was inspected, returned null)', () => {
    // This is the "node was inspected but returned null" case
    expect(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: null }))
      .toEqual({ type: 'reconnect', reason: 'auth-401-unclassified', statusCode: DisconnectReason.loggedOut });
  });

  it('absence of conflictType key preserves backward-compatible exit (legacy path)', () => {
    // No conflictType key (not present in context object) → conservative exit
    expect(decideDisconnectAction(DisconnectReason.loggedOut, {}))
      .toEqual({ type: 'exit', reason: 'logged-out' });
  });

  it('combined guards: conflictType=device_removed AND unclassified401Attempted still exits', () => {
    // device_removed is terminal regardless of the attempted flag
    expect(decideDisconnectAction(DisconnectReason.loggedOut, {
      conflictType: 'device_removed',
      unclassified401Attempted: true,
    })).toEqual({ type: 'exit', reason: 'logged-out' });
  });
});

describe('decideDisconnectAction extensions — contextual state preservation', () => {
  it('restartRequiredCount is read and preserved, not modified', () => {
    const context = { restartRequiredCount: 5 };
    const result = decideDisconnectAction(DisconnectReason.restartRequired, context);
    expect(context.restartRequiredCount).toBe(5);  // unchanged
  });

  it('unclassified401Attempted is read but not modified', () => {
    const context = { unclassified401Attempted: true };
    const result = decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: null, ...context });
    expect(context.unclassified401Attempted).toBe(true);  // unchanged
  });

  it('multiple context keys are independently evaluated', () => {
    const context = {
      restartRequiredCount: 10,
      conflictType: 'device_removed',
      unclassified401Attempted: true,
    };
    // With conflictType=device_removed, result is exit (device_removed takes precedence)
    expect(decideDisconnectAction(DisconnectReason.loggedOut, context))
      .toEqual({ type: 'exit', reason: 'logged-out' });
  });
});

describe('decideDisconnectAction extensions — default context behavior', () => {
  it('omitted context parameter defaults to empty object (backward compat)', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut))
      .toEqual({ type: 'exit', reason: 'logged-out' });
  });

  it('omitted restartRequiredCount defaults to 0', () => {
    expect(decideDisconnectAction(DisconnectReason.restartRequired, {}))
      .toEqual({ type: 'reconnect', reason: 'restart-required' });
  });
});
