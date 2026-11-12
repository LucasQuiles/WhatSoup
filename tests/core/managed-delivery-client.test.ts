import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpManagedDeliveryClient } from '../../src/core/managed-delivery-client.ts';
import {
  TEST_DELIVERY_BASE_URL,
  TEST_DELIVERY_HOST,
  TEST_LINK_HOST,
  TEST_PROTECTED_DELIVERY_PINS,
} from '../helpers/protected-delivery-pins.ts';

const DELIVERY_REF = 'D'.repeat(22);
const SHARE_ID = 'S'.repeat(22);
const FRAGMENT_KEY = 'K'.repeat(43);
const MANAGED_LINK = `https://${TEST_LINK_HOST}/s/#v3.${SHARE_ID}.${FRAGMENT_KEY}`;
const INTAKE_ID = 'I'.repeat(22);
const INTAKE_LINK = `https://${TEST_LINK_HOST}/s/#i1.${INTAKE_ID}.${FRAGMENT_KEY}`;
const EXPIRES_AT = '2030-10-29T12:05:00.000Z';
const ISSUED_AT = '2030-10-29T12:00:00.000Z';

type FetchCall = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): HttpManagedDeliveryClient {
  return new HttpManagedDeliveryClient({
    baseUrl: TEST_DELIVERY_BASE_URL,
    token: 'DUMMY-transport-token',
    fetch,
    pins: TEST_PROTECTED_DELIVERY_PINS,
  });
}

function stageReply(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deliveryRef: DELIVERY_REF,
    id: SHARE_ID,
    expiresAt: EXPIRES_AT,
    state: 'unclaimed',
    ...extra,
  };
}

function resolveReply(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SHARE_ID,
    link: MANAGED_LINK,
    expiresAt: EXPIRES_AT,
    state: 'unclaimed',
    ...extra,
  };
}

