// tests/transport/twilio/twilio-port.test.ts
// All SDK and keyring interactions are injected via deps; no network calls.

import { describe, it, expect, vi } from 'vitest';
import { SdkTwilioSmsPort } from '../../../src/transport/twilio/twilio-port.ts';
import type { TwilioClientLike } from '../../../src/transport/twilio/twilio-port.ts';
import type { TwilioSmsConfig } from '../../../src/transport/twilio/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: TwilioSmsConfig = {
  account: 'ml-bot',
  accountSid: 'AC00000000000000000000000000000000',
  authTokenService: 'twilio-ml-bot',
  phoneNumber: '+15559990000',
  inboundMode: 'poll',
  pollIntervalMs: 15000,
  rateLimit: { smsPerMinute: 30 },
};

const TOKEN = 'test-secret-token-1234';

/** Build a minimal mock Twilio client. */
function makeMockClient(overrides: Partial<{
  accountFetch: () => Promise<unknown>;
  messagesCreate: (params: Record<string, unknown>) => Promise<{ sid: string }>;
  messagesList: (params: Record<string, unknown>) => Promise<unknown[]>;
}>): TwilioClientLike {
  const accountFetch = overrides.accountFetch ?? vi.fn().mockResolvedValue({ sid: BASE_CONFIG.accountSid });
  const messagesCreate = overrides.messagesCreate ?? vi.fn().mockResolvedValue({ sid: 'SM111' });
  const messagesList = overrides.messagesList ?? vi.fn().mockResolvedValue([]);

  return {
    api: {
      v2010: {
        // accounts is called as a function: accounts(sid) -> { fetch }
        accounts: ((_sid: string) => ({ fetch: accountFetch })) as TwilioClientLike['api']['v2010']['accounts'],
      },
    },
    messages: {
      create: messagesCreate as TwilioClientLike['messages']['create'],
      list: messagesList as TwilioClientLike['messages']['list'],
    },
  };
}

// ---------------------------------------------------------------------------
// Lazy init
// ---------------------------------------------------------------------------

