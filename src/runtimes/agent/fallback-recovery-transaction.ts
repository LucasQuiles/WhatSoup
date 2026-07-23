import { alertEvidenceValue } from './tool-update.ts';
import type { PrimaryModelUsabilityResult } from './providers/primary-model-usability.ts';

/**
 * FallbackRecoveryTransaction (DUR-02).
 *
 * A primary-recovery probe's REAL generation result is the single source of
 * truth for a fallback→primary revert. Prior behavior collapsed that result
 * to a bare boolean (`probePrimaryProviderRecovered(): Promise<boolean>`)
 * before `deactivateProviderFallback()` acted on it, discarding the evidence
 * and leaving `fallback_recovery_stalled` cleared nowhere in the codebase —
 * once a stall alert fired, it stayed open forever even after the instance
 * recovered (the live CATEGORY-C defect: `probeAttempts: 403+`,
 * `fallbackReverts: 0`).
 *
 * This module does not re-probe. It evaluates the SAME probe result already
 * produced by the existing probe (unchanged, not rebuilt here) and decides
 * whether that result is a trustworthy canary for the instance-default
 * scope's revert. Pure: no I/O, no alert emission, no state mutation —
 * runtime.ts applies the decision and owns every side effect.
 *
 * "Canary" = the probe result, validated on three axes, never trusted as a
 * bare boolean ("never on the probe alone"):
 *   - status is actually `usable` (not just truthy from a stub/edge case);
 *   - it targets the ACTUAL primary (provider/model match) — a misdirected
 *     or stale-target result can never pass as evidence for THIS revert;
 *   - it is FRESH (checkedAt within `maxEvidenceAgeMs` of evaluation time) —
 *     a queued/delayed evaluation must not manufacture freshness it lacks.
 * All three must hold, or the transaction does not commit and both
 * incidents (`provider_fallback_activated`, `fallback_recovery_stalled`)
 * stay open — matching "a failed canary keeps both open."
 *
 * The transaction is instance-scoped only: it never reads or writes
 * chat_model_preference, so a chat holding its own strict pin (Kimi/GLM/
 * DeepSeek) is structurally unaffected by an instance-default revert — that
 * chat's route resolves independently via resolveRoute's preference
 * precedence once the fallback window closes.
 */

export interface FallbackRecoveryEvidence extends PrimaryModelUsabilityResult {
  /** Epoch ms the probe result was captured — the probe's own observation
   *  time, never the wall clock at evaluation time. */
  checkedAt: number;
}

export interface FallbackRecoveryContext {
  instanceName: string;
  primaryProvider: string;
  primaryModel: string | null;
  fallbackProvider: string;
  fallbackModel: string | null;
  /** fallbackProbeAttempts BEFORE this transition would reset it — carried
   *  into the receipt so the reset is provably not lossy. */
  probeAttemptsAtTransition: number;
  now: number;
  /** A stale cached evidence sample cannot commit a transition even if its
   *  status was usable when captured. */
  maxEvidenceAgeMs: number;
}

export type FallbackRecoveryRejectReason =
  | 'evidence-not-usable'
  | 'evidence-provider-mismatch'
  | 'evidence-model-mismatch'
  | 'evidence-stale';

export interface FallbackRecoveryReceipt {
  instanceName: string;
  transitionAt: number;
  reasonCode: 'primary-probe-ok';
  from: { provider: string; model: string | null };
  to: { provider: string; model: string | null };
  evidence: { provider: string; model: string | null; status: PrimaryModelUsabilityResult['status']; checkedAt: number };
  canary: 'passed';
  probeAttemptsAtTransition: number;
}

export type FallbackRecoveryDecision =
  | { commit: true; receipt: FallbackRecoveryReceipt }
  | { commit: false; rejectReason: FallbackRecoveryRejectReason };

export function evaluateFallbackRecoveryTransaction(
  evidence: FallbackRecoveryEvidence,
  ctx: FallbackRecoveryContext,
): FallbackRecoveryDecision {
  if (evidence.status !== 'usable') {
    return { commit: false, rejectReason: 'evidence-not-usable' };
  }
  if (evidence.provider !== ctx.primaryProvider) {
    return { commit: false, rejectReason: 'evidence-provider-mismatch' };
  }
  // A configured primary model must match the observed model; a null
  // primary model (provider-default routing) accepts any observed model.
  if (ctx.primaryModel !== null && evidence.model !== null && evidence.model !== ctx.primaryModel) {
    return { commit: false, rejectReason: 'evidence-model-mismatch' };
  }
  const age = ctx.now - evidence.checkedAt;
  if (!Number.isFinite(age) || age < 0 || age > ctx.maxEvidenceAgeMs) {
    return { commit: false, rejectReason: 'evidence-stale' };
  }
  return {
    commit: true,
    receipt: {
      instanceName: ctx.instanceName,
      transitionAt: ctx.now,
      reasonCode: 'primary-probe-ok',
      from: { provider: ctx.fallbackProvider, model: ctx.fallbackModel },
      to: { provider: ctx.primaryProvider, model: ctx.primaryModel },
      evidence: { provider: evidence.provider, model: evidence.model, status: evidence.status, checkedAt: evidence.checkedAt },
      canary: 'passed',
      probeAttemptsAtTransition: ctx.probeAttemptsAtTransition,
    },
  };
}

/**
 * Free-text evidence string for the emitted alert, matching the repo's
 * `key=value` evidence convention. Field allowlist only — never the raw
 * probe result — so a provider error string can never ride along inside a
 * "success" receipt (there isn't one to leak on the success path, but the
 * allowlist is deliberate and future-proof against the receipt growing
 * more probe-derived fields later).
 */
export function formatFallbackRecoveryReceiptEvidence(receipt: FallbackRecoveryReceipt): string {
  return [
    `from_provider=${alertEvidenceValue(receipt.from.provider)}`,
    `from_model=${alertEvidenceValue(receipt.from.model)}`,
    `to_provider=${alertEvidenceValue(receipt.to.provider)}`,
    `to_model=${alertEvidenceValue(receipt.to.model)}`,
    `evidence_status=${alertEvidenceValue(receipt.evidence.status)}`,
    `evidence_provider=${alertEvidenceValue(receipt.evidence.provider)}`,
    `evidence_model=${alertEvidenceValue(receipt.evidence.model)}`,
    `checked_at=${new Date(receipt.evidence.checkedAt).toISOString()}`,
    `canary=${receipt.canary}`,
    `probe_attempts=${receipt.probeAttemptsAtTransition}`,
  ].join(' ');
}
