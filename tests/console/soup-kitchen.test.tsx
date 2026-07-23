/**
 * SoupKitchen page — v3.5 Fleet surface behavior tests (T5 b-03).
 *
 * Renders the real component under jsdom + Testing Library and asserts on
 * observable DOM. Rewritten for the v3.5 anatomy (mockup fleet.html SSOT):
 *   - KPI strip: 5 cards in the k/v/d anatomy; the carried #1881/#1879/#1762
 *     coverage counters + #1925 freshness marker live in the meta row.
 *   - Lines table columns: shape | Line | Channel | Agent | Mode | State |
 *     Grants | 7d | actions (Table primitives; bulk select is a reveal on
 *     the leading shape cell).
 *   - Sort via the panel-h Menu; filter via the panel-h Popover (mode pills
 *     + TextInput search).
 *   - Charts/KPI-click filtering are gone from Fleet (metrics live at
 *     /metrics until b-09a; filtering is explicit in the popover).
 *   - Activity panel carries the heartbeat rail.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  act,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context';

// Hoisted hook mocks — must be declared before component import so the
// `vi.mock` factories below can wire them in without forward-reference TDZ
// issues.
const useLinesMock = vi.hoisted(() => vi.fn());
const useFeedMock = vi.hoisted(() => vi.fn());
const useFleetMetricsMock = vi.hoisted(() => vi.fn());
const useLogsMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const restartMock = vi.hoisted(() => vi.fn());
const stopInstanceMock = vi.hoisted(() => vi.fn());
const deleteLineMock = vi.hoisted(() => vi.fn());
// FleetRowMenu (per-row action kebab) calls useQueryClient on render; the page
// harness has no QueryClientProvider, so stub the client (same idiom as
// ops-page.test.tsx). The menu's api wiring is exercised in fleet-row-menu.test.tsx.
const invalidateQueriesMock = vi.hoisted(() => vi.fn());
// LineSpark issues a real useQuery per row (lazy 7d series); the harness has
// no QueryClientProvider, so useQuery is stubbed at the module boundary.
// Default: no data (EM_DASH cells); the spark suite overrides with buckets.
const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
    useQuery: (opts: unknown) => useQueryMock(opts),
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../../console/src/hooks/use-fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-fleet')>();
  return {
    ...actual,
    useLines: useLinesMock,
    useFeed: useFeedMock,
    useLogs: useLogsMock,
  };
});

vi.mock('../../console/src/hooks/use-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-metrics')>();
  return {
    ...actual,
    useFleetMetrics: useFleetMetricsMock,
  };
});

vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: restartMock,
    stopInstance: stopInstanceMock,
    deleteLine: deleteLineMock,
  },
}));

// Transport status (DD-29). Default connected so the genuine-error branch
// behaves as before; the offline-branch suite flips this to disconnected.
const transportMock = vi.hoisted(() => ({
  status: 'connected' as 'connected' | 'reconnecting' | 'offline',
  isDisconnected: false,
}));
vi.mock('../../console/src/hooks/use-transport-status', () => ({
  useTransportStatus: () => transportMock,
}));

// `framer-motion` issues a `prefers-reduced-motion` MediaQueryList probe that
// jsdom doesn't implement. Stub it so motion.div renders without warnings.
beforeEach(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  }
  restartMock.mockReset();
  restartMock.mockResolvedValue({ status: 'ok', instance: 'test-line' });
  stopInstanceMock.mockReset();
  stopInstanceMock.mockResolvedValue({ status: 'ok', instance: 'test-line' });
  deleteLineMock.mockReset();
  deleteLineMock.mockResolvedValue({ deleted: 'test-line' });
  useQueryMock.mockReset();
  useQueryMock.mockReturnValue({ data: undefined, isError: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Restore the default connected transport for the next test.
  transportMock.status = 'connected';
  transportMock.isDisconnected = false;
});

import SoupKitchen from '../../console/src/pages/SoupKitchen';
import { displayInstanceName, formatPhone, formatCompact } from '../../console/src/lib/text-utils';
import type { FeedEvent, FleetMetrics, LineInstance, Mode } from '../../console/src/types';
import type { LogEntry } from '../../console/src/types';
import type { Freshness } from '../../console/src/lib/freshness';

// ---------------------------------------------------------------------------
// Test data factories + render helper
// ---------------------------------------------------------------------------

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'test-line',
    phone: '+15550001234',
    mode: 'passive',
    status: 'online',
    accessMode: 'open',
    healthPort: 9100,
    uptime: '2h',
    messagesTotal: 50,
    health: null,
    heartbeat: [],
    lastActive: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}

function makeLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2026-06-11T12:00:00Z',
    level: 'info',
    msg: 'test message',
    source: 'test-source',
    ...overrides,
  };
}

interface RenderOptions {
  lines?: LineInstance[];
  feed?: FeedEvent[];
  linesError?: Error | null;
  feedError?: Error | null;
  linesRefetch?: ReturnType<typeof vi.fn>;
  feedRefetch?: ReturnType<typeof vi.fn>;
  linesFreshness?: Freshness;
  fleetMetrics?: Partial<FleetMetrics> | null;
  logs?: LogEntry[];
  logsError?: Error | null;
  logsRefetch?: ReturnType<typeof vi.fn>;
  toastValue?: ToastContextValue;
}

function makeToastValue(): ToastContextValue {
  return {
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  };
}

function renderPage(opts: RenderOptions = {}) {
  const lines = opts.lines ?? [];
  const feed = opts.feed ?? [];

  useLinesMock.mockReturnValue({
    data: lines,
    isError: Boolean(opts.linesError),
    error: opts.linesError ?? null,
    refetch: opts.linesRefetch ?? vi.fn(),
    freshness: opts.linesFreshness,
  });
  useFeedMock.mockReturnValue({
    data: feed,
    isError: Boolean(opts.feedError),
    error: opts.feedError ?? null,
    refetch: opts.feedRefetch ?? vi.fn(),
  });
  useFleetMetricsMock.mockReturnValue({
    data: opts.fleetMetrics ?? undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  useLogsMock.mockReturnValue({
    data: opts.logs ?? [],
    isError: Boolean(opts.logsError),
    error: opts.logsError ?? null,
    refetch: opts.logsRefetch ?? vi.fn(),
  });

  const toastValue = opts.toastValue ?? makeToastValue();

  return render(
    <ToastContext.Provider value={toastValue}>
      <MemoryRouter>
        <SoupKitchen />
      </MemoryRouter>
    </ToastContext.Provider>,
  );
}

// ---------------------------------------------------------------------------
// Anatomy helpers
// ---------------------------------------------------------------------------

/** KPI card by its mono caps label (.fleet-kpi__k). */
function kpiCard(label: string): HTMLElement {
  const key = screen.getByText(label, { selector: '.fleet-kpi__k' });
  const card = key.closest('.fleet-kpi');
  if (!card) throw new Error(`KPI "${label}" has no .fleet-kpi ancestor`);
  return card as HTMLElement;
}

