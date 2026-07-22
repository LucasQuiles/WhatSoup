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
  authTokenService: 'whatsoup-twilio-ml-bot',
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
    calls: {
      create: vi.fn().mockResolvedValue({ sid: 'CA000001', status: 'queued' }) as TwilioClientLike['calls']['create'],
    },
  };
}

// ---------------------------------------------------------------------------
// Lazy init
// ---------------------------------------------------------------------------

describe('SdkTwilioSmsPort lazy init', () => {
  it('rejects a cross-line selector before credential or client access', () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const factory = vi.fn().mockReturnValue(makeMockClient({}));

    expect(() => new SdkTwilioSmsPort(
      { ...BASE_CONFIG, authTokenService: 'whatsoup-twilio-other-line' },
      { credentialLookup: lookup, clientFactory: factory },
    )).toThrow(/whatsoup-twilio-ml-bot/);
    expect(lookup).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects an invalid account with a forged null selector before credential or client access', () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const factory = vi.fn().mockReturnValue(makeMockClient({}));

    expect(() => new SdkTwilioSmsPort(
      { ...BASE_CONFIG, account: 'INVALID', authTokenService: null } as unknown as TwilioSmsConfig,
      { credentialLookup: lookup, clientFactory: factory },
    )).toThrow(/valid account|authTokenService/i);
    expect(lookup).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('captures validated config before the caller-owned object can mutate', async () => {
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const factory = vi.fn().mockReturnValue(makeMockClient({}));
    const mutable = { ...BASE_CONFIG };
    const port = new SdkTwilioSmsPort(mutable, { credentialLookup: lookup, clientFactory: factory });

    mutable.authTokenService = 'openai';
    mutable.accountSid = `AC${'f'.repeat(32)}`;
    await port.verifyCredentials();

    expect(lookup).toHaveBeenCalledWith('whatsoup-twilio-ml-bot');
    expect(lookup).not.toHaveBeenCalledWith('openai');
    expect(factory).toHaveBeenCalledWith(BASE_CONFIG.accountSid, TOKEN);
  });

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

  it('includes outbound-api messages with fromMe: true alongside inbound messages', async () => {
    // Previously this test verified that outbound-api was filtered out.
    // Now outbound messages are included with fromMe: true so the adapter can
    // emit them as echo confirmations for the durability engine.
    // When phoneNumber is configured, listInboundSince makes TWO calls:
    //   call 1: {to: phoneNumber} — inbound messages
    //   call 2: {from: phoneNumber} — outbound messages
    const since = new Date('2025-01-01T00:00:00Z');
    const inboundMessages = [
      makeMsg({ sid: 'SM1', direction: 'inbound', dateSent: new Date('2025-01-01T12:00:00Z') }),
      makeMsg({ sid: 'SM3', direction: 'inbound', dateSent: new Date('2025-01-01T12:02:00Z') }),
    ];
    const outboundMessages = [
      makeMsg({ sid: 'SM2', direction: 'outbound-api', dateSent: new Date('2025-01-01T12:01:00Z') }),
    ];
    // First call (to=) returns inbound, second call (from=) returns outbound
    const messagesList = vi.fn()
      .mockResolvedValueOnce(inboundMessages)
      .mockResolvedValueOnce(outboundMessages);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    // All three records returned, sorted ascending
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.sid)).toEqual(['SM1', 'SM2', 'SM3']);
    // Direction mapping
    expect(result[0].fromMe).toBe(false);  // inbound
    expect(result[1].fromMe).toBe(true);   // outbound-api
    expect(result[2].fromMe).toBe(false);  // inbound
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
});

// ---------------------------------------------------------------------------
// listInboundSince — outbound echo support (two-call split, fromMe mapping)
// ---------------------------------------------------------------------------

describe('SdkTwilioSmsPort listInboundSince — outbound echo support', () => {
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
    const base = new Date('2025-06-01T12:00:00Z');
    return {
      sid: overrides.sid ?? 'SMout001',
      from: overrides.from ?? '+15559990000',
      to: overrides.to ?? '+15551230000',
      body: overrides.body ?? 'bot reply',
      direction: overrides.direction ?? 'outbound-api',
      dateSent: overrides.dateSent ?? base,
      dateCreated: overrides.dateCreated ?? base,
      status: overrides.status ?? 'sent',
    };
  }

  it('makes TWO SDK list calls when phoneNumber is configured: one {to} and one {from}', async () => {
    const messagesList = vi.fn().mockResolvedValue([]);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await port.listInboundSince(new Date('2025-06-01T00:00:00Z'));

    expect(messagesList).toHaveBeenCalledTimes(2);
    const call0 = messagesList.mock.calls[0][0] as Record<string, unknown>;
    const call1 = messagesList.mock.calls[1][0] as Record<string, unknown>;
    // One call has {to: phoneNumber}, the other has {from: phoneNumber}
    const toCall = [call0, call1].find((c) => 'to' in c);
    const fromCall = [call0, call1].find((c) => 'from' in c);
    expect(toCall?.['to']).toBe(BASE_CONFIG.phoneNumber);
    expect(fromCall?.['from']).toBe(BASE_CONFIG.phoneNumber);
  });

  it('makes ONE SDK list call when messagingServiceSid-only config (no phoneNumber)', async () => {
    const messagesList = vi.fn().mockResolvedValue([]);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const mssConfig: TwilioSmsConfig = { ...BASE_CONFIG, phoneNumber: undefined, messagingServiceSid: 'mg00000000000000000000000000000000' };
    const port = new SdkTwilioSmsPort(mssConfig, { credentialLookup: lookup, clientFactory: factory });

    await port.listInboundSince(new Date('2025-06-01T00:00:00Z'));

    expect(messagesList).toHaveBeenCalledTimes(1);
    const callArg = messagesList.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('to');
    expect(callArg).not.toHaveProperty('from');
  });

  it('maps outbound-api direction → fromMe: true', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const messages = [makeMsg({ direction: 'outbound-api', dateSent: new Date('2025-06-01T12:00:00Z') })];
    // First call (to=) returns nothing, second call (from=) returns the outbound msg
    const messagesList = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(messages);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result).toHaveLength(1);
    expect(result[0].fromMe).toBe(true);
    expect(result[0].sid).toBe('SMout001');
  });

  it('maps outbound-reply direction → fromMe: true', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const messages = [makeMsg({ sid: 'SMreply', direction: 'outbound-reply', dateSent: new Date('2025-06-01T12:00:00Z') })];
    const messagesList = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(messages);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result).toHaveLength(1);
    expect(result[0].fromMe).toBe(true);
  });

  it('maps inbound direction → fromMe: false', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const messages = [makeMsg({ sid: 'SMin', from: '+15551230000', to: '+15559990000', direction: 'inbound', dateSent: new Date('2025-06-01T12:00:00Z') })];
    const messagesList = vi.fn()
      .mockResolvedValueOnce(messages)  // to= call returns this
      .mockResolvedValueOnce([]);       // from= call returns nothing
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result).toHaveLength(1);
    expect(result[0].fromMe).toBe(false);
    expect(result[0].sid).toBe('SMin');
  });

  it('deduplicates by SID when the same record appears in both API call results', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const duplicate = makeMsg({ sid: 'SMdup', direction: 'outbound-api', dateSent: new Date('2025-06-01T12:00:00Z') });
    // Same SID in both calls — can happen under race conditions
    const messagesList = vi.fn()
      .mockResolvedValueOnce([duplicate])
      .mockResolvedValueOnce([duplicate]);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result).toHaveLength(1);
    expect(result[0].sid).toBe('SMdup');
  });

  it('merges inbound and outbound records, sorted ascending by sentAt', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const inMsg = makeMsg({ sid: 'SMin', from: '+15551230000', to: '+15559990000', direction: 'inbound', dateSent: new Date('2025-06-01T12:00:00Z') });
    const outMsg = makeMsg({ sid: 'SMout', from: '+15559990000', to: '+15551230000', direction: 'outbound-api', dateSent: new Date('2025-06-01T12:01:00Z') });
    const messagesList = vi.fn()
      .mockResolvedValueOnce([inMsg])   // to= call returns inbound
      .mockResolvedValueOnce([outMsg]); // from= call returns outbound
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result).toHaveLength(2);
    expect(result[0].sid).toBe('SMin');
    expect(result[1].sid).toBe('SMout');
    expect(result[0].fromMe).toBe(false);
    expect(result[1].fromMe).toBe(true);
  });

  it('forwards limit = pageSize * 2 to EACH SDK call when pageSize is set', async () => {
    const messagesList = vi.fn().mockResolvedValue([]);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    await port.listInboundSince(new Date('2026-01-01T00:00:00Z'), 5);

    expect(messagesList).toHaveBeenCalledTimes(2);
    expect(messagesList.mock.calls[0][0]).toMatchObject({ limit: 10 });
    expect(messagesList.mock.calls[1][0]).toMatchObject({ limit: 10 });
  });
});

