import { describe, expect, it } from 'vitest';
import { countOperatorCancelledTurns } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import type { FinalizeRuntimeTurnResult } from '../../../src/runtimes/agent/turn-finalizer.ts';
import type { AttemptOutcome } from '../../../src/runtimes/agent/turn-terminal.ts';

function terminal(attemptOutcome: AttemptOutcome): PromiseSettledResult<FinalizeRuntimeTurnResult> {
  return {
    status: 'fulfilled',
    value: { kind: 'terminal', terminal: { attemptOutcome } } as unknown as FinalizeRuntimeTurnResult,
  };
}

describe('#3716: countOperatorCancelledTurns', () => {
  it('counts only terminal operator_cancelled results, split into queued and active', () => {
    const settled: PromiseSettledResult<FinalizeRuntimeTurnResult>[] = [
      terminal({ kind: 'failed', class: 'operator_cancelled' }),
      terminal({ kind: 'failed', class: 'operator_cancelled' }),
      {
        status: 'fulfilled',
        value: { kind: 'reclaimed_by_sweep', mayAdvance: true } as unknown as FinalizeRuntimeTurnResult,
      },
      terminal({ kind: 'admission_rejected' }),
      { status: 'rejected', reason: new Error('finalization failed') },
      terminal({ kind: 'failed', class: 'crash' }),
    ];

    expect(countOperatorCancelledTurns(settled, new Set([0, 2, 3, 4]))).toEqual({ active: 1, queued: 1 });
  });

  it('reports zero for a teardown with nothing cancelled', () => {
    expect(countOperatorCancelledTurns([], new Set())).toEqual({ active: 0, queued: 0 });
  });
});
