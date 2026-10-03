// src/runtimes/agent/outbound-turn-evidence.ts
// The outbound queue's per-turn delivery evidence: its mutable form and its frozen copies.

import type { OutboundMessageRole, TurnDeliveryEvidence } from './outbound-queue.ts';

export interface MutableTurnDeliveryEvidence {
  readonly turnId: string;
  readonly epoch: number;
  readonly opIds: Record<OutboundMessageRole, number[]>;
  withheldAnswerCount: number;
}

export interface TurnEvidenceFlush {
  readonly evidence: MutableTurnDeliveryEvidence;
  readonly completion: Promise<TurnDeliveryEvidence>;
}

export function freezeTurnEvidence(evidence: MutableTurnDeliveryEvidence): TurnDeliveryEvidence {
  return Object.freeze({
    turnId: evidence.turnId,
    answerOpIds: Object.freeze([...evidence.opIds.answer]),
    lifecycleOpIds: Object.freeze([...evidence.opIds.lifecycle]),
    statusOpIds: Object.freeze([...evidence.opIds.status]),
    withheldAnswerCount: evidence.withheldAnswerCount,
  });
}

export function copyTurnEvidence(evidence: TurnDeliveryEvidence): TurnDeliveryEvidence {
  return Object.freeze({
    turnId: evidence.turnId,
    answerOpIds: Object.freeze([...evidence.answerOpIds]),
    lifecycleOpIds: Object.freeze([...evidence.lifecycleOpIds]),
    statusOpIds: Object.freeze([...evidence.statusOpIds]),
    withheldAnswerCount: evidence.withheldAnswerCount,
  });
}
