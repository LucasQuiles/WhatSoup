/**
 * Gated cold-obligation activation (capability-obligation replay, round-15
 * finding 2; outcome truthfulness reworked for post-merge audit F2). Draining a
 * parked obligation dispatches a minted turn through the supervisor, which
 * needs an ACTIVE per-chat session. After a cold restart the session is absent
 * and — for groups — AE1 deliberately excludes it from the autonomous startup
 * resume (resuming a group would fire unsolicited messages bypassing the
 * sibling filter). So the incident obligations could not drain by any route.
 *
 * This is the OWNER-AUTHORIZED alternative to autonomous resume: an explicit
 * operator action that activates ONE named, already-gated obligation's session
 * and drains that obligation through the supervisor's TARGETED scan. For a
 * GROUP it refuses to activate unless a current AS-08 approval is in force —
 * the approval IS the authorization to activate (and therefore to send), which
 * is a different act from the autonomous proactive resume AE1 forbids. This
 * module does NOT touch `resolvePerChatDispatchTarget` or the startup sweep;
 * `activateSession` and `drainNamed` are injected so the gate is unit-tested
 * without the live runtime.
 *
 * AUDIT F2 (truthful named-drain outcomes): the previous implementation
 * reported success after session activation + ANY global supervisor tick — but
 * the global tick is oldest-first with a scan cap, so the NAMED obligation may
 * never even be scanned. Now (a) the drain processes the named obligation via
 * the supervisor's targeted entry point (same per-row claim/dispatch pipeline
 * as the global scan), and (b) the reported outcome is DERIVED FROM THE NAMED
 * ROW'S POST-STATE (`operatorInspectObligation` + receipts + the targeted
 * report) — never from the mere fact that something ran.
 */
import type { Database } from '../../core/database.ts';
import type { CapabilityObligationStore } from '../../core/capability-obligation-store.ts';
import type { NamedObligationTickResult } from './capability-obligation-supervisor.ts';

export interface DrainNowDeps {
  db: Database;
  store: CapabilityObligationStore;
  /** Activate (create + bring to active) the per-chat session for a delivery JID; true when active. */
  activateSession: (deliveryJid: string) => Promise<boolean>;
  /**
   * Process EXACTLY the named obligation through the supervisor's targeted
   * per-row claim/dispatch pipeline (audit F2) — the same code path the global
   * scan runs, scoped to one row. Replaces the old global `runTick` port, which
   * could not guarantee the named obligation was ever scanned.
   */
  drainNamed: (obligationId: number) => Promise<NamedObligationTickResult>;
  /**
   * Round-22 pre-activation gate (gap-doc remaining item 2): could ANY live
   * attestation plausibly admit this obligation (provider/harness ignored —
   * unknowable pre-spawn)? False (or a throw — fail-closed) refuses BEFORE the
   * session is created, so a drain that would necessarily park never activates
   * anything. The claim's exact-binding admission (r15 F4) stays authoritative.
   */
  hasAdmissibleAttestationCandidate: (obligationId: number) => boolean;
}

export type DrainNowGateRefusalReason =
  | 'not_found'
  | 'not_drainable'
  | 'group_approval_required'
  | 'no_admissible_attestation'
  | 'session_activation_failed';

/** Why an activated drain left the named obligation parked (post-state derived). */
export type NamedDrainParkReason =
  /** Post-state is neither waiting nor a state this vocabulary names more precisely (e.g. cancelled, exhausted). */
  | 'not_waiting'
  /** Still waiting AND still due — the targeted pass did not progress it (e.g. a lost claim race). */
  | 'still_due'
  | 'attempts_exhausted'
  | 'backoff_pending'
  /** blocked_media via the finite retention horizon (A-08). */
  | 'media_expired'
  /** blocked_media via integrity failure (missing/mismatched retained bytes). */
  | 'media_blocked'
  /** No admissible attestation at claim time; zero attempts consumed. */
  | 'attestation_skip'
  /** Quarantined blocked_ambiguous — the dispatch crossed the provider boundary then failed. */
  | 'dispatch_ambiguous'
  /** state = completed but the receipt chain could not be verified (fail-closed; should be unreachable). */
  | 'settlement_evidence_incomplete';

/**
 * The truthful outcome for the NAMED obligation, derived from post-state
 * queries — never from "a tick ran". `named_settled` additionally requires the
 * verified receipt chain (completion proof + an ok receipt bound to the
 * settling claim epoch/attempt).
 */
export type NamedDrainOutcome =
  | { kind: 'named_settled'; state: 'completed'; completionProofId: string; executionReceiptId: number }
  | { kind: 'named_dispatched'; state: 'claimed'; attemptCount: number; claimEpoch: number }
  /** Claimed, but not by this drain's dispatch (a rival scanner holds the lease). */
  | { kind: 'named_claimed'; state: 'claimed'; attemptCount: number }
  | { kind: 'named_parked'; state: string; reason: NamedDrainParkReason; detail: string | null }
  | { kind: 'named_not_found' };

export type DrainNowResult =
  | { activated: false; reason: DrainNowGateRefusalReason }
  | { activated: true; named: NamedDrainOutcome };

