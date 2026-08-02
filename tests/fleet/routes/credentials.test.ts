/**
 * Branch-coverage tests for src/fleet/routes/credentials.ts
 *
 * mockRes comes from the shared harness (tests/helpers/http-mocks.ts); mockReq
 * stays local — see the comment above its definition for why.
 * No real keychain/exec is touched — the keyring module is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

// Keyring mock — hoisted so the factory can reference stable identities.
const keyringMock = vi.hoisted(() => ({
  writeCredential: vi.fn(),
  deleteCredential: vi.fn(),
  lookupCredential: vi.fn(),
  resolveProviderKeyService: vi.fn(),
  SERVICE_ENV_MAP: {} as Record<string, string>,
}));
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual, // keep the REAL KeyringWriteError class identity (instanceof gate)
    writeCredential: keyringMock.writeCredential,
    deleteCredential: keyringMock.deleteCredential,
    lookupCredential: keyringMock.lookupCredential,
    resolveProviderKeyService: keyringMock.resolveProviderKeyService,
    SERVICE_ENV_MAP: keyringMock.SERVICE_ENV_MAP,
  };
});

import {
  setExtraCredentialServices,
  handlePutCredential,
  handleDeleteCredential,
  handleGetCredential,
  handleVerifyCredential,
  _resetMutationCooldownsForTests,
  _resetVerifyCooldownsForTests,
  type CredentialDeps,
} from '../../../src/fleet/routes/credentials.ts';
import { KeyringWriteError } from '../../../src/lib/keyring.ts';
import { mockRes } from '../../helpers/http-mocks.ts';

// ---------------------------------------------------------------------------
// Helpers (style reused verbatim from feed.test.ts, extended to carry a body)
// ---------------------------------------------------------------------------
//
// mockReq stays local (not migrated onto tests/helpers/http-mocks.ts): this
// file's `beforeEach` calls `vi.useFakeTimers()` for every test, and the
// shared mockReq schedules each body-chunk write via `setImmediate` (even a
// single-chunk body needs one hop to reach `.end()`). `vi.useFakeTimers()`
// replaces `globalThis.setImmediate` but NOT `process.nextTick` — confirmed
// via an identity check (`globalThis.setImmediate !== realSetImmediate` is
// true; `process.nextTick !== realNextTick` is false, under this repo's
// Vitest config, which sets no `fakeTimers.toFake` override) — so any
// `setImmediate` hop the shared mockReq schedules never fires without a
// manual `vi.advanceTimers*` call; swapping it in hung every `readBody`-
// consuming call to the 10s test timeout. Retrofitting a manual advance at
// each of the ~25 body-bearing call sites was rejected — several tests here
// (mutation throttle, verify cooldown, the AbortController-timeout test)
// assert exact cooldown/timeout timer semantics, and interleaving an extra
// timer-advance before every handler call risks perturbing that in-SUT
// timing. This local mockReq schedules its single emit via `process.nextTick`
// only (no `setImmediate`), which already coexists with the fake timers here
// today. An unexplored alternative for a future lane: pin this file's
// `vi.useFakeTimers({ toFake: [...] })` to exclude `setImmediate` while still
// faking `setTimeout`/`Date` for the cooldown/timeout tests — not attempted
// here since it changes fake-timer scope repo-file-wide, out of bounds for a
// TEST-ONLY, behavior-preserving migration.
//
// mockRes DOES migrate below: it's purely synchronous (no timer/scheduling
// dependency), so the only behavioral difference is that the shared MockRes
// stores `_body` as a raw string instead of eagerly JSON.parsing it — every
// call site below parses it explicitly via `JSON.parse(res._body)`.

function mockReq(body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  (req as any).url = '/';
  (req as any).method = 'POST';
  (req as any).headers = {};
  process.nextTick(() => {
    if (body !== undefined) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', data);
    }
    req.emit('end');
  });
  return req;
}

const noopDeps: CredentialDeps = { instances: [] };

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  _resetMutationCooldownsForTests();
  _resetVerifyCooldownsForTests();
  setExtraCredentialServices([]);
  keyringMock.writeCredential.mockReset().mockReturnValue({ backend: 'macos-keychain' });
  keyringMock.deleteCredential.mockReset().mockReturnValue({ deleted: true, backend: 'macos-keychain' });
  keyringMock.lookupCredential.mockReset();
  keyringMock.resolveProviderKeyService.mockReset().mockReturnValue(null);
  // SERVICE_ENV_MAP is read by reference — reset to empty each run.
  for (const k of Object.keys(keyringMock.SERVICE_ENV_MAP)) delete keyringMock.SERVICE_ENV_MAP[k];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// checkService branches (driven via handlers)
// ---------------------------------------------------------------------------

describe('checkService (via handlePutCredential)', () => {
  it('rejects an invalid-charset service name with 400', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'Bad Name!' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'invalid service name' });
  });

  it('rejects a blocklisted service with 403', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'whatsoup-health-token' });
    expect(res._status).toBe(403);
    expect(JSON.parse(res._body)).toEqual({ error: 'service is not writable' });
  });

  it('rejects an allowlist-unknown but valid-charset service with 404', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'notreal' });
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: 'unknown credential service' });
  });

  it('proceeds for an allowlisted service (openai) by reaching writeCredential)', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'openai' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'openai', backend: 'macos-keychain' });
  });

  it('rejects with 400 when params.name is undefined (the ?? "" branch fails the charset regex)', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, {});
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'invalid service name' });
  });
});

// ---------------------------------------------------------------------------
// setExtraCredentialServices
// ---------------------------------------------------------------------------

describe('setExtraCredentialServices', () => {
  it('accepts valid custom services and rejects invalid / blocklisted ones', () => {
    const rejected = setExtraCredentialServices(['custom-svc', 'Bad Name!', 'whatsoup-health-token']);
    expect(rejected).toEqual(['Bad Name!', 'whatsoup-health-token']);
  });

  it('makes an accepted custom service usable in a PUT', async () => {
    setExtraCredentialServices(['custom-svc']);
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'custom-svc' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'custom-svc' });
  });

  it('does NOT make a rejected custom service usable in a PUT', async () => {
    setExtraCredentialServices(['Bad Name!']);
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'Bad Name!' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'invalid service name' });
  });
});

// ---------------------------------------------------------------------------
// mutation throttle (PUT path)
// ---------------------------------------------------------------------------

describe('mutation throttle', () => {
  it('returns 429 on a back-to-back PUT to the same service', async () => {
    const r1 = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), r1, { name: 'openai' });
    expect(r1._status).toBe(200);
    const r2 = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), r2, { name: 'openai' });
    expect(r2._status).toBe(429);
    expect(JSON.parse(r2._body)).toMatchObject({ error: 'mutation cooldown' });
    expect(JSON.parse(r2._body).retryAfter).toBeGreaterThan(0);
  });

  it('re-arms after MUTATION_COOLDOWN_MS (1000ms) elapses', async () => {
    const r1 = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), r1, { name: 'openai' });
    expect(r1._status).toBe(200);
    vi.advanceTimersByTime(1_000);
    const r2 = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), r2, { name: 'openai' });
    expect(r2._status).toBe(200);
    expect(JSON.parse(r2._body)).toMatchObject({ ok: true, service: 'openai' });
  });
});

// ---------------------------------------------------------------------------
// handlePutCredential — body & write-error branches
// ---------------------------------------------------------------------------

describe('handlePutCredential — body validation', () => {
  it('returns 400 on invalid JSON body', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq('not-json'), res, { name: 'openai' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'invalid JSON body' });
  });

  it('returns 400 when body value is not a string', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 123 }), res, { name: 'openai' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'body must be {"value": string}' });
  });

  it('returns 400 when the body is empty (readBody "" || "{}" branch → value undefined)', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq(), res, { name: 'openai' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'body must be {"value": string}' });
  });

  it('returns 400 when value is empty / whitespace', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: '   ' }), res, { name: 'openai' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'value must be a non-empty single-line string of at most 4096 bytes' });
  });

  it('returns 400 when value contains a newline', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'line1\nline2' }), res, { name: 'openai' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'value must be a non-empty single-line string of at most 4096 bytes' });
  });

  it('returns 400 when value exceeds 4096 bytes', async () => {
    const res = mockRes();
    const big = 'a'.repeat(4097);
    await handlePutCredential(mockReq({ value: big }), res, { name: 'openai' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'value must be a non-empty single-line string of at most 4096 bytes' });
  });
});

describe('handlePutCredential — write outcomes', () => {
  it('returns 503 on KeyringWriteError code KEYRING_LOCKED', async () => {
    keyringMock.writeCredential.mockImplementation(() => {
      throw new KeyringWriteError('KEYRING_LOCKED', 'keychain locked');
    });
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'openai' });
    expect(res._status).toBe(503);
    expect(JSON.parse(res._body)).toEqual({ error: 'keychain locked', code: 'KEYRING_LOCKED' });
  });

  it('returns 501 on KeyringWriteError code KEYRING_WRITE_UNSUPPORTED', async () => {
    keyringMock.writeCredential.mockImplementation(() => {
      throw new KeyringWriteError('KEYRING_WRITE_UNSUPPORTED', 'unsupported backend');
    });
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'openai' });
    expect(res._status).toBe(501);
    expect(JSON.parse(res._body)).toEqual({ error: 'unsupported backend', code: 'KEYRING_WRITE_UNSUPPORTED' });
  });

  it('returns 500 on KeyringWriteError with an other code (KEYRING_ACCESS_DENIED)', async () => {
    keyringMock.writeCredential.mockImplementation(() => {
      throw new KeyringWriteError('KEYRING_ACCESS_DENIED', 'access denied');
    });
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'openai' });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toEqual({ error: 'access denied', code: 'KEYRING_ACCESS_DENIED' });
  });

  it('returns 500 KEYRING_WRITE_FAILED on a non-KeyringWriteError throw', async () => {
    keyringMock.writeCredential.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'openai' });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toEqual({ error: 'credential write failed', code: 'KEYRING_WRITE_FAILED' });
  });

  it('reports envShadowed:true when the service env var is set', async () => {
    keyringMock.SERVICE_ENV_MAP['openai'] = 'OPENAI_API_KEY';
    vi.stubEnv('OPENAI_API_KEY', 'env-set-value-xyz');
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'openai' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'openai', envShadowed: true });
  });

  it('reports envShadowed:false when no service env var is mapped', async () => {
    const res = mockRes();
    await handlePutCredential(mockReq({ value: 'test-value-abc' }), res, { name: 'openai' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'openai', envShadowed: false });
  });
});

// ---------------------------------------------------------------------------
// handleDeleteCredential
// ---------------------------------------------------------------------------

describe('handleDeleteCredential', () => {
  it('returns 200 when deleteCredential reports deleted:true', async () => {
    keyringMock.deleteCredential.mockReturnValue({ deleted: true, backend: 'macos-keychain' });
    const res = mockRes();
    await handleDeleteCredential(mockReq(), res, { name: 'openai' }, noopDeps);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'openai', envShadowed: false });
  });

  it('returns 404 when deleteCredential reports deleted:false', async () => {
    keyringMock.deleteCredential.mockReturnValue({ deleted: false, backend: 'macos-keychain' });
    const res = mockRes();
    await handleDeleteCredential(mockReq(), res, { name: 'openai' }, noopDeps);
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toMatchObject({ ok: false, service: 'openai' });
  });

  it('reports inUse:true when a deps instance resolves to the service', async () => {
    keyringMock.resolveProviderKeyService.mockImplementation((provider: unknown) =>
      provider === 'openai-api' ? 'openai' : null,
    );
    const deps: CredentialDeps = {
      instances: [{ name: 'op', agentOptions: { provider: 'openai-api', model: 'gpt-4' } }],
    };
    const res = mockRes();
    await handleDeleteCredential(mockReq(), res, { name: 'openai' }, deps);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'openai', inUse: true });
  });

  it('reports inUse:true when a fallback provider resolves to the service', async () => {
    keyringMock.resolveProviderKeyService.mockImplementation((provider: unknown) =>
      provider === 'openai-api' ? 'openai' : null,
    );
    const deps: CredentialDeps = {
      instances: [{ name: 'op', agentOptions: { fallbackProvider: 'openai-api', fallbackModel: 'gpt-4' } }],
    };
    const res = mockRes();
    await handleDeleteCredential(mockReq(), res, { name: 'openai' }, deps);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'openai', inUse: true });
  });

  it('reports inUse:false when no instance resolves to the service', async () => {
    keyringMock.resolveProviderKeyService.mockReturnValue(null);
    const deps: CredentialDeps = {
      instances: [{ name: 'op', agentOptions: { provider: 'anthropic-api', model: 'claude' } }],
    };
    const res = mockRes();
    await handleDeleteCredential(mockReq(), res, { name: 'openai' }, deps);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'openai', inUse: false });
  });

  it('handles an instance with no agentOptions (nullish-coalesce branch) → inUse:false', async () => {
    keyringMock.resolveProviderKeyService.mockReturnValue(null);
    const deps: CredentialDeps = { instances: [{ name: 'bare' }] };
    const res = mockRes();
    await handleDeleteCredential(mockReq(), res, { name: 'openai' }, deps);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, service: 'openai', inUse: false });
  });

  it('returns the checkService error early on an invalid service name (line 219 branch)', async () => {
    const res = mockRes();
    await handleDeleteCredential(mockReq(), res, { name: 'Bad Name!' }, noopDeps);
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'invalid service name' });
  });

  it('returns 429 on a back-to-back DELETE to the same service (throttle branch)', async () => {
    keyringMock.deleteCredential.mockReturnValue({ deleted: true, backend: 'macos-keychain' });
    const r1 = mockRes();
    await handleDeleteCredential(mockReq(), r1, { name: 'openai' }, noopDeps);
    expect(r1._status).toBe(200);
    const r2 = mockRes();
    await handleDeleteCredential(mockReq(), r2, { name: 'openai' }, noopDeps);
    expect(r2._status).toBe(429);
    expect(JSON.parse(r2._body)).toMatchObject({ error: 'mutation cooldown' });
  });
});

// ---------------------------------------------------------------------------
// handleGetCredential
// ---------------------------------------------------------------------------

describe('handleGetCredential', () => {
  it('always returns 405 (credentials are write-only)', () => {
    const res = mockRes();
    handleGetCredential(mockReq(), res);
    expect(res._status).toBe(405);
    expect(JSON.parse(res._body)).toEqual({ error: 'credentials are write-only' });
  });
});

// ---------------------------------------------------------------------------
// handleVerifyCredential
// ---------------------------------------------------------------------------

describe('handleVerifyCredential', () => {
  it('returns the checkService error early on an invalid service name (line 252 branch)', async () => {
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'Bad Name!' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'invalid service name' });
  });

  it('returns 429 on a back-to-back verify to the same service', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const r1 = mockRes();
    await handleVerifyCredential(mockReq(), r1, { name: 'openai' });
    expect(r1._status).toBe(200);
    const r2 = mockRes();
    await handleVerifyCredential(mockReq(), r2, { name: 'openai' });
    expect(r2._status).toBe(429);
    expect(JSON.parse(r2._body)).toMatchObject({ error: 'verify cooldown' });
  });

  it('returns 404 when no key is stored', async () => {
    keyringMock.lookupCredential.mockReturnValue(null);
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'openai' });
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ error: 'no key stored for service', service: 'openai' });
  });

  it('returns 200 status:unsupported when no verify descriptor exists', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    // deepseek has a descriptor; minimax does NOT — use a custom service.
    setExtraCredentialServices(['custom-svc']);
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'custom-svc' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true, service: 'custom-svc', status: 'unsupported', envShadowed: false });
  });

  it('sends Authorization: Bearer <key> for a bearer descriptor (openai) and reports valid on 2xx', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'openai' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers).toMatchObject({ Authorization: 'Bearer test-value-abc' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true, service: 'openai', status: 'valid', envShadowed: false });
  });

  it('sends x-api-key header for a non-bearer descriptor (anthropic)', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'anthropic' });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers).toMatchObject({
      'x-api-key': 'test-value-abc',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.parse(res._body)).toMatchObject({ ok: true, status: 'valid' });
  });

  it('reports status:invalid on a 401 response', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401 }));
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'openai' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: false, service: 'openai', status: 'invalid', envShadowed: false });
  });

  it('reports status:invalid on a 403 response', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 403 }));
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'openai' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: false, service: 'openai', status: 'invalid', envShadowed: false });
  });

  it('reports status:unreachable on a 500 response', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 500 }));
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'openai' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: false, service: 'openai', status: 'unreachable', envShadowed: false });
  });

  it('reports status:unreachable when fetch throws', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const res = mockRes();
    await handleVerifyCredential(mockReq(), res, { name: 'openai' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: false, service: 'openai', status: 'unreachable', envShadowed: false });
  });

  it('reports status:unreachable when the AbortController timeout fires', async () => {
    keyringMock.lookupCredential.mockReturnValue('test-value-abc');
    // fetch returns a promise that ONLY rejects when its abort signal fires —
    // mirroring a real fetch timing out, so the handler's setTimeout → abort()
    // path trips the catch and yields status:'unreachable'.
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          reject(new Error('The user aborted a request'));
        });
      });
    }));
    const res = mockRes();
    const p = handleVerifyCredential(mockReq(), res, { name: 'openai' });
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: false, service: 'openai', status: 'unreachable', envShadowed: false });
  });
});
