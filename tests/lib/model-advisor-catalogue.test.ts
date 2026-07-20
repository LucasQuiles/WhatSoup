/**
 * Tests for the /config model catalogue seam in model-advisor.ts:
 *   - classifyModelFetchFailure: the single HTTP-concept classifier shared by
 *     every vendor-facing caller (Q 2b: no per-call-site status→reason drift).
 *   - resolveClaudeOAuthCred: reads the claude-cli's OWN OAuth credential (the
 *     subscription CLI authenticates /v1/models with `Authorization: Bearer`,
 *     verified live 2026-07-20 — NOT an x-api-key). present / expired / absent.
 *   - fetchAnthropicModelIdsWithStatus: anthropic-ONLY live listing, classified.
 *     Prefers the OAuth credential (no separate key needed on q); falls back to
 *     an explicit ANTHROPIC_API_KEY (x-api-key).
 *
 * fetch + ANTHROPIC_API_KEY are stubbed (same pattern as model-advisor.test.ts);
 * the OAuth credential is injected (no real creds file read in unit tests).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyModelFetchFailure,
  resolveClaudeOAuthCred,
  fetchAnthropicModelIdsWithStatus,
  type ClaudeOAuthCredResult,
} from '../../src/lib/model-advisor.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ABSENT = (): ClaudeOAuthCredResult => ({ status: 'absent' });

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

describe('resolveClaudeOAuthCred', () => {
  const T = 1_000_000; // fixed clock
  const creds = (accessToken: unknown, expiresAt: unknown) =>
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });

  it('returns present with the token when the file has an unexpired accessToken', () => {
    const out = resolveClaudeOAuthCred({ readFileText: () => creds('oauth-tok-live', T + 60_000), nowMs: T });
    expect(out).toStrictEqual({ status: 'present', token: 'oauth-tok-live' });
  });

  it('returns expired when expiresAt is at/before now (self-heals on the next agent turn)', () => {
    expect(resolveClaudeOAuthCred({ readFileText: () => creds('oauth-tok-stale', T - 1), nowMs: T }))
      .toStrictEqual({ status: 'expired' });
    expect(resolveClaudeOAuthCred({ readFileText: () => creds('oauth-tok-stale', T), nowMs: T }))
      .toStrictEqual({ status: 'expired' });
  });

  it('returns absent when the file is missing, unparseable, or has no token', () => {
    expect(resolveClaudeOAuthCred({ readFileText: () => null, nowMs: T })).toStrictEqual({ status: 'absent' });
    expect(resolveClaudeOAuthCred({ readFileText: () => 'not json{', nowMs: T })).toStrictEqual({ status: 'absent' });
    expect(resolveClaudeOAuthCred({ readFileText: () => JSON.stringify({}), nowMs: T })).toStrictEqual({ status: 'absent' });
    expect(resolveClaudeOAuthCred({ readFileText: () => creds('', T + 60_000), nowMs: T })).toStrictEqual({ status: 'absent' });
  });

  it('treats a token with no expiresAt as present (server response is the authority)', () => {
    const out = resolveClaudeOAuthCred({ readFileText: () => JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-tok-x' } }), nowMs: T });
    expect(out).toStrictEqual({ status: 'present', token: 'oauth-tok-x' });
  });
});

describe('fetchAnthropicModelIdsWithStatus — OAuth credential path', () => {
  it('fetches with Authorization: Bearer (not x-api-key) when the OAuth credential is present', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'claude-opus-4-8' }] }) });
    vi.stubGlobal('fetch', fetchSpy);

    const out = await fetchAnthropicModelIdsWithStatus({ readOAuthCred: () => ({ status: 'present', token: 'oauth-tok-live' }) });
    expect(out).toStrictEqual({ status: 'ok', ids: ['claude-opus-4-8'] });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['x-api-key']).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer oauth-tok-live');
  });

  it('returns credential-expired WITHOUT calling fetch when the OAuth token is expired', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicModelIdsWithStatus({ readOAuthCred: () => ({ status: 'expired' }) }))
      .toStrictEqual({ status: 'credential-expired' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('classifies a 401 on a present (unexpired) OAuth token as failed/unauthorized (revoked)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await fetchAnthropicModelIdsWithStatus({ readOAuthCred: () => ({ status: 'present', token: 'oauth-tok-revoked' }) }))
      .toStrictEqual({ status: 'failed', category: 'unauthorized' });
  });
});

describe('fetchAnthropicModelIdsWithStatus — env-key fallback path (no OAuth credential)', () => {
  it('returns no-key without calling fetch when neither OAuth credential nor env key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicModelIdsWithStatus({ readOAuthCred: ABSENT })).toStrictEqual({ status: 'no-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches with x-api-key and returns ok on a 200 when only an env key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-8' }, { id: 'claude-sonnet-5' }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicModelIdsWithStatus({ readOAuthCred: ABSENT })).toStrictEqual({
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

    expect(await fetchAnthropicModelIdsWithStatus({ readOAuthCred: ABSENT })).toStrictEqual({
      status: 'failed',
      category: 'unauthorized',
    });
  });

  it('classifies a 500 as failed/lookup-failed', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    expect(await fetchAnthropicModelIdsWithStatus({ readOAuthCred: ABSENT })).toStrictEqual({
      status: 'failed',
      category: 'lookup-failed',
    });
  });

  it('classifies a network error as failed/lookup-failed', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    expect(await fetchAnthropicModelIdsWithStatus({ readOAuthCred: ABSENT })).toStrictEqual({
      status: 'failed',
      category: 'lookup-failed',
    });
  });

  it('classifies an abort/timeout throw as failed/timeout', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')));

    expect(await fetchAnthropicModelIdsWithStatus({ readOAuthCred: ABSENT })).toStrictEqual({
      status: 'failed',
      category: 'timeout',
    });
  });
});
