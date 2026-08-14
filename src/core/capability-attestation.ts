/**
 * D5 — exact-bound capability attestation (capability-obligation replay).
 *
 * An attestation is an immutable, versioned readiness record (migration 58)
 * proving the DECLARED capability contract is actually executable on a specific
 * host/release/provider/skill/dependency/media-root combination, backed by a
 * bounded non-sending canary. Provider health or `/health` output NEVER admits
 * a claim; only an exact, fresh, unrevoked, canary-passing attestation does.
 *
 * `findAdmissibleAttestation` is the single admission query the obligation
 * supervisor consumes: every binding field must match exactly; the result is
 * either `admissible` (newest match) or a typed skip reason. A skip consumes
 * zero execution attempts (D5) — the supervisor simply does not claim.
 *
 * Attestation PRODUCTION (hashing the installed skill, probing dependencies,
 * running the canary) lives in the ops probe tooling; this module owns only the
 * durable record + the admission decision, so the trust boundary is a single
 * reviewed query.
 */
import { createHash } from 'node:crypto';

import type { Database } from './database.ts';

/**
 * D5: EVERY field here participates in the exact-match admission WHERE clause.
 * The running consumer derives all of them from live facts (host, release,
 * provider, contract, installed skill/resolver/dependency identity, configured
 * probe/canary identity, media root); an attestation that differs in any one
 * of them never admits.
 */
export interface CapabilityAttestationBinding {
  hostId: string;
  runtimeUser: string;
  releaseSha: string;
  schemaVersion: number;
  providerId: string;
  harnessType: string;
  contractVersion: string;
  capability: string;
  skillName: string;
  skillVersion: string | null;
  skillDigest: string;
  resolverDigest: string | null;
  dependencyVersions: Record<string, string>;
  probeVersion: string;
  canaryId: string;
  mediaRoot: string;
}

export interface CapabilityAttestationRecordParams extends CapabilityAttestationBinding {
  canaryResult: 'pass' | 'fail';
  nonce: string;
  attestedAt: string;
  expiresAt: string;
}

/**
 * Sorted-key serialization shared by record and admission — key order must
 * never defeat (or forge) a dependency-version match.
 */