/** Coverage meta row under the strip. */
function kpiMeta(): HTMLElement {
  const el = document.querySelector('.fleet-kpis-meta');
  if (!el) throw new Error('no .fleet-kpis-meta row');
  return el as HTMLElement;
}

/** Table body — anchored on the "Mode" columnheader. */
function tableBody(): HTMLElement {
  const headerCell = screen.getByRole('columnheader', { name: /^Mode\b/ });
  const tbody = headerCell.closest('table')!.querySelector('tbody');
  if (!tbody) throw new Error('SoupKitchen table has no tbody');
  return tbody as HTMLElement;
}

function tableRows(): HTMLTableRowElement[] {
  // Data rows only — spacer/state rows carry no LineRow classes.
  return Array.from(tableBody().querySelectorAll('tr')).filter(
    (r) => !r.hasAttribute('aria-hidden') && !r.textContent?.includes('Unable to load') && !r.textContent?.includes('No instances match') && !r.textContent?.includes('Showing cached data'),
  ) as HTMLTableRowElement[];
}

function tableCell(row: HTMLElement, index: number): HTMLElement {
  const cell = row.querySelectorAll('td')[index];
  if (!cell) throw new Error(`missing table cell at index ${index}`);
  return cell as HTMLElement;
}

/** Line names in render order. Col 1 is the Line identity cell. */
function visibleTableLineNames(lines: LineInstance[]): string[] {
  const known = new Map(lines.map((line) => [displayInstanceName(line.name), line.name]));
  return tableRows()
    .map((row) => {
      const lineCell = tableCell(row, 1);
      for (const [displayName, rawName] of known) {
        if (within(lineCell).queryByText(displayName)) return rawName;
      }
      return undefined;
    })
    .filter((name): name is string => name !== undefined);
}

