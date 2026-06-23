// src/lib/genuine-recovery.ts

export interface RecoveryProofDeps {
  /**
   * True iff at least one outbound op was confirmed delivered (echoed_at set)
   * within the last `seconds`. A delivered agent message implies a successful
   * authenticated model completion, so this is proof auth currently works.
   */
  confirmedOutboundWithinSeconds(seconds: number): boolean;
}

export interface RecoveryProof {
  recovered: boolean;
  evidence: string;
}

/**
 * Evaluate the genuine-recovery proof for the auth_terminal fault class.
 * Portable proof: a confirmed-delivered outbound within `windowSeconds`.
 */
export function proveAuthRecovery(deps: RecoveryProofDeps, windowSeconds: number): RecoveryProof {
  if (deps.confirmedOutboundWithinSeconds(windowSeconds)) {
    return { recovered: true, evidence: `confirmed_outbound_within_${windowSeconds}s` };
  }
  return { recovered: false, evidence: `no_confirmed_outbound_within_${windowSeconds}s` };
}
