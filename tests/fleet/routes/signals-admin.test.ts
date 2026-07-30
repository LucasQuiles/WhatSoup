import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb } from '../../../src/fleet/incidents/db.ts';
import { IncidentStore } from '../../../src/fleet/incidents/store.ts';
import { ProducerStore } from '../../../src/fleet/incidents/producers.ts';
import { createSignalsHandlers, type SignalsDeps } from '../../../src/fleet/routes/signals.ts';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const ROOT = 'root-token-fixture';

let dir: string;
let incidentStore: IncidentStore | null;
let producerStore: ProducerStore | null;

function deps(overrides: Partial<SignalsDeps> = {}): SignalsDeps {
  return {
    getIncidentStore: () => incidentStore,
    getProducerStore: () => producerStore,
    now: () => NOW,
    verifyRootToken: (req: IncomingMessage) => req.headers['authorization'] === `Bearer ${ROOT}`,
    securityAudit: () => {},
    ...overrides,
  };
}

function mockReq(options: { body?: string; headers?: Record<string, string> }): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  (req as unknown as { url: string }).url = '/api/producers';
  (req as unknown as { method: string }).method = 'POST';
  (req as unknown as { headers: Record<string, string> }).headers = {
    'content-type': 'application/json',
    ...options.headers,
  };
  process.nextTick(() => {
    if (options.body !== undefined) req.emit('data', options.body);
    req.emit('end');
  });
  return req;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function mockRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: undefined };
  let resolveDone: (value: CapturedResponse) => void;
  const done = new Promise<CapturedResponse>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      return res;
    },
    end(payload?: string) {
      captured.body = payload === undefined || payload === '' ? undefined : JSON.parse(payload);
      resolveDone(captured);
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function registrationBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    producerId: 'prod-alpha',
    producerDomainId: 'dom-selfcheck',
    allowedKinds: ['heartbeat_observed'],
    allowedConditionClasses: [],
    allowedSubjects: ['host:alpha'],
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-signals-admin-'));
  const db = openIncidentDb(join(dir, 'incidents.db'));
  incidentStore = new IncidentStore(db);
  producerStore = new ProducerStore(db);
});

