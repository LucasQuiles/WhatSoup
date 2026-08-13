/**
 * capability-obligation-attest (round-15 finding 1 front-door): the operator
 * command derives the binding and records an ADMISSIBLE attestation only on a
 * passing canary. Dry-run (no canary) records nothing; a failed canary records
 * nothing (fail-closed). The canary outcome is injected here — no resolver runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findAdmissibleAttestation } from '../../src/core/capability-attestation.ts';
import { Database } from '../../src/core/database.ts';
import { attest, bindingForAttestArgs, parseAttestArgs, type AttestArgs } from '../../scripts/capability-obligation-attest.ts';

let db: Database;

function args(over: Partial<AttestArgs> = {}): AttestArgs {
  return {
    dbPath: ':memory:', providerId: 'claude-cli', contractVersion: 'c/1', capability: 'child_process_tools',
    skill: {
      skillName: 'watch', skillVersion: '1.0.0', skillDigest: 'sd', resolverDigest: 'rd',
      dependencyVersions: { 'yt-dlp': '2026.03.17' }, probeVersion: 'p/1', canaryId: 'can-1',
    },
    mediaRoot: '/var/media', releaseSha: 'rel-1', validForSeconds: 3600, runId: 'run-1',
    hostId: 'test-host', runtimeUser: 'test-user', runCanary: false, confirm: false, json: false,
    ...over,
  };
}

beforeEach(() => { db = new Database(':memory:'); db.open(); });
afterEach(() => db.close());

describe('attest (operator attestation producer front-door)', () => {
  it('dry-run (no canary) derives the digest and records NOTHING', () => {
    const result = attest(db, args(), null, new Date());
    expect(result).toMatchObject({ mode: 'dry-run', recorded: false, attestationDigest: expect.any(String) });
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_attestations').get() as { c: number }).c).toBe(0);
  });

  it('a PASSING canary records an attestation that ADMITS the derived binding', () => {
    const a = args();
    const result = attest(db, a, { result: 'pass', nonce: 'run-1' }, new Date());
    expect(result).toMatchObject({ mode: 'record', recorded: true, attestationId: expect.any(Number) });
    expect(findAdmissibleAttestation(db, bindingForAttestArgs(a))).toMatchObject({ outcome: 'admissible' });
  });

  it('FALSIFIER: a FAILED canary records nothing and admission stays closed', () => {
    const a = args();
    const result = attest(db, a, { result: 'fail', nonce: 'run-1' }, new Date());
    expect(result).toMatchObject({ mode: 'record', recorded: false, reason: 'canary_failed' });
    expect(findAdmissibleAttestation(db, bindingForAttestArgs(a))).toMatchObject({ outcome: 'skip' });
  });

  it('parseAttestArgs requires the core binding flags and collects --dep', () => {
    const parsed = parseAttestArgs([
      '--db', 'x.db', '--provider', 'claude-cli', '--contract-version', 'c/1', '--capability', 'child_process_tools',
      '--skill-name', 'watch', '--skill-digest', 'sd', '--probe-version', 'p/1', '--canary-id', 'can-1',
      '--media-root', '/var/media', '--release-sha', 'rel-1', '--valid-seconds', '3600', '--run-id', 'run-1',
      '--dep', 'yt-dlp=2026.03.17', '--host', 'h', '--runtime-user', 'u',
    ]);
    expect(parsed.skill.dependencyVersions).toEqual({ 'yt-dlp': '2026.03.17' });
    expect(parsed.runCanary).toBe(false);
    expect(() => parseAttestArgs(['--db', 'x.db'])).toThrow(/--provider is required/);
  });
});
