import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  agent365AccountDigest,
  createAgent365Client,
  type Agent365ClientOptions,
  type Agent365SendOnceInput,
} from '../../src/core/capabilities/agent365-client.ts';

const ENDPOINT = 'http://127.0.0.1:10000';
const READINESS_URL = `${ENDPOINT}/capabilities/microsoft-365/readiness`;
const SEND_URL = `${ENDPOINT}/mail/send-once`;
const API_KEY = 'test-key';
const ACCOUNT_ID = 'acct-contract';
const ACCOUNT_PERMIT_DIGEST = agent365AccountDigest(ACCOUNT_ID);
const OPERATION_KEY = 'operation-contract';
const TO_ADDRESS = ['recipient', 'example.invalid'].join('@');
const CC_ADDRESS = ['copy', 'example.invalid'].join('@');
const OBSERVED_AT = '2026-07-11T16:00:00Z';
const NOW_MS = Date.parse(OBSERVED_AT);
const oracle = JSON.parse(
  readFileSync(new URL('../../contracts/agent365-whatsoup-v1.json', import.meta.url), 'utf8'),
) as {
  samples: {
    readiness: Array<{
      name: string;
      http_status: number;
      body: Record<string, unknown>;
    }>;
  };
};

function readyReadiness(): Record<string, unknown> {
  return {
    version: 1,
    status: 'ready',
    account_id: ACCOUNT_ID,
    observed_at: OBSERVED_AT,
    expires_at: '2026-07-11T16:01:00Z',
    read: {
      ready: true,
      reason_codes: [],
      authenticated: true,
      token_broker_enabled: true,
      subscriptions_current: true,
      ingestion_fresh: true,
      public_ingress_ready: true,
    },
    mail_send: {
      ready: true,
      reason_codes: [],
      permission_ready: true,
      ledger_ready: true,
    },
  };
}

function mailUnavailableReadiness(): Record<string, unknown> {
  const readiness = readyReadiness();
  return {
    ...readiness,
    status: 'degraded',
    mail_send: {
      ready: false,
      reason_codes: ['mail_permission_unavailable'],
      permission_ready: false,
      ledger_ready: true,
    },
  };
}

function receipt(
  state: 'reserved' | 'draft_created' | 'accepted' | 'failed_pre_send' | 'unknown',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const accepted = state === 'accepted';
  return {
    operation_key: OPERATION_KEY,
    account_id: ACCOUNT_ID,
    state,
    error_code: state === 'failed_pre_send'
      ? 'mail_command_failed'
      : state === 'unknown'
        ? 'send_outcome_unknown'
        : null,
    attempt_count: state === 'reserved' || state === 'failed_pre_send' ? 0 : 1,
    created_at: '2026-07-11T16:00:00Z',
    updated_at: '2026-07-11T16:00:01Z',
    accepted_at: accepted ? '2026-07-11T16:00:01Z' : null,
    ...overrides,
  };
}

function response(
  value: unknown,
  init: {
    status?: number;
    url: string;
    contentType?: string;
  },
): Response {
  const result = new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
  Object.defineProperty(result, 'url', {
    configurable: true,
    value: init.url,
  });
  return result;
}

function statusResponse(status: number): Response {
  return response({ detail: 'private-backend-detail' }, {
    status,
    url: SEND_URL,
    contentType: 'text/plain',
  });
}

function options(fetchImpl: typeof fetch): Agent365ClientOptions {
  return {
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    fetch: fetchImpl,
    clock: () => NOW_MS,
    timeoutMs: 1_000,
  };
}

function input(bodyFormat: 'text' | 'html' = 'text'): Agent365SendOnceInput {
  return {
    operationKey: OPERATION_KEY,
    accountPermitDigest: ACCOUNT_PERMIT_DIGEST,
    message: {
      subject: 'Contract subject',
      body: '<p>Contract body</p>',
      bodyFormat,
      to: [TO_ADDRESS],
      cc: [CC_ADDRESS],
      bcc: [],
    },
  };
}

