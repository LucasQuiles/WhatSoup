import { describe, it, expect } from 'vitest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import {
  buildDisconnectDecisionRecord,
  classifyDisconnectAction,
  decideDisconnectAction,
  formatDisconnectDecision,
} from '../../src/transport/auth-disconnect-policy.ts';

describe('decideDisconnectAction', () => {
  it('returns exit/logged-out when statusCode is DisconnectReason.loggedOut', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut)).toEqual({
      type: 'exit',
      reason: 'logged-out',
      basis: 'uninspected',
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
      basis: 'device_removed',
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
    ).toEqual({ type: 'exit', reason: 'logged-out', basis: 'ambiguous_401_repeated' });
  });

  it('device_removed stays terminal even after an attempt flag — never wastes a reconnect on the proven case', () => {
    expect(
      decideDisconnectAction(DisconnectReason.loggedOut, {
        conflictType: 'device_removed',
        unclassified401Attempted: true,
      }),
    ).toEqual({ type: 'exit', reason: 'logged-out', basis: 'device_removed' });
  });

  it('backward compatible: a 401 with no conflict context still exits, labelled uninspected rather than confirmed', () => {
    expect(decideDisconnectAction(DisconnectReason.loggedOut)).toEqual({
      type: 'exit',
      reason: 'logged-out',
      basis: 'uninspected',
    });
  });
});

describe('classifyDisconnectAction — the carried classification is derived from the action alone', () => {
  it('maps every logged-out basis and the bounded retry to its own classification', () => {
    expect(classifyDisconnectAction(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: 'device_removed' })))
      .toBe('confirmed_device_removed');
    expect(classifyDisconnectAction(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: null })))
      .toBe('ambiguous_401_reconnecting');
    expect(classifyDisconnectAction(decideDisconnectAction(DisconnectReason.loggedOut, {
      conflictType: 'replaced',
      unclassified401Attempted: true,
    }))).toBe('ambiguous_401_parked');
    expect(classifyDisconnectAction(decideDisconnectAction(DisconnectReason.loggedOut)))
      .toBe('uninspected_401_conservative_exit');
  });

  it('classifies every non-401 decision as other, including an unmapped future status code', () => {
    for (const code of [
      DisconnectReason.restartRequired,
      DisconnectReason.connectionReplaced,
      DisconnectReason.multideviceMismatch,
      DisconnectReason.connectionClosed,
      599,
      undefined,
    ]) {
      expect(classifyDisconnectAction(decideDisconnectAction(code))).toBe('other');
    }
  });

  it('formats the decision with its basis so a log line cannot read an ambiguous park as a confirmed removal', () => {
    expect(formatDisconnectDecision(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: 'device_removed' })))
      .toBe('exit:logged-out:device_removed');
    expect(formatDisconnectDecision(decideDisconnectAction(DisconnectReason.loggedOut, {
      conflictType: null,
      unclassified401Attempted: true,
    }))).toBe('exit:logged-out:ambiguous_401_repeated');
    expect(formatDisconnectDecision(decideDisconnectAction(DisconnectReason.loggedOut, { conflictType: null })))
      .toBe('reconnect:auth-401-unclassified');
  });
});

describe('buildDisconnectDecisionRecord', () => {
  const observedAtMs = Date.parse('2026-09-25T01:02:03.000Z');

  it('records inspection provenance separately from the conflict value', () => {
    const inspectedNull = { conflictType: null, unclassified401Attempted: false };
    const record = buildDisconnectDecisionRecord(
      DisconnectReason.loggedOut,
      inspectedNull,
      decideDisconnectAction(DisconnectReason.loggedOut, inspectedNull),
      observedAtMs,
    );
    expect(record).toEqual({
      version: 1,
      classification: 'ambiguous_401_reconnecting',
      decision: 'reconnect:auth-401-unclassified',
      action: 'reconnect',
      reason: 'auth-401-unclassified',
      basis: null,
      statusCode: 401,
      conflictInspected: true,
      conflictType: null,
      unclassified401RetrySpent: false,
      observedAt: '2026-09-25T01:02:03.000Z',
    });

    const uninspected = buildDisconnectDecisionRecord(
      DisconnectReason.loggedOut,
      {},
      decideDisconnectAction(DisconnectReason.loggedOut, {}),
      observedAtMs,
    );
    expect(uninspected.conflictInspected).toBe(false);
    expect(uninspected.classification).toBe('uninspected_401_conservative_exit');
    expect(uninspected.basis).toBe('uninspected');
  });

  it('bounds a hostile conflict attribute instead of copying it verbatim', () => {
    const context = { conflictType: `device_removed${'x'.repeat(500)}` };
    const record = buildDisconnectDecisionRecord(
      DisconnectReason.loggedOut,
      context,
      decideDisconnectAction(DisconnectReason.loggedOut, context),
      observedAtMs,
    );
    expect(record.classification).toBe('ambiguous_401_reconnecting');
    expect(record.conflictType!.length).toBeLessThanOrEqual(64);
  });

  it('reports an unknown observation time as null rather than inventing one', () => {
    const record = buildDisconnectDecisionRecord(
      DisconnectReason.connectionClosed,
      {},
      decideDisconnectAction(DisconnectReason.connectionClosed),
      null,
    );
    expect(record.observedAt).toBeNull();
    expect(record.classification).toBe('other');
    expect(record.conflictInspected).toBe(false);
  });
});
