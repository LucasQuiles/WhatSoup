import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFixedHttpMfaAdapter,
  createFixedHttpTokenAdapter,
} from '../../src/secure-handoff/http-adapters.ts';
import { createServiceOwnedCredentialStore } from '../../src/secure-handoff/credential-store.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type CapturedRequest = { method: string | undefined; path: string | undefined; headers: Record<string, string | string[] | undefined>; body: string };

const TOKEN_VALUE = 'token-value-for-local-fixture';
const MFA_CODE = 'mfa-code-for-local-fixture';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function localHttpFixture(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<{ origin: string }> {
  const server = createServer((request, response) => { void handler(request, response); });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local fixture did not bind TCP');
  return { origin: `http://127.0.0.1:${address.port}` };
}

function httpsFixtureSeam(origin: string, requested: URL[]): FetchLike {
  return async (input, init) => {
    const requestedUrl = input instanceof URL
      ? input
      : input instanceof Request
        ? new URL(input.url)
        : new URL(input);
    requested.push(requestedUrl);
    if (requestedUrl.protocol !== 'https:' || requestedUrl.hostname !== 'fixed-target.invalid') {
      throw new Error('fixture rejected non-fixed target');
    }
    return fetch(`${origin}${requestedUrl.pathname}`, init);
  };
}

async function capture(request: IncomingMessage): Promise<CapturedRequest> {
  const chunks: string[] = [];
  request.setEncoding('utf8');
  for await (const chunk of request) chunks.push(chunk);
  return { method: request.method, path: request.url, headers: request.headers, body: chunks.join('') };
}

function tokenOptions(fetch: FetchLike) {
  return {
    resourceId: 'fixed-token-resource',
    principal: 'fixed-principal',
    action: 'validate_token',
    endpoint: 'https://fixed-target.invalid/token',
    fetch,
  };
}

function mfaOptions(fetch: FetchLike) {
  return {
    resourceId: 'fixed-mfa-resource',
    principal: 'fixed-principal',
    action: 'confirm_mfa',
    endpoint: 'https://fixed-target.invalid/mfa',
    username: 'fixed-username',
    mfaOperationId: 'fixed-operation-123',
    fetch,
  };
}

describe('fixed token and MFA HTTP adapters', () => {
  it('sends a token only as a bearer header to the snapshotted fixed GET target', async () => {
    const received: CapturedRequest[] = [];
    const fixture = await localHttpFixture(async (request, response) => {
      received.push(await capture(request));
      response.writeHead(204).end();
    });
    const requested: URL[] = [];
    const options = tokenOptions(httpsFixtureSeam(fixture.origin, requested));
    const adapter = createFixedHttpTokenAdapter(options);
    options.endpoint = 'https://fixed-target.invalid/changed-after-registration';

    await expect(adapter.execute({ value: TOKEN_VALUE, kind: 'token', saveStore: null })).resolves.toEqual({
      outcome: 'succeeded', operationResult: { phase: 'token', outcome: 'completed' },
    });

    expect(adapter).toMatchObject({
      resourceId: 'fixed-token-resource', principal: 'fixed-principal', action: 'validate_token',
      kinds: ['token'], approvedSaveStore: null,
    });
    expect(received).toEqual([expect.objectContaining({
      method: 'GET', path: '/token', body: '', headers: expect.objectContaining({
        authorization: `Bearer ${TOKEN_VALUE}`, accept: 'application/json', 'cache-control': 'no-store',
      }),
    })]);
    expect(received[0]?.headers['content-type']).toBeUndefined();
    expect(requested.map(String)).toEqual(['https://fixed-target.invalid/token']);
  });

  it('classifies token rejection, redirect and wrong-kind execution without sending a second request', async () => {
    let requests = 0;
    const fixture = await localHttpFixture(async (request, response) => {
      requests++;
      await capture(request);
      if (request.url === '/denied') response.writeHead(401).end();
      else response.writeHead(302, { location: '/denied' }).end();
    });
    const requested: URL[] = [];
    const denied = createFixedHttpTokenAdapter({ ...tokenOptions(httpsFixtureSeam(fixture.origin, requested)), endpoint: 'https://fixed-target.invalid/denied' });
    const redirected = createFixedHttpTokenAdapter({ ...tokenOptions(httpsFixtureSeam(fixture.origin, requested)), endpoint: 'https://fixed-target.invalid/redirect' });

    await expect(denied.execute({ value: TOKEN_VALUE, kind: 'token', saveStore: null })).resolves.toBe('failed');
    await expect(redirected.execute({ value: TOKEN_VALUE, kind: 'token', saveStore: null })).rejects.toThrow('fixed token outcome is ambiguous');
    await expect(denied.execute({ value: TOKEN_VALUE, kind: 'password', saveStore: null })).rejects.toThrow('fixed token outcome is ambiguous');

    expect(requests).toBe(2);
    expect(JSON.stringify(requested)).not.toContain(TOKEN_VALUE);
  });

  it('saves a token only after a successful explicitly scoped execution', async () => {
    const saved: string[] = [];
    const store = createServiceOwnedCredentialStore({
      name: 'fixed-token-store', resourceId: 'fixed-token-resource', principal: 'fixed-principal', action: 'validate_token',
      persist: (value) => { saved.push(value); },
    });
    let validationAttempts = 0;
    const fixture = await localHttpFixture(async (request, response) => {
      await capture(request);
      validationAttempts++;
      response.writeHead(validationAttempts === 3 ? 401 : 204).end();
    });
    const adapter = createFixedHttpTokenAdapter({ ...tokenOptions(httpsFixtureSeam(fixture.origin, [])), store });

    await expect(adapter.execute({ value: TOKEN_VALUE, kind: 'token', saveStore: null })).resolves.toEqual({
      outcome: 'succeeded', operationResult: { phase: 'token', outcome: 'completed' },
    });
    await expect(adapter.execute({ value: TOKEN_VALUE, kind: 'token', saveStore: 'fixed-token-store' })).resolves.toEqual({
      outcome: 'succeeded', operationResult: { phase: 'token', outcome: 'completed' },
    });
    await expect(adapter.execute({ value: TOKEN_VALUE, kind: 'token', saveStore: 'fixed-token-store' })).resolves.toBe('failed');
    await expect(adapter.execute({ value: TOKEN_VALUE, kind: 'token', saveStore: 'different-store' })).rejects.toThrow('fixed token outcome is ambiguous');

    expect(saved).toEqual([TOKEN_VALUE]);
    expect(adapter.approvedSaveStore).toBe('fixed-token-store');
  });

  it('posts a fixed MFA payload, snapshots operation metadata, and never permits saving', async () => {
    const received: CapturedRequest[] = [];
    const fixture = await localHttpFixture(async (request, response) => {
      const input = await capture(request);
      received.push(input);
      const payload = JSON.parse(input.body) as Record<string, unknown>;
      response.writeHead(payload.code === MFA_CODE ? 200 : 403).end();
    });
    const requested: URL[] = [];
    const options = mfaOptions(httpsFixtureSeam(fixture.origin, requested));
    const adapter = createFixedHttpMfaAdapter(options);
    options.endpoint = 'https://fixed-target.invalid/changed-after-registration';
    options.username = 'changed-username';
    options.mfaOperationId = 'changed-operation';

    await expect(adapter.execute({ value: MFA_CODE, kind: 'mfa', saveStore: null })).resolves.toEqual({
      outcome: 'succeeded', operationResult: { phase: 'mfa', outcome: 'completed' },
    });
    await expect(adapter.execute({ value: 'wrong-code', kind: 'mfa', saveStore: null })).resolves.toBe('failed');
    await expect(adapter.execute({ value: MFA_CODE, kind: 'mfa', saveStore: 'any-store' })).rejects.toThrow('fixed MFA outcome is ambiguous');
    await expect(adapter.execute({ value: MFA_CODE, kind: 'token', saveStore: null })).rejects.toThrow('fixed MFA outcome is ambiguous');

    expect(adapter).toMatchObject({ kinds: ['mfa'], mfaOperationId: 'fixed-operation-123', approvedSaveStore: null });
    expect(requested.map(String)).toEqual([
      'https://fixed-target.invalid/mfa', 'https://fixed-target.invalid/mfa',
    ]);
    expect(received.map(({ method, path, headers, body }) => ({ method, path, contentType: headers['content-type'], body: JSON.parse(body) }))).toEqual([
      { method: 'POST', path: '/mfa', contentType: 'application/json', body: { username: 'fixed-username', code: MFA_CODE, operationId: 'fixed-operation-123' } },
      { method: 'POST', path: '/mfa', contentType: 'application/json', body: { username: 'fixed-username', code: 'wrong-code', operationId: 'fixed-operation-123' } },
    ]);
  });

  it('uses an operation only when the registered MFA consumer supplies it from Links', async () => {
    const received: CapturedRequest[] = [];
    const fixture = await localHttpFixture(async (request, response) => {
      received.push(await capture(request));
      response.writeHead(204).end();
    });
    const requested: URL[] = [];
    const adapter = createFixedHttpMfaAdapter({
      resourceId: 'fixed-mfa-resource', principal: 'fixed-principal', action: 'confirm_mfa',
      endpoint: 'https://fixed-target.invalid/mfa', username: 'fixed-username', operationMode: 'links_registered',
      fetch: httpsFixtureSeam(fixture.origin, requested),
    } as unknown as Parameters<typeof createFixedHttpMfaAdapter>[0]);

    await expect(adapter.execute({ value: MFA_CODE, kind: 'mfa', saveStore: null, operationId: 'live-source-operation' }))
      .resolves.toEqual({ outcome: 'succeeded', operationResult: { phase: 'mfa', outcome: 'completed' } });
    await expect(adapter.execute({ value: MFA_CODE, kind: 'mfa', saveStore: null }))
      .rejects.toThrow('fixed MFA outcome is ambiguous');

    expect(adapter).toMatchObject({ kinds: ['mfa'], acceptsRegisteredMfa: true, approvedSaveStore: null });
    expect(adapter.mfaOperationId).toBeUndefined();
    expect(requested.map(String)).toEqual(['https://fixed-target.invalid/mfa']);
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual({
      username: 'fixed-username', code: MFA_CODE, operationId: 'live-source-operation',
    });
  });

  it('rejects untrusted endpoints, unregistered store scope, and unknown configuration keys without echoing a value', () => {
    const fetch: FetchLike = async () => new Response(null, { status: 204 });
    const scopedElsewhere = createServiceOwnedCredentialStore({
      name: 'other-store', resourceId: 'fixed-token-resource', principal: 'fixed-principal', action: 'different-action', persist: () => {},
    });
    const reject = (operation: () => unknown) => {
      expect(operation).toThrow(/fixed (token|MFA) adapter is invalid/);
      try { operation(); } catch (error) { expect(String(error)).not.toContain(TOKEN_VALUE); }
    };

    reject(() => createFixedHttpTokenAdapter({ ...tokenOptions(fetch), endpoint: 'https://user:pass@fixed-target.invalid/token' }));
    reject(() => createFixedHttpTokenAdapter({ ...tokenOptions(fetch), endpoint: 'https://fixed-target.invalid/token?destination=other' }));
    reject(() => createFixedHttpTokenAdapter({ ...tokenOptions(fetch), store: scopedElsewhere }));
    reject(() => createFixedHttpMfaAdapter({ ...mfaOptions(fetch), endpoint: 'https://fixed-target.invalid/mfa#fragment' }));
    reject(() => createFixedHttpMfaAdapter({ ...mfaOptions(fetch), unknown: true } as unknown as ReturnType<typeof mfaOptions>));
  });
});