describe('SdkTwilioSmsPort lazy init', () => {
  it('does NOT call credentialLookup at construction time', () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const factory = vi.fn().mockReturnValue(makeMockClient({}));

    new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    expect(lookup).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('calls credentialLookup exactly once on first use, not again on second use', async () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const factory = vi.fn().mockReturnValue(makeMockClient({}));
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await port.verifyCredentials();
    await port.verifyCredentials();

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(BASE_CONFIG.authTokenService);
  });

  it('passes (accountSid, token) to the client factory', async () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const factory = vi.fn().mockReturnValue(makeMockClient({}));
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await port.verifyCredentials();

    expect(factory).toHaveBeenCalledWith(BASE_CONFIG.accountSid, TOKEN);
  });

  it('propagates keyring lookup failure without retry', async () => {
    const lookup = vi.fn().mockReturnValue(null); // token not found
    const factory = vi.fn();
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await expect(port.verifyCredentials()).rejects.toThrow(/auth token not found/i);
    expect(factory).not.toHaveBeenCalled();
    // Calling again re-throws without retrying the factory
    await expect(port.sendSms({ to: '+15551230000', from: '+15559990000', body: 'hi' })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// verifyCredentials
// ---------------------------------------------------------------------------

describe('SdkTwilioSmsPort verifyCredentials', () => {
  it('calls api.v2010.accounts(accountSid).fetch()', async () => {
    const accountFetch = vi.fn().mockResolvedValue({ sid: BASE_CONFIG.accountSid });
    const factory = vi.fn().mockReturnValue(makeMockClient({ accountFetch }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await port.verifyCredentials();

    expect(accountFetch).toHaveBeenCalledTimes(1);
  });

  it('propagates auth failure with code and status preserved', async () => {
    const authError = Object.assign(new Error('Authentication Error'), { code: 20003, status: 401 });
    const accountFetch = vi.fn().mockRejectedValue(authError);
    const factory = vi.fn().mockReturnValue(makeMockClient({ accountFetch }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const err = await port.verifyCredentials().catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: number }).code).toBe(20003);
    expect((err as { status?: number }).status).toBe(401);
  });

  it('does NOT include the token in the error message on auth failure', async () => {
    const authError = Object.assign(
      new Error(`Authentication failed with token ${TOKEN}`),
      { code: 20003, status: 401 },
    );
    const accountFetch = vi.fn().mockRejectedValue(authError);
    const factory = vi.fn().mockReturnValue(makeMockClient({ accountFetch }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const err = await port.verifyCredentials().catch((e) => e);

    expect((err as Error).message).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// sendSms
// ---------------------------------------------------------------------------

describe('SdkTwilioSmsPort sendSms', () => {
  it('passes {to, body, from} when config uses phoneNumber (no messagingServiceSid)', async () => {
    const messagesCreate = vi.fn().mockResolvedValue({ sid: 'SM999' });
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesCreate }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.sendSms({ to: '+15551230000', from: '+15559990000', body: 'hello' });

    expect(result.sid).toBe('SM999');
    expect(messagesCreate).toHaveBeenCalledWith({
      to: '+15551230000',
      body: 'hello',
      from: '+15559990000',
    });
  });

  it('passes {to, body, messagingServiceSid} when messagingServiceSid is provided', async () => {
    const messagesCreate = vi.fn().mockResolvedValue({ sid: 'SM888' });
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesCreate }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const configWithMss: TwilioSmsConfig = { ...BASE_CONFIG, messagingServiceSid: 'MGaabb' };
    const port = new SdkTwilioSmsPort(configWithMss, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.sendSms({
      to: '+15551230000',
      messagingServiceSid: 'MGaabb',
      body: 'hello',
    });

    expect(result.sid).toBe('SM888');
    expect(messagesCreate).toHaveBeenCalledWith({
      to: '+15551230000',
      body: 'hello',
      messagingServiceSid: 'MGaabb',
    });
    // from must NOT be included when messagingServiceSid is set
    const callArg = messagesCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('from');
  });

  it('preserves code/status on error and does not include token in message', async () => {
    const sendError = Object.assign(
      new Error(`Invalid To Number: use token ${TOKEN}`),
      { code: 21211, status: 400 },
    );
    const messagesCreate = vi.fn().mockRejectedValue(sendError);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesCreate }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const err = await port.sendSms({ to: '+15551230000', from: '+15559990000', body: 'hi' }).catch((e) => e);

    expect((err as { code?: number }).code).toBe(21211);
    expect((err as { status?: number }).status).toBe(400);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// listInboundSince
// ---------------------------------------------------------------------------

describe('SdkTwilioSmsPort listInboundSince', () => {
  // Helper to build a mock MessageInstance
  function makeMsg(overrides: Partial<{
    sid: string;
    from: string;
    to: string;
    body: string;
    direction: string;
    dateSent: Date;
    dateCreated: Date;
    status: string;
  }> = {}) {
    const base = new Date('2025-01-01T12:00:00Z');
    return {
      sid: overrides.sid ?? 'SMabc',
      from: overrides.from ?? '+15551230000',
      to: overrides.to ?? '+15559990000',
      body: overrides.body ?? 'test body',
      direction: overrides.direction ?? 'inbound',
      dateSent: overrides.dateSent ?? base,
      dateCreated: overrides.dateCreated ?? base,
      status: overrides.status ?? 'received',
    };
  }

  it('throws RangeError for pageSize 0 without calling the client', async () => {
    const messagesList = vi.fn();
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await expect(port.listInboundSince(new Date(), 0)).rejects.toThrow(RangeError);
    expect(messagesList).not.toHaveBeenCalled();
  });

  it('throws RangeError for pageSize -1 without calling the client', async () => {
    const messagesList = vi.fn();
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await expect(port.listInboundSince(new Date(), -1)).rejects.toThrow(RangeError);
    expect(messagesList).not.toHaveBeenCalled();
  });

  it('throws RangeError for pageSize 1.5 (non-integer) without calling the client', async () => {
    const messagesList = vi.fn();
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await expect(port.listInboundSince(new Date(), 1.5)).rejects.toThrow(RangeError);
    expect(messagesList).not.toHaveBeenCalled();
  });

  it('passes dateSentAfter = since - 1000ms to the SDK list call', async () => {
    const since = new Date('2025-06-01T10:00:00.000Z');
    const expectedDateSentAfter = new Date(since.getTime() - 1000);

    const messagesList = vi.fn().mockResolvedValue([]);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await port.listInboundSince(since);

    const callArg = messagesList.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg['dateSentAfter']).toEqual(expectedDateSentAfter);
  });

  it('filters out non-inbound messages (e.g. outbound-api)', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const messages = [
      makeMsg({ sid: 'SM1', direction: 'inbound', dateSent: new Date('2025-01-01T12:00:00Z') }),
      makeMsg({ sid: 'SM2', direction: 'outbound-api', dateSent: new Date('2025-01-01T12:01:00Z') }),
      makeMsg({ sid: 'SM3', direction: 'inbound', dateSent: new Date('2025-01-01T12:02:00Z') }),
    ];
    const messagesList = vi.fn().mockResolvedValue(messages);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.sid)).toEqual(['SM1', 'SM3']);
  });

  it('applies client-side inclusive filter: message exactly at since is included', async () => {
    const since = new Date('2025-01-01T12:00:00.000Z');
    const messages = [
      makeMsg({ sid: 'SM-exact', direction: 'inbound', dateSent: since }), // exactly at since
      makeMsg({ sid: 'SM-before', direction: 'inbound', dateSent: new Date(since.getTime() - 1) }),
    ];
    const messagesList = vi.fn().mockResolvedValue(messages);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result.map((m) => m.sid)).toContain('SM-exact');
    expect(result.map((m) => m.sid)).not.toContain('SM-before');
  });

  it('sorts ascending by sentAt even when SDK returns newest-first (Twilio default)', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    // SDK returns newest-first
    const messages = [
      makeMsg({ sid: 'SM3', direction: 'inbound', dateSent: new Date('2025-01-01T12:02:00Z') }),
      makeMsg({ sid: 'SM2', direction: 'inbound', dateSent: new Date('2025-01-01T12:01:00Z') }),
      makeMsg({ sid: 'SM1', direction: 'inbound', dateSent: new Date('2025-01-01T12:00:00Z') }),
    ];
    const messagesList = vi.fn().mockResolvedValue(messages);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result.map((m) => m.sid)).toEqual(['SM1', 'SM2', 'SM3']);
  });

  it('slices to pageSize after sort', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    // 5 messages newest-first from SDK
    const messages = [5, 4, 3, 2, 1].map((n) =>
      makeMsg({
        sid: `SM${n}`,
        direction: 'inbound',
        dateSent: new Date(`2025-01-01T12:0${n}:00Z`),
      }),
    );
    const messagesList = vi.fn().mockResolvedValue(messages);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since, 3);

    // Should be oldest 3 after ascending sort
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.sid)).toEqual(['SM1', 'SM2', 'SM3']);
  });

  it('passes to filter (phoneNumber) to the SDK call', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const messagesList = vi.fn().mockResolvedValue([]);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await port.listInboundSince(since);

    const callArg = messagesList.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg['to']).toBe(BASE_CONFIG.phoneNumber);
  });
});

