import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';
import { MAX_SILENCE_MINUTES } from '../../../src/fleet/routes/silence.ts';

// Built from the exported bound so the two can never drift. The bound's own
// VALUE is pinned separately below — otherwise a mutation that changed the cap
// would silently move this expectation with it and prove nothing.
const DURATION_ERROR =
  `duration_minutes must be a positive number of minutes no greater than ${MAX_SILENCE_MINUTES}`;

let homeDir: string;

function configDir(): string {
  return join(homeDir, '.config', 'whatsoup');
}

function silencesFile(): string {
  return join(configDir(), 'fleet-silences.json');
}

function writeSilences(rules: unknown[]): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(silencesFile(), JSON.stringify(rules, null, 2) + '\n');
}

function streamErrorReq(message: string): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  stream.headers = {};
  stream.method = 'POST';
  stream.url = '/api/fleet/silence';
  process.nextTick(() => {
    stream.emit('error', new Error(message));
  });
  return stream;
}

async function importRoutes(): Promise<typeof import('../../../src/fleet/routes/silence.ts')> {
  return import('../../../src/fleet/routes/silence.ts');
}

describe('fleet silence routes', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'whatsoup-silence-route-'));
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal: () => Promise<typeof import('node:os')>) => {
      const actual = await importOriginal();
      return { ...actual, homedir: () => homeDir };
    });
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('lists active silences and filters expired rules', async () => {
    const activeUntil = new Date(Date.now() + 60_000).toISOString();
    const expiredUntil = new Date(Date.now() - 60_000).toISOString();
    writeSilences([
      {
        instance: 'q',
        until: activeUntil,
        reason: 'maintenance',
        silencedBy: 'operator',
        createdAt: '2026-06-14T00:00:00.000Z',
      },
      {
        instance: 'old',
        until: expiredUntil,
        reason: 'stale',
        silencedBy: 'operator',
        createdAt: '2026-06-13T00:00:00.000Z',
      },
    ]);

    const { handleGetSilences } = await importRoutes();
    const res = mockRes();

    await handleGetSilences(mockReq({ method: 'GET', url: '/api/fleet/silences' }), res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(res._body)).toEqual({
      silences: [
        {
          instance: 'q',
          until: activeUntil,
          reason: 'maintenance',
          silencedBy: 'operator',
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ],
    });
  });

  it('adds a silence with a default reason and persists restrictive file permissions', async () => {
    const { handleAddSilence } = await importRoutes();
    const res = mockRes();

    await handleAddSilence(
      mockReq({
        method: 'POST',
        url: '/api/fleet/silence',
        body: JSON.stringify({ instance: 'q', duration_minutes: 15 }),
      }),
      res,
    );

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(res._body);
    expect(body).toMatchObject({
      ok: true,
      rule: {
        instance: 'q',
        reason: 'manual silence',
        silencedBy: 'fleet-api',
      },
    });
    expect(Date.parse(body.rule.until)).toBeGreaterThan(Date.now());
    expect(Date.parse(body.rule.createdAt)).not.toBeNaN();

    const saved = JSON.parse(readFileSync(silencesFile(), 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject(body.rule);
    expect(statSync(silencesFile()).mode & 0o777).toBe(0o600);
  });

  it('replaces an existing silence for the same instance while preserving other rules', async () => {
    writeSilences([
      {
        instance: 'q',
        until: new Date(Date.now() + 60_000).toISOString(),
        reason: 'old reason',
        silencedBy: 'operator',
        createdAt: '2026-06-14T00:00:00.000Z',
      },
      {
        instance: 'loops',
        until: new Date(Date.now() + 120_000).toISOString(),
        reason: 'keep',
        silencedBy: 'operator',
        createdAt: '2026-06-14T00:01:00.000Z',
      },
    ]);
    const { handleAddSilence } = await importRoutes();
    const res = mockRes();

    await handleAddSilence(
      mockReq({
        method: 'POST',
        url: '/api/fleet/silence',
        body: JSON.stringify({ instance: 'q', duration_minutes: 30, reason: 'fresh deploy' }),
      }),
      res,
    );

    expect(res._status).toBe(200);
    const saved = JSON.parse(readFileSync(silencesFile(), 'utf8'));
    expect(saved).toHaveLength(2);
    expect(saved.find((rule: { instance: string }) => rule.instance === 'q')).toMatchObject({
      instance: 'q',
      reason: 'fresh deploy',
      silencedBy: 'fleet-api',
    });
    expect(saved.find((rule: { instance: string }) => rule.instance === 'loops')).toMatchObject({
      instance: 'loops',
      reason: 'keep',
    });
  });

  it.each([
    ['invalid JSON', '{', 'invalid JSON'],
    [
      'missing instance',
      JSON.stringify({ duration_minutes: 15 }),
      'instance is required',
    ],
    [
      'empty instance',
      JSON.stringify({ instance: '', duration_minutes: 15 }),
      'instance is required',
    ],
    [
      'bad duration',
      JSON.stringify({ instance: 'q', duration_minutes: 0 }),
      DURATION_ERROR,
    ],
    [
      'nonnumeric duration',
      JSON.stringify({ instance: 'q', duration_minutes: '15' }),
      DURATION_ERROR,
    ],
    // #2292 L11. `1e999` is a VALID JSON number literal that parses to Infinity;
    // typeof is 'number' and `Infinity <= 0` is false, so it passed the old
    // guard and reached addSilence, where toISOString() threw a RangeError out
    // of an unguarded call.
    [
      'an overflowing duration literal (parses to Infinity)',
      '{"instance":"q","duration_minutes":1e999}',
      DURATION_ERROR,
    ],
    // The case Number.isFinite alone does NOT catch: finite, yet past the
    // ECMA-262 maximum time value, so it throws identically.
    [
      'a finite duration that still overflows Date',
      JSON.stringify({ instance: 'q', duration_minutes: 1e308 }),
      DURATION_ERROR,
    ],
    [
      'a finite duration one minute past the cap',
      JSON.stringify({ instance: 'q', duration_minutes: MAX_SILENCE_MINUTES + 1 }),
      DURATION_ERROR,
    ],
    [
      'a negative duration',
      JSON.stringify({ instance: 'q', duration_minutes: -30 }),
      DURATION_ERROR,
    ],
  ])('rejects %s', async (_name, body, expectedError) => {
    const { handleAddSilence } = await importRoutes();
    const res = mockRes();

    await handleAddSilence(
      mockReq({ method: 'POST', url: '/api/fleet/silence', body }),
      res,
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: expectedError });
  });

  // Pins the bound's VALUE. The table above derives its expected message from
  // MAX_SILENCE_MINUTES, so without this a change to the cap would drag every
  // expectation along with it and stay invisible.
  it('caps a silence at one year', () => {
    expect(MAX_SILENCE_MINUTES).toBe(365 * 24 * 60);
    expect(MAX_SILENCE_MINUTES).toBe(525_600);
  });

  // The accept side of the boundary — a cap that rejected everything would pass
  // every rejection test above while breaking the endpoint.
  it('accepts a silence exactly at the cap and stores a valid expiry', async () => {
    const { handleAddSilence } = await importRoutes();
    const res = mockRes();

    await handleAddSilence(
      mockReq({
        method: 'POST',
        url: '/api/fleet/silence',
        body: JSON.stringify({ instance: 'q', duration_minutes: MAX_SILENCE_MINUTES }),
      }),
      res,
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    // The value that used to throw came from toISOString() on an Invalid Date;
    // a parseable expiry in the future is exactly what that failure destroyed.
    expect(Date.parse(body.rule.until)).not.toBeNaN();
    expect(Date.parse(body.rule.until)).toBeGreaterThan(Date.now());
    expect(JSON.parse(readFileSync(silencesFile(), 'utf8'))).toHaveLength(1);
  });

  it('persists nothing when an overflowing duration is rejected', async () => {
    const { handleAddSilence } = await importRoutes();
    const res = mockRes();

    await handleAddSilence(
      mockReq({
        method: 'POST',
        url: '/api/fleet/silence',
        body: '{"instance":"q","duration_minutes":1e999}',
      }),
      res,
    );

    expect(res._status).toBe(400);
    expect(() => readFileSync(silencesFile(), 'utf8')).toThrow();
  });

  it('reports request stream failures without persisting a silence', async () => {
    const { handleAddSilence } = await importRoutes();
    const res = mockRes();

    await handleAddSilence(streamErrorReq('socket reset while reading'), res);

    expect(res._status).toBe(400);
    const streamBody = JSON.parse(res._body);
    expect(streamBody.schema).toBe('fleet-error-v1');
    expect(streamBody.code).toBe('validation_failed');
    expect(streamBody.operation).toBe('silence');
    expect(() => readFileSync(silencesFile(), 'utf8')).toThrow();
  });

  it('rejects a request body that exceeds the size limit without persisting', async () => {
    const { handleAddSilence } = await importRoutes();
    const res = mockRes();

    await handleAddSilence(mockReq({ method: 'POST', url: '/api/fleet/silence', body: 'x'.repeat(64 * 1024 + 1) }), res);

    expect(res._status).toBe(400);
    const tooLargeBody = JSON.parse(res._body);
    expect(tooLargeBody.schema).toBe('fleet-error-v1');
    expect(tooLargeBody.code).toBe('validation_failed');
    expect(tooLargeBody.operation).toBe('silence');
    expect(() => readFileSync(silencesFile(), 'utf8')).toThrow();
  });

  it('removes existing silences and returns 404 for missing instances', async () => {
    writeSilences([
      {
        instance: 'q',
        until: new Date(Date.now() + 60_000).toISOString(),
        reason: 'maintenance',
        silencedBy: 'operator',
        createdAt: '2026-06-14T00:00:00.000Z',
      },
    ]);
    const { handleRemoveSilence } = await importRoutes();

    const missingRes = mockRes();
    await handleRemoveSilence(mockReq({ method: 'DELETE' }), missingRes, { instance: 'loops' });
    expect(missingRes._status).toBe(404);
    expect(JSON.parse(missingRes._body)).toEqual({ error: 'no silence found for instance' });

    const removeRes = mockRes();
    await handleRemoveSilence(mockReq({ method: 'DELETE' }), removeRes, { instance: 'q' });
    expect(removeRes._status).toBe(200);
    expect(JSON.parse(removeRes._body)).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(silencesFile(), 'utf8'))).toEqual([]);
  });
});
