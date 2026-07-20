// tests/transport/signal/adapter-extensions.test.ts
// SupportsReactions / SupportsTyping / SupportsReadReceipts / SupportsDelete
// — extension mix-ins the SignalAdapter declares in v1.
import { describe, it, expect } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig, peerConversationRef } from './mock-port.ts';
import { makeChannelId, type ChannelId, type MessageRef } from '../../../src/core/transport-refs.ts';

function makeAdapter(port: MockSignalPort = new MockSignalPort()) {
  const adapter = new SignalAdapter(makeSignalConfig(), port);
  return { adapter, port, channelId: makeChannelId('signal', 'test') };
}

function peerMessageRef(channelId: ChannelId, peerId: string, msgTs: number): MessageRef {
  return { channel: channelId, conversation: peerId, id: String(msgTs) };
}

describe('SignalAdapter — SupportsReactions', () => {
  it('react() calls port.sendReaction with the emoji and remove:false', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 12345);

    await adapter.react(target, '👍');

    expect(port.reactions).toHaveLength(1);
    expect(port.reactions[0]).toMatchObject({
      targetTimestamp: 12345,
      targetAuthor: '+15559990000',
      emoji: '👍',
      remove: false,
    });
  });

  it('unreact() calls port.sendReaction with empty emoji and remove:true', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 12345);

    await adapter.unreact(target, '👍');

    expect(port.reactions).toHaveLength(1);
    expect(port.reactions[0]).toMatchObject({ emoji: '', remove: true });
  });

  it('react() rejects a cross-channel target', async () => {
    const { adapter } = makeAdapter();
    const target: MessageRef = {
      channel: 'signal:wrong' as ChannelId,
      conversation: '+15559990000',
      id: '12345',
    };

    await expect(adapter.react(target, '👍')).rejects.toThrow(/does not match adapter channel/);
  });

  it('react() rejects a non-numeric message id', async () => {
    const { adapter, channelId } = makeAdapter();
    const target: MessageRef = { channel: channelId, conversation: '+15559990000', id: 'not-a-timestamp' };

    await expect(adapter.react(target, '👍')).rejects.toThrow(/positive epoch-ms timestamp/);
  });
});

describe('SignalAdapter — SupportsTyping', () => {
  it('setTyping(true) calls port.sendTypingIndicator with composing:true', async () => {
    const { adapter, port, channelId } = makeAdapter();
    await adapter.setTyping(peerConversationRef(channelId, '+15559990000'), true);
    expect(port.typings[0]).toMatchObject({ target: '+15559990000', composing: true });
  });

  it('setTyping(false) calls port.sendTypingIndicator with composing:false', async () => {
    const { adapter, port, channelId } = makeAdapter();
    await adapter.setTyping(peerConversationRef(channelId, '+15559990000'), false);
    expect(port.typings[0]).toMatchObject({ composing: false });
  });

  it('setTyping rejects a non-E.164 / non-UUID target', async () => {
    const { adapter, channelId } = makeAdapter();
    await expect(adapter.setTyping(peerConversationRef(channelId, 'bogus'), true))
      .rejects.toThrow(/E\.164 destination or Signal UUID/);
  });
});

describe('SignalAdapter — SupportsReadReceipts', () => {
  it('markRead() calls port.sendReadReceipts with the target timestamp', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 99999);

    await adapter.markRead(target);

    expect(port.receipts).toHaveLength(1);
    expect(port.receipts[0]).toMatchObject({
      target: '+15559990000',
      timestamps: [99999],
    });
  });

  it('markRead() rejects a cross-channel target', async () => {
    const { adapter } = makeAdapter();
    const target: MessageRef = { channel: 'signal:nope' as ChannelId, conversation: '+15559990000', id: '1' };
    await expect(adapter.markRead(target)).rejects.toThrow(/does not match adapter channel/);
  });
});

describe('SignalAdapter — SupportsDelete', () => {
  it("deleteMessage(scope: 'me') throws (unsupported by signal-cli)", async () => {
    const { adapter, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 1);
    await expect(adapter.deleteMessage(target, 'me')).rejects.toThrow(/scope 'me' is not supported/);
  });

  it("deleteMessage(scope: 'everyone') sends a remove reaction", async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 12345);

    await adapter.deleteMessage(target, 'everyone');

    expect(port.reactions).toHaveLength(1);
    expect(port.reactions[0]).toMatchObject({
      targetTimestamp: 12345,
      targetAuthor: '+15559990000',
      emoji: '',
      remove: true,
    });
  });
});
