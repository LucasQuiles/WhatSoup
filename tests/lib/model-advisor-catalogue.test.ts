/**
 * Tests for the /config model catalogue seam in model-advisor.ts:
 *   - classifyModelFetchFailure: the single HTTP-concept classifier shared by
 *     every vendor-facing caller (Q 2b: no per-call-site status→reason drift).
 *   - fetchAnthropicModelIdsWithStatus: anthropic-ONLY live listing, classified.
 *     Uses an explicit ANTHROPIC_API_KEY (x-api-key) only; it must never
 *     inspect or reuse a Claude CLI credential.
 *   - fetchAnthropicApiModelIdsWithStatus: the managed API adapter's distinct
 *     x-api-key identity.
 *
 * fetch + ANTHROPIC_API_KEY are stubbed (same pattern as model-advisor.test.ts);
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resolveApiKey consults keychain before process.env; no catalogue unit test may
// reach the host keychain. This boundary mock remains valid once the CLI-file
// reader is removed, because API-key catalogue discovery still uses resolveApiKey.
const lookupCredentialMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => string | null>(() => null));
vi.mock('../../src/lib/keyring.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/keyring.ts')>()),
  lookupCredential: (...args: unknown[]) => lookupCredentialMock(...args),
}));
import {
  classifyModelFetchFailure,
  fetchAnthropicApiModelIdsWithStatus,
  fetchAnthropicModelIdsWithStatus,
} from '../../src/lib/model-advisor.ts';

let claudeConfigDir: string;
let claudeSecureStorageDir: string;

beforeEach(() => {
  claudeConfigDir = mkdtempSync(join(tmpdir(), 'whatsoup-test-claude-config-'));
  claudeSecureStorageDir = mkdtempSync(join(tmpdir(), 'whatsoup-test-claude-secure-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
  vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', claudeSecureStorageDir);
  lookupCredentialMock.mockReset();
  lookupCredentialMock.mockReturnValue(null);
});

afterEach(() => {
  rmSync(claudeConfigDir, { recursive: true, force: true });
  rmSync(claudeSecureStorageDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('classifyModelFetchFailure', () => {
  it('maps 401 and 403 to unauthorized (the credential is not accepted)', () => {
    expect(classifyModelFetchFailure({ status: 401, reason: 'HTTP 401' })).toBe('unauthorized');
    expect(classifyModelFetchFailure({ status: 403, reason: 'HTTP 403' })).toBe('unauthorized');
  });

  it('maps a status-less abort/timeout reason to timeout', () => {
    expect(classifyModelFetchFailure({ reason: 'The operation was aborted due to timeout' })).toBe('timeout');
    expect(classifyModelFetchFailure({ reason: 'AbortError: This operation was aborted' })).toBe('timeout');
  });

  it('maps 5xx / 429 / other non-auth failures to lookup-failed (server could not answer)', () => {
    expect(classifyModelFetchFailure({ status: 500, reason: 'HTTP 500' })).toBe('lookup-failed');
    expect(classifyModelFetchFailure({ status: 503, reason: 'HTTP 503' })).toBe('lookup-failed');
    expect(classifyModelFetchFailure({ status: 429, reason: 'HTTP 429' })).toBe('lookup-failed');
  });

  it('maps a status-less non-timeout network error to lookup-failed', () => {
    expect(classifyModelFetchFailure({ reason: 'fetch failed' })).toBe('lookup-failed');
  });

  it('does not treat a 5xx whose body mentions "timeout" as a timeout (status wins)', () => {
    // A 504 is still the server answering — status present → not the abort path.
    expect(classifyModelFetchFailure({ status: 504, reason: 'HTTP 504' })).toBe('lookup-failed');
  });
});

describe('fetchAnthropicModelIdsWithStatus — explicit API-key path', () => {
  it('returns no-key without calling fetch when no API key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({ status: 'no-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not make a Bearer request from a stale non-selected CLI file', async () => {
    writeFileSync(
      join(claudeConfigDir, '.credentials.json'),
      // Distant fixed expiry: this must be a live-looking stale-selector file,
      // without a host-speed-sensitive Date.now() window.
      JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-stale-token', expiresAt: 4_102_444_800_000 } }),
    );
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({ status: 'no-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches with x-api-key and returns ok on a 200 when only an env key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-8' }, { id: 'claude-sonnet-5' }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({
      status: 'ok',
      ids: ['claude-opus-4-8', 'claude-sonnet-5'],
    });
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['x-api-key']).toBe('sk-test');
  });

  it('classifies a 401 as failed/unauthorized (env key present but rejected)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({
      status: 'failed',
      category: 'unauthorized',
    });
  });

  it('classifies a 500 as failed/lookup-failed', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({
      status: 'failed',
      category: 'lookup-failed',
    });
  });

  it('classifies a network error as failed/lookup-failed', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({
      status: 'failed',
      category: 'lookup-failed',
    });
  });

  it('classifies an abort/timeout throw as failed/timeout', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')));

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({
      status: 'failed',
      category: 'timeout',
    });
  });
});

describe('fetchAnthropicApiModelIdsWithStatus — managed API credential path', () => {
  it('uses the managed API key and never a CLI OAuth bearer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'vendor-model-1' }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicApiModelIdsWithStatus({ resolveKey: () => 'managed-key-fixture' }))
      .toStrictEqual({ status: 'ok', ids: ['vendor-model-1'] });
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers['x-api-key']).toBe('managed-key-fixture');
  });

  it('returns no-key without issuing a request when the managed key is absent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicApiModelIdsWithStatus({ resolveKey: () => '' }))
      .toStrictEqual({ status: 'no-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The adapter catalogue is resolved while a request waits, so it makes one
  // attempt. Only the background currency monitor retries transient failures;
  // its 2 s + 8 s backoff must never reach this path.
  it('makes a single attempt on a transient 503 and never waits out a retry backoff', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchSpy);
    const realSetTimeout = globalThis.setTimeout;
    const backoffDelays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      cb: (...a: unknown[]) => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === 2_000 || ms === 8_000) {
        backoffDelays.push(ms);
        cb();
        return { unref: () => {} } as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(cb, ms, ...rest);
    }) as unknown as typeof globalThis.setTimeout);

    expect(await fetchAnthropicApiModelIdsWithStatus({ resolveKey: () => 'managed-key-fixture' }))
      .toStrictEqual({ status: 'failed', category: 'lookup-failed' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(backoffDelays).toEqual([]);
  });
});
