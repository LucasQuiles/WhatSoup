import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const alertFns = vi.hoisted(() => ({
  emitAlert: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: alertFns.emitAlert,
  emitAlertChecked: alertFns.emitAlert,
  clearAlertSource: alertFns.clearAlertSource,
  clearAlertSourceChecked: alertFns.clearAlertSource,
}));

import { emitAlert, clearAlertSource } from '../../src/lib/emit-alert.ts';
import {
  checkModelCurrency,
  checkModelCurrencyStatus,
  notifyModelAdvisories,
  notifyModelCurrencyResult,
  notifyModelLiveScanStatus,
  getModelAdvisories,
  fetchLiveModelIds,
  fetchLiveModelIdsWithStatus,
  fetchLiveModelIdsCached,
  resolveModelRole,
  startModelCurrencyMonitor,
  __resetModelAdvisorForTest,
} from '../../src/lib/model-advisor.ts';

const emitAlertMock = vi.mocked(emitAlert);
const clearAlertSourceMock = vi.mocked(clearAlertSource);

beforeEach(() => {
  __resetModelAdvisorForTest();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('fetchLiveModelIds', () => {
  it('skips vendors with no API key (no network calls)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await fetchLiveModelIds()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns model IDs from the vendor list endpoint', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-9' }, { id: 'claude-fable-5' }] }),
    }));
    expect(await fetchLiveModelIds()).toEqual(['claude-opus-4-9', 'claude-fable-5']);
  });

  it('keeps ids empty but records degraded status on network errors', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline sk-ant-secretvalue')));
    expect(await fetchLiveModelIds()).toEqual([]);
    const result = await fetchLiveModelIdsWithStatus();
    expect(result.ids).toEqual([]);
    expect(result.liveScan).toMatchObject({
      mode: 'degraded',
      attemptedVendors: ['anthropic'],
      fetchedCount: 0,
      degradedVendors: [{ vendor: 'anthropic', reason: 'offline [redacted-key]' }],
    });
  });

  it('keeps ids empty but records degraded status on non-OK responses', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await fetchLiveModelIds()).toEqual([]);
    const result = await fetchLiveModelIdsWithStatus();
    expect(result.liveScan).toMatchObject({
      mode: 'degraded',
      degradedVendors: [{ vendor: 'anthropic', status: 401, reason: 'HTTP 401' }],
    });
  });
});

describe('checkModelCurrency', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  it('returns no advisories for an all-current config', async () => {
    const advisories = await checkModelCurrency({
      conversation: 'claude-opus-4-8',
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5',
      fallback: 'gpt-5.4',
    });
    expect(advisories).toEqual([]);
  });

  it('tags advisories with the config role and skips empty slots', async () => {
    const advisories = await checkModelCurrency({
      conversation: 'claude-opus-4-6',
      agent: undefined,
      validation: '',
    });
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({
      role: 'conversation',
      model: 'claude-opus-4-6',
      level: 'upgrade-available',
      recommended: 'claude-opus-4-8',
    });
  });

  it('recommends live-discovered models newer than the static catalog', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-9' }] }),
    }));
    const advisories = await checkModelCurrency({ conversation: 'claude-opus-4-8' });
    expect(advisories[0]).toMatchObject({ level: 'upgrade-available', recommended: 'claude-opus-4-9' });
  });

  it('returns static advisories with degraded live-scan metadata when vendor discovery fails', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const result = await checkModelCurrencyStatus({ conversation: 'claude-opus-4-6' });
    expect(result.advisories[0]).toMatchObject({
      role: 'conversation',
      recommended: 'claude-opus-4-8',
    });
    expect(result.liveScan).toMatchObject({
      mode: 'degraded',
      degradedVendors: [{ vendor: 'anthropic', reason: 'offline' }],
    });
  });
});

