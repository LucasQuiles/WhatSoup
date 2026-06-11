// tests/transport/twilio/adapter-send.test.ts
import { describe, it, expect } from 'vitest';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';
import type { TwilioSmsConfig } from '../../../src/transport/twilio/types.ts';
import {
  AuthRequiredError,
  PayloadTooLargeError,
  ConversationNotFoundError,
  PermanentProviderError,
  RateLimitedError,
} from '../../../src/transport/contract/errors.ts';

function makeConfig(overrides?: Partial<TwilioSmsConfig>): TwilioSmsConfig {
  return {
    account: 'ml-bot',
    accountSid: 'AC00000000000000000000000000000000',
    authTokenService: 'twilio-ml-bot',
    phoneNumber: '+15559990000',
    inboundMode: 'poll',
    pollIntervalMs: 15000,
    rateLimit: { smsPerMinute: 30 },
    ...overrides,
  };
}

describe('TwilioSmsAdapter capabilities', () => {
  it('reports kind sms with correct channel id', () => {
    const port = new MockTwilioSmsPort();
    const config = makeConfig();
    const adapter = new TwilioSmsAdapter(config, port);
    const caps = adapter.capabilities;
    expect(caps.kind).toBe('sms');
    expect(caps.channel).toBe(makeChannelId('sms', 'ml-bot'));
  });

  it('has an empty extensions set', () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    expect(adapter.capabilities.extensions.size).toBe(0);
  });

  it('has maxTextLength of 1600', () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    expect(adapter.capabilities.maxTextLength).toBe(1600);
  });

  it('has auth token', () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    expect(adapter.capabilities.auth).toBe('token');
  });
});

describe('TwilioSmsAdapter connect', () => {
  it('happy path: transitions disconnected to connected and emits state events', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const states: string[] = [];
    adapter.on('state', (h) => states.push(h.state));

    expect(adapter.state().state).toBe('disconnected');
    await adapter.connect();
    expect(adapter.state().state).toBe('connected');
    expect(states).toContain('starting');
    expect(states).toContain('connected');
    expect(states.indexOf('starting')).toBeLessThan(states.indexOf('connected'));
  });

  it('auth failure: throws AuthRequiredError and leaves state disconnected', async () => {
    const port = new MockTwilioSmsPort();
    const authErr = Object.assign(new Error('401 auth failed'), { status: 401, code: 20003 });
    port.failNextVerify(authErr);

    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    const states: string[] = [];
    adapter.on('state', (h) => states.push(h.state));

    await expect(adapter.connect()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(adapter.state().state).toBe('disconnected');
    expect(states).toContain('starting');
  });

  it('rate-limit failure: throws RateLimitedError and leaves state disconnected', async () => {
    const port = new MockTwilioSmsPort();
    port.failNextVerify(Object.assign(new Error('too many requests'), { status: 429 }));

    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await expect(adapter.connect()).rejects.toBeInstanceOf(RateLimitedError);
    expect(adapter.state().state).toBe('disconnected');
  });

  it('non-auth failure: throws PermanentProviderError and leaves state disconnected', async () => {
    const port = new MockTwilioSmsPort();
    port.failNextVerify(Object.assign(new Error('boom'), { status: 500 }));

    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await expect(adapter.connect()).rejects.toBeInstanceOf(PermanentProviderError);
    expect(adapter.state().state).toBe('disconnected');
  });
});

