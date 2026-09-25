import { describe, expect, it } from 'vitest';

import {
  AUTH_401_FAILURE_CLASS_BY_CLASSIFICATION,
  DISCONNECT_CLASSIFICATIONS,
  NO_RESTART_UNCONFIRMED_401_CLASSES,
  readHealthDisconnectDecision,
} from '../../src/lib/disconnect-classification.ts';
import registry from '../../src/lib/fault-taxonomy-registry.json' with { type: 'json' };

describe('readHealthDisconnectDecision — consumer side of whatsapp.connection.disconnect_decision', () => {
  const record = (classification: unknown, extra: Record<string, unknown> = {}) => ({
    disconnect_decision: { version: 1, classification, ...extra },
  });

  it('reports a legacy payload with no disconnect_decision key as absent, so callers use the documented fallback', () => {
    expect(readHealthDisconnectDecision({ last_status_code: 401 })).toEqual({ kind: 'absent' });
    expect(readHealthDisconnectDecision(undefined)).toEqual({ kind: 'absent' });
    expect(readHealthDisconnectDecision('not-a-record')).toEqual({ kind: 'absent' });
  });

  it('reports an explicit null as none: no close observed since process start or the last open', () => {
    expect(readHealthDisconnectDecision({ disconnect_decision: null })).toEqual({ kind: 'none' });
  });

  it('returns every known classification unchanged', () => {
    for (const classification of DISCONNECT_CLASSIFICATIONS) {
      expect(readHealthDisconnectDecision(record(classification))).toEqual({
        kind: 'classified',
        classification,
      });
    }
  });

  it('keeps an unknown future classification unknown instead of mapping it to terminal or healthy', () => {
    expect(readHealthDisconnectDecision(record('device_quarantined_v2'))).toEqual({
      kind: 'unknown',
      reason: 'unrecognized_classification',
    });
  });

  it('treats a wrong version, a non-string classification or a non-object node as unknown, never as absent', () => {
    expect(readHealthDisconnectDecision(record('confirmed_device_removed', { version: 2 }))).toEqual({
      kind: 'unknown',
      reason: 'unsupported_version',
    });
    expect(readHealthDisconnectDecision(record(42))).toEqual({
      kind: 'unknown',
      reason: 'unrecognized_classification',
    });
    expect(readHealthDisconnectDecision({ disconnect_decision: 'confirmed_device_removed' })).toEqual({
      kind: 'unknown',
      reason: 'malformed',
    });
    expect(readHealthDisconnectDecision({ disconnect_decision: [] })).toEqual({
      kind: 'unknown',
      reason: 'malformed',
    });
  });
});

describe('auth-failure classes carried from the transport decision', () => {
  it('names confirmed removal serverside_logout_irreversible and gives each unconfirmed 401 its own class', () => {
    expect(AUTH_401_FAILURE_CLASS_BY_CLASSIFICATION).toEqual({
      confirmed_device_removed: 'serverside_logout_irreversible',
      ambiguous_401_reconnecting: 'auth_401_ambiguous_retrying',
      ambiguous_401_parked: 'auth_401_ambiguous_parked',
      uninspected_401_conservative_exit: 'auth_401_uninspected_exit',
    });
  });

  it('keeps every no-restart unconfirmed class in the registry terminal set so no watchdog restart-loops it', () => {
    for (const cls of NO_RESTART_UNCONFIRMED_401_CLASSES) {
      expect(registry.authFailureClasses).toContain(cls);
    }
    expect(registry.authFailureClasses).not.toContain('auth_401_ambiguous_retrying');
  });

  it('uses class names that are not substrings of one another, because Python consumers match by substring', () => {
    const names = [
      ...registry.authFailureClasses,
      'auth_401_ambiguous_retrying',
      'auth_bond_at_risk',
      'auth_bond_read_persistent',
      'local_corruption_restorable',
      'local_corruption_unrestorable',
    ];
    for (const a of names) {
      for (const b of names) {
        if (a !== b) expect(b.includes(a), `${a} is a substring of ${b}`).toBe(false);
      }
    }
  });
});
