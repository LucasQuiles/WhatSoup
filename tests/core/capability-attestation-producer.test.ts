/**
 * D5 attestation producer (round-15 finding 1): a passing canary yields exactly
 * one ADMISSIBLE attestation; a failed / absent canary or a bad validity window
 * records NOTHING (fail-closed), so admission stays closed. The producer never
 * runs a resolver — the canary outcome is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findAdmissibleAttestation,
  type CapabilityAttestationBinding,
} from '../../src/core/capability-attestation.ts';
import { produceCapabilityAttestation } from '../../src/core/capability-attestation-producer.ts';
import { Database } from '../../src/core/database.ts';

let db: Database;

const BINDING: CapabilityAttestationBinding = {
  hostId: 'test-host', runtimeUser: 'test-user', releaseSha: 'relsha-1', schemaVersion: 60,
  providerId: 'claude-cli', harnessType: 'persistent_session', contractVersion: 'c/1',
  capability: 'child_process_tools', skillName: 'watch', skillVersion: '1.0.0',
  skillDigest: 'sd', resolverDigest: 'rd', dependencyVersions: { 'yt-dlp': '2026.03.17' },
  probeVersion: 'p/1', canaryId: 'can-1', mediaRoot: '/var/media',
};

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
});
afterEach(() => db.close());

describe('produceCapabilityAttestation (D5 producer)', () => {
  it('a PASSING canary records exactly one attestation that ADMITS the same binding', () => {
    const out = produceCapabilityAttestation(db, {
      binding: BINDING,
      canary: { result: 'pass', nonce: 'nonce-1' },
      validForSeconds: 3600,
      attestedAt: new Date(), // fresh so findAdmissibleAttestation's freshness check passes
      evidence: { probeStdoutRef: null, probeStderrRef: null, probeExit: null, canaryInputRef: null, mediaRootReadable: null },
    });
    expect(out).toEqual({ recorded: true, attestationId: expect.any(Number) });
    // End-to-end: the produced attestation is what the supervisor's admission consumes.
    const admission = findAdmissibleAttestation(db, BINDING);
    expect(admission).toEqual({ outcome: 'admissible', attestationId: (out as { attestationId: number }).attestationId });
  });

  it('FALSIFIER: a FAILED canary records NOTHING and leaves admission closed (fail-closed)', () => {
    const out = produceCapabilityAttestation(db, {
      binding: BINDING,
      canary: { result: 'fail', nonce: 'nonce-2' },
      validForSeconds: 3600,
      attestedAt: new Date('2026-08-13T00:00:00.000Z'),
      evidence: { probeStdoutRef: null, probeStderrRef: null, probeExit: null, canaryInputRef: null, mediaRootReadable: null },
    });
    expect(out).toEqual({ recorded: false, reason: 'canary_failed' });
    // Nothing was laundered into a passing attestation.
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_attestations').get() as { c: number }).c).toBe(0);
    expect(findAdmissibleAttestation(db, BINDING)).toEqual({ outcome: 'skip', reason: 'none_recorded' });
  });

  it('a non-positive validity window records nothing', () => {
    expect(
      produceCapabilityAttestation(db, {
        binding: BINDING, canary: { result: 'pass', nonce: 'n' }, validForSeconds: 0,
        attestedAt: new Date('2026-08-13T00:00:00.000Z'),
        evidence: { probeStdoutRef: null, probeStderrRef: null, probeExit: null, canaryInputRef: null, mediaRootReadable: null },
      }),
    ).toEqual({ recorded: false, reason: 'invalid_validity_window' });
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_attestations').get() as { c: number }).c).toBe(0);
  });

  it('the produced attestation expires exactly validForSeconds after attestedAt', () => {
    produceCapabilityAttestation(db, {
      binding: BINDING, canary: { result: 'pass', nonce: 'n-exp' }, validForSeconds: 600,
      attestedAt: new Date('2026-08-13T00:00:00.000Z'),
      evidence: { probeStdoutRef: null, probeStderrRef: null, probeExit: null, canaryInputRef: null, mediaRootReadable: null },
    });
    const row = db.raw.prepare('SELECT attested_at, expires_at FROM capability_attestations LIMIT 1').get() as {
      attested_at: string; expires_at: string;
    };
    expect(row.attested_at).toBe('2026-08-13T00:00:00.000Z');
    expect(row.expires_at).toBe('2026-08-13T00:10:00.000Z');
  });
});