/**
 * Derive the truthful outcome for one named obligation from its POST-STATE:
 * the durable row + receipt chain (`operatorInspectObligation`), the targeted
 * report (only to distinguish "this drain dispatched it" from "a rival holds
 * it", and to carry typed skip reasons), and the store's own due predicate for
 * backoff/exhaustion classification. Exported so the derivation is directly
 * unit-testable against store states the public path cannot reach in one call
 * (e.g. a completed row).
 */
export function deriveNamedDrainOutcome(
  store: CapabilityObligationStore,
  obligationId: number,
  tick: NamedObligationTickResult,
): NamedDrainOutcome {
  const view = store.operatorInspectObligation(obligationId);
  if (view === null) return { kind: 'named_not_found' };
  const state = view.obligation.state as string;
  const attemptCount = view.obligation.attempt_count as number;
  const claimEpoch = (view.obligation.claim_epoch as number | null) ?? 0;
  const lastEventReason = (): string | null => {
    const last = view.events.at(-1);
    return (last?.reason_code as string | undefined) ?? null;
  };

  if (state === 'completed') {
    const completionProofId = (view.obligation.completion_proof_id as string | null) ?? null;
    const receipt = view.receipts.find(
      (r) => r.claim_epoch === claimEpoch && r.attempt_number === attemptCount && r.result_status === 'ok',
    );
    if (completionProofId !== null && receipt !== undefined) {
      return {
        kind: 'named_settled',
        state: 'completed',
        completionProofId,
        executionReceiptId: receipt.id as number,
      };
    }
    // Fail-closed: never report settled without the verified chain.
    return { kind: 'named_parked', state, reason: 'settlement_evidence_incomplete', detail: null };
  }

  if (state === 'claimed') {
    if (tick.report.dispatched.includes(obligationId)) {
      return { kind: 'named_dispatched', state: 'claimed', attemptCount, claimEpoch };
    }
    return { kind: 'named_claimed', state: 'claimed', attemptCount };
  }

  const skip = tick.report.attestationSkips.find((s) => s.id === obligationId);
  if (skip !== undefined) {
    return { kind: 'named_parked', state, reason: 'attestation_skip', detail: skip.reason };
  }
  if (state === 'blocked_media') {
    const detail = lastEventReason();
    return {
      kind: 'named_parked',
      state,
      reason: detail === 'media_retention_expired' ? 'media_expired' : 'media_blocked',
      detail,
    };
  }
  if (state === 'blocked_ambiguous') {
    return { kind: 'named_parked', state, reason: 'dispatch_ambiguous', detail: lastEventReason() };
  }
  if (state === 'waiting_capability') {
    const due = store.dueObligationById(obligationId);
    if (due.due === null && due.notDueReason === 'backoff_pending') {
      return { kind: 'named_parked', state, reason: 'backoff_pending', detail: null };
    }
    if (due.due === null && due.notDueReason === 'attempts_exhausted') {
      return { kind: 'named_parked', state, reason: 'attempts_exhausted', detail: null };
    }
    return { kind: 'named_parked', state, reason: 'still_due', detail: null };
  }
  return { kind: 'named_parked', state, reason: 'not_waiting', detail: null };
}

/**
 * Activate + drain one named obligation, fail-closed. The obligation must be in
 * `waiting_capability` (already past attestation/approval gating); a GROUP must
 * additionally carry a consumed approval that is STILL unrevoked and unexpired,
 * or activation is refused before any session is created (never activate a group
 * that the claim would reject anyway — and never send to a group whose approval
 * lapsed). On activation the named obligation is processed via the supervisor's
 * TARGETED scan and the result is derived from its post-state (audit F2).
 */
export async function drainObligationNow(deps: DrainNowDeps, obligationId: number): Promise<DrainNowResult> {
  const o = deps.db.raw
    .prepare(
      `SELECT is_group AS isGroup, state, delivery_jid AS deliveryJid, drain_approval_id AS drainApprovalId
       FROM capability_obligations WHERE id = ?`,
    )
    .get(obligationId) as
    | { isGroup: number; state: string; deliveryJid: string; drainApprovalId: number | null }
    | undefined;
  if (o === undefined) return { activated: false, reason: 'not_found' };
  if (o.state !== 'waiting_capability') return { activated: false, reason: 'not_drainable' };

  if (o.isGroup === 1) {
    // AS-08 authorization to activate: a live (unrevoked, unexpired) consumed approval.
    const approval = o.drainApprovalId === null
      ? undefined
      : (deps.db.raw
          .prepare(
            `SELECT 1 AS ok FROM capability_drain_approvals
             WHERE id = ? AND obligation_id = ? AND scope = 'group'
               AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')`,
          )
          .get(o.drainApprovalId, obligationId) as { ok: number } | undefined);
    if (approval === undefined) return { activated: false, reason: 'group_approval_required' };
  }

  // Round-22 pre-activation gate: never create/activate a session for an
  // obligation nothing could admit. A throwing check refuses (fail-closed).
  let candidate = false;
  try {
    candidate = deps.hasAdmissibleAttestationCandidate(obligationId);
  } catch {
    candidate = false;
  }
  if (!candidate) return { activated: false, reason: 'no_admissible_attestation' };

  const active = await deps.activateSession(o.deliveryJid);
  if (!active) return { activated: false, reason: 'session_activation_failed' };
  const tick = await deps.drainNamed(obligationId);
  return { activated: true, named: deriveNamedDrainOutcome(deps.store, obligationId, tick) };
}