function sequencedFetch(second: Response): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response(readyReadiness(), { url: READINESS_URL }))
    .mockResolvedValueOnce(second);
}

describe('Agent365 reserved-winner send-once HTTP client', () => {
  it('fails proven pre-send on an account-permit change without issuing a POST', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(readyReadiness(), { url: READINESS_URL }));
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner({
      ...input(),
      accountPermitDigest: agent365AccountDigest('different-selected-account'),
    });

    expect(result).toEqual({
      kind: 'failed',
      provenPreSend: true,
      reason: 'mail_send_not_ready',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it.each([
    ['dot operation', { ...input(), operationKey: '.' }],
    ['path operation', { ...input(), operationKey: 'operation/private' }],
    ['long operation', { ...input(), operationKey: 'a'.repeat(129) }],
    ['unknown body format', {
      ...input(),
      message: { ...input().message, bodyFormat: 'markdown' },
    }],
    ['empty recipient list', {
      ...input(),
      message: { ...input().message, to: [] },
    }],
    ['too many recipients', {
      ...input(),
      message: { ...input().message, to: Array(51).fill(TO_ADDRESS) },
    }],
    ['too many recipients across fields', {
      ...input(),
      message: {
        ...input().message,
        cc: Array(50).fill(CC_ADDRESS),
      },
    }],
    ['non-string recipient', {
      ...input(),
      message: { ...input().message, to: [7] },
    }],
    ['long recipient', {
      ...input(),
      message: { ...input().message, to: [`${'a'.repeat(310)}@example.com`] },
    }],
    ['long subject', {
      ...input(),
      message: { ...input().message, subject: 's'.repeat(999) },
    }],
    ['oversized UTF-8 body', {
      ...input(),
      message: { ...input().message, body: 'é'.repeat(524_289) },
    }],
    ['missing bcc array', {
      ...input(),
      message: { ...input().message, bcc: undefined },
    }],
  ])('rejects invalid local input before the readiness GET: %s', async (_name, malformed) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(
      malformed as unknown as Agent365SendOnceInput,
    );

    expect(result).toEqual({
      kind: 'failed',
      provenPreSend: true,
      reason: 'mail_request_invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds a throwing malformed input without making an HTTP call or echoing the error', async () => {
    const marker = 'private-input-getter-marker';
    const malformed = input() as Agent365SendOnceInput & { operationKey: string };
    Object.defineProperty(malformed, 'operationKey', {
      get() {
        throw new Error(marker);
      },
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(malformed);

    expect(result).toEqual({
      kind: 'failed',
      provenPreSend: true,
      reason: 'mail_request_invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it.each([
    ['text', 'Text'],
    ['html', 'HTML'],
  ] as const)('performs one fresh GET then one POST and maps %s to %s', async (bodyFormat, contentType) => {
    const fetchImpl = sequencedFetch(response(receipt('accepted'), { url: SEND_URL }));
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(input(bodyFormat));

    expect(result).toEqual({ kind: 'accepted' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(READINESS_URL);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(SEND_URL);
    const postInit = fetchImpl.mock.calls[1]?.[1];
    expect(postInit).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: expect.any(AbortSignal),
    });
    expect(JSON.parse(String(postInit?.body))).toEqual({
      operation_key: OPERATION_KEY,
      account_id: ACCOUNT_ID,
      message: {
        subject: 'Contract subject',
        body: '<p>Contract body</p>',
        content_type: contentType,
        to: [TO_ADDRESS],
        cc: [CC_ADDRESS],
        bcc: [],
      },
    });
    expect(JSON.stringify(result)).not.toContain(ACCOUNT_ID);
    expect(JSON.stringify(result)).not.toContain(OPERATION_KEY);
  });

  it.each(
    oracle.samples.readiness
      .filter((sample) => sample.name !== 'ready')
      .map((sample) => [sample.name, sample] as const),
  )('does not POST for authoritative non-send-ready evidence: %s', async (_name, sample) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(sample.body, {
        status: sample.http_status,
        url: READINESS_URL,
      }))
      .mockResolvedValueOnce(response(receipt('accepted'), { url: SEND_URL }));
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(input());

    expect(result).toEqual({
      kind: 'failed',
      provenPreSend: true,
      reason: 'mail_send_not_ready',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('turns a failed fresh readiness GET into a proven pre-send failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error('private-readiness-error-marker'),
    );
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(input());

    expect(result).toEqual({
      kind: 'failed',
      provenPreSend: true,
      reason: 'readiness_unavailable',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private-readiness-error-marker');
  });

  it.each(['reserved', 'draft_created', 'unknown'] as const)(
    'quarantines a bounded %s receipt without retrying',
    async (state) => {
      const fetchImpl = sequencedFetch(response(receipt(state), { url: SEND_URL }));
      const client = createAgent365Client(options(fetchImpl));

      const result = await client.sendOnceForReservedWinner(input());

      expect(result).toEqual({
        kind: 'unknown',
        quarantine: true,
        reason: 'backend_nonterminal_receipt',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('maps failed_pre_send to a proven local failure', async () => {
    const fetchImpl = sequencedFetch(response(receipt('failed_pre_send'), { url: SEND_URL }));
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(input());

    expect(result).toEqual({
      kind: 'failed',
      provenPreSend: true,
      reason: 'backend_failed_pre_send',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 409, 424])(
    'quarantines HTTP %s after dispatch without proving a pre-send rejection',
    async (status) => {
      const fetchImpl = sequencedFetch(statusResponse(status));
      const client = createAgent365Client(options(fetchImpl));

      const result = await client.sendOnceForReservedWinner(input());

      expect(result).toEqual({
        kind: 'unknown',
        quarantine: true,
        reason: 'dispatch_outcome_unknown',
      });
      expect(result).not.toHaveProperty('provenPreSend');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(result)).not.toContain('private-backend-detail');
    },
  );

  it.each([201, 418, 500, 503])(
    'classifies HTTP %s after dispatch as unknown and never retries',
    async (status) => {
      const fetchImpl = sequencedFetch(statusResponse(status));
      const client = createAgent365Client(options(fetchImpl));

      const result = await client.sendOnceForReservedWinner(input());

      expect(result).toEqual({
        kind: 'unknown',
        quarantine: true,
        reason: 'dispatch_outcome_unknown',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    receipt('accepted', { operation_key: 'different-operation' }),
    receipt('accepted', { account_id: 'different-account' }),
    { state: 'accepted', body: 'private-malformed-success-marker' },
  ])('quarantines a malformed or mismatched HTTP 200 receipt', async (body) => {
    const fetchImpl = sequencedFetch(response(body, { url: SEND_URL }));
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(input());

    expect(result).toEqual({
      kind: 'unknown',
      quarantine: true,
      reason: 'dispatch_response_invalid',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('private-malformed-success-marker');
    expect(JSON.stringify(result)).not.toContain('different-account');
    expect(JSON.stringify(result)).not.toContain('different-operation');
  });

  it('classifies a reset after POST dispatch as unknown without retrying or leaking the error', async () => {
    const marker = 'private-reset-error-marker';
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(readyReadiness(), { url: READINESS_URL }))
      .mockRejectedValueOnce(new Error(marker));
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(input());

    expect(result).toEqual({
      kind: 'unknown',
      quarantine: true,
      reason: 'dispatch_outcome_unknown',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('quarantines a final POST URL mismatch and does not forward or retry', async () => {
    const mismatched = response(receipt('accepted', { account_id: 'url-marker-account' }), {
      url: 'http://localhost:10000/mail/send-once',
    });
    const fetchImpl = sequencedFetch(mismatched);
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.sendOnceForReservedWinner(input());

    expect(result).toEqual({
      kind: 'unknown',
      quarantine: true,
      reason: 'dispatch_outcome_unknown',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(SEND_URL);
    expect(fetchImpl.mock.calls[1]?.[1]?.redirect).toBe('error');
    expect(JSON.stringify(result)).not.toContain('url-marker-account');
  });
});