afterEach(() => {
  incidentStore?.close();
  incidentStore = null;
  producerStore = null;
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  handler: 'postProducer' | 'postProducerCredential' | 'deleteProducerCredential',
  options: { body?: string; headers?: Record<string, string>; producerId?: string },
  d: SignalsDeps = deps(),
): Promise<CapturedResponse> {
  const handlers = createSignalsHandlers(d);
  const { res, done } = mockRes();
  const req = mockReq({ body: options.body, headers: options.headers });
  if (handler === 'postProducer') await handlers.postProducer(req, res);
  else if (handler === 'postProducerCredential') {
    await handlers.postProducerCredential(req, res, { id: options.producerId ?? 'prod-alpha' });
  } else {
    await handlers.deleteProducerCredential(req, res, { id: options.producerId ?? 'prod-alpha' });
  }
  return done;
}

describe('producer admin routes', () => {
  it('postProducer requires the root token', async () => {
    const out = await call('postProducer', { body: registrationBody(), headers: {} });
    expect(out.status).toBe(401);
    const withProducerCred = await call('postProducer', {
      body: registrationBody(),
      headers: { authorization: 'Bearer not-root' },
    });
    expect(withProducerCred.status).toBe(401);
  });

  it('registers a producer and returns the enrollment secret exactly once', async () => {
    const out = await call('postProducer', {
      body: registrationBody(),
      headers: { authorization: `Bearer ${ROOT}` },
    });
    expect(out.status).toBe(201);
    const body = out.body as { producerId: string; enrollmentSecret: string; enrollmentSecretExpiresAt: string };
    expect(body.producerId).toBe('prod-alpha');
    expect(body.enrollmentSecret.length).toBeGreaterThan(20);
    expect(Date.parse(body.enrollmentSecretExpiresAt)).toBeGreaterThan(NOW.getTime());
  });

  it('rejects duplicate registration with 409', async () => {
    await call('postProducer', { body: registrationBody(), headers: { authorization: `Bearer ${ROOT}` } });
    const dup = await call('postProducer', {
      body: registrationBody(),
      headers: { authorization: `Bearer ${ROOT}` },
    });
    expect(dup.status).toBe(409);
    expect((dup.body as { error: { code: string } }).error.code).toBe('producer_exists');
  });

  it('rejects invalid registration input with 422', async () => {
    const out = await call('postProducer', {
      body: registrationBody({ allowedKinds: ['not_a_kind'] }),
      headers: { authorization: `Bearer ${ROOT}` },
    });
    expect(out.status).toBe(422);
  });

  it('exchanges the enrollment secret for a credential that authenticates against postSignal', async () => {
    const reg = await call('postProducer', {
      body: registrationBody(),
      headers: { authorization: `Bearer ${ROOT}` },
    });
    const { enrollmentSecret } = reg.body as { enrollmentSecret: string };

    const ex = await call('postProducerCredential', {
      body: JSON.stringify({ enrollmentSecret }),
      headers: {},
    });
    expect(ex.status).toBe(201);
    const { credential } = ex.body as { credential: string };
    expect(credential.length).toBeGreaterThan(20);

    const handlers = createSignalsHandlers(deps());
    const { res, done } = mockRes();
    await handlers.postSignal(
      mockReq({
        body: JSON.stringify({
          schemaVersion: 1,
          signalId: 'hb-1',
          kind: 'heartbeat_observed',
          subject: 'host:alpha',
          observedAt: '2026-07-28T11:59:00.000Z',
        }),
        headers: { authorization: `Bearer ${credential}` },
      }),
      res,
    );
    expect((await done).status).toBe(201);

    const replayExchange = await call('postProducerCredential', {
      body: JSON.stringify({ enrollmentSecret }),
      headers: {},
    });
    expect(replayExchange.status).toBe(401);
  });

  it('rotates under the current credential and revocation kills access', async () => {
    const reg = await call('postProducer', {
      body: registrationBody(),
      headers: { authorization: `Bearer ${ROOT}` },
    });
    const { enrollmentSecret } = reg.body as { enrollmentSecret: string };
    const ex = await call('postProducerCredential', { body: JSON.stringify({ enrollmentSecret }), headers: {} });
    const { credential } = ex.body as { credential: string };

    const rotated = await call('postProducerCredential', {
      body: JSON.stringify({}),
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(rotated.status).toBe(201);
    const { credential: next } = rotated.body as { credential: string };
    expect(next).not.toBe(credential);

    const revoked = await call('deleteProducerCredential', {
      headers: { authorization: `Bearer ${ROOT}` },
    });
    expect(revoked.status).toBe(204);
    expect(producerStore?.authenticate(next, NOW)).toBeNull();
    expect(producerStore?.authenticate(credential, NOW)).toBeNull();
  });

  it('deleteProducerCredential requires root and is idempotent', async () => {
    const unauthorized = await call('deleteProducerCredential', { headers: {} });
    expect(unauthorized.status).toBe(401);
    const first = await call('deleteProducerCredential', { headers: { authorization: `Bearer ${ROOT}` } });
    expect(first.status).toBe(204);
    const again = await call('deleteProducerCredential', { headers: { authorization: `Bearer ${ROOT}` } });
    expect(again.status).toBe(204);
  });

  it('emits bounded security audit events for register, failed enrollment, and revoke', async () => {
    const events: Array<Record<string, unknown>> = [];
    const audited = deps({
      securityAudit: (event) => events.push(event as unknown as Record<string, unknown>),
    });

    const reg = await call('postProducer', {
      body: registrationBody(),
      headers: { authorization: `Bearer ${ROOT}` },
    }, audited);
    const { enrollmentSecret } = reg.body as { enrollmentSecret: string };
    expect(events).toContainEqual({ type: 'producer_registered', producerId: 'prod-alpha' });

    const rejected = await call('postProducerCredential', {
      body: JSON.stringify({ enrollmentSecret: 'wrong-secret' }),
      headers: {},
    }, audited);
    expect(rejected.status).toBe(401);
    expect(events).toContainEqual({
      type: 'enrollment_rejected',
      producerId: 'prod-alpha',
      reason: 'secret_mismatch',
    });

    const revoked = await call('deleteProducerCredential', {
      headers: { authorization: `Bearer ${ROOT}` },
    }, audited);
    expect(revoked.status).toBe(204);
    expect(events).toContainEqual({ type: 'producer_revoked', producerId: 'prod-alpha' });

    // No secret material ever enters the audit stream.
    expect(JSON.stringify(events)).not.toContain(enrollmentSecret);
  });

  it('keeps external enrollment failures uniform across internal audit reasons', async () => {
    const events: Array<Record<string, unknown>> = [];
    const audited = deps({
      securityAudit: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    await call('postProducer', {
      body: registrationBody(),
      headers: { authorization: `Bearer ${ROOT}` },
    }, audited);

    const mismatch = await call('postProducerCredential', {
      body: JSON.stringify({ enrollmentSecret: 'wrong-secret' }),
      headers: {},
    }, audited);
    const unknownProducer = await call('postProducerCredential', {
      body: JSON.stringify({ enrollmentSecret: 'wrong-secret' }),
      headers: {},
      producerId: 'prod-ghost',
    }, audited);

    expect(mismatch.status).toBe(401);
    expect(unknownProducer.status).toBe(401);
    expect(unknownProducer.body).toEqual(mismatch.body);

    const reasons = events
      .filter((event) => event.type === 'enrollment_rejected')
      .map((event) => event.reason)
      .sort();
    expect(reasons).toEqual(['no_active_enrollment', 'secret_mismatch']);
  });
});
