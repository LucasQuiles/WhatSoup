import { alertEvidenceValue } from './tool-update.ts';
import type { PrimaryModelUsabilityResult } from './providers/primary-model-usability.ts';

// DUR-02 canary freshness bound, generous over the probe's 15s CLI deadline (primary-model-usability-adapters.ts) since the result is consumed synchronously right after.
const MAX_EVIDENCE_AGE_MS = 60_000;

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
 * whether that result is trustworthy validation for the instance-default
 * scope's revert. Pure: no I/O, no alert emission, no state mutation —
 * runtime.ts applies the decision and owns every side effect.
 *
 * TERMINOLOGY (post-quality-pass A2 honest re-scope — see
 * artifacts/execution/PRESTAGE-DUR02-fallback-recovery-transaction.md for the
 * recorded rationale): the probe is validated on three axes, never trusted as
 * a bare boolean ("never on the probe alone") — status is actually `usable`
 * (not just truthy from a stub/edge case), it targets the ACTUAL primary
 * (provider/model match — a misdirected or stale-target result can never
 * pass as evidence for THIS revert), and it is FRESH (checkedAt within
 * `maxEvidenceAgeMs` of evaluation time — a queued/delayed evaluation must
 * not manufacture freshness it lacks). This is `probeValidated`, a genuine
 * PRE-REVERT check — it is NOT a post-revert canary (a real turn actually
 * succeeding through the reverted route), which this module cannot produce
 * because it never runs after the flip. The receipt says so honestly
 * (`postRevertCanary: 'not_run'`); runtime.ts tracks the real post-revert
 * confirmation separately via `recordTurnCapabilitySuccess` and defers the
 * `provider_fallback_activated` clear to that event, not to this receipt.
 * `fallback_recovery_stalled` clears on the validated probe alone — that
 * incident is honestly about probe cadence, not about primary health, so a
 * validated probe genuinely resolves it. All three axes must hold, or the
 * transaction does not commit and both incidents stay open.
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
  /** The pre-revert probe passed all three validation axes — a real check,
   *  not a rubber stamp. NOT a claim that a post-revert turn ran. */
  probeValidated: true;
  /** Always 'not_run' at receipt-creation time (immutable — this receipt is
   *  never mutated after the fact). The real post-revert confirmation is
   *  tracked separately by runtime.ts and reported in its OWN clear event. */
  postRevertCanary: 'not_run';
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
      probeValidated: true,
      postRevertCanary: 'not_run',
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
    `probe_validated=${receipt.probeValidated}`,
    `post_revert_canary=${receipt.postRevertCanary}`,
    `probe_attempts=${receipt.probeAttemptsAtTransition}`,
  ].join(' ');
}

export type FallbackRecoveryProbeContext = Omit<FallbackRecoveryContext, 'now' | 'maxEvidenceAgeMs'>;

/**
 * Runs `probe` once and evaluates the transaction against its result — the
 * shared core behind runtime.ts's revert-timer and standing-probe paths, so
 * neither duplicates evidence capture. `probe` receives an `onEvidence`
 * callback (never a shared field: concurrent callers on the same instance,
 * e.g. the diagnostic bundle, must not race the read) and resolves to the
 * collapsed boolean; a caller whose probe never invokes the callback (a
 * bare-boolean test stub) gets a synthesized evidence sample instead.
 */
export async function resolveFallbackRecoveryDecision(
  probe: (onEvidence: (evidence: FallbackRecoveryEvidence) => void) => Promise<boolean>,
  ctx: FallbackRecoveryProbeContext,
  onProbeError: (err: unknown) => void,
): Promise<FallbackRecoveryDecision> {
  let evidence: FallbackRecoveryEvidence | null = null;
  // Promise.resolve().then(...) — not a direct probe(...).catch(...) — so a
  // test stub that replaces the probe with a plain synchronous function
  // (returning a raw boolean, not a Promise) still normalizes safely instead
  // of throwing on a missing .catch.
  const recovered = await Promise.resolve()
    .then(() => probe((e) => { evidence = e; }))
    .catch((err) => {
      onProbeError(err);
      return false;
    });
  const resolvedEvidence: FallbackRecoveryEvidence = evidence ?? {
    status: recovered ? 'usable' : 'unknown',
    provider: ctx.primaryProvider,
    model: ctx.primaryModel,
    checkedAt: Date.now(),
  };
  return evaluateFallbackRecoveryTransaction(resolvedEvidence, { ...ctx, now: Date.now(), maxEvidenceAgeMs: MAX_EVIDENCE_AGE_MS });
}

export interface StallAlertPlan {
  emit: boolean;
  ceiling: boolean;
}

/**
 * DUR-02 bounded escalation: fire at T, 2T, 3T ... up to `ceilingMultiple * T`
 * (marking the ceiling hit distinctly), then stop — repeating an
 * indistinguishable alert forever past a known, indefinite stall is exactly
 * the noise this exists to prevent. The window keeps extending regardless.
 * `threshold`/`ceilingMultiple` are caller-supplied (not env globals here) so
 * this stays pure over its own policy inputs — see runtime.ts for the env-clamp.
 */
export function stallAlertPlan(attempts: number, threshold: number, ceilingMultiple: number): StallAlertPlan {
  const ceilingAttempts = threshold * ceilingMultiple;
  const isThresholdMultiple = attempts >= threshold && attempts % threshold === 0;
  return {
    emit: isThresholdMultiple && attempts <= ceilingAttempts,
    ceiling: attempts === ceilingAttempts,
  };
}