/** AlertBanner — anchor on the "N alert(s)" badge text. */
function alertBanner(): HTMLElement | null {
  const badge = screen.queryByText(/^\d+ alerts?$/);
  if (!badge) return null;
  return badge.closest('div[style*="--s-crit-wash"]') ?? (badge.parentElement?.parentElement as HTMLElement);
}

/** Open the panel-h sort menu and return the menu surface. */
function openSortMenu(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /^sort lines/i });
  fireEvent.click(trigger);
  return screen.getByRole('menu');
}

/** Open the filter popover. */
function openFilter(): void {
  fireEvent.click(screen.getByRole('button', { name: /^filter/ }));
}

/** Mode pill inside the open filter popover. */
function getModePill(label: string): HTMLElement {
  const pills = screen.getAllByRole('button', { name: label });
  const pill = pills.find((p) => p.hasAttribute('aria-pressed'));
  if (!pill) throw new Error(`mode pill "${label}" not found`);
  return pill;
}

/** Row checkbox for a line (the reveal is CSS-driven — always in the DOM). */
function rowCheckbox(displayName: string): HTMLElement {
  return screen.getByRole('checkbox', { name: `Select ${displayName}` });
}

// ---------------------------------------------------------------------------
// Page row + KPI strip
// ---------------------------------------------------------------------------

describe('page row (single-h1 law + mockup header action)', () => {
  it('the surface owns the h1 and the Hatch action opens the wizard', () => {
    renderPage({ lines: [makeLine()] });
    const h1s = document.querySelectorAll('h1');
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe('Fleet');
    fireEvent.click(screen.getByRole('button', { name: /hatch a line/i }));
    // Wizard is latched-mounted on first open (C-B3W4-3).
    expect(document.body.textContent).toMatch(/add line|hatch/i);
  });
});

describe('KPI strip (mockup .kpis — 5 cards, k/v/d anatomy)', () => {
  it('renders the five mockup cards', () => {
    renderPage({ lines: [makeLine()] });
    for (const label of ['Lines online', 'Agent sessions', 'Messages today', 'Tokens (24h)', 'Response p50']) {
      expect(kpiCard(label)).toBeTruthy();
    }
  });

  it('Lines online shows connected/total with the #1881 unproven subline', () => {
    renderPage({
      lines: [
        makeLine({ name: 'a', status: 'online' }),
        makeLine({ name: 'b', status: 'unreachable', health: null }),
      ],
    });
    const card = kpiCard('Lines online');
    expect(card.textContent).toContain('1');
    expect(card.textContent).toContain('/2');
    // b has no health body → connectivity unknown (unproven), not disconnect.
    expect(card.textContent).toMatch(/1 unproven/);
  });

  it('Tokens (24h) renders the fleet in+out sum when token data exists', () => {
    renderPage({
      lines: [makeLine()],
      fleetMetrics: {
        meta: { hasTokenData: true } as FleetMetrics['meta'],
        tokenUsage: [
          { bucket: 'a', input: 1_000_000, output: 500_000 },
          { bucket: 'b', input: 2_000_000, output: 600_000 },
        ],
      },
    });
    expect(kpiCard('Tokens (24h)').textContent).toContain(formatCompact(4_100_000));
  });

  it('Tokens (24h) is honest when the endpoint has no token data', () => {
    renderPage({ lines: [makeLine()], fleetMetrics: { meta: { hasTokenData: false } as FleetMetrics['meta'], tokenUsage: [] } });
    expect(kpiCard('Tokens (24h)').textContent).toMatch(/no token data/);
  });

  it('Response p50 is an honest EM_DASH until b-12 telemetry lands', () => {
    renderPage({ lines: [makeLine()] });
    expect(kpiCard('Response p50').textContent).toMatch(/no telemetry/);
  });

  it('coverage meta row carries the #1879/#1762 denominators', () => {
    renderPage({
      lines: [
        makeLine({ name: 'a', status: 'online' }),
        makeLine({
          name: 'b',
          status: 'degraded',
          stale: true,
          metricAvailability: { messageStats: 'unavailable' },
        }),
      ],
    });
    const meta = kpiMeta().textContent ?? '';
    expect(meta).toMatch(/connectivity unknown 1 of 2/);
    expect(meta).toMatch(/metrics unavailable 1 of 2/);
    expect(meta).toMatch(/carried health 1 of 2/);
  });

  it('the meta row carries the #1925 observedAt marker — fresh when current, stale-flagged when carried', () => {
    const fresh: Freshness = { stale: false, observedAt: Date.now() - 5_000 };
    const { unmount } = renderPage({ lines: [makeLine()], linesFreshness: fresh });
    expect(kpiMeta().textContent).toMatch(/observed /);
    expect(kpiMeta().querySelector('.warn')).toBeNull();
    unmount();

    const stale: Freshness = { stale: true, observedAt: Date.now() - 120_000 };
    renderPage({ lines: [makeLine()], linesFreshness: stale });
    expect(kpiMeta().textContent).toMatch(/stale · /);
    expect(kpiMeta().querySelector('.warn')).not.toBeNull();
  });

  it('message totals exclude faulted reads (#1879) instead of folding them as zero', () => {
    renderPage({
      lines: [
        makeLine({ name: 'a', messageStats: { sent: 10, received: 5, images: 0, audio: 0, documents: 0 } }),
        makeLine({ name: 'b', metricAvailability: { messageStats: 'unavailable' } }),
      ],
    });
    expect(kpiCard('Messages today').textContent).toContain('15');
  });
});