// ---------------------------------------------------------------------------
// twilio-port.ts uncovered-branch coverage
// ---------------------------------------------------------------------------

describe('twilio-port.ts uncovered-branch coverage', () => {
  // Reusable message builder mirroring the MessageInstanceLike shape.
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
    const base = new Date('2025-06-01T12:00:00Z');
    return {
      sid: overrides.sid ?? 'SMcov1',
      from: overrides.from ?? '+15551230000',
      to: overrides.to ?? '+15559990000',
      body: overrides.body ?? 'cov body',
      direction: overrides.direction ?? 'inbound',
      dateSent: overrides.dateSent ?? base,
      dateCreated: overrides.dateCreated ?? base,
      status: overrides.status ?? 'received',
    };
  }

  // --- placeCall success path (lines 347-355) -------------------------------

  it('placeCall forwards {to, from, twiml, statusCallback} and returns {sid, status}', async () => {
    const callsCreate = vi.fn().mockResolvedValue({ sid: 'CAcall1', status: 'queued' });
    const client = makeMockClient({});
    (client.calls as { create: typeof callsCreate }).create = callsCreate;
    const factory = vi.fn().mockReturnValue(client);
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.placeCall({
      to: '+15551230000',
      from: '+15559990000',
      twiml: '<Response><Say>hi</Say></Response>',
      statusCallback: 'https://example.invalid/status',
    });

    expect(result).toEqual({ sid: 'CAcall1', status: 'queued' });
    expect(callsCreate).toHaveBeenCalledWith({
      to: '+15551230000',
      from: '+15559990000',
      twiml: '<Response><Say>hi</Say></Response>',
      statusCallback: 'https://example.invalid/status',
    });
  });

  // --- placeCall error path: scrubAndRethrow (lines 356-357) -----------------

  it('placeCall scrubs token from error and preserves code/status', async () => {
    const callsCreate = vi.fn().mockRejectedValue(
      Object.assign(new Error(`call failed token=${TOKEN}`), { code: 13225, status: 400 }),
    );
    const client = makeMockClient({});
    (client.calls as { create: typeof callsCreate }).create = callsCreate;
    const factory = vi.fn().mockReturnValue(client);
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const err = await port.placeCall({ to: '+15551230000', twiml: '<Response/>' }).catch((e) => e);

    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain('[REDACTED]');
    expect((err as { code?: number }).code).toBe(13225);
    expect((err as { status?: number }).status).toBe(400);
  });

  // --- listInboundSince: unknown direction → skip (line 300) ----------------

  it('skips records whose direction is neither inbound nor outbound-*', async () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const messages = [
      makeMsg({ sid: 'SMkeep', direction: 'inbound', dateSent: new Date('2025-06-01T12:00:00Z') }),
      makeMsg({ sid: 'SMskip', direction: 'shortcoded', dateSent: new Date('2025-06-01T12:01:00Z') }),
    ];
    const messagesList = vi.fn()
      .mockResolvedValueOnce(messages)
      .mockResolvedValueOnce([]);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const result = await port.listInboundSince(since);

    expect(result.map((m) => m.sid)).toEqual(['SMkeep']);
  });

  // --- list error path: phoneNumber configured, Promise.all rejects (line 275) ---

  it('listInboundSince scrubs token when the parallel (to/from) list call rejects', async () => {
    const listError = Object.assign(new Error(`list bomb ${TOKEN}`), { code: 50001, status: 500 });
    const messagesList = vi.fn().mockRejectedValue(listError);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const err = await port.listInboundSince(new Date('2025-01-01T00:00:00Z')).catch((e) => e);

    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain('[REDACTED]');
    expect((err as { code?: number }).code).toBe(50001);
    expect((err as { status?: number }).status).toBe(500);
  });

  // --- list error path: messagingServiceSid-only config, single list rejects (line 288) ---

  it('listInboundSince scrubs token when the single list call rejects (no phoneNumber)', async () => {
    const listError = Object.assign(new Error(`mss bomb ${TOKEN}`), { code: 50002, status: 503 });
    const messagesList = vi.fn().mockRejectedValue(listError);
    const factory = vi.fn().mockReturnValue(makeMockClient({ messagesList }));
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const mssConfig: TwilioSmsConfig = { ...BASE_CONFIG, phoneNumber: undefined, messagingServiceSid: 'mg00000000000000000000000000000000' };
    const port = new SdkTwilioSmsPort(mssConfig, { credentialLookup: lookup, clientFactory: factory });

    const err = await port.listInboundSince(new Date('2025-01-01T00:00:00Z')).catch((e) => e);

    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain('[REDACTED]');
    expect((err as { code?: number }).code).toBe(50002);
    expect((err as { status?: number }).status).toBe(503);
  });

  // --- scrub fallback: non-Error thrown object with no message/stack/code (lines 123,125,126,129) ---

  it('initClient scrubs a non-Error rejection (no message/stack/code/status) and rethrows', async () => {
    // Factory rejects with a non-Error object lacking every typed field,
    // forcing every ternary in scrubAndRethrow to its falsy branch.
    const factory = vi.fn().mockRejectedValue({ unrelated: true });
    const lookup = vi.fn().mockReturnValue(TOKEN);
    const port = new SdkTwilioSmsPort(BASE_CONFIG, { credentialLookup: lookup, clientFactory: factory });

    const err = await port.verifyCredentials().catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // String({unrelated:true}) → "[object Object]"
    expect((err as Error).message).toBe('[object Object]');
    expect((err as { code?: number }).code).toBeUndefined();
    expect((err as { status?: number }).status).toBeUndefined();
  });
});
