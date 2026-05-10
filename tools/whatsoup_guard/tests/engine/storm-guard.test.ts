import { describe, expect, it } from 'vitest';
import { stormGuardSuppresses } from '../../src/engine/storm-guard.ts';

const NOW = Date.parse('2026-05-08T12:00:00Z');
const APPLIED = 'APPLIED';

describe('stormGuardSuppresses', () => {
  it('does not suppress the first occurrence', () => {
    const result = stormGuardSuppresses({
      now: NOW,
      lastAlert: undefined,
      payloadHash: 'p1',
      actionResult: APPLIED,
    });

    expect(result.suppress).toBe(false);
  });

  it('suppresses an identical crit within 15 minutes', () => {
    const result = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 60_000, payloadHash: 'p1', actionResult: APPLIED },
      payloadHash: 'p1',
      actionResult: APPLIED,
    });

    expect(result).toEqual({ suppress: true, reason: 'identical crit within 15m window' });
  });

  it('does not suppress when payload changes', () => {
    const result = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 60_000, payloadHash: 'p1', actionResult: APPLIED },
      payloadHash: 'p2',
      actionResult: APPLIED,
    });

    expect(result).toEqual({ suppress: false, reason: 'payload changed' });
  });

  it('does not suppress when action result changes', () => {
    const result = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 60_000, payloadHash: 'p1', actionResult: APPLIED },
      payloadHash: 'p1',
      actionResult: 'FAILED',
    });

    expect(result).toEqual({ suppress: false, reason: 'action changed' });
  });

  it('does not suppress past the 15-minute window', () => {
    const result = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 16 * 60_000, payloadHash: 'p1', actionResult: APPLIED },
      payloadHash: 'p1',
      actionResult: APPLIED,
    });

    expect(result).toEqual({ suppress: false, reason: 'storm window expired' });
  });

  it('does not suppress at the exact 15-minute boundary', () => {
    const result = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW - 15 * 60_000, payloadHash: 'p1', actionResult: APPLIED },
      payloadHash: 'p1',
      actionResult: APPLIED,
    });

    expect(result).toEqual({ suppress: false, reason: 'storm window expired' });
  });

  it('does not suppress when the prior alert timestamp is in the future', () => {
    const result = stormGuardSuppresses({
      now: NOW,
      lastAlert: { ts: NOW + 60_000, payloadHash: 'p1', actionResult: APPLIED },
      payloadHash: 'p1',
      actionResult: APPLIED,
    });

    expect(result).toEqual({ suppress: false, reason: 'last alert is in the future' });
  });
});
