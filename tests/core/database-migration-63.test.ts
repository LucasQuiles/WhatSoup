/**
 * Migration 63 (#3221 Debt 2): the attestation-evidence columns land IN the
 * `capability_attestations` row — probe stdout/stderr refs (sha256, never raw
 * content), the probe exit code, the bounded canary-input ref, and the observed
 * media-root readability — graduating the round-17 receipt file from sole
 * preservation to corroboration. The migration also REBUILDS the
 * `capability_attestations_immutable` trigger so the new evidence columns are
 * immutable exactly like every other attestation field.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { produceCapabilityAttestation } from '../../src/core/capability-attestation-producer.ts';
import type { CapabilityAttestationBinding } from '../../src/core/capability-attestation.ts';
import { runMigration58 } from '../../src/core/database-migration-58.ts';
import { runMigration63 } from '../../src/core/database-migration-63.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

const EVIDENCE_COLUMNS = [
  'probe_stdout_ref',
  'probe_stderr_ref',
  'probe_exit',
  'canary_input_ref',
  'media_root_readable',
] as const;

const SHA64 = 'a'.repeat(64);

function columnNames(raw: DatabaseSync): string[] {
  return (raw.prepare("PRAGMA table_info('capability_attestations')").all() as Array<{ name: string }>)
    .map((c) => c.name);
}

/** Insert a full attestation row via raw SQL (column list explicit, evidence optional). */
function insertAttestation(raw: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    host_id: 'h1',
    runtime_user: 'u1',
    release_sha: 'sha1',
    schema_version: 63,
    provider_id: 'claude-cli',
    harness_type: 'persistent_session',
    contract_version: 'c/1',
    capability: 'child_process_tools',
    skill_name: 'watch',
    skill_digest: 'sd',
    dependency_versions: '{}',
    media_root: '/var/media',
    canary_id: 'can-1',
    canary_result: 'pass',
    probe_version: 'p/1',
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    attested_at: '2026-08-29T00:00:00.000Z',
    expires_at: '2026-08-29T01:00:00.000Z',
    ...overrides,
  };
  const columns = Object.keys(row);
  raw
    .prepare(
      `INSERT INTO capability_attestations (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...(Object.values(row) as Array<string | number | null>));
}

describe('database migration 63 — attestation-evidence columns', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    runMigration58(raw);
  });

  afterEach(() => {
    raw.close();
  });

  it('adds the five evidence columns that migration 58 did not carry', () => {
    const before = columnNames(raw);
    for (const col of EVIDENCE_COLUMNS) expect(before).not.toContain(col);
    runMigration63(raw);
    const after = columnNames(raw);
    for (const col of EVIDENCE_COLUMNS) expect(after).toContain(col);
  });

  it('re-runs idempotently and preserves existing rows (legacy rows keep NULL evidence)', () => {
    insertAttestation(raw, { nonce: 'legacy-1' });
    runMigration63(raw);
    runMigration63(raw);
    const row = raw
      .prepare(
        `SELECT probe_stdout_ref, probe_stderr_ref, probe_exit, canary_input_ref, media_root_readable
         FROM capability_attestations WHERE nonce = 'legacy-1'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      probe_stdout_ref: null,
      probe_stderr_ref: null,
      probe_exit: null,
      canary_input_ref: null,
      media_root_readable: null,
    });
  });

  it('rejects malformed evidence at the schema layer (64-hex refs, 0/1 readability, integer exit)', () => {
    runMigration63(raw);
    expect(() => insertAttestation(raw, { probe_stdout_ref: 'short' })).toThrow(/CHECK/i);
    expect(() => insertAttestation(raw, { probe_stderr_ref: 'x'.repeat(63) })).toThrow(/CHECK/i);
    expect(() => insertAttestation(raw, { canary_input_ref: 'y'.repeat(65) })).toThrow(/CHECK/i);
    expect(() => insertAttestation(raw, { media_root_readable: 5 })).toThrow(/CHECK/i);
    expect(() => insertAttestation(raw, { probe_exit: 'zero' })).toThrow(/CHECK/i);
    insertAttestation(raw, {
      nonce: 'ok-1',
      probe_stdout_ref: SHA64,
      probe_stderr_ref: SHA64,
      probe_exit: 0,
      canary_input_ref: SHA64,
      media_root_readable: 1,
    });
  });

  it('REBUILDS the immutability trigger to cover the evidence columns (one-way revocation preserved)', () => {
    runMigration63(raw);
    insertAttestation(raw, {
      nonce: 'imm-1',
      probe_stdout_ref: SHA64,
      probe_exit: 0,
      media_root_readable: 1,
    });
    for (const col of EVIDENCE_COLUMNS) {
      expect(() =>
        raw.prepare(`UPDATE capability_attestations SET ${col} = NULL WHERE nonce = 'imm-1'`).run(),
      ).toThrow(/immutable/i);
    }
    // Revocation stays available and one-way, exactly as migration 58 defined it.
    raw.prepare("UPDATE capability_attestations SET revoked_at = '2026-08-29T02:00:00.000Z' WHERE nonce = 'imm-1'").run();
    expect(() =>
      raw.prepare('UPDATE capability_attestations SET revoked_at = NULL WHERE nonce = \'imm-1\'').run(),
    ).toThrow(/one-way/i);
  });
});

describe('migration 63 through the full registry + the producer writes the evidence', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => db.close());

  it('a fresh database opens at schema 63 with the evidence columns present', () => {
    expect(CURRENT_SCHEMA_MIGRATION).toBe(64);
    const cols = columnNames(db.raw as unknown as DatabaseSync);
    for (const col of EVIDENCE_COLUMNS) expect(cols).toContain(col);
  });

  it('produceCapabilityAttestation persists the evidence IN the row (receipt becomes corroborating)', () => {
    const binding: CapabilityAttestationBinding = {
      hostId: 'h1', runtimeUser: 'u1', releaseSha: 'sha1', schemaVersion: 63,
      providerId: 'claude-cli', harnessType: 'persistent_session', contractVersion: 'c/1',
      capability: 'child_process_tools', skillName: 'watch', skillVersion: '1.0.0',
      skillDigest: 'sd', resolverDigest: 'rd', dependencyVersions: {}, probeVersion: 'p/1',
      canaryId: 'can-1', mediaRoot: '/var/media',
    };
    const out = produceCapabilityAttestation(db, {
      binding,
      canary: { result: 'pass', nonce: 'evidence-1' },
      validForSeconds: 3600,
      attestedAt: new Date('2026-08-29T00:00:00.000Z'),
      evidence: {
        probeStdoutRef: SHA64,
        probeStderrRef: SHA64,
        probeExit: 0,
        canaryInputRef: SHA64,
        mediaRootReadable: true,
      },
    });
    expect(out).toEqual({ recorded: true, attestationId: expect.any(Number) });
    const row = db.raw
      .prepare(
        `SELECT probe_stdout_ref, probe_stderr_ref, probe_exit, canary_input_ref, media_root_readable
         FROM capability_attestations WHERE nonce = 'evidence-1'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      probe_stdout_ref: SHA64,
      probe_stderr_ref: SHA64,
      probe_exit: 0,
      canary_input_ref: SHA64,
      media_root_readable: 1,
    });
  });
});