describe('notifyModelAdvisories', () => {
  const advisory = {
    model: 'claude-opus-4-6',
    role: 'conversation',
    level: 'upgrade-available' as const,
    recommended: 'claude-opus-4-8',
    message: 'upgrade available',
  };

  it('emits an info alert for upgrade availability', () => {
    notifyModelAdvisories('test-bot', [advisory]);
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    const [instance, source, summary] = emitAlertMock.mock.calls[0];
    expect(instance).toBe('test-bot');
    expect(source).toBe('model-currency');
    expect(summary).toContain('claude-opus-4-6 → claude-opus-4-8');
    expect(summary).toContain('[info]');
  });

  it('escalates to warning when a model is deprecated or retired', () => {
    notifyModelAdvisories('test-bot', [
      advisory,
      { ...advisory, model: 'claude-sonnet-4-20250514', level: 'deprecated', recommended: 'claude-sonnet-4-6' },
    ]);
    expect(emitAlertMock.mock.calls[0][2]).toContain('[warning]');
  });

  it('does not re-alert on an unchanged advisory set', () => {
    notifyModelAdvisories('test-bot', [advisory]);
    notifyModelAdvisories('test-bot', [advisory]);
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
  });

  it('re-alerts when the advisory set changes', () => {
    notifyModelAdvisories('test-bot', [advisory]);
    notifyModelAdvisories('test-bot', [{ ...advisory, recommended: 'claude-opus-4-9' }]);
    expect(emitAlertMock).toHaveBeenCalledTimes(2);
  });

  it('renders a missing recommended model as a placeholder in the summary', () => {
    notifyModelAdvisories('test-bot', [{ ...advisory, recommended: undefined }]);
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    // line 232: `a.recommended ?? '?'` (and line 206 dedup key uses `?? ''`)
    expect(emitAlertMock.mock.calls[0][2]).toContain('claude-opus-4-6 → ?');
  });

  it('clears the alert source once a flagged config comes back clean', () => {
    notifyModelAdvisories('test-bot', [advisory]);
    notifyModelAdvisories('test-bot', []);
    expect(clearAlertSourceMock).toHaveBeenCalledWith('test-bot', 'model-currency');
  });

  it('does not emit clears when nothing was ever alerted', () => {
    notifyModelAdvisories('test-bot', []);
    notifyModelAdvisories('test-bot', []);
    expect(clearAlertSourceMock).not.toHaveBeenCalled();
    expect(emitAlertMock).not.toHaveBeenCalled();
  });

  it('caches advisories for the /health endpoint', () => {
    notifyModelAdvisories('test-bot', [advisory]);
    const snapshot = getModelAdvisories();
    expect(snapshot.checkedAt).toBeTruthy();
    expect(snapshot.advisories).toEqual([advisory]);
  });

  it('emits a separate alert when the live model scan degrades', () => {
    notifyModelLiveScanStatus('test-bot', {
      mode: 'degraded',
      attemptedVendors: ['anthropic'],
      degradedVendors: [{ vendor: 'anthropic', status: 401, reason: 'HTTP 401' }],
      fetchedCount: 0,
    });
    expect(emitAlertMock).toHaveBeenCalledWith(
      'test-bot',
      'model-currency-live-scan',
      expect.stringContaining('anthropic=HTTP 401'),
      expect.stringContaining('"mode":"degraded"'),
      'warning',
    );
    expect(getModelAdvisories().liveScan).toMatchObject({ mode: 'degraded' });
  });

  it('dedupes unchanged live-scan degradation alerts', () => {
    const degraded = {
      mode: 'degraded' as const,
      attemptedVendors: ['openai'],
      degradedVendors: [{ vendor: 'openai', reason: 'offline' }],
      fetchedCount: 0,
    };
    notifyModelLiveScanStatus('test-bot', degraded);
    notifyModelLiveScanStatus('test-bot', degraded);
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
  });

  it('clears the live-scan alert once vendor discovery recovers', () => {
    notifyModelLiveScanStatus('test-bot', {
      mode: 'degraded',
      attemptedVendors: ['openai'],
      degradedVendors: [{ vendor: 'openai', reason: 'offline' }],
      fetchedCount: 0,
    });
    notifyModelLiveScanStatus('test-bot', {
      mode: 'live',
      attemptedVendors: ['openai'],
      degradedVendors: [],
      fetchedCount: 1,
    });
    expect(clearAlertSourceMock).toHaveBeenCalledWith('test-bot', 'model-currency-live-scan');
  });

  it('records monitor results and alerts only the live-scan source when a clean static fallback is degraded', () => {
    notifyModelCurrencyResult('test-bot', {
      advisories: [],
      liveScan: {
        mode: 'degraded',
        attemptedVendors: ['anthropic'],
        degradedVendors: [{ vendor: 'anthropic', reason: 'offline' }],
        fetchedCount: 0,
      },
    });
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    expect(emitAlertMock.mock.calls[0][1]).toBe('model-currency-live-scan');
    expect(getModelAdvisories()).toMatchObject({
      advisories: [],
      liveScan: { mode: 'degraded' },
    });
  });
});

