import type { ReplyGuaranteeManager } from '../../core/reply-guarantee.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import type { QueuedTurn } from './turn-queue.ts';

export interface RuntimeTurnPreBoundaryCancellationPort {
  readonly replyGuarantee: ReplyGuaranteeManager | null;
  readonly perChatInboundSeqQueue: Map<string, number[]>;
  readonly perChatTurnSourceMessageId: Map<string, string>;
  readonly perChatTurnContentType: Map<string, string>;
  readonly perChatTurnText: Map<string, string>;
  readonly perChatTurnSuppressedReplySatisfaction: Set<string>;
  readonly perChatAssistantItemText: Map<string, Map<string, string>>;
  readonly perChatRouteMarkerHold: Map<string, string>;
  readonly pendingTurnText: Map<string, string>;
  readonly pendingTurnActorJid: Map<string, string | undefined>;
  getQueueForChat(chatJid: string, mapKey?: string): IOutboundQueue | null;
}

export function discardCancelledPreBoundaryPerChatTurn(
  host: RuntimeTurnPreBoundaryCancellationPort,
  mapKey: string,
  turn: QueuedTurn,
): void {
  if (host.perChatTurnSourceMessageId.get(mapKey) !== turn.sourceMessageId) return;

  const seqs = host.perChatInboundSeqQueue.get(mapKey);
  if (turn.inboundSeq !== undefined && seqs) {
    const index = seqs.lastIndexOf(turn.inboundSeq);
    if (index >= 0) seqs.splice(index, 1);
    if (seqs.length === 0) host.perChatInboundSeqQueue.delete(mapKey);
    host.getQueueForChat(turn.chatJid, mapKey)?.setInboundSeq(seqs[0]);
    host.replyGuarantee?.disarm(turn.inboundSeq);
  }
  host.perChatTurnSourceMessageId.delete(mapKey);
  host.perChatTurnContentType.delete(mapKey);
  host.perChatTurnText.delete(mapKey);
  host.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
  host.perChatAssistantItemText.delete(mapKey);
  host.perChatRouteMarkerHold.delete(mapKey);
  host.pendingTurnText.delete(mapKey);
  host.pendingTurnActorJid.delete(mapKey);
}
