import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFixedHttpLoginAdapter,
  FixedIntakeConsumer,
  type FixedConsumerAdapter,
} from '../../src/secure-handoff/consumer.ts';
import {
  createFixedHttpCredentialStore,
  createServiceOwnedCredentialStore,
  type ServiceOwnedCredentialStore,
} from '../../src/secure-handoff/credential-store.ts';

const INTAKE_ID = 'I'.repeat(22);
const RECEIPT = 'R'.repeat(43);
const SECRET = 'dummy-password-that-must-not-leave-the-consumer';

type FetchCall = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function consumed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INTAKE_ID,
    resourceId: 'dummy-login',
    principal: 'alice',
    kind: 'password',
    action: 'sign_in',
    operationId: null,
    value: SECRET,
    save: false,
    receipt: RECEIPT,
    ...overrides,
  };
}

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

async function loginFixture(): Promise<{ endpoint: string; accepted: Array<Record<string, unknown>> }> {
  const accepted: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const value = JSON.parse(body) as Record<string, unknown>;
      if (request.method !== 'POST' || request.url !== '/login' || value.username !== 'dummy-user' || value.password !== SECRET) {
        response.writeHead(401).end(JSON.stringify({ accepted: false }));
        return;
      }
      accepted.push(value);
      response.writeHead(204).end();
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP');
  return { endpoint: `http://127.0.0.1:${address.port}/login`, accepted };
}

async function credentialStoreFixture(): Promise<{ endpoint: string; values: string[]; authorization: string | undefined }> {
  const values: string[] = [];
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body) as Record<string, unknown>;
      authorization = request.headers.authorization;
      if (request.method !== 'POST' || request.url !== '/credential' || typeof payload.value !== 'string') {
        response.writeHead(400).end(JSON.stringify({ stored: false }));
        return;
      }
      values.push(payload.value);
      response.writeHead(204).end();
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP');
  return {
    endpoint: `http://127.0.0.1:${address.port}/credential`,
    values,
    get authorization() { return authorization; },
  };
}

async function restartLinksFixture(save = false): Promise<{ fetch: typeof globalThis.fetch; consumeRequests: () => number }> {
  let state: 'awaiting_input' | 'consuming' | 'ambiguous' = 'awaiting_input';
  let consumes = 0;
  let ambiguousAttempts = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (request.method !== 'POST' || body !== '{}') {
        response.writeHead(400).end(JSON.stringify({ error: 'invalid' }));
        return;
      }
      if (request.url === `/s/api/v1/intakes/${INTAKE_ID}/consume`) {
        consumes++;
        if (state !== 'awaiting_input') {
          response.writeHead(409).end(JSON.stringify({ error: 'consuming' }));
          return;
        }
        state = 'consuming';
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(consumed({ save })));
        return;
      }
      if (request.url === `/s/api/v1/intakes/${INTAKE_ID}/ambiguous`) {
        ambiguousAttempts++;
        if (ambiguousAttempts === 1) {
          response.writeHead(503).end(JSON.stringify({ error: 'unavailable' }));
          return;
        }
        state = 'ambiguous';
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: INTAKE_ID, state }));
        return;
      }
      if (request.url === `/s/api/v1/intakes/${INTAKE_ID}/complete`) {
        response.writeHead(503).end(JSON.stringify({ error: 'unavailable' }));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind TCP');
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    fetch: async (url, init) => fetch(`${endpoint}${new URL(String(url)).pathname}`, init),
    consumeRequests: () => consumes,
  };
}

function fixedAdapter(
  endpoint: string,
  fetch: typeof globalThis.fetch,
  store?: ServiceOwnedCredentialStore,
): FixedConsumerAdapter {
  return createFixedHttpLoginAdapter({
    resourceId: 'dummy-login',
    principal: 'alice',
    action: 'sign_in',
    endpoint: 'https://fixed-dummy.invalid/login',
    username: 'dummy-user',
    fetch: async (_url, init) => fetch(endpoint, init),
    ...(store === undefined ? {} : { store }),
  });
}

