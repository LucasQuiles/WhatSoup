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
  it('react() fails closed until MessageRef carries the target author', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 12345);

    await expect(adapter.react(target, '👍')).rejects.toThrow(/target author/i);

    expect(port.reactions).toHaveLength(0);
  });

  it('unreact() fails closed until MessageRef carries the target author', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 12345);

    await expect(adapter.unreact(target, '👍')).rejects.toThrow(/target author/i);

    expect(port.reactions).toHaveLength(0);
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

  it('fails closed for group reactions too', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, 'Z3JvdXAtY29udmVyc2F0aW9u', 12345);

    await expect(adapter.react(target, '👍')).rejects.toThrow(/target author/i);
    expect(port.reactions).toHaveLength(0);
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

  it('setTyping supports a Signal group target without treating it as a peer identity', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const groupId = 'Z3JvdXAtY29udmVyc2F0aW9u';

    await adapter.setTyping(peerConversationRef(channelId, groupId), true);

    expect(port.typings[0]).toEqual({ groupId, composing: true });
  });

  it('setTyping rejects a non-E.164 / non-UUID / non-group target', async () => {
    const { adapter, channelId } = makeAdapter();
    await expect(adapter.setTyping(peerConversationRef(channelId, 'bogus'), true))
      .rejects.toThrow(/E\.164 destination, Signal UUID, or group id/);
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

  it('markRead() fails closed for a group until the sender can be resolved separately', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, 'Z3JvdXAtY29udmVyc2F0aW9u', 99999);

    await expect(adapter.markRead(target)).rejects.toThrow(/group read receipts require a sender/i);
    expect(port.receipts).toHaveLength(0);
  });
});

describe('SignalAdapter — SupportsDelete', () => {
  it("deleteMessage(scope: 'me') throws (unsupported by signal-cli)", async () => {
    const { adapter, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 1);
    await expect(adapter.deleteMessage(target, 'me')).rejects.toThrow(/scope 'me' is not supported/);
  });

  it("deleteMessage(scope: 'everyone') calls the remoteDelete operation", async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerMessageRef(channelId, '+15559990000', 12345);

    await adapter.deleteMessage(target, 'everyone');

    expect(port.deletes).toHaveLength(1);
    expect(port.deletes[0]).toMatchObject({
      targetTimestamp: 12345,
      recipient: '+15559990000',
    });
    expect(port.reactions).toHaveLength(0);
  });
});
