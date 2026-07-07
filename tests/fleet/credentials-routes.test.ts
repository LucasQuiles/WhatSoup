// tests/fleet/credentials-routes.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

const keyringMock = vi.hoisted(() => ({
  writeCredential: vi.fn(),
  deleteCredential: vi.fn(),
  lookupCredential: vi.fn(),
}));
vi.mock('../../src/lib/keyring.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/keyring.ts')>()),
  ...keyringMock,
}));

import {
  handlePutCredential,
  handleDeleteCredential,
  handleVerifyCredential,
  handleGetCredential,
  CREDENTIAL_ALLOWLIST,
  CREDENTIAL_WRITE_BLOCKLIST,
  setExtraCredentialServices,
  _resetVerifyCooldownsForTests,
  _resetMutationCooldownsForTests,
} from '../../src/fleet/routes/credentials.ts';

/** Minimal req/res doubles matching the node:http handler contract. */
function fakeReq(body?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}
function fakeRes(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  let code = 0;
  let payload = '';
  const res = {
    writeHead(c: number) { code = c; return res; },
    setHeader() { return res; },
    end(chunk?: string) { payload = chunk ?? ''; },
  } as unknown as ServerResponse;
  return { res, status: () => code, json: () => JSON.parse(payload || '{}') };
}

beforeEach(() => {
  keyringMock.writeCredential.mockReset().mockReturnValue({ backend: 'macos-keychain' });
  keyringMock.deleteCredential.mockReset().mockReturnValue({ deleted: true, backend: 'macos-keychain' });
  keyringMock.lookupCredential.mockReset().mockReturnValue('resolved-key');
  _resetVerifyCooldownsForTests();
  _resetMutationCooldownsForTests();
  setExtraCredentialServices([]);
  delete process.env.DEEPSEEK_API_KEY;
});

describe('PUT /api/credentials/:service', () => {
  it('writes an allowlisted service and reports backend + envShadowed=false', async () => {
    const { res, status, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-new' }), res, { name: 'deepseek' });
    expect(keyringMock.writeCredential).toHaveBeenCalledWith('deepseek', 'sk-new');
    expect(status()).toBe(200);
    expect(json()).toEqual({ ok: true, service: 'deepseek', backend: 'macos-keychain', envShadowed: false });
  });

  it('reports envShadowed=true when the mapped env var is set', async () => {
    process.env.DEEPSEEK_API_KEY = 'shadow';
    const { res, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-new' }), res, { name: 'deepseek' });
    expect(json().envShadowed).toBe(true);
  });

  it('rejects a blocklisted service with 403 and never touches the keyring', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: 'whatsoup-health-token' });
    expect(status()).toBe(403);
    expect(keyringMock.writeCredential).not.toHaveBeenCalled();
  });

  it.each(['pinecone', 'elevenlabs', 'unknown-svc'])('rejects non-allowlisted %s with 404', async (svc) => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: svc });
    expect(status()).toBe(404);
    expect(keyringMock.writeCredential).not.toHaveBeenCalled();
  });

  it('rejects bad charset (uppercase / traversal) with 400 before any lookup', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: '../etc' });
    expect(status()).toBe(400);
    expect(keyringMock.writeCredential).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['multiline', 'a\nb'],
    ['oversize', 'x'.repeat(4097)],
  ])('rejects %s value with 400', async (_label, value) => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
    expect(keyringMock.writeCredential).not.toHaveBeenCalled();
  });

  it('maps KEYRING_LOCKED to 503 without echoing the value', async () => {
    const { KeyringWriteError } = await vi.importActual<typeof import('../../src/lib/keyring.ts')>('../../src/lib/keyring.ts');
    keyringMock.writeCredential.mockImplementation(() => {
      throw new KeyringWriteError('KEYRING_LOCKED', 'keychain write failed for service deepseek');
    });
    const { res, status, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-SECRET' }), res, { name: 'deepseek' });
    expect(status()).toBe(503);
    expect(JSON.stringify(json())).not.toContain('sk-SECRET');
    expect(json().code).toBe('KEYRING_LOCKED');
  });
});

describe('DELETE /api/credentials/:service', () => {
  it('deletes and reports inUse + envShadowed', async () => {
    const { res, status, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, { instances: [] });
    expect(keyringMock.deleteCredential).toHaveBeenCalledWith('deepseek');
    expect(status()).toBe(200);
    expect(json()).toEqual({ ok: true, service: 'deepseek', envShadowed: false, inUse: false });
  });

  it('404s when nothing was deleted, still explaining env shadowing', async () => {
    keyringMock.deleteCredential.mockReturnValue({ deleted: false, backend: 'macos-keychain' });
    process.env.DEEPSEEK_API_KEY = 'shadow';
    const { res, status, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, { instances: [] });
    expect(status()).toBe(404);
    expect(json().envShadowed).toBe(true);
  });

  it('flags inUse when a discovered instance resolves this service as primary or fallback', async () => {
    const deps = {
      instances: [
        { name: 'instance-a', agentOptions: { provider: 'claude-cli', fallbackProvider: 'opencode-cli', fallbackModel: 'deepseek/deepseek-chat' } },
      ],
    };
    const { res, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, deps);
    expect(json().inUse).toBe(true);
  });
});

