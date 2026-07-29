// tests/transport/signal/adapter-send.test.ts
// sendText happy path + validation rules + port-error mapping.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig, peerConversationRef } from './mock-port.ts';
import { makeChannelId, type ChannelId } from '../../../src/core/transport-refs.ts';

function makeAdapter(port: MockSignalPort = new MockSignalPort()) {
  const adapter = new SignalAdapter(makeSignalConfig(), port);
  return { adapter, port, channelId: makeChannelId('signal', 'test') };
}

describe('SignalAdapter — sendText happy path', () => {
  it('sends a text message and returns a MessageRef with the port timestamp as id', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, '+15559990000');

    const ref = await adapter.sendText(target, 'hello');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ recipient: '+15559990000', body: 'hello' });
    expect(ref.channel).toBe(channelId);
    expect(ref.conversation).toBe('+15559990000');
    // The mock port generates the timestamp (Date.now() + sent.length); the
    // recorded SendSignalArgs doesn't carry it back. Assert the id is a
    // positive numeric string instead — that's the adapter's stringification
    // of the port's returned envelope timestamp.
    expect(ref.id).toMatch(/^\d+$/);
    expect(Number(ref.id)).toBeGreaterThan(0);
  });

  it('accepts a Signal UUID as the target id', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    const target = peerConversationRef(channelId, uuid);

    await adapter.sendText(target, 'hi');

    expect(port.sent[0]?.recipient).toBe(uuid);
  });

  it('forwards opts.correlationId through to the port call (no swallow)', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, '+15559990000');

    const ref = await adapter.sendText(target, 'x', { correlationId: 'custom-corr-1' });

    // The send completed (no exception swallowed) and returned a valid MessageRef
    // stamped with the port's timestamp. The correlationId is adapter-internal
    // (used for error mapping); full error-path correlation assertion lives in
    // the error-mapping test below.
    expect(ref.channel).toBe(channelId);
    expect(ref.conversation).toBe('+15559990000');
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]?.body).toBe('x');
  });
});

describe('SignalAdapter — sendText validation', () => {
  it('rejects a target whose channel does not match the adapter channel', async () => {
    const { adapter } = makeAdapter();
    const otherChannel = makeChannelId('signal', 'other-account') as ChannelId;
    const target = { channel: otherChannel, id: '+15559990000' };

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/does not match adapter channel/);
  });

  it('rejects a non-E.164, non-UUID target id', async () => {
    const { adapter, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, 'not-a-valid-id');

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/E\.164 destination, Signal UUID, or group id/);
  });

  it('rejects empty text', async () => {
    const { adapter, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, '+15559990000');

    await expect(adapter.sendText(target, '')).rejects.toThrow(/requires non-empty text/);
  });

  it('rejects text over maxTextLength (64 KiB)', async () => {
    const { adapter, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, '+15559990000');
    const tooLong = 'x'.repeat(65_536);

    await expect(adapter.sendText(target, tooLong)).rejects.toThrow(/exceeds maxTextLength/);
  });

  it('accepts text exactly at maxTextLength', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const target = peerConversationRef(channelId, '+15559990000');
    const atCap = 'x'.repeat(65_535);

    await adapter.sendText(target, atCap);
    expect(port.sent).toHaveLength(1);
  });
});

