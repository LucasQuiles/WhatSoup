import { describe, expect, it } from 'vitest';
import { dedupSuppresses } from '../../src/engine/dedup.ts';
import { Severity } from '../../src/types.ts';

const NOW = Date.parse('2026-05-08T12:00:00Z');
const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);

describe('dedupSuppresses', () => {
  it('suppresses a fresh high alert with the same fingerprint within the 6h window', () => {
    const result = dedupSuppresses({
      now: NOW,
      severity: 'high',
      fingerprint: FINGERPRINT,
      previousAlert: { ts: NOW - 60 * 60 * 1000, severity: 'high', fingerprint: FINGERPRINT },
    });

    expect(result.suppress).toBe(true);
  });

  it('does not suppress past the severity window', () => {
    const result = dedupSuppresses({
      now: NOW,
      severity: 'high',
      fingerprint: FINGERPRINT,
      previousAlert: { ts: NOW - 7 * 60 * 60 * 1000, severity: 'high', fingerprint: FINGERPRINT },
    });

    expect(result).toEqual({ suppress: false, reason: 'dedup window expired' });
  });

  it('does not suppress at the exact severity window boundary', () => {
    const result = dedupSuppresses({
      now: NOW,
      severity: 'high',
      fingerprint: FINGERPRINT,
      previousAlert: { ts: NOW - 6 * 60 * 60 * 1000, severity: 'high', fingerprint: FINGERPRINT },
    });

    expect(result).toEqual({ suppress: false, reason: 'dedup window expired' });
  });

  it('does not suppress on severity escalation', () => {
    const result = dedupSuppresses({
      now: NOW,
      severity: 'crit',
      fingerprint: FINGERPRINT,
      previousAlert: { ts: NOW - 60 * 60 * 1000, severity: 'high', fingerprint: FINGERPRINT },
    });

    expect(result).toEqual({ suppress: false, reason: 'severity escalated' });
  });

  it('does not suppress when the fingerprint changed', () => {
    const result = dedupSuppresses({
      now: NOW,
      severity: 'high',
      fingerprint: FINGERPRINT,
      previousAlert: { ts: NOW - 60 * 60 * 1000, severity: 'high', fingerprint: OTHER_FINGERPRINT },
    });

    expect(result).toEqual({ suppress: false, reason: 'fingerprint changed' });
  });

  it('does not suppress when there is no previous alert', () => {
    expect(dedupSuppresses({
      now: NOW,
      severity: 'med',
      fingerprint: FINGERPRINT,
      previousAlert: undefined,
    }).suppress).toBe(false);
  });

  it('does not suppress severities with no dedup window', () => {
    const result = dedupSuppresses({
      now: NOW,
      severity: 'crit',
      fingerprint: FINGERPRINT,
      previousAlert: { ts: NOW - 60_000, severity: 'crit', fingerprint: FINGERPRINT },
    });

    expect(result).toEqual({ suppress: false, reason: 'severity has no dedup window' });
  });

  it('does not suppress when the previous alert timestamp is in the future', () => {
    const result = dedupSuppresses({
      now: NOW,
      severity: 'high',
      fingerprint: FINGERPRINT,
      previousAlert: { ts: NOW + 60_000, severity: 'high', fingerprint: FINGERPRINT },
    });

    expect(result).toEqual({ suppress: false, reason: 'previous alert is in the future' });
  });

  it('does not suppress when the caller marks the decision as protected from dedup', () => {
    const result = dedupSuppresses({
      now: NOW,
      severity: 'high',
      fingerprint: FINGERPRINT,
      previousAlert: { ts: NOW - 60_000, severity: 'high', fingerprint: FINGERPRINT },
      dedupAllowed: false,
    });

    expect(result).toEqual({ suppress: false, reason: 'dedup disabled for event' });
  });

  it('lets the schema reject unknown severity before helper use', () => {
    expect(() => Severity.parse('urgent')).toThrow();
  });
});
