// tests/transport/imessage/adapter-send.test.ts
import { describe, it, expect } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig, peerConversationRef } from './mock-port.ts';
import { makeChannelId, type ChannelId } from '../../../src/core/transport-refs.ts';

function makeAdapter(port: MockImessagePort = new MockImessagePort()) {
  const adapter = new ImessageAdapter(makeImessageConfig(), port);
  return { adapter, port, channelId: makeChannelId('imessage', 'test') };
}

describe('ImessageAdapter — sendText happy path', () => {
  it('sends to an AppleID email recipient and returns a MessageRef with the port guid', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const recipient = ['user', 'example.com'].join('@');
    const target = peerConversationRef(channelId, recipient);

    const ref = await adapter.sendText(target, 'hello');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ recipient, body: 'hello' });
    expect(ref.channel).toBe(channelId);
    expect(ref.conversation).toBe(recipient);
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
    const target = { channel: otherChannel, id: 'user@example.com' };

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/does not match adapter channel/);
  });

  it('rejects an invalid recipient (not email/phone/chat-guid)', async () => {
    const { adapter, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, 'not-valid');

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/valid iMessage recipient/);
  });

  it('rejects empty text', async () => {
    const { adapter, channelId } = makeAdapter();
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@example.com'), ''))
      .rejects.toThrow(/requires non-empty text/);
  });

  it('rejects text over maxTextLength', async () => {
    const { adapter, channelId } = makeAdapter();
    const tooLong = 'x'.repeat(65_536);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@example.com'), tooLong))
      .rejects.toThrow(/exceeds maxTextLength/);
  });
});

describe('ImessageAdapter — sendText port-error mapping', () => {
  it('maps an acknowledged imsg send without an identifier to SendAmbiguousError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('accepted without id'), {
        code: 'SendAcceptedWithoutId',
        phase: 'ack_received',
      }),
    });
    const { adapter, channelId } = makeAdapter(port);
    const error = await adapter.sendText(
      peerConversationRef(channelId, 'u@example.com'),
      'hi',
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      payload: {
        code: 'transport.send_ambiguous',
        retryable: false,
        phase: 'ack_received',
      },
    });
  });

  it('maps a 401 to AuthRequiredError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('Unauthorized'), { status: 401, code: 'Unauthorized' }),
    });
    const { adapter, channelId } = makeAdapter(port);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@example.com'), 'hi'))
      .rejects.toThrow(/iMessage auth error/);
  });

  it('maps a 429 to RateLimitedError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('Too many requests'), { status: 429 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@example.com'), 'hi'))
      .rejects.toThrow(/iMessage rate limit/);
  });

  it('maps a 5xx to TransientProviderError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('boom'), { status: 503 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@example.com'), 'hi'))
      .rejects.toThrow(/iMessage transient error/);
  });

  it('maps an unmatched error to PermanentProviderError', async () => {
    const port = new MockImessagePort({
      sendError: Object.assign(new Error('bad request'), { status: 400 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    await expect(adapter.sendText(peerConversationRef(channelId, 'u@example.com'), 'hi'))
      .rejects.toThrow(/iMessage provider error/);
  });
});

describe('ImessageAdapter — extension error mapping', () => {
  it('maps an unavailable imsg bridge method to a non-retryable provider error', async () => {
    const port = new MockImessagePort();
    port.sendTypingIndicator = async () => {
      throw Object.assign(new Error('method not found'), {
        code: 'UnsupportedMethod',
        status: 501,
      });
    };
    const { adapter, channelId } = makeAdapter(port);

    const error = await adapter.setTyping(
      peerConversationRef(channelId, 'u@example.com'),
      true,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      payload: {
        code: 'transport.permanent_provider',
        retryable: false,
        providerCode: 'UnsupportedMethod',
      },
    });
  });
});