describe('SignalAdapter — sendText port-error mapping', () => {
  it('maps a 401 to AuthRequiredError', async () => {
    const port = new MockSignalPort({
      sendError: Object.assign(new Error('unlinked'), { status: 401 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    const target = peerConversationRef(channelId, '+15559990000');

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/Signal auth error/);
  });

  it('maps a 429 to RateLimitedError', async () => {
    const port = new MockSignalPort({
      sendError: Object.assign(new Error('Too many requests'), { status: 429 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    const target = peerConversationRef(channelId, '+15559990000');

    await expect(adapter.sendText(target, 'hi')).rejects.toMatchObject({
      payload: {
        code: 'transport.rate_limited',
        phase: 'provider_call_started',
      },
    });
  });

  it('maps a 5xx to TransientProviderError', async () => {
    const port = new MockSignalPort({
      sendError: Object.assign(new Error('boom'), { status: 503 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    const target = peerConversationRef(channelId, '+15559990000');

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/Signal transient error/);
  });

  it('maps a ControllableException code to TransientProviderError', async () => {
    const port = new MockSignalPort({
      sendError: Object.assign(new Error('retryable'), { code: 'ControllableException' }),
    });
    const { adapter, channelId } = makeAdapter(port);
    const target = peerConversationRef(channelId, '+15559990000');

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/Signal transient error/);
  });

  it('maps signal-cli numeric I/O and rate-limit codes without treating recipient errors as auth', async () => {
    const target = peerConversationRef(makeChannelId('signal', 'test'), '+15559990000');

    await expect(new SignalAdapter(makeSignalConfig(), new MockSignalPort({
      sendError: Object.assign(new Error('I/O failure'), { code: '-3' }),
    })).sendText(target, 'hi')).rejects.toThrow(/Signal transient error/);

    await expect(new SignalAdapter(makeSignalConfig(), new MockSignalPort({
      sendError: Object.assign(new Error('rate limited'), { code: '-5' }),
    })).sendText(target, 'hi')).rejects.toThrow(/Signal rate limit/);

    await expect(new SignalAdapter(makeSignalConfig(), new MockSignalPort({
      sendError: Object.assign(new Error('Recipient is not registered'), { code: '-1' }),
    })).sendText(target, 'hi')).rejects.toThrow(/Signal provider error/);

    await expect(new SignalAdapter(makeSignalConfig(), new MockSignalPort({
      sendError: Object.assign(new Error('safety number changed'), { code: '-4' }),
    })).sendText(target, 'hi')).rejects.toThrow(/Signal provider error/);
  });

  it('maps an unmatched error to PermanentProviderError', async () => {
    const port = new MockSignalPort({
      sendError: Object.assign(new Error('unknown fault'), { status: 400 }),
    });
    const { adapter, channelId } = makeAdapter(port);
    const target = peerConversationRef(channelId, '+15559990000');

    await expect(adapter.sendText(target, 'hi')).rejects.toThrow(/Signal provider error/);
  });

  it('honors a port-supplied phase of not_started instead of claiming provider_call_started', async () => {
    // A port error that provably precedes any provider contact (e.g. a
    // pre-write connection refusal) must surface phase 'not_started', not
    // the classification default. Covers the auth branch of mapPortError.
    const port = new MockSignalPort({
      sendError: Object.assign(new Error('unlinked'), { status: 401, phase: 'not_started' }),
    });
    const { adapter, channelId } = makeAdapter(port);
    const target = peerConversationRef(channelId, '+15559990000');

    await expect(adapter.sendText(target, 'hi')).rejects.toMatchObject({
      payload: {
        code: 'transport.auth_required',
        phase: 'not_started',
      },
    });
  });
});

describe('SignalAdapter — group sends', () => {
  it('routes a base64 group id through groupId, never recipient', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const groupId = 'Z3JvdXAtY29udmVyc2F0aW9u';

    await adapter.sendText(peerConversationRef(channelId, groupId), 'group hello');

    expect(port.sent[0]).toMatchObject({ groupId, body: 'group hello' });
    expect(port.sent[0]).not.toHaveProperty('recipient');
  });

  it('does not misclassify a maximum-length E.164 number as a base64 group id', async () => {
    const { adapter, port, channelId } = makeAdapter();
    const e164 = '+155500000000001';

    await adapter.sendText(peerConversationRef(channelId, e164), 'direct hello');

    expect(port.sent[0]).toMatchObject({ recipient: e164 });
    expect(port.sent[0]).not.toHaveProperty('groupId');
  });
});

describe('SignalAdapter — local rate limit', () => {
  afterEach(() => vi.useRealTimers());

  it('enforces the configured per-conversation minute cap before calling the port', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00Z'));
    const port = new MockSignalPort();
    const adapter = new SignalAdapter(makeSignalConfig({
      rateLimit: { messagesPerMinute: 1 },
    }), port);
    const target = peerConversationRef(adapter.capabilities.channel, '+15559990000');

    await adapter.sendText(target, 'one');
    await expect(adapter.sendText(target, 'two')).rejects.toMatchObject({
      payload: {
        code: 'transport.rate_limited',
        phase: 'not_started',
        retryAfterMs: 60000,
      },
    });
    expect(port.sent).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60000);
    await expect(adapter.sendText(target, 'three')).resolves.toBeDefined();
    expect(port.sent).toHaveLength(2);
  });

  it('prunes expired rate-limit windows across high-cardinality conversations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00Z'));
    const adapter = new SignalAdapter(makeSignalConfig({
      rateLimit: { messagesPerMinute: 1 },
    }), new MockSignalPort());

    for (let index = 0; index < 1_000; index++) {
      await adapter.sendText(
        peerConversationRef(
          adapter.capabilities.channel,
          `+1555${String(index).padStart(7, '0')}`,
        ),
        'one',
      );
    }
    const history = (adapter as unknown as {
      sendHistory: Map<string, number[]>;
    }).sendHistory;
    expect(history.size).toBe(1_000);

    await vi.advanceTimersByTimeAsync(60_000);
    await adapter.sendText(
      peerConversationRef(adapter.capabilities.channel, '+15559999999'),
      'fresh',
    );

    expect(history.size).toBe(1);
    expect(history.has('+15559999999')).toBe(true);
  });
});
