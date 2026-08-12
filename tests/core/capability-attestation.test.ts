/**
 * D5 — attestation is exact-bound and expires closed (capability-obligation
 * replay). Claim admission requires a fresh, unrevoked attestation whose EVERY
 * binding field matches the running consumer and the obligation's contract;
 * missing/stale/mismatched/revoked/failed-canary attestations skip admission
 * with a typed reason and never admit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findAdmissibleAttestation,
  recordCapabilityAttestation,
  type CapabilityAttestationBinding,
} from '../../src/core/capability-attestation.ts';
import { Database } from '../../src/core/database.ts';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
});

afterEach(() => {
  db.close();
});

const BINDING: CapabilityAttestationBinding = {
  hostId: 'test-host',
  runtimeUser: 'test-user',
  releaseSha: 'relsha-1',
  schemaVersion: 57,
  providerId: 'claude-cli',
  harnessType: 'persistent_session',
  contractVersion: 'test-instance/1',
  capability: 'child_process_tools',
  skillName: 'watch',
  skillDigest: 'skill-digest-1',
  mediaRoot: '/var/media-root',
};

function record(over: Partial<Parameters<typeof recordCapabilityAttestation>[1]> = {}) {
  return recordCapabilityAttestation(db, {
    ...BINDING,
    skillVersion: '1.0.0',
    resolverDigest: 'resolver-digest-1',
    dependencyVersions: { 'yt-dlp': '2026.03.17' },
    canaryId: 'canary-1',
    canaryResult: 'pass',
    probeVersion: 'probe/1',
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    attestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...over,
  });
}

describe('recordCapabilityAttestation', () => {
  it('inserts and returns the id', () => {
    const id = record();
    expect(id).toBeTypeOf('number');
  });
});

describe('findAdmissibleAttestation — exact binding', () => {
  it('admits an exact fresh match', () => {
    const id = record();
    const found = findAdmissibleAttestation(db, BINDING);
    expect(found.outcome).toBe('admissible');
    if (found.outcome === 'admissible') expect(found.attestationId).toBe(id);
  });

  it('skips with reason none_recorded when nothing matches at all', () => {
    const found = findAdmissibleAttestation(db, BINDING);
    expect(found).toEqual({ outcome: 'skip', reason: 'none_recorded' });
  });

  it.each([
    ['hostId', 'other-host'],
    ['runtimeUser', 'other-user'],
    ['releaseSha', 'other-sha'],
    ['providerId', 'openai-api'],
    ['harnessType', 'managed_loop'],
    ['contractVersion', 'test-instance/2'],
    ['capability', 'other_cap'],
    ['skillName', 'other-skill'],
    ['skillDigest', 'other-digest'],
    ['mediaRoot', '/other/root'],
  ] as const)('a %s mismatch is a typed binding_mismatch skip', (field, wrong) => {
    record();
    const found = findAdmissibleAttestation(db, { ...BINDING, [field]: wrong });
    expect(found).toEqual({ outcome: 'skip', reason: 'binding_mismatch' });
  });

  it('a schemaVersion mismatch is a binding_mismatch skip', () => {
    record();
    const found = findAdmissibleAttestation(db, { ...BINDING, schemaVersion: 58 });
    expect(found).toEqual({ outcome: 'skip', reason: 'binding_mismatch' });
  });

  it('an expired attestation is a stale skip', () => {
    record({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const found = findAdmissibleAttestation(db, BINDING);
    expect(found).toEqual({ outcome: 'skip', reason: 'stale' });
  });

  it('a revoked attestation is a revoked skip', () => {
    const id = record();
    db.raw.prepare("UPDATE capability_attestations SET revoked_at = datetime('now') WHERE id = ?").run(id);
    const found = findAdmissibleAttestation(db, BINDING);
    expect(found).toEqual({ outcome: 'skip', reason: 'revoked' });
  });

  it('a failed canary is a canary_failed skip', () => {
    record({ canaryResult: 'fail' });
    const found = findAdmissibleAttestation(db, BINDING);
    expect(found).toEqual({ outcome: 'skip', reason: 'canary_failed' });
  });

  it('prefers the newest admissible attestation when several match', () => {
    record({ attestedAt: '2026-08-12T00:00:00Z' });
    const newer = record({ attestedAt: '2026-08-12T01:00:00Z' });
    const found = findAdmissibleAttestation(db, BINDING);
    expect(found.outcome).toBe('admissible');
    if (found.outcome === 'admissible') expect(found.attestationId).toBe(newer);
  });

  it('an admissible record among expired/revoked/failed ones still admits', () => {
    record({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    record({ canaryResult: 'fail' });
    const good = record();
    const found = findAdmissibleAttestation(db, BINDING);
    expect(found.outcome).toBe('admissible');
    if (found.outcome === 'admissible') expect(found.attestationId).toBe(good);
  });
});
