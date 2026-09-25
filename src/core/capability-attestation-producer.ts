/**
 * D5 attestation PRODUCER (capability-obligation replay, round-15 finding 1).
 *
 * `capability-attestation.ts` owns the durable record + the admission decision;
 * nothing in the shipped feature CALLED the record path, so no attestation ever
 * existed and every real obligation parked (the supervisor requires an admissible
 * attestation to claim). This module is the missing producer: it turns an
 * observed live binding plus a bounded, NON-SENDING canary OUTCOME into a durable
 * attestation — and refuses, fail-closed, to record anything on a canary that did
 * not pass.
 *
 * The canary is INJECTED here, deliberately: this module never spawns a resolver
 * or calls a provider. Executing the declared resolver as a probe is a real
 * execution and belongs behind the operator command's explicit opt-in
 * (`scripts/capability-obligation-attest.ts`), never in this recording core. That
 * keeps the trust boundary a single reviewed function: a passing canary in →
 * exactly one recorded attestation out; a failing/absent canary → nothing
 * recorded, so admission stays closed.
 */
import {
  recordCapabilityAttestation,
  type CapabilityAttestationBinding,
  type CapabilityAttestationEvidence,
} from './capability-attestation.ts';
import type { Database } from './database.ts';

/**
 * The result of the bounded, non-sending capability canary. `nonce` is the unique
 * probe-run identifier that lands on the attestation row (the D5 freshness/
 * identity marker); it is the caller's job to make it unique per run.
 */
export interface CapabilityCanaryOutcome {
  result: 'pass' | 'fail';
  nonce: string;
  /** Optional structured probe detail for the audit trail (never model-controlled text). */
  detail?: Record<string, unknown>;
}

export interface ProduceAttestationInput {
  /** The observed live binding: host/release/provider/harness + observed skill/resolver/dep identity. */
  binding: CapabilityAttestationBinding;
  /** The bounded non-sending canary's outcome (this module NEVER runs the canary itself). */
  canary: CapabilityCanaryOutcome;
  /** How long the recorded attestation stays admissible, in seconds (must be > 0). */
  validForSeconds: number;
  /** Injected clock — the moment of attestation (tests pass a fixed value). */
  attestedAt: Date;
  /**
   * Migration-63 (#3221 Debt 2): the probe evidence recorded IN the row —
   * stream refs, exit, canary-input ref, media-root readability. REQUIRED so
   * every producer caller writes it consciously; derive it from a live canary
   * outcome via `attestationEvidenceFromCanary`.
   */
  evidence: CapabilityAttestationEvidence;
}

/**
 * Derive the row evidence from a canary outcome's structured `detail`
 * (`runResolverCanary` records stdoutSha256/stderrSha256/exitCode/
 * probeSourceDigest there) plus the front-door's media-root observation.
 * Absent/underivable detail fields become NULL — never a fabricated ref.
 */
export function attestationEvidenceFromCanary(
  canary: CapabilityCanaryOutcome,
  mediaRootReadable: boolean | null,
): CapabilityAttestationEvidence {
  const detail = canary.detail ?? {};
  const sha = (value: unknown): string | null =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
  const exit = detail['exitCode'];
  return {
    probeStdoutRef: sha(detail['stdoutSha256']),
    probeStderrRef: sha(detail['stderrSha256']),
    probeExit: typeof exit === 'number' && Number.isInteger(exit) ? exit : null,
    canaryInputRef: sha(detail['probeSourceDigest']),
    mediaRootReadable,
  };
}

export type ProduceAttestationResult =
  | { recorded: true; attestationId: number }
  | { recorded: false; reason: 'canary_failed' | 'invalid_validity_window' };

/**
 * Record an attestation for the observed binding IFF the canary passed. Fail
 * closed: a failed canary, or a non-positive validity window, records NOTHING —
 * a probe that did not pass must never admit a replay.
 */
export function produceCapabilityAttestation(
  db: Database,
  input: ProduceAttestationInput,
): ProduceAttestationResult {
  if (input.canary.result !== 'pass') {
    return { recorded: false, reason: 'canary_failed' };
  }
  if (!Number.isFinite(input.validForSeconds) || input.validForSeconds <= 0) {
    return { recorded: false, reason: 'invalid_validity_window' };
  }
  const expiresAt = new Date(input.attestedAt.getTime() + input.validForSeconds * 1000);
  const attestationId = recordCapabilityAttestation(db, {
    ...input.binding,
    canaryResult: 'pass',
    nonce: input.canary.nonce,
    attestedAt: input.attestedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    evidence: input.evidence,
  });
  return { recorded: true, attestationId };
}