function registeredPasswordStore(persist: (value: string) => Promise<void> | void): ServiceOwnedCredentialStore {
  return createServiceOwnedCredentialStore({
    name: 'dummy-password-store',
    resourceId: 'dummy-login',
    principal: 'alice',
    action: 'sign_in',
    persist,
  });
}

describe('fixed intake consumer', () => {
  it('bounds settled operations while the remote consume fence prevents replay after eviction', async () => {
    const consumedIds = new Set<string>();
    let consumeRequests = 0;
    let actions = 0;
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token',
      adapters: [{ resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'],
        approvedSaveStore: null, async execute() { actions++; return 'succeeded'; } }],
      fetch: async (url) => {
        const parts = new URL(String(url)).pathname.split('/');
        const id = parts.at(-2)!;
        if (parts.at(-1) === 'consume') {
          consumeRequests++;
          if (consumedIds.has(id)) return json({ error: 'already_consumed' }, 409);
          consumedIds.add(id);
          return json(consumed({ id }));
        }
        return json({ id, state: parts.at(-1) === 'complete' ? 'succeeded' : 'ambiguous' });
      },
    });
    for (let index = 0; index < 1_001; index++) {
      const id = String(index).padStart(22, 'I');
      await expect(consumer.execute({ intakeId: id, resourceId: 'dummy-login' }))
        .resolves.toEqual({ id, state: 'succeeded' });
    }
    const firstId = '0'.padStart(22, 'I');
    await expect(consumer.execute({ intakeId: firstId, resourceId: 'dummy-login' }))
      .resolves.toEqual({ id: firstId, state: 'ambiguous' });
    expect(consumeRequests).toBe(1_002);
    expect(actions).toBe(1_001);
  });

  it('rejects excess concurrent operations without evicting an active operation', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let consumeRequests = 0;
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token',
      adapters: [{ resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'],
        approvedSaveStore: null, async execute() { return 'succeeded'; } }],
      fetch: async (url) => {
        const parts = new URL(String(url)).pathname.split('/');
        const id = parts.at(-2)!;
        if (parts.at(-1) === 'consume') {
          consumeRequests++;
          await pending;
          return json(consumed({ id }));
        }
        return json({ id, state: 'succeeded' });
      },
    });
    const operations = Array.from({ length: 1_000 }, (_, index) =>
      consumer.execute({ intakeId: String(index).padStart(22, 'I'), resourceId: 'dummy-login' }));
    try {
      const excess = consumer.execute({ intakeId: 'X'.repeat(22), resourceId: 'dummy-login' });
      let admissionError: unknown;
      void excess.catch((error: unknown) => { admissionError = error; });
      await Promise.resolve();
      expect(admissionError).toEqual(new Error('consumer capacity is unavailable'));
      expect(consumer.execute({ intakeId: '0'.padStart(22, 'I'), resourceId: 'dummy-login' })).toBe(operations[0]);
      expect(consumeRequests).toBe(1_000);
    } finally {
      release();
      await Promise.all(operations);
    }
  });

  it('retains the registered adapter binding and operation after caller mutation', async () => {
    let originalCalls = 0;
    let replacementCalls = 0;
    const kinds: Array<'password' | 'mfa'> = ['password'];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds, approvedSaveStore: null,
      async execute() {
        expect(this.principal).toBe('alice');
        originalCalls++;
        return 'succeeded';
      },
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => String(url).endsWith('/consume')
        ? json(consumed()) : json({ id: INTAKE_ID, state: 'succeeded' }),
    });
    adapter.execute = async () => { replacementCalls++; return 'succeeded'; };
    Object.assign(adapter, { principal: 'mallory', resourceId: 'redirected', action: 'other' });
    kinds.splice(0, 1, 'mfa');

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' }))
      .resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  });

  it('reconciles a consuming intake without retrieving or replaying its value', async () => {
    const calls: string[] = [];
    const fixture = await loginFixture();
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token',
      adapters: [fixedAdapter(fixture.endpoint, globalThis.fetch)],
      fetch: async (url) => {
        calls.push(String(url));
        return json({ id: INTAKE_ID, state: 'ambiguous', value: SECRET });
      },
    });
    const request = { intakeId: INTAKE_ID, resourceId: 'dummy-login' };

    await expect(consumer.reconcileAmbiguous(request)).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    await expect(consumer.execute(request)).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    await expect(consumer.reconcileAmbiguous({ ...request, resourceId: 'other-resource' })).rejects.toThrow('consumer request is invalid');

    expect(calls).toEqual([`https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/ambiguous`]);
    expect(fixture.accepted).toEqual([]);
  });

  it('does not interrupt an active fixed action when reconciliation is requested', async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const calls: string[] = [];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      async execute() { await pending; return 'succeeded'; },
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        calls.push(String(url));
        return String(url).endsWith('/consume') ? json(consumed()) : json({ id: INTAKE_ID, state: 'succeeded' });
      },
    });
    const request = { intakeId: INTAKE_ID, resourceId: 'dummy-login' };
    const executing = consumer.execute(request);
    const reconciling = consumer.reconcileAmbiguous(request);
    finish!();

    await expect(executing).resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });
    await expect(reconciling).resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });
    expect(calls).toEqual([
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/consume`,
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/complete`,
    ]);
  });

  it('uses a consumed credential only in the registered HTTP login and returns content-free completion', async () => {
    const fixture = await loginFixture();
    const calls: FetchCall[] = [];
    const adapter = fixedAdapter(fixture.endpoint, globalThis.fetch);
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1',
      token: 'consumer-only-token',
      adapters: [adapter],
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        if (String(url).endsWith('/consume')) return json(consumed());
        if (String(url).endsWith('/complete')) return json({ id: INTAKE_ID, state: 'succeeded' });
        throw new Error('unexpected Links route');
      },
    });

    const outcome = await consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' });

    expect(outcome).toEqual({ id: INTAKE_ID, state: 'succeeded' });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(fixture.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
    expect(calls.map((call) => call.url)).toEqual([
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/consume`,
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/complete`,
    ]);
    expect(String(calls[0].init.body)).toBe('{}');
    expect(new Headers(calls[0].init.headers).get('Content-Type')).toBe('application/json');
    expect(String(calls[1].init.body)).toBe(JSON.stringify({ receipt: RECEIPT, outcome: 'succeeded' }));
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer consumer-only-token');
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('does not run a fixed operation when the consumed binding or save consent is invalid', async () => {
    const invoked: string[] = [];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      execute: async () => { invoked.push('called'); return 'succeeded'; },
    };
    const calls: string[] = [];
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/consume')) return json(consumed({ resourceId: 'other-resource', save: true }));
        if (String(url).endsWith('/ambiguous')) return json({ id: INTAKE_ID, state: 'ambiguous' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(invoked).toEqual([]);
    expect(calls).toEqual([
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/consume`,
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/ambiguous`,
    ]);
  });

  it('reconciles a malformed or unauthorized-save consume result without invoking an adapter', async () => {
    const invoked: string[] = [];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      execute: async () => { invoked.push('called'); return 'succeeded'; },
    };
    const calls: string[] = [];
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/consume')) return json({ malformed: true });
        if (String(url).endsWith('/ambiguous')) return json({ id: INTAKE_ID, state: 'ambiguous' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(invoked).toEqual([]);
    expect(calls).toEqual([
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/consume`,
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/ambiguous`,
    ]);
  });

  it('never persists a password when the registered adapter has no approved store', async () => {
    const invoked: string[] = [];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      execute: async () => { invoked.push('called'); return 'succeeded'; },
    };
    const calls: string[] = [];
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/consume')) return json(consumed({ save: true }));
        if (String(url).endsWith('/ambiguous')) return json({ id: INTAKE_ID, state: 'ambiguous' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(invoked).toEqual([]);
    expect(calls).toEqual([
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/consume`,
      `https://links.example.test/s/api/v1/intakes/${INTAKE_ID}/ambiguous`,
    ]);
  });

  it('passes a save store to a registered generic adapter only with Links consent', async () => {
    const inputs: Array<{ value: string; kind: string; saveStore: string | null }> = [];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: 'registered-store',
      execute: async (input) => { inputs.push(input); return 'succeeded'; },
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) return json(consumed({ save: true }));
        if (String(url).endsWith('/complete')) return json({ id: INTAKE_ID, state: 'succeeded' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });
    expect(inputs).toEqual([{ value: SECRET, kind: 'password', saveStore: 'registered-store' }]);
  });

  it('preserves an adapter timeout as ambiguous and never re-consumes on retry', async () => {
    let consumeCalls = 0;
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      execute: async () => { throw new Error('dummy timeout'); },
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) { consumeCalls++; return json(consumed()); }
        if (String(url).endsWith('/ambiguous')) return json({ id: INTAKE_ID, state: 'ambiguous' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(consumeCalls).toBe(1);
  });

  it('does not replay a failed store write after restart when the backend rejects a second consume', async () => {
    const login = await loginFixture();
    const links = await restartLinksFixture(true);
    let storeAttempts = 0;
    const adapter = fixedAdapter(login.endpoint, globalThis.fetch, registeredPasswordStore(() => {
      storeAttempts++;
      throw new Error('fixture store is unavailable');
    }));
    const options = {
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter], fetch: links.fetch,
    };
    const beforeRestart = new FixedIntakeConsumer(options);
    const afterRestart = new FixedIntakeConsumer(options);

    await expect(beforeRestart.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    await expect(afterRestart.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(links.consumeRequests()).toBe(2);
    expect(login.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
    expect(storeAttempts).toBe(1);
  });

  it('reconciles a lost consume response as ambiguous and never sends a second consume request', async () => {
    let consumeCalls = 0;
    let ambiguousBody: BodyInit | null | undefined;
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      execute: async () => 'succeeded',
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url, init) => {
        if (String(url).endsWith('/consume')) { consumeCalls++; throw new Error('response lost'); }
        if (String(url).endsWith('/ambiguous')) {
          ambiguousBody = init?.body;
          return json({ id: INTAKE_ID, state: 'ambiguous' });
        }
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(consumeCalls).toBe(1);
    expect(String(ambiguousBody)).toBe('{}');
  });

  it('rejects an unknown resource before calling Links', async () => {
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [],
      fetch: async () => { throw new Error('Links must not be called'); },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'unregistered' })).rejects.toThrow('consumer request is invalid');
  });

  it('rejects an extra caller-selected destination field without calling Links', async () => {
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      execute: async () => 'succeeded',
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async () => { throw new Error('Links must not be called'); },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login', url: 'https://attacker.invalid' }))
      .rejects.toThrow('consumer request is invalid');
  });

  it('does not permit one intake ID to be re-used with a second registered resource', async () => {
    const first: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      execute: async () => 'succeeded',
    };
    const second: FixedConsumerAdapter = {
      resourceId: 'other-login', principal: 'alice', action: 'sign_in', kinds: ['password'], approvedSaveStore: null,
      execute: async () => 'succeeded',
    };
    const calls: string[] = [];
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [first, second],
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/consume')) return json(consumed());
        if (String(url).endsWith('/complete')) return json({ id: INTAKE_ID, state: 'succeeded' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });
    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'other-login' })).rejects.toThrow('consumer request is invalid');
    expect(calls.filter((url) => url.endsWith('/consume'))).toHaveLength(1);
  });

  it('uses MFA only when Links supplies the registered challenge job and never supplies a save store', async () => {
    const challengeId = 'fixture-login-step-1';
    const inputs: Array<{ value: string; kind: string; saveStore: string | null }> = [];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['mfa'], mfaOperationId: challengeId,
      approvedSaveStore: 'registered-store',
      execute: async (input) => { inputs.push(input); return 'succeeded'; },
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) return json(consumed({ kind: 'mfa', operationId: challengeId }));
        if (String(url).endsWith('/complete')) return json({ id: INTAKE_ID, state: 'succeeded' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });
    expect(inputs).toEqual([{ value: SECRET, kind: 'mfa', saveStore: null }]);
  });

  it('marks MFA save consent ambiguous even when the registered challenge job matches', async () => {
    const challengeId = 'fixture-login-step-1';
    const invoked: string[] = [];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['mfa'], mfaOperationId: challengeId,
      approvedSaveStore: 'registered-store',
      execute: async () => { invoked.push('called'); return 'succeeded'; },
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) return json(consumed({ kind: 'mfa', operationId: challengeId, save: true }));
        if (String(url).endsWith('/ambiguous')) return json({ id: INTAKE_ID, state: 'ambiguous' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(invoked).toEqual([]);
  });

  it('rejects an MFA operation ID containing a control character before invoking work', async () => {
    const invoked: string[] = [];
    const adapter: FixedConsumerAdapter = {
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in', kinds: ['mfa'], mfaOperationId: 'fixture-login-step-1',
      approvedSaveStore: null,
      execute: async () => { invoked.push('called'); return 'succeeded'; },
    };
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) return json(consumed({ kind: 'mfa', operationId: 'fixture-login-step-1\n' }));
        if (String(url).endsWith('/ambiguous')) return json({ id: INTAKE_ID, state: 'ambiguous' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(invoked).toEqual([]);
  });

  it('rejects consumer and login endpoints with embedded credentials', () => {
    expect(() => new FixedIntakeConsumer({
      baseUrl: 'https://user:password@links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [],
    })).toThrow('fixed consumer configuration is invalid');
    expect(() => createFixedHttpLoginAdapter({
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in',
      endpoint: 'https://user:password@fixed-dummy.invalid/login', username: 'dummy-user',
    })).toThrow('fixed HTTP login adapter is invalid');
  });

  it('only registers password login and rejects an unsupported save configuration', () => {
    const adapter = createFixedHttpLoginAdapter({
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in',
      endpoint: 'https://fixed-dummy.invalid/login', username: 'dummy-user',
    });
    expect(adapter.kinds).toEqual(['password']);
    expect(adapter.approvedSaveStore).toBeNull();
    expect(() => createFixedHttpLoginAdapter({
      resourceId: 'dummy-login', principal: 'alice', action: 'sign_in',
      endpoint: 'https://fixed-dummy.invalid/login', username: 'dummy-user', approvedSaveStore: 'unsupported-store',
    } as unknown as Parameters<typeof createFixedHttpLoginAdapter>[0])).toThrow('fixed HTTP login adapter is invalid');
  });

  it('persists the exact password only after a successful fixed login with Links save consent', async () => {
    const fixture = await loginFixture();
    const writes: string[] = [];
    const adapter = fixedAdapter(fixture.endpoint, globalThis.fetch, registeredPasswordStore(async (value) => {
      expect(fixture.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
      writes.push(value);
    }));
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) return json(consumed({ save: true }));
        if (String(url).endsWith('/complete')) return json({ id: INTAKE_ID, state: 'succeeded' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' }))
      .resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });

    expect(writes).toEqual([SECRET]);
  });

  it('writes a consented password to the configured fixed HTTPS store after its fixed login', async () => {
    const login = await loginFixture();
    const credentialStore = await credentialStoreFixture();
    const store = createFixedHttpCredentialStore({
      name: 'dummy-password-store',
      resourceId: 'dummy-login',
      principal: 'alice',
      action: 'sign_in',
      endpoint: 'https://credential-store.invalid/credential',
      authorization: 'store-service-token',
      fetch: async (_url, init) => fetch(credentialStore.endpoint, init),
    });
    const adapter = fixedAdapter(login.endpoint, globalThis.fetch, store);
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) return json(consumed({ save: true }));
        if (String(url).endsWith('/complete')) return json({ id: INTAKE_ID, state: 'succeeded' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' }))
      .resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });

    expect(login.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
    expect(credentialStore.values).toEqual([SECRET]);
    expect(credentialStore.authorization).toBe('Bearer store-service-token');
  });

  it('preserves a credential value exactly when its registered store persists it', async () => {
    const writes: string[] = [];
    const store = registeredPasswordStore((value) => { writes.push(value); });
    const value = '  exact opaque value  ';

    await store.save(value);

    expect(writes).toEqual([value]);
  });

  it('snapshots the fixed writer and login account at registration', async () => {
    const fixture = await loginFixture();
    const firstWrites: string[] = [];
    const redirectedWrites: string[] = [];
    const storeOptions = {
      name: 'dummy-password-store',
      resourceId: 'dummy-login',
      principal: 'alice',
      action: 'sign_in',
      persist: (value: string) => { firstWrites.push(value); },
    };
    const store = createServiceOwnedCredentialStore(storeOptions);
    storeOptions.persist = (value) => { redirectedWrites.push(value); };
    const adapterOptions = {
      resourceId: 'dummy-login',
      principal: 'alice',
      action: 'sign_in',
      endpoint: 'https://fixed-dummy.invalid/login',
      username: 'dummy-user',
      store,
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => fetch(fixture.endpoint, init),
    };
    const adapter = createFixedHttpLoginAdapter(adapterOptions);
    adapterOptions.username = 'redirected-user';

    await expect(adapter.execute({ value: SECRET, kind: 'password', saveStore: 'dummy-password-store' }))
      .resolves.toBe('succeeded');

    expect(fixture.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
    expect(firstWrites).toEqual([SECRET]);
    expect(redirectedWrites).toEqual([]);
  });

  it('does not persist when Links omitted save consent or the fixed login failed', async () => {
    const fixture = await loginFixture();
    const writes: string[] = [];
    const adapter = fixedAdapter(fixture.endpoint, globalThis.fetch, registeredPasswordStore((value) => { writes.push(value); }));
    const noConsent = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) return json(consumed());
        if (String(url).endsWith('/complete')) return json({ id: INTAKE_ID, state: 'succeeded' });
        throw new Error('unexpected Links route');
      },
    });
    const failedLogin = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) return json(consumed({ value: 'wrong-password', save: true }));
        if (String(url).endsWith('/complete')) return json({ id: INTAKE_ID, state: 'failed' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(noConsent.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' }))
      .resolves.toEqual({ id: INTAKE_ID, state: 'succeeded' });
    await expect(failedLogin.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' }))
      .resolves.toEqual({ id: INTAKE_ID, state: 'failed' });

    expect(writes).toEqual([]);
    expect(fixture.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
  });

  it('denies unregistered stores and MFA before the fixed password login can run', async () => {
    const fixture = await loginFixture();
    const writes: string[] = [];
    const adapter = fixedAdapter(fixture.endpoint, globalThis.fetch, registeredPasswordStore((value) => { writes.push(value); }));

    await expect(adapter.execute({ value: SECRET, kind: 'password', saveStore: 'other-store' })).rejects.toThrow('fixed login outcome is ambiguous');
    await expect(adapter.execute({ value: SECRET, kind: 'mfa', saveStore: 'dummy-password-store' })).rejects.toThrow('fixed login outcome is ambiguous');

    expect(fixture.accepted).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('marks a store failure ambiguous and does not replay the login or store write', async () => {
    const fixture = await loginFixture();
    let storeAttempts = 0;
    let consumeAttempts = 0;
    const adapter = fixedAdapter(fixture.endpoint, globalThis.fetch, registeredPasswordStore(() => {
      storeAttempts++;
      throw new Error('fixture store is unavailable');
    }));
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter],
      fetch: async (url) => {
        if (String(url).endsWith('/consume')) { consumeAttempts++; return json(consumed({ save: true })); }
        if (String(url).endsWith('/ambiguous')) return json({ id: INTAKE_ID, state: 'ambiguous' });
        throw new Error('unexpected Links route');
      },
    });

    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' }))
      .resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    await expect(consumer.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' }))
      .resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });

    expect(fixture.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
    expect(storeAttempts).toBe(1);
    expect(consumeAttempts).toBe(1);
  });

  it('does not expose its consumer bearer through ordinary object inspection', () => {
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [],
    });

    expect(Object.prototype.hasOwnProperty.call(consumer, 'token')).toBe(false);
    expect(JSON.stringify(consumer)).not.toContain('consumer-only-token');
  });
});
