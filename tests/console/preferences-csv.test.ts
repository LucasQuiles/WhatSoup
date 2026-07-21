/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('framer-motion', async () => {
  const React = await import('react');
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    motion: {
      div: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => React.createElement('div', props, children),
    },
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useParams: () => ({ name: 'loops' }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock('../../console/src/hooks/toast-context', () => ({
  useToast: () => ({
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLine: () => ({
    data: {
      name: 'loops',
      phone: '+15551234567',
      mode: 'agent',
      status: 'online',
      accessMode: 'allowlist',
      healthPort: 9001,
      uptime: '5m',
      messagesTotal: 0,
      heartbeat: ['up', 'up', 'up'],
      linkedStatus: 'linked',
      sandboxPerChat: false,
      config: { agentOptions: { provider: 'codex-cli' } },
      health: {
        status: 'ok',
        uptime_seconds: 300,
        messages_total: 0,
        whatsapp: { connection: { state: 'connected' } },
        sqlite: { messages_total: 0, schema_version: 1 },
      },
    },
  }),
  useChats: () => ({ data: [] }),
  useMessages: () => ({ data: [] }),
  useAccess: () => ({ data: [] }),
  useLogs: () => ({ data: [] }),
  useTyping: () => ({ data: [] }),
  // LineDetail's checkpoint browser calls useCheckpoints() during render; the
  // mock must expose it or the module throws before the metrics-range assertion.
  useCheckpoints: () => ({ data: undefined, isLoading: false, freshness: undefined }),
  // LineDetail also feeds the live-session inspector (terminal stage A) —
  // useLiveSessions must exist on the mock or the render throws at load.
  useLiveSessions: () => ({ data: undefined, isLoading: false, freshness: { observedAt: null, stale: false } }),
  // Agent-mode SummaryTab embeds ProvidersKeysCard, which reads these hooks.
  useProviders: () => ({ data: [] }),
  useProviderStatus: () => ({
    data: {
      primary: { provider: 'codex-cli', model: null, keyPresent: null },
      fallback: { provider: null, model: null, keyPresent: null, active: false, activeUntil: null },
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../../console/src/hooks/use-metrics', () => ({
  useMetrics: () => ({
    data: {
      range: '24h',
      messageVolume: [],
      tokenUsage: [],
      sessionActivity: [],
      tokenUsageByProvider: {},
      sessionActivityByProvider: {},
      activeHours: [],
      activeHoursByDate: [],
      hasMessageData: false,
      hasTokenData: false,
      hasSessionData: false,
      providers: [],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const store: Record<string, string> = {};
const mockStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
};
const browserStore: Record<string, string> = {};

function installLocalStorage(): void {
  for (const key in browserStore) delete browserStore[key];
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => browserStore[key] ?? null,
    setItem: (key: string, value: string) => { browserStore[key] = value; },
    removeItem: (key: string) => { delete browserStore[key]; },
    clear: () => { for (const key in browserStore) delete browserStore[key]; },
  });
}

beforeEach(() => installLocalStorage());

describe('preferences', () => {
  beforeEach(() => { for (const k in store) delete store[k]; });

  it('getPreference returns default when key not set', async () => {
    const { getPreference } = await import('../../console/src/lib/preferences.ts');
    expect(getPreference('metricsRange', '24h', mockStorage as any)).toBe('24h');
  });

  it('setPreference persists and getPreference retrieves', async () => {
    const { getPreference, setPreference } = await import('../../console/src/lib/preferences.ts');
    setPreference('metricsRange', '7d', mockStorage as any);
    expect(getPreference('metricsRange', '24h', mockStorage as any)).toBe('7d');
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

describe('metricsToCSV', () => {
  it('converts message volume to CSV string', async () => {
    const { metricsToCSV } = await import('../../console/src/lib/csv-export.ts');
    const csv = metricsToCSV([
      { bucket: '2026-01-01T00:00:00Z', inbound: 5, outbound: 3, media: 0 },
      { bucket: '2026-01-01T01:00:00Z', inbound: 2, outbound: 1, media: 0 },
    ]);
    expect(csv).toContain('bucket,inbound,outbound');
    expect(csv).toContain('2026-01-01T00:00:00Z,5,3');
    expect(csv).toContain('2026-01-01T01:00:00Z,2,1');
  });

  it('returns header-only for empty data', async () => {
    const { metricsToCSV } = await import('../../console/src/lib/csv-export.ts');
    expect(metricsToCSV([])).toBe('bucket,inbound,outbound');
  });
});

// ---------------------------------------------------------------------------
// Integration checks
// ---------------------------------------------------------------------------

describe('MetricsTab CSV export integration', () => {
  it('exports MetricsTab message volume through the CSV download path', async () => {
    const { MetricsTab } = await import('../../console/src/components/line-detail/MetricsTab.tsx');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const createObjectURL = vi.fn((blob: Blob) => {
      expect(blob).toBeInstanceOf(Blob);
      return 'blob:metrics';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    render(createElement(MetricsTab, {
      metrics: {
        range: '7d',
        messageVolume: [{ bucket: '2026-01-01T00:00:00Z', inbound: 5, outbound: 3, media: 0 }],
        tokenUsage: [],
        sessionActivity: [],
        tokenUsageByProvider: {},
        sessionActivityByProvider: {},
        activeHours: [],
        activeHoursByDate: [],
        hasMessageData: true,
        hasTokenData: false,
        hasSessionData: false,
        providers: [],
      },
      metricsLoading: false,
      metricsError: null,
      metricsRange: '7d',
      setMetricsRange: vi.fn(),
      lineName: 'loops',
    }));

    fireEvent.click(screen.getByLabelText('Export metrics as CSV'));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeDefined();
    if (!blob) throw new Error('expected CSV export to create a blob URL');
    expect(await blob.text()).toBe('bucket,inbound,outbound\n2026-01-01T00:00:00Z,5,3');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:metrics');
  });
});

describe('LineDetail preferences integration', () => {
  it('loads and persists the metrics range preference through the rendered page', async () => {
    localStorage.setItem('whatsoup:metricsRange', '30d');
    const { default: LineDetail } = await import('../../console/src/pages/LineDetail.tsx');

    render(createElement(LineDetail));
    fireEvent.click(screen.getByRole('tab', { name: 'Metrics' }));

    // DD-15: range seg is now ToolbarTimeRange — pressed state is the semantic
    // contract, not a class toggle.
    expect(screen.getByRole('button', { name: '30d' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '7d' }));
    expect(localStorage.getItem('whatsoup:metricsRange')).toBe('7d');
  });
});
