import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SIGNAL_KINDS, type SignalKind } from './envelope.ts';

export interface ProducerRegistration {
  producerId: string;
  producerDomainId: string;
  allowedKinds: readonly SignalKind[];
  allowedConditionClasses: readonly string[];
  allowedSubjects: readonly string[];
  enrollmentTtlMs?: number;
}

export type RegisterResult =
  | { ok: true; enrollmentSecret: string; enrollmentSecretExpiresAt: string }
  | { ok: false; reason: 'producer_exists' | 'invalid_input' };

/** Internal-only failure classification for security auditing. Never exposed
 * over HTTP — external enrollment failures stay uniform. */
export type ExchangeFailureReason =
  | 'no_active_enrollment'
  | 'enrollment_expired'
  | 'secret_mismatch'
  | 'enrollment_burned';

export type ExchangeResult =
  | { ok: true; credential: string; credentialExpiresAt: string }
  | { ok: false; reason: ExchangeFailureReason };
export type RotateResult = { ok: true; credential: string; credentialExpiresAt: string } | { ok: false };

export interface AuthenticatedProducer {
  producerId: string;
  producerDomainId: string;
  allowedKinds: readonly string[];
  allowedConditionClasses: readonly string[];
  allowedSubjects: readonly string[];
}

export type ScopeDenial = 'kind_not_allowed' | 'condition_class_not_allowed' | 'subject_not_allowed';

const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60_000;
const MAX_ENROLLMENT_TTL_MS = 30 * 60_000;
const DEFAULT_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60_000;
const DEFAULT_ROTATION_OVERLAP_MS = 24 * 60 * 60_000;
const MAX_ENROLLMENT_MISMATCHES = 3;
const MAX_ID_LENGTH = 128;

interface ProducerRow {
  producer_id: string;
  producer_domain_id: string;
  allowed_kinds: string;
  allowed_condition_classes: string;
  allowed_subjects: string;
  status: string;
  credential_hash: string | null;
  credential_expires_at: string | null;
  prev_credential_hash: string | null;
  prev_expires_at: string | null;
  enrollment_secret_hash: string | null;
  enrollment_secret_expires_at: string | null;
  enrollment_mismatches: number;
}

export class ProducerStore {
  private readonly db: DatabaseSync;
  private readonly rotationOverlapMs: number;
  private readonly credentialTtlMs: number;

  // No close(): the ProducerStore shares its handle with the IncidentStore,
  // and the owning aggregate (the fleet server, or the test that opened the
  // database) is the only closer — two closers on one handle double-close.
  constructor(db: DatabaseSync, options?: { rotationOverlapMs?: number; credentialTtlMs?: number }) {
    this.db = db;
    this.rotationOverlapMs = options?.rotationOverlapMs ?? DEFAULT_ROTATION_OVERLAP_MS;
    this.credentialTtlMs = options?.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS;
  }