// ---------------------------------------------------------------------------
// Init robustness (single-flight, factory failure)
// ---------------------------------------------------------------------------

describe('SdkTwilioSmsPort init robustness', () => {
  it('concurrent first calls share one credential lookup and one client (single-flight)', async () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const factory = vi.fn().mockImplementation(async () => {
      // Yield so both callers are in flight before the client resolves
      await Promise.resolve();
      return makeMockClient({});
    });
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await Promise.all([port.verifyCredentials(), port.verifyCredentials(), port.sendSms({ to: '+1', body: 'x' })]);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('factory failure is scrubbed (no token in message) and retried on the next call', async () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error(`construction failed with ${TOKEN}`))
      .mockResolvedValueOnce(makeMockClient({}));
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await expect(port.verifyCredentials()).rejects.toSatisfy((e: Error) => {
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).toContain('[REDACTED]');
      return true;
    });

    // Failure was not cached as permanent — the next call retries and succeeds
    await expect(port.verifyCredentials()).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('forwards limit = pageSize * 2 to the SDK as the over-fetch buffer', async () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const messagesList = vi.fn().mockResolvedValue([]);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await port.listInboundSince(new Date('2026-01-01T00:00:00Z'), 5);

    expect(messagesList).toHaveBeenCalledTimes(1);
    expect(messagesList.mock.calls[0][0]).toMatchObject({ limit: 10 });
  });
});
