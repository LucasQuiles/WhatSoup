import type { TurnFinalizationBookkeepingParams } from '../../core/durability.ts';
import type { TurnDeliveryEvidence } from './outbound-queue.ts';
import {
  finalizeRuntimeTurn,
  type FinalizeRuntimeTurnResult,
  type RuntimeAnswerEvidence,
  type RuntimeTurnFinalizerDurability,
} from './turn-finalizer.ts';
import type { AttemptOutcome } from './turn-terminal.ts';
import type { RuntimeTurnContext } from './runtime-turn-context.ts';

export interface RuntimeTurnEvidenceQueue {
  flushTurnEvidence(turnId: string): Promise<TurnDeliveryEvidence>;
}

export interface FinalizeQueuedRuntimeTurnParams {
  readonly instanceName: string;
  readonly durability: RuntimeTurnFinalizerDurability;
  readonly queue: RuntimeTurnEvidenceQueue;
  readonly context: RuntimeTurnContext;
  readonly attemptOutcome: AttemptOutcome;
  readonly bookkeeping?: TurnFinalizationBookkeepingParams;
}

export async function collectRuntimeTurnAnswerEvidence(
  queue: RuntimeTurnEvidenceQueue,
  turnId: string,
): Promise<RuntimeAnswerEvidence> {
  try {
    const evidence = await queue.flushTurnEvidence(turnId);
    return { kind: 'ready', opIds: evidence.answerOpIds };
  } catch {
    return { kind: 'failed' };
  }
}

export async function finalizeQueuedRuntimeTurn(
  params: FinalizeQueuedRuntimeTurnParams,
): Promise<FinalizeRuntimeTurnResult> {
  const answerEvidence = await collectRuntimeTurnAnswerEvidence(
    params.queue,
    params.context.identity.logicalTurnId,
  );

  return finalizeRuntimeTurn({
    instanceName: params.instanceName,
    durability: params.durability,
    identity: params.context.identity,
    attemptOutcome: params.attemptOutcome,
    answerEvidence,
    recoveryOwner: params.context.recoveryOwner,
    replay: params.context.replay,
    ...(params.bookkeeping === undefined ? {} : { bookkeeping: params.bookkeeping }),
  });
}
