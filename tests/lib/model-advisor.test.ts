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
  notifyModelAdvisories,
  getModelAdvisories,
  fetchLiveModelIds,
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

  it('fails open on network errors', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchLiveModelIds()).toEqual([]);
  });

  it('fails open on non-OK responses', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await fetchLiveModelIds()).toEqual([]);
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
});
