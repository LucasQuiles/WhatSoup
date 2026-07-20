// tests/transport/imessage/adapter-send.test.ts
import { describe, it, expect } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig, peerConversationRef } from './mock-port.ts';
import type { ChannelId } from '../../../src/core/transport-refs.ts';

function makeAdapter(port: MockImessagePort = new MockImessagePort()) {
  const adapter = new ImessageAdapter(makeImessageConfig(), port);
  return { adapter, port, channelId: adapter.channelId as ChannelId };
}

describe('ImessageAdapter — sendText happy path', () => {
  it('sends to an AppleID email recipient and returns a MessageRef with the port guid', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, 'user@icloud.com');

    const ref = await adapter.sendText(target, 'hello');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ recipient: 'user@icloud.com', body: 'hello' });
    expect(ref.channel).toBe(channelId);
    expect(ref.conversation).toBe('user@icloud.com');
    expect(typeof ref.id).toBe('string');
    expect(ref.id).toMatch(/^guid-\d+$/);
  });

  it('sends to an E.164 phone recipient', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, '+15559990000');

    await adapter.sendText(target, 'hi');

    expect(port.sent[0]?.recipient).toBe('+15559990000');
  });

  it('sends to a chat GUID for group sends', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, 'iMessage;-;chatA-123');

    await adapter.sendText(target, 'group hi');

    expect(port.sent[0]?.recipient).toBe('iMessage;-;chatA-123');
  });
});

describe('ImessageAdapter — sendText validation', () => {
  it('rejects a cross-channel target', async () => {
    const { adapter } = makeAdapter();
    const otherChannel = 'imessage:other' as ChannelId;
    const target = { channel: otherChannel, id: 'user@icloud.com' };

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/does not match adapter channel/);
  });

  it('rejects an invalid recipient (not email/phone/chat-guid)', async () => {
    const { adapter, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, 'not-valid');

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/valid iMessage recipient/);
  });

  it('rejects empty text', async () => {
    const { adapter, channelId } = makeAdapter();
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@icloud.com'), ''))
      .rejects.toThrow(/requires non-empty text/);
  });

  it('rejects text over maxTextLength', async () => {
    const { adapter, channelId } = makeAdapter();
    const tooLong = 'x'.repeat(65_536);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@icloud.com'), tooLong))
      .rejects.toThrow(/exceeds maxTextLength/);
  });
});

describe('ImessageAdapter — sendText port-error mapping', () => {
  it('maps a 401 to AuthRequiredError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('Unauthorized'), { status: 401, code: 'Unauthorized' }),
    });
    const { adapter, channelId } = makeAdapter(port);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@icloud.com'), 'hi'))
      .rejects.toThrow(/iMessage auth error/);
  });

  it('maps a 429 to RateLimitedError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('Too many requests'), { status: 429 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@icloud.com'), 'hi'))
      .rejects.toThrow(/iMessage rate limit/);
  });

  it('maps a 5xx to TransientProviderError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('boom'), { status: 503 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@icloud.com'), 'hi'))
      .rejects.toThrow(/iMessage transient error/);
  });

  it('maps an unmatched error to PermanentProviderError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('bad request'), { status: 400 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@icloud.com'), 'hi'))
      .rejects.toThrow(/iMessage provider error/);
  });
});
