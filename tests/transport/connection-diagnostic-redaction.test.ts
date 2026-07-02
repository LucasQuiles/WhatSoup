// QR-118: the diagnostic redactor's keyed-secret denylist (isSensitiveDiagnosticKey)
// must not drift from the shared SSOT (SENSITIVE_KEY_RE). It feeds redactDiagnosticValue,
// which redacts the auth-bond context persisted to connection-state.json / bond-event
// JSONL — so a missing Signal-protocol key name would leave that key material unredacted
// at rest if any creds-shaped object flows through it.
import { describe, it, expect } from 'vitest';
import { isSensitiveDiagnosticKey } from '../../src/transport/connection.ts';
import { SENSITIVE_KEY_RE } from '../../src/transport/third-party-console-redaction.ts';

describe('isSensitiveDiagnosticKey — SSOT coverage (QR-118)', () => {
  // The 11 Signal-protocol keys previously missing from the diagnostic denylist
  // but present in the shared SENSITIVE_KEY_RE.
  const previouslyMissing = [
    'identityKey', 'ratchet', 'rootKey', 'baseKey', 'chainKey', 'messageKeys',
    'ephemeralKey', 'remoteIdentityKey', 'lastRemoteEphemeralKey', 'pubKey', 'privKey',
  ];
  for (const key of previouslyMissing) {
    it(`redacts Signal-protocol key: ${key}`, () => {
      expect(isSensitiveDiagnosticKey(key)).toBe(true);
    });
  }

  it('still redacts the original keys (no regression)', () => {
    for (const key of ['token', 'advSecretKey', 'signedIdentityKey', 'noiseKey', 'appStateSyncKey']) {
      expect(isSensitiveDiagnosticKey(key)).toBe(true);
    }
  });

  it('does not over-match a benign diagnostic key', () => {
    for (const key of ['status', 'timestamp', 'reason', 'cycles']) {
      expect(isSensitiveDiagnosticKey(key)).toBe(false);
    }
  });

  // Drift guard: the diagnostic denylist must be a superset-or-equal of the shared SSOT,
  // so the two redactors cannot diverge again.
  it('is superset-or-equal of the shared SENSITIVE_KEY_RE (no drift)', () => {
    const ssotTokens = SENSITIVE_KEY_RE.source.replace(/^\(\?:|\)$/g, '').split('|');
    const notCovered = ssotTokens.filter((t) => !isSensitiveDiagnosticKey(t));
    expect(notCovered).toEqual([]);
  });
});
