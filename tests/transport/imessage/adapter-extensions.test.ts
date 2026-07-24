// tests/transport/imessage/adapter-extensions.test.ts
import { describe, it, expect } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig, peerConversationRef } from './mock-port.ts';
import { makeChannelId, type ChannelId, type MessageRef } from '../../../src/core/transport-refs.ts';

function makeAdapter(port: MockImessagePort = new MockImessagePort()) {
  const adapter = new ImessageAdapter(makeImessageConfig(), port);
  return { adapter, port, channelId: makeChannelId('imessage', 'test') };
}

function peerMessageRef(channelId: ChannelId, peerId: string, guid: string): MessageRef {
  return { channel: channelId, conversation: peerId, id: guid };
}

describe('ImessageAdapter — SupportsReactions', () => {
  it('react() calls port.sendReaction with targetGuid + conversation + emoji', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, 'user@example.com', 'guid-123');

    await adapter.react(target, '❤️');

    expect(port.reactions).toHaveLength(1);
    expect(port.reactions[0]).toMatchObject({
      targetGuid: 'guid-123',
      conversation: 'user@example.com',
      emoji: '❤️',
      remove: false,
    });
  });

  it('unreact() calls port.sendReaction with empty emoji and remove:true', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, 'user@example.com', 'guid-123');

    await adapter.unreact(target, '❤️');

    expect(port.reactions[0]).toMatchObject({ emoji: '', remove: true });
  });

  it('react() rejects a cross-channel target', async () => {
    const { adapter } = makeAdapter();
    const target: MessageRef = {
      channel: 'imessage:nope' as ChannelId,
      conversation: 'u@example.com',
      id: 'guid-1',
    };
    await expect(adapter.react(target, '❤️')).rejects.toThrow(/does not match adapter channel/);
  });
});

describe('ImessageAdapter — SupportsTyping', () => {
  it('setTyping(true) calls port.sendTypingIndicator with composing:true', async () => {
    const { adapter, port, channelId } = makeAdapter();
    await adapter.setTyping(peerConversationRef(channelId, 'user@example.com'), true);
    expect(port.typings[0]).toMatchObject({ conversation: 'user@example.com', composing: true });
  });

  it('setTyping(false) calls port.sendTypingIndicator with composing:false', async () => {
    const { adapter, port, channelId } = makeAdapter();
    await adapter.setTyping(peerConversationRef(channelId, 'user@example.com'), false);
    expect(port.typings[0]).toMatchObject({ composing: false });
  });

  it('setTyping rejects an invalid recipient', async () => {
    const { adapter, channelId } = makeAdapter();
    await expect(adapter.setTyping(peerConversationRef(channelId, 'bogus'), true))
      .rejects.toThrow(/valid iMessage recipient/);
  });
});

describe('ImessageAdapter — SupportsReadReceipts', () => {
  it('markRead() calls port.sendReadReceipts with the conversation + guid', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, 'user@example.com', 'guid-42');

    await adapter.markRead(target);

    expect(port.receipts).toHaveLength(1);
    expect(port.receipts[0]).toMatchObject({
      conversation: 'user@example.com',
      guids: ['guid-42'],
    });
  });

  it('markRead() rejects a cross-channel target', async () => {
    const { adapter } = makeAdapter();
    const target: MessageRef = {
      channel: 'imessage:nope' as ChannelId,
      conversation: 'u@example.com',
      id: 'guid-1',
    };
    await expect(adapter.markRead(target)).rejects.toThrow(/does not match adapter channel/);
  });
});
