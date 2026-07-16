import type { TurnReplyRequest, TurnReplySink } from '../../core/turn-reply.ts';
import type { IOutboundQueue } from './outbound-queue.ts';

export function createActiveTurnReplySink(
  resolveQueue: (request: TurnReplyRequest) => IOutboundQueue | null | undefined,
): TurnReplySink {
  return (request) => {
    const queue = resolveQueue(request);
    if (!queue?.enqueueToolReplyText) return { disposition: 'inactive' };
    if (queue.targetConversationKey !== request.conversationKey) {
      return { disposition: 'rejected', reason: 'turn_target_mismatch' };
    }
    return queue.enqueueToolReplyText(request.text);
  };
}