  register(input: ProducerRegistration, now: Date): RegisterResult {
    if (!validRegistration(input)) return { ok: false, reason: 'invalid_input' };
    const secret = randomBytes(32).toString('base64url');
    const ttl = Math.min(input.enrollmentTtlMs ?? DEFAULT_ENROLLMENT_TTL_MS, MAX_ENROLLMENT_TTL_MS);
    try {
      this.db
        .prepare(
          `INSERT INTO producers (
             producer_id, producer_domain_id, allowed_kinds, allowed_condition_classes,
             allowed_subjects, status, enrollment_secret_hash, enrollment_secret_expires_at,
             enrollment_mismatches, created_at)
           VALUES (?, ?, ?, ?, ?, 'enabled', ?, ?, 0, ?)`,
        )
        .run(
          input.producerId,
          input.producerDomainId,
          JSON.stringify(input.allowedKinds),
          JSON.stringify(input.allowedConditionClasses),
          JSON.stringify(input.allowedSubjects),
          digest(secret),
          new Date(now.getTime() + ttl).toISOString(),
          now.toISOString(),
        );
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'producer_exists' };
      throw err;
    }
    return {
      ok: true,
      enrollmentSecret: secret,
      enrollmentSecretExpiresAt: new Date(now.getTime() + ttl).toISOString(),
    };
  }

  exchangeEnrollmentSecret(producerId: string, secret: string, now: Date): ExchangeResult {
    const row = this.findRow(producerId);
    if (!row || row.status !== 'enabled' || !row.enrollment_secret_hash) {
      return { ok: false, reason: 'no_active_enrollment' };
    }
    if (!row.enrollment_secret_expires_at || Date.parse(row.enrollment_secret_expires_at) <= now.getTime()) {
      this.clearEnrollmentSecret(producerId);
      return { ok: false, reason: 'enrollment_expired' };
    }
    if (digest(secret) !== row.enrollment_secret_hash) {
      const mismatches = row.enrollment_mismatches + 1;
      if (mismatches >= MAX_ENROLLMENT_MISMATCHES) {
        this.clearEnrollmentSecret(producerId);
        return { ok: false, reason: 'enrollment_burned' };
      }
      this.db
        .prepare(`UPDATE producers SET enrollment_mismatches = ? WHERE producer_id = ?`)
        .run(mismatches, producerId);
      return { ok: false, reason: 'secret_mismatch' };
    }
    const credential = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.credentialTtlMs).toISOString();
    this.db
      .prepare(
        `UPDATE producers
            SET credential_hash = ?, credential_expires_at = ?,
                enrollment_secret_hash = NULL, enrollment_secret_expires_at = NULL,
                enrollment_mismatches = 0
          WHERE producer_id = ?`,
      )
      .run(digest(credential), expiresAt, producerId);
    return { ok: true, credential, credentialExpiresAt: expiresAt };
  }

  rotateCredential(producerId: string, currentCredential: string, now: Date): RotateResult {
    const row = this.findRow(producerId);
    if (!row || row.status !== 'enabled' || !row.credential_hash) return { ok: false };
    if (digest(currentCredential) !== row.credential_hash) return { ok: false };
    if (row.credential_expires_at && Date.parse(row.credential_expires_at) <= now.getTime()) {
      return { ok: false };
    }
    const credential = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.credentialTtlMs).toISOString();
    // The retired credential keeps working for the overlap window, but never
    // beyond its own original expiry — rotation must not extend a lifetime.
    const overlapEndMs = Math.min(
      row.credential_expires_at ? Date.parse(row.credential_expires_at) : Number.POSITIVE_INFINITY,
      now.getTime() + this.rotationOverlapMs,
    );
    this.db
      .prepare(
        `UPDATE producers
            SET prev_credential_hash = credential_hash,
                prev_expires_at = ?,
                credential_hash = ?, credential_expires_at = ?
          WHERE producer_id = ?`,
      )
      .run(
        new Date(overlapEndMs).toISOString(),
        digest(credential),
        expiresAt,
        producerId,
      );
    return { ok: true, credential, credentialExpiresAt: expiresAt };
  }

  revoke(producerId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE producers
            SET status = 'revoked', credential_hash = NULL, credential_expires_at = NULL,
                prev_credential_hash = NULL, prev_expires_at = NULL,
                enrollment_secret_hash = NULL, enrollment_secret_expires_at = NULL
          WHERE producer_id = ?`,
      )
      .run(producerId);
    return Number(result.changes) > 0;
  }

  authenticate(bearer: string, now: Date): AuthenticatedProducer | null {
    if (bearer.length === 0) return null;
    const hash = digest(bearer);
    const row = this.db
      .prepare(
        `SELECT * FROM producers
          WHERE status = 'enabled' AND (credential_hash = ? OR prev_credential_hash = ?)`,
      )
      .get(hash, hash) as ProducerRow | undefined;
    if (!row) return null;

    const liveMatch =
      row.credential_hash === hash &&
      (!row.credential_expires_at || Date.parse(row.credential_expires_at) > now.getTime());
    const prevMatch =
      row.prev_credential_hash === hash &&
      row.prev_expires_at !== null &&
      Date.parse(row.prev_expires_at) > now.getTime();
    if (!liveMatch && !prevMatch) return null;

    return {
      producerId: row.producer_id,
      producerDomainId: row.producer_domain_id,
      allowedKinds: JSON.parse(row.allowed_kinds) as string[],
      allowedConditionClasses: JSON.parse(row.allowed_condition_classes) as string[],
      allowedSubjects: JSON.parse(row.allowed_subjects) as string[],
    };
  }

  authorize(
    producer: AuthenticatedProducer,
    signal: { kind: string; conditionClass?: string; subject: string },
  ): ScopeDenial | null {
    if (!producer.allowedKinds.includes(signal.kind)) return 'kind_not_allowed';
    const isConditionKind = signal.kind === 'condition_observed' || signal.kind === 'condition_recovered';
    if (isConditionKind) {
      if (!signal.conditionClass || !producer.allowedConditionClasses.includes(signal.conditionClass)) {
        return 'condition_class_not_allowed';
      }
    }
    if (!producer.allowedSubjects.includes(signal.subject)) return 'subject_not_allowed';
    return null;
  }

  private findRow(producerId: string): ProducerRow | undefined {
    return this.db.prepare(`SELECT * FROM producers WHERE producer_id = ?`).get(producerId) as
      | ProducerRow
      | undefined;
  }

  private clearEnrollmentSecret(producerId: string): void {
    this.db
      .prepare(
        `UPDATE producers
            SET enrollment_secret_hash = NULL, enrollment_secret_expires_at = NULL,
                enrollment_mismatches = 0
          WHERE producer_id = ?`,
      )
      .run(producerId);
  }
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf-8').digest('hex')}`;
}

function validRegistration(input: ProducerRegistration): boolean {
  const boundedId = (v: string): boolean => typeof v === 'string' && v.length >= 1 && v.length <= MAX_ID_LENGTH;
  if (!boundedId(input.producerId) || !boundedId(input.producerDomainId)) return false;
  if (
    input.enrollmentTtlMs !== undefined &&
    (!Number.isInteger(input.enrollmentTtlMs) || input.enrollmentTtlMs <= 0)
  ) {
    return false;
  }
  if (!Array.isArray(input.allowedKinds) || input.allowedKinds.length === 0) return false;
  if (!input.allowedKinds.every((k) => (SIGNAL_KINDS as readonly string[]).includes(k))) return false;
  if (!Array.isArray(input.allowedConditionClasses) || !input.allowedConditionClasses.every(boundedId)) {
    return false;
  }
  if (
    !Array.isArray(input.allowedSubjects) ||
    input.allowedSubjects.length === 0 ||
    !input.allowedSubjects.every(boundedId)
  ) {
    return false;
  }
  return true;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}
