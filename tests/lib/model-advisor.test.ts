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