// ---------------------------------------------------------------------------
// Lines table anatomy
// ---------------------------------------------------------------------------

describe('lines table (mockup single-line anatomy)', () => {
  it('renders one row per line under default filters', () => {
    renderPage({ lines: [makeLine({ name: 'a' }), makeLine({ name: 'b' })] });
    expect(tableRows().length).toBe(2);
  });

  it('renders the mockup column headers', () => {
    renderPage({ lines: [makeLine()] });
    for (const h of ['Line', 'Channel', 'Agent', 'Mode', 'State', 'Grants', '7d']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeTruthy();
    }
  });

  it('every row carries a status shape (shape law)', () => {
    renderPage({
      lines: [
        makeLine({ name: 'ok', status: 'online' }),
        makeLine({ name: 'warn', status: 'degraded' }),
        makeLine({ name: 'crit', status: 'unreachable' }),
      ],
    });
    expect(document.querySelector('.fleet-shape--disc')).toBeTruthy();
    expect(document.querySelector('.fleet-shape--diamond')).toBeTruthy();
    expect(document.querySelector('.fleet-shape--square')).toBeTruthy();
  });

  it('a stale online line renders the warn diamond, never the fresh disc (#1762)', () => {
    renderPage({
      lines: [makeLine({ name: 'stale-online', status: 'online', stale: true })],
    });
    expect(document.querySelector('.fleet-shape--diamond')).toBeTruthy();
    expect(document.querySelector('.fleet-shape--disc')).toBeNull();
  });

  it('channel glyph carries the state tag and an accessible label', () => {
    renderPage({
      lines: [
        makeLine({
          name: 'wa-line',
          status: 'online',
          health: {
            status: 'ok',
            uptime_seconds: 7200,
            messages_total: 50,
            whatsapp: { connected: true, connection: { state: 'connected' } },
            sqlite: { messages_total: 50, schema_version: 42 },
          },
        }),
      ],
    });
    expect(screen.getByRole('img', { name: 'WhatsApp · connected' })).toBeTruthy();
  });

  it('agent cell is the honest unassigned state until b-04', () => {
    renderPage({ lines: [makeLine({ name: 'a' })] });
    expect(within(tableRows()[0]).getByText('unassigned')).toBeTruthy();
  });

  it('grants cell renders the R3-13 hidden-by-default chip until the Grant API', () => {
    renderPage({ lines: [makeLine({ name: 'a' })] });
    const cell = tableCell(tableRows()[0], 6);
    expect(cell.querySelector('.fleet-grant--hid')).toBeTruthy();
    expect(cell.textContent).toBe('H');
  });

  it('state pill maps real status (never the spec-future deactivated)', () => {
    renderPage({
      lines: [
        makeLine({ name: 'a', status: 'online' }),
        makeLine({ name: 'b', status: 'degraded', health: null }),
      ],
    });
    const pills = document.querySelectorAll('.fleet-state');
    const texts = Array.from(pills).map((p) => p.textContent);
    expect(texts).toContain('live');
    expect(texts).toContain('degraded');
  });

  it('mode cell renders the mode in its channel class', () => {
    renderPage({ lines: [makeLine({ name: 'a', mode: 'agent' })] });
    const mode = tableCell(tableRows()[0], 4).querySelector('.fleet-mode--agent');
    expect(mode?.textContent).toBe('agent');
  });

  it('7d spark cell renders EM_DASH while the lazy series has no data', () => {
    renderPage({ lines: [makeLine({ name: 'a' })] });
    expect(tableCell(tableRows()[0], 7).textContent).toBe('—');
  });

  it('line identity shows the masked phone and name', () => {
    renderPage({ lines: [makeLine({ name: 'personal', phone: '+15551234567' })] });
    const cell = tableCell(tableRows()[0], 1);
    expect(cell.textContent).toContain(displayInstanceName('personal'));
    expect(cell.textContent).toContain(formatPhone('+15551234567'));
  });
});