export function canonicalDependencyVersions(deps: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

/**
 * A stable, recomputable digest of an attestation's BINDING IDENTITY — exactly
 * the fields `findAdmissibleAttestation` matches on, and NOTHING ephemeral
 * (nonce / attested_at / expires_at are deliberately excluded, so a routine
 * canary re-mint of the same host/release/provider/skill keeps a drain approval
 * valid, while a release/provider/skill/dependency change invalidates it).
 *
 * Because admission is an EXACT match on every one of these fields, this digest
 * computed over the admission `binding` IS the identity of whichever attestation
 * admitted — no row re-read needed. A group drain approval binds to it
 * (`drain_attestation_digest`), and the claim refuses unless the attestation
 * admitting THAT claim carries the same identity (r14 F1): approval →
 * cached-drain-facts → admitting-attestation must all agree.
 *
 * Positional array (not an object) so key order can never defeat or forge a
 * match; `canonicalDependencyVersions` normalises the one nested map.
 */
/**
 * The declared skill/resolver/probe identity half of a binding (from
 * `options.attestation`). Kept separate from the live facts so one shared builder
 * assembles the binding the SAME way for the supervisor's admission and for the
 * operator CLIs — a mismatch here would make every approval unclaimable under the
 * r14-F1 rule (`drain_attestation_digest == admitting binding digest`).
 */
export interface AttestationSkillIdentity {
  skillName: string;
  skillVersion: string | null;
  skillDigest: string;
  resolverDigest: string | null;
  dependencyVersions: Record<string, string>;
  probeVersion: string;
  canaryId: string;
}

/** Assemble the exact D5 binding from its three sources (live facts + obligation/contract + declared identity). */
export function buildCapabilityAttestationBinding(params: {
  liveFacts: {
    hostId: string;
    runtimeUser: string;
    releaseSha: string;
    schemaVersion: number;
    providerId: string;
    harnessType: string;
  };
  contractVersion: string;
  capability: string;
  skill: AttestationSkillIdentity;
  mediaRoot: string;
}): CapabilityAttestationBinding {
  return {
    ...params.liveFacts,
    contractVersion: params.contractVersion,
    capability: params.capability,
    skillName: params.skill.skillName,
    skillVersion: params.skill.skillVersion,
    skillDigest: params.skill.skillDigest,
    resolverDigest: params.skill.resolverDigest,
    dependencyVersions: params.skill.dependencyVersions,
    probeVersion: params.skill.probeVersion,
    canaryId: params.skill.canaryId,
    mediaRoot: params.mediaRoot,
  };
}

export function attestationBindingDigest(binding: CapabilityAttestationBinding): string {
  const canonical = JSON.stringify([
    binding.hostId,
    binding.runtimeUser,
    binding.releaseSha,
    binding.schemaVersion,
    binding.providerId,
    binding.harnessType,
    binding.contractVersion,
    binding.capability,
    binding.skillName,
    binding.skillVersion,
    binding.skillDigest,
    binding.resolverDigest,
    canonicalDependencyVersions(binding.dependencyVersions),
    binding.probeVersion,
    binding.canaryId,
    binding.mediaRoot,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export function recordCapabilityAttestation(
  db: Database,
  params: CapabilityAttestationRecordParams,
): number {
  const result = db.raw
    .prepare(
      `INSERT INTO capability_attestations (
         host_id, runtime_user, release_sha, schema_version, provider_id, harness_type,
         contract_version, capability, skill_name, skill_version, skill_digest,
         resolver_digest, dependency_versions, media_root, canary_id, canary_result,
         probe_version, nonce, attested_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.hostId,
      params.runtimeUser,
      params.releaseSha,
      params.schemaVersion,
      params.providerId,
      params.harnessType,
      params.contractVersion,
      params.capability,
      params.skillName,
      params.skillVersion,
      params.skillDigest,
      params.resolverDigest,
      canonicalDependencyVersions(params.dependencyVersions),
      params.mediaRoot,
      params.canaryId,
      params.canaryResult,
      params.probeVersion,
      params.nonce,
      params.attestedAt,
      params.expiresAt,
    );
  return Number(result.lastInsertRowid);
}

export type AttestationAdmission =
  | { outcome: 'admissible'; attestationId: number }
  | { outcome: 'skip'; reason: 'none_recorded' | 'binding_mismatch' | 'stale' | 'revoked' | 'canary_failed' };

/**
 * The single admission decision. Exact-match on EVERY binding field; among
 * exact matches, freshness/revocation/canary decide; the newest fully
 * admissible record wins. Reason precedence when nothing admits: a fully
 * matching record's defect (canary > revoked > stale) is more informative than
 * `binding_mismatch`, which in turn beats `none_recorded`.
 */
export function findAdmissibleAttestation(
  db: Database,
  binding: CapabilityAttestationBinding,
): AttestationAdmission {
  const total = (
    db.raw.prepare('SELECT COUNT(*) AS c FROM capability_attestations').get() as { c: number }
  ).c;
  if (total === 0) return { outcome: 'skip', reason: 'none_recorded' };

  const rows = db.raw
    .prepare(
      `SELECT id, canary_result, revoked_at,
              (datetime(expires_at) > datetime('now')) AS fresh
       FROM capability_attestations
       WHERE host_id = ? AND runtime_user = ? AND release_sha = ? AND schema_version = ?
         AND provider_id = ? AND harness_type = ? AND contract_version = ? AND capability = ?
         AND skill_name = ? AND skill_version IS ? AND skill_digest = ?
         AND resolver_digest IS ? AND dependency_versions = ?
         AND probe_version = ? AND canary_id = ? AND media_root = ?
       ORDER BY datetime(attested_at) DESC, id DESC`,
    )
    .all(
      binding.hostId,
      binding.runtimeUser,
      binding.releaseSha,
      binding.schemaVersion,
      binding.providerId,
      binding.harnessType,
      binding.contractVersion,
      binding.capability,
      binding.skillName,
      binding.skillVersion,
      binding.skillDigest,
      binding.resolverDigest,
      canonicalDependencyVersions(binding.dependencyVersions),
      binding.probeVersion,
      binding.canaryId,
      binding.mediaRoot,
    ) as Array<{ id: number; canary_result: string; revoked_at: string | null; fresh: number }>;

  if (rows.length === 0) return { outcome: 'skip', reason: 'binding_mismatch' };

  for (const row of rows) {
    if (row.canary_result === 'pass' && row.revoked_at === null && row.fresh === 1) {
      return { outcome: 'admissible', attestationId: row.id };
    }
  }
  // Nothing admissible among exact matches: report the newest record's defect.
  const newest = rows[0]!;
  if (newest.canary_result !== 'pass') return { outcome: 'skip', reason: 'canary_failed' };
  if (newest.revoked_at !== null) return { outcome: 'skip', reason: 'revoked' };
  return { outcome: 'skip', reason: 'stale' };
}