function intakeReply(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INTAKE_ID,
    resourceId: 'dummy-account',
    accountLabel: 'Dummy account',
    consumerLabel: 'Dummy consumer',
    action: 'sign_in',
    kind: 'password',
    saveAllowed: true,
    expiresAt: EXPIRES_AT,
    state: 'awaiting_input',
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('managed delivery HTTP client', () => {
  it('uses stable idempotency keys, redirect errors, and never stages a URL', async () => {
    const calls: FetchCall[] = [];
    const managed = client(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return calls.length === 1
        ? json(stageReply({ link: MANAGED_LINK }))
        : json(resolveReply());
    });

    const staged = await managed.stageRustdesk({
      deviceId: 'desk-1',
      purpose: 'login',
      principal: '15551234567',
      operationId: 'stage-operation',
    });
    const resolved = await managed.resolve({
      deliveryRef: DELIVERY_REF,
      principal: '15551234567',
      operationId: 'resolve-operation',
    });

    expect(staged).toEqual({
      deliveryRef: DELIVERY_REF,
      id: SHARE_ID,
      expiresAt: EXPIRES_AT,
      state: 'unclaimed',
    });
    expect(JSON.stringify(staged)).not.toContain(MANAGED_LINK);
    expect(resolved).toEqual({
      id: SHARE_ID,
      link: MANAGED_LINK,
      expiresAt: EXPIRES_AT,
      state: 'unclaimed',
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://delivery.example.test/s/api/v1/deliveries');
    expect(calls[1].url).toBe(`https://delivery.example.test/s/api/v1/deliveries/${DELIVERY_REF}/resolve`);
    expect(new Headers(calls[0].init.headers).get('Idempotency-Key')).toBe('stage-operation');
    expect(new Headers(calls[1].init.headers).get('Idempotency-Key')).toBe('resolve-operation');
    expect(calls[0].init.redirect).toBe('error');
    expect(calls[1].init.redirect).toBe('error');
    expect(String(calls[0].init.body)).toBe(JSON.stringify({
      kind: 'rustdesk',
      deviceId: 'desk-1',
      principal: '15551234567',
      purpose: 'login',
    }));
    expect(String(calls[0].init.body)).not.toContain(MANAGED_LINK);
    expect(String(calls[0].init.body)).not.toContain('DUMMY-transport-token');
  });

  it('uses an exact 10-second abort deadline and turns timeout failures into a safe error', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let seenSignal: AbortSignal | null = null;
    const managed = client(async (_url, init) => {
      seenSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        seenSignal?.addEventListener('abort', () => reject(new Error(`DUMMY timeout ${MANAGED_LINK}`)), { once: true });
      });
    });

    const pending = managed.stageRustdesk({
      deviceId: 'desk-1',
      purpose: 'login',
      principal: '15551234567',
      operationId: 'timeout-operation',
    });
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(seenSignal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('managed delivery request is unavailable');
    await expect(pending).rejects.not.toThrow(MANAGED_LINK);
  });

  it('bounds chunked JSON bodies at 64 KiB and cancels the real response stream', async () => {
    let cancelled = false;
    const bytes = new TextEncoder().encode(`{"response":"${'A'.repeat(64 * 1024)}"}`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const managed = client(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(managed.stageRustdesk({
      deviceId: 'desk-1',
      purpose: 'login',
      principal: '15551234567',
      operationId: 'oversized-stream',
    })).rejects.toThrow('managed delivery response is too large');
    expect(cancelled).toBe(true);
  });

  it('keeps grant state separate from delivery evidence and excludes links from metadata', async () => {
    const calls: FetchCall[] = [];
    const managed = client(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json({
        deliveryRef: DELIVERY_REF,
        id: SHARE_ID,
        state: 'unclaimed',
        status: 'submitted',
        expiresAt: EXPIRES_AT,
        issuedAt: ISSUED_AT,
        kind: 'rustdesk',
        deviceId: 'desk-1',
        purpose: 'login',
        link: MANAGED_LINK,
      });
    });

    const status = await managed.getStatus({
      deliveryRef: DELIVERY_REF,
      principal: '15551234567',
    });

    expect(status).toEqual({
      deliveryRef: DELIVERY_REF,
      id: SHARE_ID,
      state: 'unclaimed',
      deliveryStatus: 'submitted',
      expiresAt: EXPIRES_AT,
      issuedAt: ISSUED_AT,
      kind: 'rustdesk',
      deviceId: 'desk-1',
      purpose: 'login',
    });
    expect(JSON.stringify(status)).not.toContain(MANAGED_LINK);
    expect(calls[0].url).toBe(`https://delivery.example.test/s/api/v1/deliveries/${DELIVERY_REF}?principal=15551234567`);
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.redirect).toBe('error');
  });

  it('rejects malformed opaque IDs and URLs outside the approved v3 origin', async () => {
    const malformedStage = client(async () => json(stageReply({ deliveryRef: 'D'.repeat(21) })));
    await expect(malformedStage.stageRustdesk({
      deviceId: 'desk-1',
      purpose: 'login',
      principal: '15551234567',
      operationId: 'bad-stage',
    })).rejects.toThrow('managed delivery response has an invalid deliveryRef');

    const malformedId = client(async () => json(stageReply({ id: 'S'.repeat(21) })));
    await expect(malformedId.stageRustdesk({
      deviceId: 'desk-1',
      purpose: 'login',
      principal: '15551234567',
      operationId: 'bad-id',
    })).rejects.toThrow('managed delivery response has an invalid id');

    const wrongOrigin = client(async () => json(resolveReply({ link: `https://example.test/s/#v3.${SHARE_ID}.${FRAGMENT_KEY}` })));
    await expect(wrongOrigin.resolve({
      deliveryRef: DELIVERY_REF,
      principal: '15551234567',
      operationId: 'bad-link',
    })).rejects.toThrow('managed delivery response is missing protected URL');

    const shortKey = client(async () => json(resolveReply({ link: `https://${TEST_LINK_HOST}/s/#v3.${SHARE_ID}.${FRAGMENT_KEY.slice(1)}` })));
    await expect(shortKey.resolve({
      deliveryRef: DELIVERY_REF,
      principal: '15551234567',
      operationId: 'short-key',
    })).rejects.toThrow('managed delivery response is missing protected URL');

    // Without explicit pins the client uses the production pins, which never
    // match a test host.
    const productionPins = new HttpManagedDeliveryClient({
      baseUrl: TEST_DELIVERY_BASE_URL,
      token: 'DUMMY-transport-token',
      fetch: async () => json(resolveReply({ link: MANAGED_LINK })),
    });
    await expect(productionPins.resolve({
      deliveryRef: DELIVERY_REF,
      principal: '15551234567',
      operationId: 'production-pins',
    })).rejects.toThrow('managed delivery response is missing protected URL');
  });

  it('admits a link on a pinned host taken from configured linkHosts and refuses a link outside them', async () => {
    const configured = (linkHosts: readonly string[]) => new HttpManagedDeliveryClient({
      baseUrl: TEST_DELIVERY_BASE_URL,
      token: 'DUMMY-transport-token',
      fetch: async () => json(resolveReply({ link: MANAGED_LINK })),
      pins: TEST_PROTECTED_DELIVERY_PINS,
      linkHosts,
    });
    const request = { deliveryRef: DELIVERY_REF, principal: '15551234567', operationId: 'configured-link-hosts' };

    await expect(configured([TEST_LINK_HOST]).resolve(request)).resolves.toMatchObject({ link: MANAGED_LINK });
    await expect(configured([TEST_DELIVERY_HOST]).resolve(request))
      .rejects.toThrow('managed delivery response is missing protected URL');
  });

  it('does not expose failed response bodies', async () => {
    const responseBody = `DUMMY backend response ${MANAGED_LINK}`;
    const managed = client(async () => new Response(responseBody, { status: 503 }));

    try {
      await managed.stageRustdesk({
        deviceId: 'desk-1',
        purpose: 'login',
        principal: '15551234567',
        operationId: 'safe-error',
      });
      throw new Error('expected stage failure');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('managed delivery request failed');
      expect((error as Error).message).not.toContain(responseBody);
      expect((error as Error).message).not.toContain(MANAGED_LINK);
    }
  });

  it('uses the fixed intake routes and keeps the #i1 URL out of metadata', async () => {
    const calls: FetchCall[] = [];
    const managed = client(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      if (calls.length === 1) return json(intakeReply());
      if (calls.length === 2) return json(intakeReply({ link: INTAKE_LINK }));
      if (calls.length === 3) return json(intakeReply({ state: 'submitted' }));
      return json(intakeReply({ state: 'cancelled' }));
    });

    const created = await managed.createSecretInput({
      resourceId: 'dummy-account', principal: '15551234567', kind: 'password', purpose: 'dummy login', operationId: 'create-input',
    });
    const resolved = await managed.resolveSecretInput({
      id: INTAKE_ID, principal: '15551234567', operationId: 'resolve-input',
    });
    const status = await managed.getSecretInput({ id: INTAKE_ID, principal: '15551234567' });
    const cancelled = await managed.cancelSecretInput({ id: INTAKE_ID, principal: '15551234567' });

    expect(created).toEqual(intakeReply());
    expect(status).toEqual(intakeReply({ state: 'submitted' }));
    expect(cancelled).toEqual(intakeReply({ state: 'cancelled' }));
    expect(resolved).toEqual({ ...intakeReply(), link: INTAKE_LINK });
    expect(JSON.stringify(created)).not.toContain(INTAKE_LINK);
    expect(JSON.stringify(status)).not.toContain(INTAKE_LINK);
    expect(JSON.stringify(cancelled)).not.toContain(INTAKE_LINK);
    expect(calls.map((call) => call.url)).toEqual([
      `${TEST_DELIVERY_BASE_URL}/intakes`,
      `${TEST_DELIVERY_BASE_URL}/intakes/${INTAKE_ID}/resolve`,
      `${TEST_DELIVERY_BASE_URL}/intakes/${INTAKE_ID}?principal=15551234567`,
      `${TEST_DELIVERY_BASE_URL}/intakes/${INTAKE_ID}/cancel`,
    ]);
    expect(String(calls[0]?.init.body)).toBe(JSON.stringify({
      resourceId: 'dummy-account', principal: '15551234567', kind: 'password', purpose: 'dummy login',
    }));
    expect(String(calls[1]?.init.body)).toBe(JSON.stringify({ principal: '15551234567', operationId: 'resolve-input' }));
    expect(String(calls[3]?.init.body)).toBe(JSON.stringify({ principal: '15551234567' }));
    expect(new Headers(calls[0]?.init.headers).get('Idempotency-Key')).toBe('create-input');
    expect(new Headers(calls[1]?.init.headers).get('Idempotency-Key')).toBe('resolve-input');
    expect(calls.every((call) => call.init.redirect === 'error')).toBe(true);
  });

  it('uses the unchanged intake body for an MFA request and rejects storable MFA metadata', async () => {
    const calls: FetchCall[] = [];
    const managed = client(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json(intakeReply({ kind: 'mfa', saveAllowed: false }));
    });

    await expect(managed.createSecretInput({
      resourceId: 'dummy-account', principal: '15551234567', kind: 'mfa', purpose: 'dummy MFA', operationId: 'mfa-input',
    })).resolves.toEqual(intakeReply({ kind: 'mfa', saveAllowed: false }));
    expect(String(calls[0]?.init.body)).toBe(JSON.stringify({
      resourceId: 'dummy-account', principal: '15551234567', kind: 'mfa', purpose: 'dummy MFA',
    }));
    expect(String(calls[0]?.init.body)).not.toContain('challenge');

    const invalid = client(async () => json(intakeReply({ kind: 'mfa', saveAllowed: true })));
    await expect(invalid.createSecretInput({
      resourceId: 'dummy-account', principal: '15551234567', kind: 'mfa', purpose: 'dummy MFA', operationId: 'bad-mfa-input',
    })).rejects.toThrow('managed delivery response has an invalid secret input metadata');
  });

  it('rejects an intake link that does not bind the fixed #i1 id and key shape', async () => {
    const wrongId = client(async () => json(intakeReply({
      link: `https://${TEST_LINK_HOST}/s/#i1.${SHARE_ID}.${FRAGMENT_KEY}`,
    })));
    await expect(wrongId.resolveSecretInput({
      id: INTAKE_ID, principal: '15551234567', operationId: 'wrong-intake-link',
    })).rejects.toThrow('managed delivery response is missing protected intake URL');

    const shortKey = client(async () => json(intakeReply({
      link: `https://${TEST_LINK_HOST}/s/#i1.${INTAKE_ID}.${FRAGMENT_KEY.slice(1)}`,
    })));
    await expect(shortKey.resolveSecretInput({
      id: INTAKE_ID, principal: '15551234567', operationId: 'short-intake-key',
    })).rejects.toThrow('managed delivery response is missing protected intake URL');
  });

  it('accepts an intake link only on an exactly spelled canonical pinned host', async () => {
    const request = { id: INTAKE_ID, principal: '15551234567', operationId: 'pinned-intake-link' };
    const replying = (link: string, options: { productionPins?: boolean; linkHosts?: readonly string[] } = {}) =>
      new HttpManagedDeliveryClient({
        baseUrl: TEST_DELIVERY_BASE_URL,
        token: 'DUMMY-transport-token',
        fetch: async () => json(intakeReply({ link })),
        ...(options.productionPins === true ? {} : { pins: TEST_PROTECTED_DELIVERY_PINS }),
        ...(options.linkHosts === undefined ? {} : { linkHosts: options.linkHosts }),
      });
    const refused = 'managed delivery response is missing protected intake URL';
    const fragment = `/s/#i1.${INTAKE_ID}.${FRAGMENT_KEY}`;

    await expect(replying(INTAKE_LINK).resolveSecretInput(request)).resolves.toMatchObject({ link: INTAKE_LINK });
    // A host that is not pinned, a pinned host that is not a canonical link
    // host, and spellings the URL parser would normalize are all refused.
    for (const link of [
      `https://unpinned.example.test${fragment}`,
      `https://${TEST_DELIVERY_HOST}${fragment}`,
      `https://${TEST_LINK_HOST.toUpperCase()}${fragment}`,
      `https://www.${TEST_LINK_HOST}${fragment}`,
      `https://${TEST_LINK_HOST}.${fragment}`,
      `https://${TEST_LINK_HOST}:443${fragment}`,
      `http://${TEST_LINK_HOST}${fragment}`,
      `https://${TEST_LINK_HOST}${fragment}?x=1`,
    ]) {
      await expect(replying(link).resolveSecretInput(request)).rejects.toThrow(refused);
    }
    // Configured link hosts only narrow the pinned set.
    await expect(replying(INTAKE_LINK, { linkHosts: [TEST_LINK_HOST] }).resolveSecretInput(request))
      .resolves.toMatchObject({ link: INTAKE_LINK });
    await expect(replying(INTAKE_LINK, { linkHosts: [TEST_DELIVERY_HOST] }).resolveSecretInput(request)).rejects.toThrow(refused);
    // Without explicit pins the client uses the production pins, which never
    // match a test host.
    await expect(replying(INTAKE_LINK, { productionPins: true }).resolveSecretInput(request)).rejects.toThrow(refused);
  });
});