describe('TwilioSmsAdapter sendText', () => {
  it('happy path with phoneNumber: returns MessageRef, port receives correct args', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const channel = makeChannelId('sms', 'ml-bot');
    const ref = await adapter.sendText({ channel, id: '+15551230000' }, 'hello');

    expect(ref.channel).toBe(channel);
    expect(ref.conversation).toBe('+15551230000');
    expect(typeof ref.id).toBe('string');
    expect(ref.id.length).toBeGreaterThan(0);

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0].messagingServiceSid).toBeUndefined();
    expect(port.sent[0]).toMatchObject({
      to: '+15551230000',
      from: '+15559990000',
      body: 'hello',
    });
  });

  it('messagingServiceSid preferred over phoneNumber when both present', async () => {
    const port = new MockTwilioSmsPort();
    const config = makeConfig({ messagingServiceSid: 'MGabcdef1234567890abcdef1234567890' });
    const adapter = new TwilioSmsAdapter(config, port);
    await adapter.connect();

    const channel = makeChannelId('sms', 'ml-bot');
    await adapter.sendText({ channel, id: '+15551230000' }, 'test msg');

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0].from).toBeUndefined();
    expect(port.sent[0].messagingServiceSid).toBe('MGabcdef1234567890abcdef1234567890');
  });

  it('returns MessageRef with sid from port', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const channel = makeChannelId('sms', 'ml-bot');
    const ref = await adapter.sendText({ channel, id: '+15551230000' }, 'hi');

    expect(ref.id).toMatch(/^SM/);
  });

  it('oversized text throws PayloadTooLargeError BEFORE port receives a call', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const oversized = 'x'.repeat(1601);
    const channel = makeChannelId('sms', 'ml-bot');

    await expect(
      adapter.sendText({ channel, id: '+15551230000' }, oversized),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);

    expect(port.sent).toHaveLength(0);
  });

  it('blank text throws PayloadTooLargeError BEFORE port receives a call', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const channel = makeChannelId('sms', 'ml-bot');

    await expect(
      adapter.sendText({ channel, id: '+15551230000' }, ''),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);

    expect(port.sent).toHaveLength(0);
  });

  it('wrong channel throws ConversationNotFoundError BEFORE port receives a call', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const wrongChannel = makeChannelId('sms', 'other-bot');

    await expect(
      adapter.sendText({ channel: wrongChannel, id: '+15551230000' }, 'hi'),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);

    expect(port.sent).toHaveLength(0);
  });

  it('port send failure throws PermanentProviderError', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    port.failNextSend(new Error('unknown provider error'));

    const channel = makeChannelId('sms', 'ml-bot');

    await expect(
      adapter.sendText({ channel, id: '+15551230000' }, 'hello'),
    ).rejects.toBeInstanceOf(PermanentProviderError);

    expect(port.sent).toHaveLength(0);
  });

  it('port HTTP 401 failure maps to AuthRequiredError', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const authErr = Object.assign(new Error('invalid credentials'), { status: 401 });
    port.failNextSend(authErr);

    const channel = makeChannelId('sms', 'ml-bot');

    await expect(
      adapter.sendText({ channel, id: '+15551230000' }, 'hello'),
    ).rejects.toBeInstanceOf(AuthRequiredError);

    expect(port.sent).toHaveLength(0);
  });

  it('port HTTP 429 failure maps to RateLimitedError', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const rateErr = Object.assign(new Error('too many requests'), { status: 429 });
    port.failNextSend(rateErr);

    const channel = makeChannelId('sms', 'ml-bot');

    await expect(
      adapter.sendText({ channel, id: '+15551230000' }, 'hello'),
    ).rejects.toBeInstanceOf(RateLimitedError);

    expect(port.sent).toHaveLength(0);
  });

  it('port twilio error code 20003 maps to AuthRequiredError', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const twilioErr = Object.assign(new Error('auth error'), { code: 20003 });
    port.failNextSend(twilioErr);

    const channel = makeChannelId('sms', 'ml-bot');

    await expect(
      adapter.sendText({ channel, id: '+15551230000' }, 'hello'),
    ).rejects.toBeInstanceOf(AuthRequiredError);

    expect(port.sent).toHaveLength(0);
  });

  it('port twilio error code 20429 maps to RateLimitedError', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const twilioErr = Object.assign(new Error('too many requests'), { code: 20429 });
    port.failNextSend(twilioErr);

    const channel = makeChannelId('sms', 'ml-bot');

    await expect(
      adapter.sendText({ channel, id: '+15551230000' }, 'hello'),
    ).rejects.toBeInstanceOf(RateLimitedError);

    expect(port.sent).toHaveLength(0);
  });
});

describe('TwilioSmsAdapter subscriptions', () => {
  it('dispose removes the listener', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);

    const received: string[] = [];
    const sub = adapter.on('state', (h) => received.push(h.state));

    await adapter.connect();
    const countAfterConnect = received.length;

    sub.dispose();
    await adapter.disconnect();

    expect(received.length).toBe(countAfterConnect);
  });

  it('dispose is idempotent', () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    const sub = adapter.on('error', () => {});
    expect(() => {
      sub.dispose();
      sub.dispose();
    }).not.toThrow();
  });
});

describe('TwilioSmsAdapter selfRef', () => {
  it('returns a ParticipantRef on the adapter channel', () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    const ref = adapter.selfRef();
    expect(ref.channel).toBe(makeChannelId('sms', 'ml-bot'));
    expect(typeof ref.id).toBe('string');
  });
});

describe('TwilioSmsAdapter disconnect', () => {
  it('transitions to disconnected and emits state', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig(), port);
    await adapter.connect();

    const states: string[] = [];
    adapter.on('state', (h) => states.push(h.state));

    await adapter.disconnect();
    expect(adapter.state().state).toBe('disconnected');
    expect(states).toContain('disconnected');
  });
});

describe('TwilioSmsAdapter construction guard', () => {
  it('throws loud when neither phoneNumber nor messagingServiceSid is provided', () => {
    const port = new MockTwilioSmsPort();
    const config = makeConfig();
    const broken = { ...config, phoneNumber: undefined, messagingServiceSid: undefined };
    expect(() => new TwilioSmsAdapter(broken, port)).toThrow(/phoneNumber or messagingServiceSid/);
  });
});