describe('model-advisor.ts uncovered-branch coverage', () => {
  // Flush the unhandled microtask chain kicked off by startModelCurrencyMonitor's
  // `void run()` without resorting to wall-clock delays. fetches are mocked, so a
  // bounded number of microtask drains resolves the immediate run().
  async function flushImmediateRun(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
    }
  }

  // startModelCurrencyMonitor calls `.unref()` on the setInterval handle — return
  // a fake handle that satisfies that contract so the mock does not throw.
  function fakeIntervalHandle(): NodeJS.Timeout {
    return { unref: () => {} } as unknown as NodeJS.Timeout;
  }

  it('fetches model ids from the OpenAI vendor when only OPENAI_API_KEY is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-5.4' }, { id: 'gpt-5.5-mini' }] }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const result = await fetchLiveModelIdsWithStatus();
    expect(result.ids).toEqual(['gpt-5.4', 'gpt-5.5-mini']);
    expect(result.liveScan).toMatchObject({
      mode: 'live',
      attemptedVendors: ['openai'],
      degradedVendors: [],
      fetchedCount: 2,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer fake-openai-key' },
    });
  });

  it('records both vendors as attempted and fetches in parallel when both keys are set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    const fetchSpy = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: async () => ({
        data: new URL(url).hostname === 'api.openai.com'
          ? [{ id: 'gpt-5.4' }]
          : [{ id: 'claude-opus-4-8' }],
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const result = await fetchLiveModelIdsWithStatus();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.liveScan).toMatchObject({
      mode: 'live',
      attemptedVendors: ['anthropic', 'openai'],
      fetchedCount: 2,
    });
    expect(result.ids).toEqual(['claude-opus-4-8', 'gpt-5.4']);
  });

  it('startModelCurrencyMonitor runs once at startup and records advisories + live scan', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(fakeIntervalHandle());
    startModelCurrencyMonitor('test-bot', { conversation: 'claude-opus-4-6' });
    await flushImmediateRun();
    expect(getModelAdvisories()).toMatchObject({
      checkedAt: expect.any(String),
      advisories: [
        expect.objectContaining({ role: 'conversation', model: 'claude-opus-4-6' }),
      ],
      liveScan: { mode: 'static-only' },
    });
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('startModelCurrencyMonitor keeps running and records advisories when the live fetch errors (caught upstream)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', '');
    // fetchModelIds catches this internally and returns a degraded-vendor result;
    // startModelCurrencyMonitor's own catch block therefore must NOT fire — the
    // monitor records the static-catalog advisory and the degraded live scan.
    const fetchSpy = vi.fn().mockRejectedValue(new Error('boom from fetch'));
    vi.stubGlobal('fetch', fetchSpy);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(fakeIntervalHandle());
    startModelCurrencyMonitor('test-bot', { conversation: 'claude-opus-4-6' });
    await flushImmediateRun();
    const snapshot = getModelAdvisories();
    expect(snapshot).toMatchObject({
      checkedAt: expect.any(String),
      advisories: [
        expect.objectContaining({ role: 'conversation', model: 'claude-opus-4-6' }),
      ],
      liveScan: { mode: 'degraded' },
    });
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('startModelCurrencyMonitor swallows a thrown check without crashing the process', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    // Force notifyModelAdvisories (called inside run()) to throw by stubbing
    // Date.prototype.toISOString — `lastCheckedAt = new Date().toISOString()` is
    // the first statement of notifyModelAdvisories, so the throw propagates
    // synchronously out of notifyModelCurrencyResult into run()'s try/catch.
    const toIso = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
      throw new Error('intentional model-currency failure');
    });
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(() => fakeIntervalHandle());
    startModelCurrencyMonitor('test-bot', { conversation: 'claude-opus-4-6' });
    await flushImmediateRun();
    // run()'s catch block fired: no throw escaped the void run(), and the throw
    // landed on the toISOString line so lastCheckedAt stayed null. The daily
    // re-check was still scheduled exactly once.
    expect(getModelAdvisories().checkedAt).toBe(null);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
    toIso.mockRestore();
  });
});