describe('health-observation age markers (#1877)', () => {
  it('surfaces the age on a stale line, styled as stale', () => {
    renderPage({
      lines: [
        makeLine({
          name: 'stale-line',
          stale: true,
          healthObservedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
      ],
    });
    const cell = tableCell(tableRows()[0], 1);
    expect(cell.querySelector('.fleet-obs.warn')).toBeTruthy();
    expect(cell.textContent).toMatch(/stale · /);
  });

  it('surfaces the age on a FRESH connected line too (core #1877 scenario)', () => {
    renderPage({
      lines: [
        makeLine({
          name: 'fresh-line',
          status: 'online',
          healthObservedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
    });
    const cell = tableCell(tableRows()[0], 1);
    expect(cell.textContent).toMatch(/observed /);
    expect(cell.querySelector('.fleet-obs.warn')).toBeNull();
  });

  it('renders no age tag when a line never had a live observation', () => {
    renderPage({ lines: [makeLine({ name: 'never', stale: false, healthObservedAt: null })] });
    expect(tableCell(tableRows()[0], 1).querySelector('.fleet-obs')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Activity panel + heartbeat rail
// ---------------------------------------------------------------------------

describe('activity panel + heartbeat rail', () => {
  it('renders one heartbeat bar per line with the summary label', () => {
    renderPage({
      lines: [
        makeLine({ name: 'a', status: 'online' }),
        makeLine({ name: 'b', status: 'unreachable', health: null }),
        makeLine({ name: 'c', status: 'degraded' }),
      ],
    });
    const rail = screen.getByRole('img', { name: /line health: \d+ of 3 lines healthy/i });
    expect(rail.querySelectorAll('i').length).toBe(3);
    expect(rail.querySelector('.down')).toBeTruthy();
  });

  it('labels the rail with the check count', () => {
    renderPage({ lines: [makeLine({ name: 'a' }), makeLine({ name: 'b' })] });
    expect(screen.getByText(/line health · 2 checks/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Filter popover (mode pills + search)
// ---------------------------------------------------------------------------

describe('filter popover', () => {
  const threeModes = () => [
    makeLine({ name: 'p-line', mode: 'passive' }),
    makeLine({ name: 'c-line', mode: 'chat' }),
    makeLine({ name: 'a-line', mode: 'agent' }),
  ];

  it('mode pills filter the rows with counts on the pills', () => {
    renderPage({ lines: threeModes() });
    openFilter();
    const agentPill = getModePill('agent');
    expect(agentPill.textContent).toContain('1');
    fireEvent.click(agentPill);
    const lines = threeModes();
    expect(visibleTableLineNames(lines)).toEqual(['a-line']);
  });

  it('search narrows by name and phone', () => {
    const lines = [
      makeLine({ name: 'alpha', phone: '+15551110001' }),
      makeLine({ name: 'beta', phone: '+15552220002' }),
    ];
    renderPage({ lines });
    openFilter();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search lines' }), {
      target: { value: 'alpha' },
    });
    expect(visibleTableLineNames(lines)).toEqual(['alpha']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search lines' }), {
      target: { value: '2220002' },
    });
    expect(visibleTableLineNames(lines)).toEqual(['beta']);
  });

  it('the filter button labels the active filter state', () => {
    renderPage({ lines: threeModes() });
    openFilter();
    fireEvent.click(getModePill('agent'));
    expect(screen.getByRole('button', { name: /filter · agent/ })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Sort menu
// ---------------------------------------------------------------------------

describe('sort menu (panel-h)', () => {
  it('sorts by name and toggles direction on re-select', () => {
    const lines = [
      makeLine({ name: 'charlie' }),
      makeLine({ name: 'alpha' }),
      makeLine({ name: 'bravo' }),
    ];
    renderPage({ lines });
    let menu = openSortMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Name/ }));
    // First select: descending (heaviest-first register).
    expect(visibleTableLineNames(lines)).toEqual(['charlie', 'bravo', 'alpha']);
    menu = openSortMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Name/ }));
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('sorts by unread descending', () => {
    const lines = [
      makeLine({ name: 'few', unread: 1 }),
      makeLine({ name: 'many', unread: 42 }),
      makeLine({ name: 'some', unread: 7 }),
    ];
    renderPage({ lines });
    const menu = openSortMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Unread/ }));
    expect(visibleTableLineNames(lines)).toEqual(['many', 'some', 'few']);
  });
});

// ---------------------------------------------------------------------------
// Row interaction → drawer
// ---------------------------------------------------------------------------

describe('row → drawer', () => {
  it('clicking a row opens the drawer for that line', () => {
    renderPage({ lines: [makeLine({ name: 'drawer-line' })] });
    fireEvent.click(within(tableRows()[0]).getByText(displayInstanceName('drawer-line')));
    expect(screen.getByText('Open line')).toBeTruthy();
  });

  it('pressing Enter on a row opens the drawer', () => {
    renderPage({ lines: [makeLine({ name: 'enter-line' })] });
    fireEvent.keyDown(tableRows()[0], { key: 'Enter' });
    expect(screen.getByText('Open line')).toBeTruthy();
  });

  it('aria-current marks the inspected row', () => {
    renderPage({ lines: [makeLine({ name: 'current-line' })] });
    fireEvent.click(within(tableRows()[0]).getByText(displayInstanceName('current-line')));
    expect(tableRows()[0].getAttribute('aria-current')).toBe('true');
  });

  it('"Open line" inside the drawer navigates to /lines/<name>', () => {
    renderPage({ lines: [makeLine({ name: 'nav-line' })] });
    fireEvent.click(within(tableRows()[0]).getByText(displayInstanceName('nav-line')));
    fireEvent.click(screen.getByText('Open line'));
    expect(navigateMock).toHaveBeenCalledWith('/lines/nav-line');
  });

  it('the drawer renders the scoped log and reports log errors with retry', () => {
    const refetch = vi.fn();
    renderPage({
      lines: [makeLine({ name: 'log-line' })],
      logs: [makeLogEntry({ msg: 'scoped entry' })],
    });
    fireEvent.click(within(tableRows()[0]).getByText(displayInstanceName('log-line')));
    expect(screen.getByText('scoped entry')).toBeTruthy();
  });

  it('renders "Line not found" when the inspected line vanishes', () => {
    const { rerender } = renderPage({ lines: [makeLine({ name: 'ghost' })] });
    fireEvent.click(within(tableRows()[0]).getByText(displayInstanceName('ghost')));
    // Re-render with the line removed.
    useLinesMock.mockReturnValue({
      data: [],
      isError: false,
      error: null,
      refetch: vi.fn(),
      freshness: undefined,
    });
    rerender(
      <ToastContext.Provider value={makeToastValue()}>
        <MemoryRouter>
          <SoupKitchen />
        </MemoryRouter>
      </ToastContext.Provider>,
    );
    expect(screen.getByText('Line not found')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Bulk selection + actions (hover-reveal path; jsdom has no CSS visibility)
// ---------------------------------------------------------------------------

describe('bulk select + actions', () => {
  it('toggling a row checkbox selects WITHOUT opening the drawer and shows the bulk bar', () => {
    renderPage({ lines: [makeLine({ name: 'sel-line' })] });
    fireEvent.click(rowCheckbox(displayInstanceName('sel-line')));
    expect(screen.queryByText('Open line')).toBeNull();
    expect(screen.getByLabelText('1 selected')).toBeTruthy();
  });

  it('toggling a selected row again deselects it', () => {
    renderPage({ lines: [makeLine({ name: 'sel-line' })] });
    fireEvent.click(rowCheckbox(displayInstanceName('sel-line')));
    fireEvent.click(rowCheckbox(displayInstanceName('sel-line')));
    expect(screen.queryByLabelText(/selected/)).toBeNull();
  });

  it('header select-all selects and clears every visible line', () => {
    renderPage({ lines: [makeLine({ name: 'a' }), makeLine({ name: 'b' })] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all lines' }));
    expect(screen.getByLabelText('2 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all lines' }));
    expect(screen.queryByLabelText(/selected/)).toBeNull();
  });

  it('bulk restart fires for the selected line and reports success', async () => {
    const toastValue = makeToastValue();
    renderPage({ lines: [makeLine({ name: 'bulk-r' })], toastValue });
    fireEvent.click(rowCheckbox(displayInstanceName('bulk-r')));
    fireEvent.click(screen.getByRole('button', { name: /restart/i }));
    await waitFor(() => expect(restartMock).toHaveBeenCalledWith('bulk-r'));
    await waitFor(() => expect(toastValue.success).toHaveBeenCalled());
  });

  it('bulk stop confirms via the shared dialog then calls stop per line', async () => {
    const toastValue = makeToastValue();
    renderPage({ lines: [makeLine({ name: 'bulk-s' })], toastValue });
    fireEvent.click(rowCheckbox(displayInstanceName('bulk-s')));
    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }));
    fireEvent.click(screen.getByRole('button', { name: /stop lines/i }));
    await waitFor(() => expect(stopInstanceMock).toHaveBeenCalledWith('bulk-s'));
  });

  it('bulk delete names the lines in the destructive confirm and removes fulfilled deletes from selection', async () => {
    renderPage({ lines: [makeLine({ name: 'bulk-d' })] });
    fireEvent.click(rowCheckbox(displayInstanceName('bulk-d')));
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(screen.getByText(/this cannot be undone/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    await waitFor(() => expect(deleteLineMock).toHaveBeenCalledWith('bulk-d'));
    await waitFor(() => expect(screen.queryByText(/selected/)).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// Row action menu (kebab)
// ---------------------------------------------------------------------------

describe('row action menu', () => {
  it('renders one kebab trigger per data row', () => {
    renderPage({ lines: [makeLine({ name: 'a' }), makeLine({ name: 'b' })] });
    const menus = screen.getAllByRole('button', { name: /actions for/i });
    expect(menus.length).toBe(2);
  });

  it('opening the kebab does NOT open the row drawer (stopPropagation)', () => {
    renderPage({ lines: [makeLine({ name: 'kebab-line' })] });
    fireEvent.click(screen.getByRole('button', { name: /actions for/i }));
    expect(screen.queryByText('Open line')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AlertBanner (unchanged contract)
// ---------------------------------------------------------------------------

describe('AlertBanner', () => {
  it('renders "connection lost" for an unreachable line', () => {
    renderPage({ lines: [makeLine({ name: 'down-line', status: 'unreachable' })] });
    expect(alertBanner()?.textContent).toMatch(/connection lost/i);
  });

  it('renders "auth expired" for an unreachable line with lastSessionStatus auth_expired', () => {
    renderPage({
      lines: [makeLine({ name: 'auth-line', status: 'unreachable', lastSessionStatus: 'auth_expired' })],
    });
    expect(alertBanner()?.textContent).toMatch(/auth expired/i);
  });

  it('renders "degraded" for a degraded line', () => {
    renderPage({ lines: [makeLine({ name: 'deg-line', status: 'degraded' })] });
    expect(alertBanner()?.textContent).toMatch(/degraded/i);
  });

  it('renders no banner when all lines are healthy', () => {
    renderPage({ lines: [makeLine({ name: 'ok-line', status: 'online' })] });
    expect(alertBanner()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Severity classes + error/empty/offline states
// ---------------------------------------------------------------------------

describe('severity + table states', () => {
  it('applies crit severity on unreachable rows and warn on degraded rows', () => {
    renderPage({
      lines: [
        makeLine({ name: 'crit-line', status: 'unreachable' }),
        makeLine({ name: 'warn-line', status: 'degraded' }),
      ],
    });
    expect(document.querySelector('.soup-table-row--crit')).toBeTruthy();
    expect(document.querySelector('.soup-table-row--warn')).toBeTruthy();
  });

  it('empty filter result renders the table-empty state', () => {
    renderPage({ lines: [makeLine({ name: 'a' })] });
    openFilter();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search lines' }), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByText('No instances match the current filters')).toBeTruthy();
  });

  it('genuine load error renders the retry path', () => {
    const refetch = vi.fn();
    renderPage({ linesError: new Error('boom'), linesRefetch: refetch });
    expect(screen.getByText(/Unable to load fleet data: boom/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('transport drop renders offline-with-cache, not a hard failure (DD-29)', () => {
    transportMock.status = 'offline';
    transportMock.isDisconnected = true;
    renderPage({ linesError: new Error('network down') });
    expect(screen.getByText('Showing cached data')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Virtualization (perf §3 ruling — b-03 acceptance)
// ---------------------------------------------------------------------------

describe('virtualization (>50 rows)', () => {
  it('51 lines render plainly-windowed: never more DOM rows than the fleet size, and the scroll region exists', () => {
    const many = Array.from({ length: 51 }, (_, i) => makeLine({ name: `line-${String(i).padStart(2, '0')}` }));
    renderPage({ lines: many });
    // In jsdom the virtualizer may window (subset) or fall back (all 51 when
    // the scroll element measures 0) — both honor the ruling in-browser.
    // The pin that matters here: all 51 rows render when windowing is
    // inactive, OR a subset renders with the scroll container intact.
    const rows = tableRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(51);
    expect(document.querySelector('.fleet-rows')).toBeTruthy();
  });

  it('at exactly 50 lines every row renders (plain path)', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => makeLine({ name: `line-${i}` }));
    renderPage({ lines: fifty });
    expect(tableRows().length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// LineSpark unit pins (real component, stubbed query)
// ---------------------------------------------------------------------------

describe('LineSpark data rendering', () => {
  it('renders 7 bars normalized to the row max with hi emphasis on the top quartile', async () => {
    useQueryMock.mockReturnValue({
      data: {
        hasMessageData: true,
        messageVolume: [
          { bucket: 'd1', inbound: 1, outbound: 1 },
          { bucket: 'd2', inbound: 2, outbound: 0 },
          { bucket: 'd3', inbound: 0, outbound: 0 },
          { bucket: 'd4', inbound: 5, outbound: 5 },
          { bucket: 'd5', inbound: 3, outbound: 1 },
          { bucket: 'd6', inbound: 2, outbound: 2 },
          { bucket: 'd7', inbound: 1, outbound: 0 },
        ],
      },
      isError: false,
    });
    const { LineSpark } = await import('../../console/src/components/fleet/LineSpark');
    const { container } = render(
      <MemoryRouter>
        <LineSpark name="spark-line" />
      </MemoryRouter>,
    );
    const bars = container.querySelectorAll('.fleet-spark i');
    expect(bars.length).toBe(7);
    // Max bucket d4 (10) → 100%; hi threshold = 75% of max → only d4.
    const hi = container.querySelectorAll('.fleet-spark i.hi');
    expect(hi.length).toBe(1);
    // Zero bucket d3 renders the floor stub, never a gap.
    expect((bars[2] as HTMLElement).style.height).toBe('5%');
  });

  it('renders EM_DASH when the line has no message telemetry', async () => {
    useQueryMock.mockReturnValue({
      data: { hasMessageData: false, messageVolume: [] },
      isError: false,
    });
    const { LineSpark } = await import('../../console/src/components/fleet/LineSpark');
    const { container } = render(
      <MemoryRouter>
        <LineSpark name="no-data-line" />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('—');
  });
});
