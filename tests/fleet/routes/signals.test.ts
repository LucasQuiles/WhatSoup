import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

let dir: string;
let db: ReturnType<typeof openIncidentDb>;
let incidentStore: IncidentStore | null;
let producerStore: ProducerStore | null;
let credential: string;

function deps(overrides: Partial<SignalsDeps> = {}): SignalsDeps {
  return {
    getIncidentStore: () => incidentStore,
    getProducerStore: () => producerStore,
    now: () => NOW,
    securityAudit: () => {},
    ...overrides,
  };
}

function mockReq(options: {
  body?: string | Buffer;
  /** Emit each entry as its own 'data' event (e.g. to split a multibyte
   * character across chunk boundaries). Takes precedence over `body`. */
  chunks?: Buffer[];
  headers?: Record<string, string>;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  (req as unknown as { url: string }).url = '/api/signals';
  (req as unknown as { method: string }).method = 'POST';
  (req as unknown as { headers: Record<string, string> }).headers = {
    'content-type': 'application/json',
    ...options.headers,
  };
  process.nextTick(() => {
    const parts = options.chunks ?? (options.body !== undefined ? [options.body] : []);
    const emitNext = (index: number): void => {
      if (index >= parts.length) {
        req.emit('end');
        return;
      }
      req.emit('data', parts[index]!);
      setImmediate(() => emitNext(index + 1));
    };
    emitNext(0);
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
      Object.assign(captured.headers, Object.fromEntries(
        Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ));
      return res;
    },
    end(payload?: string) {
      captured.body = payload === undefined ? undefined : JSON.parse(payload);
      resolveDone(captured);
    },
  } as unknown as ServerResponse;
  return { res, done };
}

async function post(body: string | undefined, headers: Record<string, string> = {}, d = deps()): Promise<CapturedResponse> {
  const handlers = createSignalsHandlers(d);
  const { res, done } = mockRes();
  await handlers.postSignal(mockReq({ body, headers }), res);
  return done;
}

async function postChunks(chunks: Buffer[], headers: Record<string, string> = {}, d = deps()): Promise<CapturedResponse> {
  const handlers = createSignalsHandlers(d);
  const { res, done } = mockRes();
  await handlers.postSignal(mockReq({ chunks, headers }), res);
  return done;
}

function heartbeat(signalId = 'hb-1'): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId,
    kind: 'heartbeat_observed',
    subject: 'host:alpha',
    observedAt: '2026-07-28T11:59:00.000Z',
  });
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${credential}`, ...extra };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-signals-route-'));
  db = openIncidentDb(join(dir, 'incidents.db'));
  incidentStore = new IncidentStore(db);
  producerStore = new ProducerStore(db);
  const reg = producerStore.register(
    {
      producerId: 'prod-alpha',
      producerDomainId: 'dom-selfcheck',
      allowedKinds: ['heartbeat_observed', 'condition_observed'],
      allowedConditionClasses: ['selfcheck_drift'],
      allowedSubjects: ['host:alpha'],
    },
    NOW,
  );
  if (!reg.ok) throw new Error('setup: register failed');
  const ex = producerStore.exchangeEnrollmentSecret('prod-alpha', reg.enrollmentSecret, NOW);
  if (!ex.ok) throw new Error('setup: exchange failed');
  credential = ex.credential;
});

afterEach(() => {
  incidentStore?.close();
  incidentStore = null;
  producerStore = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/signals', () => {
  it('answers 503 when the incident store is unavailable', async () => {
    const out = await post(heartbeat(), authed(), deps({ getIncidentStore: () => null }));
    expect(out.status).toBe(503);
    expect((out.body as { error: { retryable: boolean } }).error.retryable).toBe(true);
  });

  it('rejects content-encoding with 415', async () => {
    const out = await post(heartbeat(), authed({ 'content-encoding': 'gzip' }));
    expect(out.status).toBe(415);
    expect((out.body as { error: { code: string } }).error.code).toBe('unsupported_content_encoding');
  });

  it('rejects non-JSON content types with 415', async () => {
    const out = await post(heartbeat(), authed({ 'content-type': 'text/plain' }));
    expect(out.status).toBe(415);
    expect((out.body as { error: { code: string } }).error.code).toBe('unsupported_media_type');
  });

  it('rejects oversized bodies with 413', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(33 * 1024) });
    const out = await post(big, authed());
    expect(out.status).toBe(413);
    expect((out.body as { error: { code: string } }).error.code).toBe('body_too_large');
  });

  it('requires a bearer credential (401 credential_required)', async () => {
    const out = await post(heartbeat(), {});
    expect(out.status).toBe(401);
    expect((out.body as { error: { code: string } }).error.code).toBe('credential_required');
  });

  it('rejects unknown credentials uniformly (401 credential_invalid)', async () => {
    const out = await post(heartbeat(), { authorization: 'Bearer wrong' });
    expect(out.status).toBe(401);
    expect((out.body as { error: { code: string } }).error.code).toBe('credential_invalid');
  });

  it('maps malformed JSON to 400', async () => {
    const out = await post('{not json', authed());
    expect(out.status).toBe(400);
    expect((out.body as { error: { code: string } }).error.code).toBe('malformed_request');
  });

  it('maps schema violations to 422', async () => {
    const out = await post(JSON.stringify({ nope: true }), authed());
    expect(out.status).toBe(422);
    expect((out.body as { error: { code: string } }).error.code).toBe('invalid_signal');
  });

  it('denies out-of-scope signals with 403 and the scope reason', async () => {
    const outsideSubject = JSON.stringify({
      schemaVersion: 1,
      signalId: 'hb-x',
      kind: 'heartbeat_observed',
      subject: 'host:beta',
      observedAt: '2026-07-28T11:59:00.000Z',
    });
    const out = await post(outsideSubject, authed());
    expect(out.status).toBe(403);
    expect((out.body as { error: { code: string } }).error.code).toBe('subject_not_allowed');
  });

  it('accepts a signal with 201 and a deterministic receiptId', async () => {
    const out = await post(heartbeat(), authed());
    expect(out.status).toBe(201);
    const body = out.body as { receiptId: string; eventId: number; disposition: string };
    expect(body.disposition).toBe('heartbeat_recorded');
    expect(body.receiptId).toBe(`rcpt-${body.eventId}`);
  });

  it('answers exact replays with 200 and the Idempotent-Replay header', async () => {
    const body = heartbeat();
    const first = await post(body, authed());
    const replay = await post(body, authed());
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect((replay.body as { receiptId: string }).receiptId).toBe(
      (first.body as { receiptId: string }).receiptId,
    );
  });

  it('answers identity conflicts with 409', async () => {
    await post(heartbeat('hb-c'), authed());
    const conflicting = JSON.stringify({
      schemaVersion: 1,
      signalId: 'hb-c',
      kind: 'heartbeat_observed',
      subject: 'host:alpha',
      observedAt: '2026-07-28T11:58:00.000Z',
    });
    const out = await post(conflicting, authed());
    expect(out.status).toBe(409);
    expect((out.body as { error: { code: string } }).error.code).toBe('signal_identity_conflict');
  });

  it('rate limits per producer with 429 and Retry-After', async () => {
    const d = deps({ rateLimit: { windowMs: 60_000, maxPerWindow: 2 } });
    const handlers = createSignalsHandlers(d);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { res, done } = mockRes();
      await handlers.postSignal(mockReq({ body: heartbeat(`hb-rl-${i}`), headers: authed() }), res);
      statuses.push((await done).status);
    }
    expect(statuses.slice(0, 2)).toEqual([201, 201]);
    const { res, done } = mockRes();
    await handlers.postSignal(mockReq({ body: heartbeat('hb-rl-3'), headers: authed() }), res);
    const limited = await done;
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(statuses[2]).toBe(429);
  });

  it('maps storage-full failures to 507', async () => {
    const throwing = {
      acceptSignal: () => {
        throw Object.assign(new Error('database or disk is full'), { errcode: 13 });
      },
    } as unknown as IncidentStore;
    const out = await post(heartbeat(), authed(), deps({ getIncidentStore: () => throwing }));
    expect(out.status).toBe(507);
    expect((out.body as { error: { code: string } }).error.code).toBe('durable_storage_unavailable');
  });

  it('maps unexpected store failures to a static 503', async () => {
    const throwing = {
      acceptSignal: () => {
        throw new Error('secret internal detail that must not leak');
      },
    } as unknown as IncidentStore;
    const out = await post(heartbeat(), authed(), deps({ getIncidentStore: () => throwing }));
    expect(out.status).toBe(503);
    const err = (out.body as { error: { code: string; message: string } }).error;
    expect(err.code).toBe('internal_error');
    expect(err.message).not.toContain('secret internal detail');
  });
});

describe('POST /api/signals — media type is closed', () => {
  it('rejects near-JSON media types with 415', async () => {
    for (const mediaType of ['application/json5', 'application/jsonx', 'application/problem+json']) {
      const out = await post(heartbeat('hb-mt'), authed({ 'content-type': mediaType }));
      expect(out.status, mediaType).toBe(415);
      expect((out.body as { error: { code: string } }).error.code, mediaType).toBe('unsupported_media_type');
    }
  });

  it('accepts a mixed-case JSON media type with parameters', async () => {
    const out = await post(heartbeat('hb-mt-ok'), authed({ 'content-type': 'Application/JSON; charset=utf-8' }));
    expect(out.status).toBe(201);
  });
});

describe('POST /api/signals — byte-stable ingestion', () => {
  function euroHeartbeatBytes(): Buffer {
    return Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        signalId: 'hb-euro',
        kind: 'heartbeat_observed',
        subject: 'host:alpha',
        observedAt: '2026-07-28T11:59:00.000Z',
        attributes: { note: '€' },
      }),
      'utf8',
    );
  }

  function splitInsideEuro(bytes: Buffer): Buffer[] {
    const at = bytes.indexOf(0xe2) + 1;
    return [bytes.subarray(0, at), bytes.subarray(at)];
  }

  function eventCount(): number {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number | bigint }).n);
  }

  it('accepts a payload split inside a multibyte code point and hashes the original bytes', async () => {
    const bytes = euroHeartbeatBytes();
    const out = await postChunks(splitInsideEuro(bytes), authed());
    expect(out.status).toBe(201);
    const digest = (out.body as { payloadDigest: string }).payloadDigest;
    expect(digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  });

  it('returns the same digest and receipt on exact byte resend', async () => {
    const bytes = euroHeartbeatBytes();
    const first = await postChunks(splitInsideEuro(bytes), authed());
    const replay = await postChunks([bytes], authed());
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    const firstBody = first.body as { payloadDigest: string; eventId: number };
    const replayBody = replay.body as { payloadDigest: string; eventId: number };
    expect(replayBody.payloadDigest).toBe(firstBody.payloadDigest);
    expect(replayBody.eventId).toBe(firstBody.eventId);
  });

  it('answers 409 for the same identity with different valid bytes', async () => {
    const bytes = euroHeartbeatBytes();
    await postChunks([bytes], authed());
    const changed = Buffer.from(bytes.toString('utf8').replace('€', 'e'), 'utf8');
    const out = await postChunks([changed], authed());
    expect(out.status).toBe(409);
  });

  it('rejects invalid UTF-8 hidden inside an otherwise-valid JSON string with 400 and stores nothing', async () => {
    const bytes = Buffer.concat([
      Buffer.from(
        '{"schemaVersion":1,"signalId":"hb-ff","kind":"heartbeat_observed","subject":"host:alpha","observedAt":"2026-07-28T11:59:00.000Z","attributes":{"note":"',
        'utf8',
      ),
      Buffer.from([0xff]),
      Buffer.from('"}}', 'utf8'),
    ]);
    const out = await postChunks([bytes], authed());
    expect(out.status).toBe(400);
    expect((out.body as { error: { code: string } }).error.code).toBe('malformed_request');
    expect(eventCount()).toBe(0);
  });

  it('rejects a UTF-8 BOM before otherwise-valid JSON with 400 and stores nothing', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), euroHeartbeatBytes()]);
    const out = await postChunks([bytes], authed());
    expect(out.status).toBe(400);
    expect((out.body as { error: { code: string } }).error.code).toBe('malformed_request');
    expect(eventCount()).toBe(0);
  });
});
