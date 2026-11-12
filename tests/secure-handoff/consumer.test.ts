import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFixedHttpLoginAdapter,
  FixedIntakeConsumer,
  type FixedConsumerAdapter,
} from '../../src/secure-handoff/consumer.ts';

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

async function restartLinksFixture(): Promise<{ fetch: typeof globalThis.fetch; consumeRequests: () => number }> {
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
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(consumed()));
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

function fixedAdapter(endpoint: string, fetch: typeof globalThis.fetch): FixedConsumerAdapter {
  return createFixedHttpLoginAdapter({
    resourceId: 'dummy-login',
    principal: 'alice',
    action: 'sign_in',
    endpoint: 'https://fixed-dummy.invalid/login',
    username: 'dummy-user',
    fetch: async (_url, init) => fetch(endpoint, init),
  });
}

describe('fixed intake consumer', () => {
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

  it('does not repeat fixed work after restart when the backend rejects a second consume', async () => {
    const login = await loginFixture();
    const links = await restartLinksFixture();
    const adapter = fixedAdapter(login.endpoint, globalThis.fetch);
    const options = {
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [adapter], fetch: links.fetch,
    };
    const beforeRestart = new FixedIntakeConsumer(options);
    const afterRestart = new FixedIntakeConsumer(options);

    await expect(beforeRestart.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    await expect(afterRestart.execute({ intakeId: INTAKE_ID, resourceId: 'dummy-login' })).resolves.toEqual({ id: INTAKE_ID, state: 'ambiguous' });
    expect(links.consumeRequests()).toBe(2);
    expect(login.accepted).toEqual([{ username: 'dummy-user', password: SECRET }]);
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

  it('does not expose its consumer bearer through ordinary object inspection', () => {
    const consumer = new FixedIntakeConsumer({
      baseUrl: 'https://links.example.test/s/api/v1', token: 'consumer-only-token', adapters: [],
    });

    expect(Object.prototype.hasOwnProperty.call(consumer, 'token')).toBe(false);
    expect(JSON.stringify(consumer)).not.toContain('consumer-only-token');
  });
});
