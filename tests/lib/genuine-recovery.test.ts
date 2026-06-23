// tests/lib/genuine-recovery.test.ts
import { describe, it, expect } from 'vitest';
import { proveAuthRecovery, type RecoveryProofDeps } from '../../src/lib/genuine-recovery.ts';

function deps(confirmed: boolean): RecoveryProofDeps {
  return { confirmedOutboundWithinSeconds: () => confirmed };
}

describe('proveAuthRecovery', () => {
  it('reports recovered when a confirmed outbound exists within the window', () => {
    const proof = proveAuthRecovery(deps(true), 900);
    expect(proof.recovered).toBe(true);
    expect(proof.evidence).toContain('confirmed_outbound_within_900s');
  });

  it('reports NOT recovered when no confirmed outbound exists within the window', () => {
    const proof = proveAuthRecovery(deps(false), 900);
    expect(proof.recovered).toBe(false);
    expect(proof.evidence).toContain('no_confirmed_outbound_within_900s');
  });
});
