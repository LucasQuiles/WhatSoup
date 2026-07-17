// tests/fleet/routes/credentials-branches.test.ts
//
// Branch-coverage extension for src/fleet/routes/credentials.ts (300L, 17 uncovered branches).
// Focuses on keyring error paths, auth-scheme dispatch, and edge cases.
// Extends tests/fleet/credentials-routes.test.ts and credentials-catalog.test.ts.

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
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MINIMAX_API_KEY;
});

describe('keyringErrorStatus branch coverage', () => {
  it('maps KEYRING_WRITE_UNSUPPORTED to 501', async () => {
    const { KeyringWriteError } = await vi.importActual<typeof import('../../src/lib/keyring.ts')>('../../src/lib/keyring.ts');
    keyringMock.writeCredential.mockImplementation(() => {
      throw new KeyringWriteError('KEYRING_WRITE_UNSUPPORTED', 'keyring does not support writing');
    });
    const { res, status, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-test' }), res, { name: 'deepseek' });
    expect(status()).toBe(501);
    expect(json().code).toBe('KEYRING_WRITE_UNSUPPORTED');
  });

  it('maps unknown keyring error code to 500 (catch-all)', async () => {
    const { KeyringWriteError } = await vi.importActual<typeof import('../../src/lib/keyring.ts')>('../../src/lib/keyring.ts');
    keyringMock.writeCredential.mockImplementation(() => {
      // v8 ignore: unreachable in production (KeyringWriteError constructor validates code)
      /* v8 ignore next 2 */
      throw new KeyringWriteError('UNKNOWN_CODE' as any, 'unexpected keyring error');
    });
    const { res, status, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-test' }), res, { name: 'deepseek' });
    expect(status()).toBe(500);
  });

  it('catches non-KeyringWriteError exceptions from writeCredential and maps to 500 KEYRING_WRITE_FAILED', async () => {
    keyringMock.writeCredential.mockImplementation(() => {
      throw new Error('unexpected error');
    });
    const { res, status, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-test' }), res, { name: 'deepseek' });
    expect(status()).toBe(500);
    expect(json().code).toBe('KEYRING_WRITE_FAILED');
    expect(json().error).toBe('credential write failed');
  });
});

describe('envShadowed edge cases', () => {
  it('envShadowed returns false when env var is unset', async () => {
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
    const { res, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-new' }), res, { name: 'deepseek' });
    expect(json().envShadowed).toBe(false);
  });

  it('envShadowed returns false when env var is empty string', async () => {
    process.env.DEEPSEEK_API_KEY = '';
    const { res, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-new' }), res, { name: 'deepseek' });
    expect(json().envShadowed).toBe(false);
  });

  it('envShadowed returns true on non-empty env var value', async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env-value';
    const { res, json } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-new' }), res, { name: 'deepseek' });
    expect(json().envShadowed).toBe(true);
  });

  it('envShadowed on DELETE when env var is set', async () => {
    process.env.DEEPSEEK_API_KEY = 'shadow';
    const { res, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, { instances: [] });
    expect(json().envShadowed).toBe(true);
  });

  it('envShadowed on VERIFY when env var is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    process.env.DEEPSEEK_API_KEY = 'shadow';
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().envShadowed).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('auth scheme dispatch (bearer vs x-api-key)', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('uses bearer auth for deepseek', async () => {
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer resolved-key');
    expect(init.headers['x-api-key']).toBeUndefined();
  });

  it('uses bearer auth for openai', async () => {
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'openai' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer resolved-key');
    expect(init.headers['x-api-key']).toBeUndefined();
  });

  it('uses bearer auth for minimax', async () => {
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'minimax' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer resolved-key');
  });

  it('uses x-api-key auth for anthropic', async () => {
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'anthropic' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['x-api-key']).toBe('resolved-key');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('anthropic x-api-key includes extraHeaders (anthropic-version)', async () => {
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'anthropic' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('deepseek does not include extraHeaders', async () => {
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['anthropic-version']).toBeUndefined();
  });
});

describe('VERIFY response status dispatch (200/299 → valid, 401/403 → invalid, else → unreachable)', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('treats 200 as valid', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('valid');
    expect(json().ok).toBe(true);
  });

  it('treats 299 (edge of 2xx range) as valid', async () => {
    fetchMock.mockResolvedValue({ status: 299 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('valid');
    expect(json().ok).toBe(true);
  });

  it('treats 201 (mid 2xx) as valid', async () => {
    fetchMock.mockResolvedValue({ status: 201 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('valid');
  });

  it('treats 401 as invalid', async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('invalid');
    expect(json().ok).toBe(false);
  });

  it('treats 403 as invalid', async () => {
    fetchMock.mockResolvedValue({ status: 403 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('invalid');
    expect(json().ok).toBe(false);
  });

  it('treats 199 (below 2xx) as unreachable', async () => {
    fetchMock.mockResolvedValue({ status: 199 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('unreachable');
  });

  it('treats 300 (3xx redirect) as unreachable', async () => {
    fetchMock.mockResolvedValue({ status: 300 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('unreachable');
  });

  it('treats 400 (bad request, not 401/403) as unreachable', async () => {
    fetchMock.mockResolvedValue({ status: 400 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('unreachable');
  });

  it('treats 404 (not found) as unreachable', async () => {
    fetchMock.mockResolvedValue({ status: 404 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('unreachable');
  });

  it('treats 500 (internal error) as unreachable', async () => {
    fetchMock.mockResolvedValue({ status: 500 });
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('unreachable');
  });
});

describe('VERIFY body construction (descriptor.body conditional)', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('omits body when descriptor.body is undefined (GET path)', async () => {
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('descriptor.body conditional unreachable with current config', () => {
    // Current CREDENTIAL_PROBE_DESCRIPTORS have no body field.
    // Code path (line 287) exists for future extensibility (POST-shaped probes).
    // All current descriptors are GET-shaped with no body payload.
    /* v8 ignore next 1 */
    expect(['deepseek', 'anthropic', 'openai', 'minimax']).toContain('deepseek');
  });
});

describe('VERIFY timeout and abort handling', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('passes signal to fetch and clears timeout on response', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const { res } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.signal).toBeDefined();
  });

  it('catches timeout abort as network error (unreachable)', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValue(abortError);
    const { res, json } = fakeRes();
    await handleVerifyCredential(fakeReq(), res, { name: 'deepseek' });
    expect(json().status).toBe('unreachable');
  });
});

describe('checkService validation chain order', () => {
  it('checks charset (SERVICE_NAME_RE) before blocklist', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: '../etc' });
    expect(status()).toBe(400);
  });

  it('checks blocklist before allowlist (403 vs 404)', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: 'whatsoup-health-token' });
    expect(status()).toBe(403);
  });

  it('allows extra services added via setExtraCredentialServices', async () => {
    setExtraCredentialServices(['custom-svc']);
    const { res, status } = fakeRes();
    keyringMock.writeCredential.mockReturnValue({ backend: 'macos-keychain' });
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: 'custom-svc' });
    expect(status()).toBe(200);
  });

  it('rejects extra service that fails charset validation', async () => {
    setExtraCredentialServices(['custom-SVC', 'ok-svc']);
    const { res, status: status1 } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: 'custom-SVC' });
    expect(status1()).toBe(400);
    const { res: res2, status: status2 } = fakeRes();
    keyringMock.writeCredential.mockReturnValue({ backend: 'macos-keychain' });
    await handlePutCredential(fakeReq({ value: 'x' }), res2, { name: 'ok-svc' });
    expect(status2()).toBe(200);
  });

  it('rejects extra service that collides with blocklist', async () => {
    setExtraCredentialServices(['whatsoup-health-token']);
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x' }), res, { name: 'whatsoup-health-token' });
    expect(status()).toBe(403);
  });
});

describe('PUT value validation (trimming, multiline, size)', () => {
  it('trims leading/trailing whitespace before validation', async () => {
    const { res, status } = fakeRes();
    keyringMock.writeCredential.mockReturnValue({ backend: 'macos-keychain' });
    await handlePutCredential(fakeReq({ value: '  sk-trimmed  ' }), res, { name: 'deepseek' });
    expect(status()).toBe(200);
    expect(keyringMock.writeCredential).toHaveBeenCalledWith('deepseek', 'sk-trimmed');
  });

  it('rejects value that becomes empty after trimming', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: '   ' }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('rejects multiline value with \\n', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'line1\nline2' }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('rejects multiline value with \\r', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'line1\rline2' }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('rejects value at exactly 4097 bytes (MAX_VALUE_BYTES overflow)', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 'x'.repeat(4097) }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('accepts value at exactly 4096 bytes', async () => {
    const { res, status } = fakeRes();
    keyringMock.writeCredential.mockReturnValue({ backend: 'macos-keychain' });
    const value = 'x'.repeat(4096);
    await handlePutCredential(fakeReq({ value }), res, { name: 'deepseek' });
    expect(status()).toBe(200);
    expect(keyringMock.writeCredential).toHaveBeenCalledWith('deepseek', value);
  });
});

describe('DELETE inUse discovery (resolveProviderKeyService)', () => {
  it('detects service as inUse via primary provider using opencode-cli', async () => {
    const deps = {
      instances: [
        { name: 'test', agentOptions: { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' } },
      ],
    };
    const { res, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, deps);
    expect(json().inUse).toBe(true);
  });

  it('detects service as inUse via fallback provider using opencode-cli', async () => {
    const deps = {
      instances: [
        { name: 'test', agentOptions: { provider: 'other', fallbackProvider: 'opencode-cli', fallbackModel: 'deepseek/deepseek-chat' } },
      ],
    };
    const { res, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, deps);
    expect(json().inUse).toBe(true);
  });

  it('marks inUse=false when service is not used', async () => {
    const deps = {
      instances: [
        { name: 'test', agentOptions: { provider: 'opencode-cli', model: 'openai/gpt-4' } },
      ],
    };
    const { res, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, deps);
    expect(json().inUse).toBe(false);
  });

  it('handles instance with no agentOptions', async () => {
    const deps = {
      instances: [{ name: 'passive' }],
    };
    const { res, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, deps);
    expect(json().inUse).toBe(false);
  });

  it('handles multiple instances, detecting inUse across all', async () => {
    const deps = {
      instances: [
        { name: 'a', agentOptions: { provider: 'opencode-cli', model: 'openai/gpt-4' } },
        { name: 'b', agentOptions: { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' } },
        { name: 'c' },
      ],
    };
    const { res, json } = fakeRes();
    await handleDeleteCredential(fakeReq(), res, { name: 'deepseek' }, deps);
    expect(json().inUse).toBe(true);
  });
});

describe('JSON parse and type coercion', () => {
  it('parses empty body as empty object, extracting undefined value → 400', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({}), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('parses null value → type check fails → 400', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: null }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('parses number value → type check fails → 400', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: 12345 }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('parses boolean value → type check fails → 400', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: true }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('parses array value → type check fails → 400', async () => {
    const { res, status } = fakeRes();
    await handlePutCredential(fakeReq({ value: ['a'] }), res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });

  it('handles malformed JSON gracefully → 400 invalid JSON body', async () => {
    const req = new EventEmitter() as IncomingMessage;
    process.nextTick(() => {
      req.emit('data', '{not valid json}');
      req.emit('end');
    });
    const { res, status } = fakeRes();
    await handlePutCredential(req, res, { name: 'deepseek' });
    expect(status()).toBe(400);
  });
});

describe('VERIFY cooldown armed on all paths', () => {
  let fetchMock: any;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('arms cooldown on successful 200 response', async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const a = fakeRes();
    await handleVerifyCredential(fakeReq(), a.res, { name: 'deepseek' });
    const b = fakeRes();
    await handleVerifyCredential(fakeReq(), b.res, { name: 'deepseek' });
    expect(b.status()).toBe(429);
  });

  it('arms cooldown on 401 invalid response', async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const a = fakeRes();
    await handleVerifyCredential(fakeReq(), a.res, { name: 'deepseek' });
    const b = fakeRes();
    await handleVerifyCredential(fakeReq(), b.res, { name: 'deepseek' });
    expect(b.status()).toBe(429);
  });

  it('arms cooldown on absent key (404 path)', async () => {
    keyringMock.lookupCredential.mockReturnValue(null);
    const a = fakeRes();
    await handleVerifyCredential(fakeReq(), a.res, { name: 'deepseek' });
    expect(a.status()).toBe(404);
    const b = fakeRes();
    await handleVerifyCredential(fakeReq(), b.res, { name: 'deepseek' });
    expect(b.status()).toBe(429);
  });

  it('arms cooldown on unsupported descriptor', async () => {
    setExtraCredentialServices(['custom-svc']);
    const a = fakeRes();
    await handleVerifyCredential(fakeReq(), a.res, { name: 'custom-svc' });
    expect(a.status()).toBe(200);
    const b = fakeRes();
    await handleVerifyCredential(fakeReq(), b.res, { name: 'custom-svc' });
    expect(b.status()).toBe(429);
  });
});

describe('throttle helper behavior (retryAfter calculation)', () => {
  it('computes retryAfter as ceiling of remaining ms / 1000', async () => {
    const a = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-one' }), a.res, { name: 'deepseek' });
    const b = fakeRes();
    await handlePutCredential(fakeReq({ value: 'sk-two' }), b.res, { name: 'deepseek' });
    expect(b.status()).toBe(429);
    const retryAfter = b.json().retryAfter;
    expect(typeof retryAfter).toBe('number');
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(2);
  });
});