describe('resolveModelRole (symbolic model resolution)', () => {
  // The acceptance live-list from the bead spec.
  const OPENAI_LIVE_RESPONSE = {
    ok: true,
    json: async () => ({
      data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-codex' }, { id: 'gpt-5.4' }, { id: 'gpt-5.6-preview' }],
    }),
  };

  it('returns literal IDs unchanged without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await resolveModelRole('gpt-5.4')).toBe('gpt-5.4');
    expect(await resolveModelRole('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves latest-stable from the live list and caches the fetch', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    const fetchSpy = vi.fn().mockResolvedValue(OPENAI_LIVE_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);
    expect(await resolveModelRole('openai:gpt:latest-stable')).toBe('gpt-5.5');
    expect(await resolveModelRole('openai:gpt:latest-stable')).toBe('gpt-5.5');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // second resolution hit the cache
  });

  it('resolves latest (unfiltered) to the newest served ID including preview', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(OPENAI_LIVE_RESPONSE));
    expect(await resolveModelRole('openai:gpt:latest')).toBe('gpt-5.6-preview');
  });

  it('resolves to the static catalog current when the vendor live-scan is degraded (never throws)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await resolveModelRole('openai:gpt:latest-stable')).toBe('gpt-5.4');
  });

  it('resolves to the static catalog current when no vendor key is configured (static-only)', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn());
    expect(await resolveModelRole('anthropic:opus:latest-stable')).toBe('claude-opus-4-8');
    expect(await resolveModelRole('anthropic:haiku:latest')).toBe('claude-haiku-4-5');
  });

  it('fetchLiveModelIdsCached refreshes on miss and reuses within the TTL', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    const fetchSpy = vi.fn().mockResolvedValue(OPENAI_LIVE_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);
    const first = await fetchLiveModelIdsCached();
    const second = await fetchLiveModelIdsCached();
    expect(first.ids).toContain('gpt-5.5');
    expect(second.ids).toEqual(first.ids);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('checkModelCurrencyStatus advises on the RESOLVED target and re-primes the shared cache', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    const fetchSpy = vi.fn().mockResolvedValue(OPENAI_LIVE_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);
    // The symbolic role resolves to the newest stable (gpt-5.5), which IS
    // current on the live list — so no advisory fires for it, even though the
    // raw symbolic string is not a model ID at all.
    const result = await checkModelCurrencyStatus({ fallback: 'openai:gpt:latest-stable' });
    expect(result.advisories).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The check force-refreshed the shared cache: point-of-use resolution
    // afterwards does not fetch again.
    expect(await resolveModelRole('openai:gpt:latest-stable')).toBe('gpt-5.5');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('checkModelCurrencyStatus still advises when the resolved target is behind the live list', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'fake-openai-key');
    // Live list has only a preview newer than the newest stable: latest-stable
    // resolves to gpt-5.5 and no upgrade advisory fires (preview lines are a
    // different comparison family) — but a LITERAL gpt-5.4 in another role is
    // still flagged against the live list.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(OPENAI_LIVE_RESPONSE));
    const result = await checkModelCurrencyStatus({
      fallback: 'openai:gpt:latest-stable',
      conversation: 'gpt-5.4',
    });
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]).toMatchObject({
      role: 'conversation',
      model: 'gpt-5.4',
      level: 'upgrade-available',
      recommended: 'gpt-5.5',
    });
  });
});
