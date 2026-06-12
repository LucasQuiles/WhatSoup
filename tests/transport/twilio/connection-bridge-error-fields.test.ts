// tests/transport/twilio/connection-bridge-error-fields.test.ts
// Verifies that the error-channel listener logs all structured TransportErrorPayload
// fields, not just the subset previously included.
import { describe, it, expect, vi, afterEach } from 'vitest';

const bridgeLogError = vi.hoisted(() => vi.fn());

vi.mock('../../../src/logger.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/logger.ts')>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== 'twilio-bridge') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'error') {
            return (fields: Record<string, unknown>, msg: string) => {
              bridgeLogError(fields, msg);
              return (target as { error: (f: unknown, m: string) => unknown }).error(fields, msg);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

import { TwilioConnection } from '../../../src/transport/twilio/connection-bridge.ts';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';
import { makeTwilioConfig } from './helpers.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function makeBridge() {
  const port = new MockTwilioSmsPort();
  const adapter = new TwilioSmsAdapter(makeTwilioConfig({ pollIntervalMs: 1000 }), port);
  const bridge = new TwilioConnection(adapter);
  return { bridge, port, adapter };
}

describe('TwilioConnection error-channel log completeness', () => {
  it('logs providerCode, channelId, hint, scope, and idempotencyKey alongside existing fields', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, port } = makeBridge();
    await bridge.connect();

    // Trigger a poll error — the adapter maps it to a TransportError and emits
    // it on the 'error' channel which the bridge logs.
    // The mapped error will include: code, retryable, operation, correlationId,
    // channelId, scope — we verify all fields are forwarded to the logger.
    const rawPortError = new Error('upstream 503');
    port.failNextList(rawPortError);
    await vi.advanceTimersByTimeAsync(1000); // trigger one poll tick

    expect(bridgeLogError).toHaveBeenCalledOnce();
    const [fields] = bridgeLogError.mock.calls[0] as [Record<string, unknown>, string];

    // Original fields that were already logged
    expect(fields).toHaveProperty('code');
    expect(fields).toHaveProperty('operation');
    expect(fields).toHaveProperty('correlationId');
    expect(fields).toHaveProperty('retryable');

    // Newly required fields from TransportErrorPayload
    expect(fields).toHaveProperty('channelId');
    expect(fields).toHaveProperty('scope');
  });

  it('logs hint and idempotencyKey when present in the payload', async () => {
    const { bridge, adapter } = makeBridge();
    await bridge.connect();

    // Build a TransportError with hint and idempotencyKey, then deliver it to
    // the bridge's registered error listeners (same path the adapter uses).
    const { TransientProviderError } = await import('../../../src/transport/contract/errors.ts');
    const err = new TransientProviderError({
      channelId: makeChannelId('sms', 'ml-bot'),
      operation: 'poll',
      correlationId: 'corr-abc',
      message: 'upstream 503',
      scope: 'provider',
      hint: 'retry after backoff',
      providerCode: 'TWILIO_503',
      idempotencyKey: 'idem-xyz',
    });

    const errorListeners = (adapter as unknown as { listeners: { error: Set<(e: unknown) => void> } })
      .listeners.error;
    expect(errorListeners.size).toBeGreaterThan(0);
    for (const listener of errorListeners) listener(err);

    expect(bridgeLogError).toHaveBeenCalledOnce();
    const [fields] = bridgeLogError.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      providerCode: 'TWILIO_503',
      channelId: 'sms:ml-bot',
      hint: 'retry after backoff',
      scope: 'provider',
      idempotencyKey: 'idem-xyz',
    });
  });

  it('logs phase when present in the payload', async () => {
    const { bridge, adapter } = makeBridge();
    await bridge.connect();

    const { SendAmbiguousError } = await import('../../../src/transport/contract/errors.ts');
    const err = new SendAmbiguousError({
      channelId: makeChannelId('sms', 'ml-bot'),
      operation: 'sendText',
      correlationId: 'corr-def',
      message: 'send ambiguous',
      scope: 'request',
      phase: 'provider_call_started',
    });

    const errorListeners = (adapter as unknown as { listeners: { error: Set<(e: unknown) => void> } })
      .listeners.error;
    expect(errorListeners.size).toBeGreaterThan(0);
    for (const listener of errorListeners) listener(err);

    expect(bridgeLogError).toHaveBeenCalledOnce();
    const [fields] = bridgeLogError.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ phase: 'provider_call_started' });
  });
});
