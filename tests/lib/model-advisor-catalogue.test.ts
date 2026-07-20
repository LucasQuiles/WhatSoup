/**
 * Tests for the /config model catalogue seam in model-advisor.ts:
 *   - classifyModelFetchFailure: the single HTTP-concept classifier shared by
 *     every vendor-facing caller (Q 2b: no per-call-site status→reason drift).
 *   - fetchAnthropicModelIdsWithStatus: anthropic-ONLY live listing, classified
 *     (reuses fetchModelIds; never the multi-vendor flatten).
 *
 * fetch + ANTHROPIC_API_KEY are stubbed (same pattern as model-advisor.test.ts);
 * no real network or key is used.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyModelFetchFailure,
  fetchAnthropicModelIdsWithStatus,
} from '../../src/lib/model-advisor.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('classifyModelFetchFailure', () => {
  it('maps 401 and 403 to unauthorized (the key is not accepted)', () => {
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

describe('fetchAnthropicModelIdsWithStatus', () => {
  it('returns no-key without calling fetch when no anthropic key is present', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({ status: 'no-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok with the anthropic ids on a 200', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-8' }, { id: 'claude-sonnet-5' }] }),
    }));

    expect(await fetchAnthropicModelIdsWithStatus()).toStrictEqual({
      status: 'ok',
      ids: ['claude-opus-4-8', 'claude-sonnet-5'],
    });
  });

  it('classifies a 401 as failed/unauthorized (key present but rejected)', async () => {
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