describe('GET /api/credentials/:service — no read-back, ever', () => {
  it('returns 405', () => {
    const { res, status, json } = fakeRes();
    handleGetCredential(fakeReq(), res);
    expect(status()).toBe(405);
    expect(json()).toEqual({ error: 'credentials are write-only' });
  });
});

describe('POST /api/credentials/:service/verify', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports valid on 200, sending the typed auth header and never a body', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/models');
    expect(init.headers.Authorization).toBe('Bearer resolved-key');
    expect(init.body).toBe(undefined);
    expect(json()).toEqual({ ok: true, service: 'deepseek', status: 'valid', envShadowed: false });
  });

  it('reports invalid on 401', async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('invalid');
  });

  it('reports unreachable on network error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('unreachable');
  });

  it('reports unsupported for an allowlisted service with no descriptor (custom-svc)', async () => {
    // All four default-allowlisted services (deepseek, minimax, openai,
    // anthropic) now have a shared descriptor — use an operator-declared
    // extra service to exercise the genuinely-undescribed path.
    setExtraCredentialServices(['custom-svc']);
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'custom-svc' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(json().status).toBe('unsupported');
  });

  it('404s when no key is present', async () => {
    keyringMock.lookupCredential.mockReturnValue(null);
    const { res, status } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(status()).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces a per-service cooldown with 429 + retryAfter', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const a = fakeRes();
    await handleVerifyCredential(fakeReq(), a.res, { name: 'deepseek' });
    const b = fakeRes();
    await handleVerifyCredential(fakeReq(), b.res, { name: 'deepseek' });
    expect(b.status()).toBe(429);
    expect(typeof b.json().retryAfter).toBe('number');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes redirect:error in the fetch init to prevent cross-origin redirect following', async () => {
    // Regression guard for the undici custom-header-forwarding asymmetry:
    // undici does NOT strip arbitrary headers (e.g. x-api-key) on cross-origin
    // redirects, so the fetch must never follow a 3xx. Verify the call site
    // passes redirect:'error' unconditionally for all descriptors.
    fetchMock.mockResolvedValue({ status: 200 });
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'anthropic' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBe('error');
  });

  it('treats a redirect (TypeError from redirect:error) as unreachable, not a success (x-api-key path)', async () => {
    // With redirect:'error', undici throws a TypeError on any 3xx response.
    // For providers using x-api-key auth (e.g. anthropic), a redirect must
    // not be followed — it must produce a verify FAILURE (unreachable), not a
    // success, and must not leak the key to the redirect target.
    const redirectError = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(redirectError);
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'anthropic' });
    expect(json().ok).toBe(false);
    expect(json().status).toBe('unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.redirect).toBe('error');
  });

  it('arms the cooldown on the absent-key path so the presence oracle is throttled', async () => {
    // First call: no key stored → 404. The oracle leak is that a caller can
    // probe presence at unlimited rate. The cooldown must arm UNCONDITIONALLY,
    // including on this null return path.
    keyringMock.lookupCredential.mockReturnValue(null);
    const a = fakeRes();
    await handleVerifyCredential(fakeReq(), a.res, { name: 'deepseek' });
    expect(a.status()).toBe(404);

    // Second rapid call for the same service must be throttled, not re-probe.
    const b = fakeRes();
    await handleVerifyCredential(fakeReq(), b.res, { name: 'deepseek' });
    expect(b.status()).toBe(429);
    expect(typeof b.json().retryAfter).toBe('number');
    // lookupCredential must NOT have run a second time — the oracle is closed.
    expect(keyringMock.lookupCredential).toHaveBeenCalledTimes(1);
  });
});

describe('credential mutations are throttled (sync-DoS guard)', () => {
  it('throttles a rapid second PUT to the same service with 429', async () => {
    const a = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-one' }), a.res, { name: 'deepseek' });
    expect(a.status()).toBe(200);
    const b = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-two' }), b.res, { name: 'deepseek' });
    expect(b.status()).toBe(429);
    expect(typeof b.json().retryAfter).toBe('number');
    // The synchronous keyring write must not run a second time on the throttled path.
    expect(keyringMock.writeCredential).toHaveBeenCalledTimes(1);
  });

  it('throttles a rapid second DELETE to the same service with 429', async () => {
    const a = fakeRes();
    await handleDeleteCredential(fakeReq(), a.res, { name: 'deepseek' }, { instances: [] });
    expect(a.status()).toBe(200);
    const b = fakeRes();
    await handleDeleteCredential(fakeReq(), b.res, { name: 'deepseek' }, { instances: [] });
    expect(b.status()).toBe(429);
    expect(keyringMock.deleteCredential).toHaveBeenCalledTimes(1);
  });
});
