/**
 * Gated cold-obligation activation (capability-obligation replay, round-15
 * finding 2). Draining a parked obligation dispatches a minted turn through the
 * supervisor, which needs an ACTIVE per-chat session. After a cold restart the
 * session is absent and — for groups — AE1 deliberately excludes it from the
 * autonomous startup resume (resuming a group would fire unsolicited messages
 * bypassing the sibling filter). So the incident obligations could not drain by
 * any route.
 *
 * This is the OWNER-AUTHORIZED alternative to autonomous resume: an explicit
 * operator action that activates ONE named, already-gated obligation's session
 * and runs a single supervisor tick. For a GROUP it refuses to activate unless a
 * current AS-08 approval is in force — the approval IS the authorization to
 * activate (and therefore to send), which is a different act from the autonomous
 * proactive resume AE1 forbids. This module does NOT touch
 * `resolvePerChatDispatchTarget` or the startup sweep; `activateSession` and
 * `runTick` are injected so the gate is unit-tested without the live runtime.
 */
import type { Database } from '../../core/database.ts';
import type { CapabilityObligationStore } from '../../core/capability-obligation-store.ts';
import type { ObligationTickReport } from './capability-obligation-supervisor.ts';

export interface DrainNowDeps {
  db: Database;
  store: CapabilityObligationStore;
  /** Activate (create + bring to active) the per-chat session for a delivery JID; true when active. */
  activateSession: (deliveryJid: string) => Promise<boolean>;
  /** Run exactly one supervisor tick (scan → admit → claim → dispatch → settle). */
  runTick: () => Promise<ObligationTickReport>;
}

export type DrainNowResult =
  | {
      activated: false;
      reason: 'not_found' | 'not_drainable' | 'group_approval_required' | 'session_activation_failed';
    }
  | { activated: true; tick: ObligationTickReport };

/**
 * Activate + drain one named obligation, fail-closed. The obligation must be in
 * `waiting_capability` (already past attestation/approval gating); a GROUP must
 * additionally carry a consumed approval that is STILL unrevoked and unexpired,
 * or activation is refused before any session is created (never activate a group
 * that the claim would reject anyway — and never send to a group whose approval
 * lapsed).
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

  const active = await deps.activateSession(o.deliveryJid);
  if (!active) return { activated: false, reason: 'session_activation_failed' };
  const tick = await deps.runTick();
  return { activated: true, tick };
}
