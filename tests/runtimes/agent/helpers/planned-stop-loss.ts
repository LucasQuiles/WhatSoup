import { PlannedStopTurnLossError } from '../../../../src/runtimes/agent/planned-stop-drain.ts';

/**
 * #3703: a shutdown that finalizes a journaled turn `failed_terminal` rejects
 * with PlannedStopTurnLossError. Cleanup paths that stop a runtime with such a
 * turn still held accept exactly that rejection and rethrow anything else.
 */
export function acceptPlannedStopTurnLoss(error: unknown): void {
  if (!(error instanceof PlannedStopTurnLossError)) throw error;
}
