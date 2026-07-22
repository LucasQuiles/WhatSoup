import { describe, expect, it, vi } from 'vitest';
import { ImessageConnection } from '../../../src/transport/imessage/connection-bridge.ts';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { isGroupJid } from '../../../src/core/jid-constants.ts';
import { MockImessagePort, makeImessageConfig } from './mock-port.ts';

describe('ImessageConnection inbound identity', () => {
  it('canonicalizes a mixed-case AppleID before runtime persistence', async () => {
    const adapter = new ImessageAdapter(
      makeImessageConfig({ pollIntervalMs: 0 }),
      new MockImessagePort(),
    );
    const connection = new ImessageConnection(adapter);
    const onMessage = vi.fn();
    connection.onMessage = onMessage;
    await connection.connect();

    adapter.handleInboundRecord({
      guid: 'mixed-case-appleid',
      from: 'Sender@BB.Example.Test',
      to: 'bot@example.test',
      body: 'hello',
      fromMe: false,
      kind: 'text',
      timestamp: 1000,
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatJid: 'sender@bb.example.test@imessage',
      senderJid: 'sender@bb.example.test@imessage',
    }));
    await connection.shutdown();
  });

  it('preserves a canonical +E.164 direct identity', async () => {
    const adapter = new ImessageAdapter(
      makeImessageConfig({ pollIntervalMs: 0 }),
      new MockImessagePort(),
    );
    const connection = new ImessageConnection(adapter);
    const onMessage = vi.fn();
    connection.onMessage = onMessage;
    await connection.connect();

    adapter.handleInboundRecord({
      guid: 'e164-identity',
      from: '+15551230008',
      to: 'bot@example.test',
      body: 'hello',
      fromMe: false,
      kind: 'text',
      timestamp: 1000,
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatJid: '+15551230008@imessage',
      senderJid: '+15551230008@imessage',
    }));
    await connection.shutdown();
  });

  it('preserves provider group context through the runtime JID classifier', async () => {
    const adapter = new ImessageAdapter(
      makeImessageConfig({ pollIntervalMs: 0 }),
      new MockImessagePort(),
    );
    const connection = new ImessageConnection(adapter);
    const onMessage = vi.fn();
    connection.onMessage = onMessage;
    await connection.connect();

    adapter.handleInboundRecord({
      guid: 'group-message',
      from: 'sender@example.test',
      to: 'bot@example.test',
      chatGuid: 'iMessage;+;chatABC',
      body: 'hello group',
      fromMe: false,
      kind: 'text',
      timestamp: 1000,
    });

    const incoming = onMessage.mock.calls[0]?.[0];
    expect(incoming).toMatchObject({
      chatJid: 'iMessage;+;chatABC@imessage',
      isGroup: true,
    });
    expect(isGroupJid(incoming.chatJid)).toBe(true);
    await connection.shutdown();
  });

  it.each([
    'unknown',
    '15551230008',
    'not-an-email@imessage',
    'malformed@example',
  ])('drops a malformed direct provider identity: %s', async (identity) => {
    const adapter = new ImessageAdapter(
      makeImessageConfig({ pollIntervalMs: 0 }),
      new MockImessagePort(),
    );
    const connection = new ImessageConnection(adapter);
    const onMessage = vi.fn();
    connection.onMessage = onMessage;
    await connection.connect();

    const emitted = adapter.handleInboundRecord({
      guid: `invalid-${identity}`,
      from: identity,
      to: 'bot@example.test',
      body: 'hello',
      fromMe: false,
      kind: 'text',
      timestamp: 1000,
    });

    expect(emitted).toBe(false);
    expect(onMessage).not.toHaveBeenCalled();
    await connection.shutdown();
  });
});
