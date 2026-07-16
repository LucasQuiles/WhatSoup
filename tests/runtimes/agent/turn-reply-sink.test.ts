import { describe, expect, it, vi } from 'vitest';

import { createActiveTurnReplySink } from '../../../src/runtimes/agent/turn-reply-sink.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

const request = {
  chatJid: 'target@s.whatsapp.net',
  conversationKey: 'target',
  text: 'reply',
};

describe('createActiveTurnReplySink', () => {
  it('routes to the matching active queue', () => {
    const enqueueToolReplyText = vi.fn(() => ({ disposition: 'queued' as const }));
    const sink = createActiveTurnReplySink(() => ({
      targetChatJid: request.chatJid,
      targetConversationKey: request.conversationKey,
      enqueueToolReplyText,
    } as unknown as IOutboundQueue));

    expect(sink(request)).toEqual({ disposition: 'queued' });
    expect(enqueueToolReplyText).toHaveBeenCalledWith('reply');
  });

  it('fails closed instead of routing a reply into another conversation', () => {
    const enqueueToolReplyText = vi.fn(() => ({ disposition: 'queued' as const }));
    const sink = createActiveTurnReplySink(() => ({
      targetChatJid: 'other@s.whatsapp.net',
      targetConversationKey: 'other',
      enqueueToolReplyText,
    } as unknown as IOutboundQueue));

    expect(sink(request)).toEqual({ disposition: 'rejected', reason: 'turn_target_mismatch' });
    expect(enqueueToolReplyText).not.toHaveBeenCalled();
  });

  it('accepts LID and phone delivery aliases that share a canonical conversation', () => {
    const enqueueToolReplyText = vi.fn(() => ({ disposition: 'queued' as const }));
    const sink = createActiveTurnReplySink(() => ({
      targetChatJid: 'opaque@lid',
      targetConversationKey: request.conversationKey,
      enqueueToolReplyText,
    } as unknown as IOutboundQueue));

    expect(sink(request)).toEqual({ disposition: 'queued' });
    expect(enqueueToolReplyText).toHaveBeenCalledWith('reply');
  });

  it('declines routing when no admitted queue is available', () => {
    const sink = createActiveTurnReplySink(() => undefined);

    expect(sink(request)).toEqual({ disposition: 'inactive' });
  });
});
