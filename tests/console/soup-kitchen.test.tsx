/**
 * SoupKitchen page — behavior tests.
 *
 * Renders the real component under jsdom + Testing Library and asserts on
 * observable DOM (text content, aria states, classNames that encode user-
 * visible state) rather than scanning source strings or re-implementing
 * internals in a parallel helper.
 *
 * C2.3 change summary vs. the prior version:
 *   - Row activation: click/Enter now opens the Drawer; "Open line" action
 *     in the drawer navigates. Old direct-navigate test is replaced.
 *   - Sort tests: header sort buttons (role "button" inside the th) are the
 *     interaction target; aria-sort is still on the <th> (columnheader).
 *     fireEvent.click targets the sort button, not the columnheader directly.
 *   - visibleTableLineNames: "Line" is now col 0 (StatusCell + name), so the
 *     cell index changed from 1 → 0.
 *   - New: drawer open/retarget/Escape/close, aria-current on selected row,
 *     drawer kv content swap, "Line not found" error state, StatusCell
 *     presence per row, long-value fixture.
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

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Restore the default connected transport for the next test.
  transportMock.status = 'connected';
  transportMock.isDisconnected = false;
});

import SoupKitchen from '../../console/src/pages/SoupKitchen';
import { computeKpis } from '../../console/src/lib/compute-kpis';
import { deriveFleetMessageSparklines } from '../../console/src/lib/metrics-sparklines';
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

function getKpiCard(label: string): HTMLElement {
  // KPI labels live inside the .c-label span on each card. There are two
  // "Unread" hits — one in the KPI strip and one in the table column header
  // — so we filter to the label class to pick the KPI hit unambiguously.
  const candidates = screen.getAllByText(label).filter((el) => el.className.includes('c-label'));
  if (candidates.length !== 1) {
    throw new Error(`Expected 1 KPI label for "${label}", found ${candidates.length}`);
  }
  const card = candidates[0].closest('button');
  if (!card) throw new Error(`KPI card "${label}" has no enclosing button`);
  return card as HTMLElement;
}

/** Mode pills are interactive Pills: <button> whose accessible name is the label
 * (the count badge is aria-hidden, so it does not join the name). */
function getModePill(label: string): HTMLElement {
  const pills = screen.getAllByRole('button', { name: label });
  // Chart-range pills share the toolbar; mode pills are the aria-pressed toggles.
  const pill = pills.find((p) => p.hasAttribute('aria-pressed'));
  if (!pill) throw new Error(`mode pill "${label}" not found`);
  return pill;
}

/** Table body — scoped queries here ignore the KPI strip, alert banner, etc. */
function tableBody(): HTMLElement {
  // Anchor on the "Mode" columnheader — still present as col 1 in new layout.
  const headerCell = screen.getByRole('columnheader', { name: /^Mode\b/ });
  const tbody = headerCell.closest('table')!.querySelector('tbody');
  if (!tbody) throw new Error('SoupKitchen table has no tbody');
  return tbody as HTMLElement;
}

function tableRows(): HTMLTableRowElement[] {
  return Array.from(tableBody().querySelectorAll('tr'));
}

function tableCell(row: HTMLElement, index: number): HTMLElement {
  const cell = row.querySelectorAll('td')[index];
  if (!cell) throw new Error(`missing table cell at index ${index}`);
  return cell as HTMLElement;
}

/** AlertBanner — anchor on the "N alert(s)" badge text. */
function alertBanner(): HTMLElement | null {
  const badge = screen.queryByText(/^\d+ alerts?$/);
  if (!badge) return null;
  // Walk up to the banner root (the outer flex container).
  return badge.closest('div[style*="--s-crit-wash"]') ?? (badge.parentElement?.parentElement as HTMLElement);
}

/**
 * Return the list of line names visible in the instance table, preserving
 * the order produced by the component. Scoped to <tbody>.
 *
 * Column layout: col 0 is the bulk-select checkbox, col 1 is "Line" (StatusCell
 * renders the name text inside it). The Line cell index is 1.
 */
function visibleTableLineNames(lines: LineInstance[]): string[] {
  const known = new Map(lines.map((line) => [displayInstanceName(line.name), line.name]));
  return tableRows()
    .map((row) => {
      // Col 1 holds the StatusCell + name label (col 0 is the select checkbox).
      const lineCell = tableCell(row, 1);
      for (const [displayName, rawName] of known) {
        if (within(lineCell).queryByText(displayName)) return rawName;
      }
      return undefined;
    })
    .filter((name): name is string => name !== undefined);
}

/**
 * Find the sort button INSIDE a given columnheader th.
 * TableHeaderCell renders a <button> inside the <th> for sortable columns.
 */
function getSortButton(columnheader: HTMLElement): HTMLElement {
  const btn = columnheader.querySelector('button');
  if (!btn) throw new Error('No sort button in columnheader');
  return btn as HTMLElement;
}

// ---------------------------------------------------------------------------
// 1. Loading / empty state
// ---------------------------------------------------------------------------

describe('SoupKitchen loading state', () => {
  it('renders with empty lines array when data is not yet loaded', () => {
    const lines: LineInstance[] = [];
    const kpis = computeKpis(lines);

    expect(kpis.connected).toBe(0);
    expect(kpis.needAttention).toBe(0);
    expect(kpis.totalSent).toBe(0);
    expect(kpis.totalReceived).toBe(0);
    expect(kpis.agentSessions).toBe(0);
    expect(kpis.unread).toBe(0);
    expect(kpis.totalMedia).toBe(0);
  });

  it('shows "No instances match" when filtered list is empty', () => {
    renderPage({ lines: [] });
    expect(screen.getByText('No instances match the current filters')).toBeDefined();
  });

  it('defaults fleet metrics sparklines to undefined when no data', () => {
    const sparklines = deriveFleetMessageSparklines(undefined);
    expect({ sparklines }).toEqual({ sparklines: undefined });
  });
});

// ---------------------------------------------------------------------------
// 2. KPI cards with data
// ---------------------------------------------------------------------------

describe('SoupKitchen KPI cards with data', () => {
  const lines: LineInstance[] = [
    makeLine({ name: 'alpha', status: 'online', mode: 'passive', messageStats: { sent: 100, received: 200, images: 5, audio: 2, documents: 1 } }),
    makeLine({ name: 'bravo', status: 'online', mode: 'agent', messageStats: { sent: 50, received: 80, images: 10, audio: 0, documents: 3 },
      health: { status: 'ok', uptime_seconds: 3600, messages_total: 130, whatsapp: { connection: { state: 'open' } }, sqlite: { messages_total: 130, schema_version: 1 },
        runtime: { agent: { activeSessions: 2, lastSessionStatus: null, lastSessionStartedAt: null } } } }),
    makeLine({ name: 'charlie', status: 'degraded', mode: 'chat', messageStats: { sent: 20, received: 30, images: 0, audio: 0, documents: 0 } }),
    makeLine({ name: 'delta', status: 'unreachable', mode: 'passive', lastSessionStatus: 'auth_expired' }),
    makeLine({ name: 'echo', status: 'logged_out', mode: 'agent' }),
  ];

  const kpis = computeKpis(lines);

  it('computes connected count correctly', () => {
    expect(kpis.connected).toBe(2); // alpha + bravo
  });

  it('computes need attention count correctly', () => {
    expect(kpis.needAttention).toBe(3); // charlie (degraded) + delta (unreachable) + echo (logged_out)
  });

  it('aggregates sent messages', () => {
    expect(kpis.totalSent).toBe(170); // 100 + 50 + 20
  });

  it('aggregates received messages', () => {
    expect(kpis.totalReceived).toBe(310); // 200 + 80 + 30
  });

  it('aggregates media processed', () => {
    expect(kpis.totalMedia).toBe(21); // (5+2+1) + (10+0+3) + (0+0+0)
  });

  it('counts agent sessions from health runtime', () => {
    expect(kpis.agentSessions).toBe(2);
  });

  it('renders all 9 KPI cards with the expected labels', () => {
    renderPage({ lines });
    const expected = [
      'Lines Connected',
      'Connectivity Unknown',
      'Need Attention',
      'Messages Sent',
      'Messages Received',
      'Agent Sessions',
      'Unread',
      'Media Processed',
      'Metrics Unavailable',
    ];
    for (const label of expected) {
      expect(getKpiCard(label)).toBeDefined();
    }
  });

  it('surfaces the transport-connectivity denominator explicitly (#1881 criterion 5)', () => {
    // Fixture: alpha (online) + bravo (online) confirmed connected; charlie
    // (degraded), delta (unreachable), echo (logged_out) all have NO health
    // body at all (missing health data) — none is a confirmed disconnect, so
    // all three land in the "Connectivity Unknown" coverage count, out of the
    // fleet's 5 total lines.
    renderPage({ lines });
    const unknownCard = getKpiCard('Connectivity Unknown');
    expect(within(unknownCard).getByText('3')).toBeDefined();
    expect(within(unknownCard).getByText('of 5')).toBeDefined();
  });

  it('surfaces the DB metric availability denominator explicitly (#1879 crit 3)', () => {
    // None of this fixture's lines set metricAvailability — back-compat
    // lines never trip the coverage counter.
    renderPage({ lines });
    const unavailableCard = getKpiCard('Metrics Unavailable');
    expect(within(unavailableCard).getByText('0')).toBeDefined();
    expect(within(unavailableCard).getByText('of 5')).toBeDefined();
  });

  it('counts a faulted messageStats read into Metrics Unavailable, out of the message totals', () => {
    const withFault: LineInstance[] = [
      ...lines,
      makeLine({
        name: 'foxtrot',
        status: 'online',
        mode: 'chat',
        messageStats: { sent: 0, received: 0, images: 0, audio: 0, documents: 0 },
        metricAvailability: { messageStats: 'unavailable' },
      }),
    ];
    renderPage({ lines: withFault });
    const unavailableCard = getKpiCard('Metrics Unavailable');
    expect(within(unavailableCard).getByText('1')).toBeDefined();
    expect(within(unavailableCard).getByText('of 6')).toBeDefined();
    // The faulted line's zero-value fallback does not inflate/deflate the
    // totals — its contribution is skipped, not summed as a real zero.
    expect(within(getKpiCard('Messages Sent')).getByText('170')).toBeDefined();
  });

  it('renders the computed KPI values on the cards', () => {
    renderPage({ lines });
    expect(within(getKpiCard('Lines Connected')).getByText('2')).toBeDefined();
    expect(within(getKpiCard('Need Attention')).getByText('3')).toBeDefined();
    const sentValue = within(getKpiCard('Messages Sent')).getByText('170');
    const receivedValue = within(getKpiCard('Messages Received')).getByText('310');
    const sessionsValue = within(getKpiCard('Agent Sessions')).getByText('2');
    const mediaValue = within(getKpiCard('Media Processed')).getByText('21');
    expect(sentValue).toBeDefined();
    expect(receivedValue).toBeDefined();
    expect(sessionsValue).toBeDefined();
    expect(mediaValue).toBeDefined();
    for (const value of [sentValue, receivedValue, sessionsValue, mediaValue]) {
      expect(value.className).not.toMatch(/text-(m-|s-)/);
      expect(value.getAttribute('style')).toContain('--text-2');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Instance table rendering — real component DOM
// ---------------------------------------------------------------------------

describe('SoupKitchen instance table rendering', () => {
  const lines: LineInstance[] = [
    makeLine({
      name: 'primary-line', mode: 'passive', status: 'online', phone: '+15551234567',
      chatCounts: { chats: 42, groups: 8 }, unread: 3,
      messageStats: { sent: 10, received: 20, images: 0, audio: 0, documents: 0 },
    }),
    makeLine({
      name: 'operator-agent', mode: 'agent', status: 'online', phone: '+15559876543',
      chatCounts: { chats: 15, groups: 2 }, unread: 0,
      messageStats: { sent: 200, received: 150, images: 5, audio: 1, documents: 2 },
      totalSessions: 47, tokenUsage: { input: 125000, output: 45000 },
    }),
  ];

  it('renders one row per line under "no filter" defaults', () => {
    renderPage({ lines });
    const rows = screen.getAllByRole('row');
    // 1 header row + 2 data rows
    expect(rows.length).toBe(3);
  });

  it('renders all expected column headers', () => {
    renderPage({ lines });
    // C2.3: "Line" replaced the old "Mode+Line" split — col 0 is now "Line"
    // (StatusCell+name). "Mode" is still col 1.
    const expected = ['Line', 'Mode', 'Chats', 'Groups', 'Unread', 'Sent', 'Recv', 'Tokens', 'Sessions', 'Provider', 'Tags', 'Active'];
    for (const col of expected) {
      expect(screen.getByRole('columnheader', { name: new RegExp(`^${col}\\b`) })).toBeDefined();
    }
  });

  it('renders a StatusCell in the Line column (col 1) of each data row (shape law)', () => {
    renderPage({ lines });
    // StatusCell renders soup-status-cell class. Assert at least one per row.
    // This is a shape-law check — does NOT assert color (visual only).
    // Col 0 is the bulk-select checkbox; the StatusCell/Line is col 1.
    for (const row of tableRows()) {
      const cell = tableCell(row, 1);
      // StatusCell renders a span.soup-status-cell containing a shape span + label
      expect(cell.querySelector('.soup-status-cell')).not.toBeNull();
    }
  });

  it('surfaces the health-observation age on a stale line row, styled as stale (#1877 crit 5)', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const staleLine = makeLine({
      name: 'stale-line',
      status: 'degraded',
      stale: true,
      healthObservedAt: fiveMinutesAgo,
    });
    renderPage({ lines: [...lines, staleLine] });
    // Scoped to the table (not screen-global): a degraded line also raises
    // an AlertBanner entry showing the same raw name, which would otherwise
    // collide with a global getByText query.
    const row = within(tableBody()).getByText(displayInstanceName('stale-line')).closest('tr') as HTMLElement;
    // Binary stale-or-not is not enough — the AGE of the last live
    // observation must be visible, not just the word "stale".
    const tag = within(tableCell(row, 1)).getByText(/stale.*5m ago/);
    expect(tag).not.toBeNull();
    expect(tag.className).toMatch(/text-s-warn/);
  });

  it('surfaces the health-observation age on a FRESH (non-stale) connected line too — this is the core #1877 scenario: a connected tab can still be showing an aging snapshot even though the server has not flagged it stale', () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const freshLine = makeLine({
      name: 'fresh-line',
      status: 'online',
      stale: false,
      healthObservedAt: tenSecondsAgo,
    });
    renderPage({ lines: [...lines, freshLine] });
    const row = within(tableBody()).getByText(displayInstanceName('fresh-line')).closest('tr') as HTMLElement;
    const tag = within(tableCell(row, 1)).getByText(/observed.*just now/);
    expect(tag).not.toBeNull();
    // Non-stale rows must not borrow the stale warning styling.
    expect(tag.className).not.toMatch(/text-s-warn/);
  });

  // ---------------------------------------------------------------------
  // D-3 universal freshness contract (F-UX-4 residual): the strip must
  // show HOW MUCH of it is carried data, a stale line must never render a
  // fresh-green shape, and the strip itself carries the #1925 observedAt
  // marker.
  // ---------------------------------------------------------------------

  it('renders the "Carried Health" coverage card counting stale lines (compute-kpis staleExcluded)', () => {
    const staleA = makeLine({ name: 'carried-a', status: 'online', stale: true });
    const staleB = makeLine({ name: 'carried-b', status: 'unreachable', stale: true });
    renderPage({ lines: [...lines, staleA, staleB] });
    const card = getKpiCard('Carried Health');
    expect(within(card).getByText('2')).toBeDefined();
    expect(within(card).getByText(`of ${lines.length + 2}`)).toBeDefined();
  });

  it('a stale online line never renders the fresh-green disc — warn diamond + carried aria (#1762 label stays)', () => {
    const staleOnline = makeLine({
      name: 'carried-online',
      status: 'online',
      stale: true,
      healthObservedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    renderPage({ lines: [staleOnline] });
    const row = within(tableBody()).getByText(displayInstanceName('carried-online')).closest('tr') as HTMLElement;
    const cell = tableCell(row, 1);
    expect(cell.querySelector('.soup-shape--ok')).toBeNull();
    expect(cell.querySelector('.soup-shape--warn')).not.toBeNull();
    const shape = cell.querySelector('[role="img"]');
    expect(shape!.getAttribute('aria-label')).toBe('online, carried forward');
  });

  it('the KPI strip carries the #1925 observedAt marker — fresh when current, stale-flagged when carried', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60_000;
    const { unmount } = renderPage({
      lines,
      linesFreshness: { observedAt: fiveMinutesAgo, stale: false } satisfies Freshness,
    });
    const freshMarker = screen.getByTitle(/Last successful fleet lines fetch/);
    expect(freshMarker.textContent).toMatch(/observed.*5m ago/);
    expect(freshMarker.className).not.toMatch(/text-s-warn/);
    unmount();

    renderPage({
      lines,
      linesFreshness: { observedAt: fiveMinutesAgo, stale: true } satisfies Freshness,
    });
    const staleMarker = screen.getByTitle(/Fleet lines carried forward/);
    expect(staleMarker.textContent).toMatch(/stale.*5m ago/);
    expect(staleMarker.className).toMatch(/text-s-warn/);
  });

  it('renders no age tag when a line has never had a live health observation', () => {
    // Uses "no-history" as the fixture name (not e.g. "never-observed") so it
    // cannot collide with the age tag's own "observed" wording via substring
    // text matching — the assertion below wants to prove the tag is ABSENT.
    const noHistoryLine = makeLine({ name: 'no-history', stale: false, healthObservedAt: null });
    renderPage({ lines: [...lines, noHistoryLine] });
    const row = within(tableBody()).getByText(displayInstanceName('no-history')).closest('tr') as HTMLElement;
    // Only the phone sub-label should exist alongside the StatusCell — no
    // third c-label span for a health-age tag.
    const labels = tableCell(row, 1).querySelectorAll('.c-label');
    expect(labels.length).toBe(1);
  });

  it('displays instance name via displayInstanceName', () => {
    expect(displayInstanceName('primary-line')).toBe('primary-line');
    expect(displayInstanceName('A')).toBe('A');
    expect(displayInstanceName('a')).toBe('A');
  });

  it('formats phone numbers for display', () => {
    expect(formatPhone('+15551234567')).toMatch(/555/);
    expect(formatPhone('unknown')).toBe('—');
  });

  it('formats compact token counts', () => {
    expect(formatCompact(170000)).toBe('170K');
    expect(formatCompact(1234)).toBe('1.2K');
    expect(formatCompact(500)).toBe('500');
    expect(formatCompact(2450000)).toBe('2.5M');
  });

  it('shows totalSessions for agent-mode rows and em-dash for non-agent rows', () => {
    renderPage({ lines });
    // Col 0 is the bulk-select checkbox, so the data columns shift +1:
    // Line=1, Mode=2, Chats=3, Groups=4, Unread=5, Sent=6, Recv=7, Tokens=8, Sessions=9.
    const agentRow = screen.getByText(displayInstanceName('operator-agent')).closest('tr') as HTMLElement;
    expect(tableCell(agentRow, 9).textContent).toBe('47');
    for (const index of [6, 7, 9]) {
      const value = tableCell(agentRow, index).querySelector('.c-data') as HTMLElement;
      expect(value.className).not.toMatch(/text-(m-|s-)/);
      expect(value.getAttribute('style')).toContain('--text-2');
    }

    const passiveRow = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    expect(tableCell(passiveRow, 9).textContent).toBe('—');
    expect(within(passiveRow).queryByText('47')).toBeNull();
  });

  // C2.3: row click now opens the drawer, not navigates directly.
  // Navigation moves to the "Open line" button inside the drawer.
  it('clicking a row opens the drawer for that line', () => {
    renderPage({ lines });
    const row = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    fireEvent.click(row);
    // Drawer is open: the inspector complementary region is present.
    expect(screen.getByRole('complementary')).toBeDefined();
    // navigateMock must NOT have been called on row click.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('pressing Enter on a row opens the drawer', () => {
    renderPage({ lines });
    const row = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByRole('complementary')).toBeDefined();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('toggling a row select checkbox selects the line WITHOUT opening the drawer, and shows the bulk bar', () => {
    renderPage({ lines });
    const row = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    // The select checkbox stops propagation, so the row's open-drawer is NOT triggered.
    expect(screen.queryByRole('complementary')).toBeNull();
    // The bulk-action bar appears with one line selected.
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar.textContent).toContain('1');
  });

  it('toggling a selected row checkbox again deselects it without opening the drawer', () => {
    renderPage({ lines });
    const row = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    const checkbox = within(row).getByRole('checkbox');

    fireEvent.click(checkbox);
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toBeDefined();

    fireEvent.click(checkbox);

    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('the header select-all checkbox selects every visible line', () => {
    renderPage({ lines });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all lines' }));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar.textContent).toContain(String(lines.length));
  });

  it('the header select-all checkbox can clear every visible selected line', () => {
    renderPage({ lines });
    const selectAll = screen.getByRole('checkbox', { name: 'Select all lines' });

    fireEvent.click(selectAll);
    expect(screen.getByRole('region', { name: 'Bulk actions' }).textContent).toContain(String(lines.length));

    fireEvent.click(selectAll);

    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  });

  it('the bulk clear button removes the current row selection', () => {
    renderPage({ lines });
    const row = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    expect(screen.getByRole('region', { name: 'Bulk actions' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  });

  it('"Open line" button inside the drawer navigates to /lines/<name>', () => {
    renderPage({ lines });
    const row = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    fireEvent.click(row);
    const openBtn = screen.getByRole('button', { name: 'Open line' });
    fireEvent.click(openBtn);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/lines/primary-line');
  });
});

// ---------------------------------------------------------------------------
// 3a. Bulk lifecycle workflows
// ---------------------------------------------------------------------------

describe('SoupKitchen bulk lifecycle workflows', () => {
  const lines: LineInstance[] = [
    makeLine({ name: 'alpha-line', mode: 'passive', status: 'online' }),
    makeLine({ name: 'bravo-line', mode: 'agent', status: 'online' }),
  ];

  function selectLine(name: string) {
    const row = screen.getByText(displayInstanceName(name)).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
  }

  it('bulk restart sends the selected line and reports a singular success', async () => {
    const toastValue = makeToastValue();
    renderPage({ lines, toastValue });
    selectLine('alpha-line');

    fireEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Restart' }));

    expect(restartMock).toHaveBeenCalledWith('alpha-line');
    expect(toastValue.info).toHaveBeenCalledWith('Restarting 1 line…');
    await waitFor(() => {
      expect(toastValue.success).toHaveBeenCalledWith('Restarted 1 line');
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['lines'] });
  });

  it('bulk restart reports mixed all-settled results without dropping selection', async () => {
    const toastValue = makeToastValue();
    restartMock
      .mockResolvedValueOnce({ status: 'ok', instance: 'alpha-line' })
      .mockRejectedValueOnce(new Error('restart denied'));
    renderPage({ lines, toastValue });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all lines' }));

    fireEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Restart' }));

    expect(restartMock).toHaveBeenCalledWith('alpha-line');
    expect(restartMock).toHaveBeenCalledWith('bravo-line');
    expect(toastValue.info).toHaveBeenCalledWith('Restarting 2 lines…');
    await waitFor(() => {
      expect(toastValue.error).toHaveBeenCalledWith('Restarted 1, failed 1');
    });
    expect(screen.getByRole('region', { name: 'Bulk actions' }).textContent).toContain('2');
  });

  it('bulk stop confirms the selected names, calls stop for each line, and reports success', async () => {
    const toastValue = makeToastValue();
    renderPage({ lines, toastValue });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all lines' }));

    fireEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Stop' }));

    expect(screen.getByText('Stop 2 lines?')).toBeDefined();
    expect(screen.getByText(/alpha-line, bravo-line/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Stop lines' }));

    expect(toastValue.info).toHaveBeenCalledWith('Stopping 2 lines…');
    await waitFor(() => {
      expect(stopInstanceMock).toHaveBeenCalledWith('alpha-line');
      expect(stopInstanceMock).toHaveBeenCalledWith('bravo-line');
      expect(toastValue.success).toHaveBeenCalledWith('Stopped 2 lines');
    });
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['lines'] });
  });

  it('bulk delete confirms destructive copy and removes only fulfilled deletes from selection', async () => {
    const toastValue = makeToastValue();
    deleteLineMock
      .mockResolvedValueOnce({ deleted: 'alpha-line' })
      .mockRejectedValueOnce(new Error('delete denied'));
    renderPage({ lines, toastValue });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all lines' }));

    fireEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Delete' }));

    expect(screen.getByText('Delete 2 lines?')).toBeDefined();
    expect(screen.getByText(/This will stop the process/)).toBeDefined();
    expect(screen.getByText(/alpha-line, bravo-line/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    expect(toastValue.info).toHaveBeenCalledWith('Deleting 2 lines…');
    await waitFor(() => {
      expect(deleteLineMock).toHaveBeenCalledWith('alpha-line');
      expect(deleteLineMock).toHaveBeenCalledWith('bravo-line');
      expect(toastValue.error).toHaveBeenCalledWith('deleted 1, failed 1');
    });
    expect(screen.getByLabelText('1 selected')).toBeDefined();
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['lines'] });
  });
});

// ---------------------------------------------------------------------------
// 3b. Per-row action Menu (FleetRowMenu) — kebab wiring on the fleet table
// ---------------------------------------------------------------------------

describe('SoupKitchen fleet row action menu', () => {
  const lines: LineInstance[] = [
    makeLine({ name: 'alpha', mode: 'passive', status: 'online' }),
    makeLine({ name: 'bravo', mode: 'agent', status: 'online' }),
  ];

  it('renders an Actions column header', () => {
    renderPage({ lines });
    // Header label is screen-reader only ("Actions") — query by columnheader name.
    expect(screen.getByRole('columnheader', { name: /Actions/ })).toBeDefined();
  });

  it('renders one kebab action trigger per data row', () => {
    renderPage({ lines });
    expect(screen.getByRole('button', { name: 'Actions for alpha' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Actions for bravo' })).toBeDefined();
  });

  it('opening the kebab menu does NOT open the row drawer (stopPropagation)', () => {
    renderPage({ lines });
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha' }));
    // The Menu surface opens…
    expect(screen.getByRole('menu')).toBeDefined();
    // …but the drawer (complementary landmark) stays closed.
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('the kebab menu exposes Restart, Stop, and Delete line items', () => {
    renderPage({ lines });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Restart')).toBeDefined();
    expect(within(menu).getByText('Stop')).toBeDefined();
    expect(within(menu).getByText('Delete line')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Error / alert state handling
// ---------------------------------------------------------------------------

describe('SoupKitchen error state handling', () => {
  it('renders an AlertBanner with "connection lost" for an unreachable line', () => {
    const lines = [makeLine({ name: 'down-line', status: 'unreachable', lastSessionStatus: null })];
    renderPage({ lines });
    const banner = alertBanner();
    expect(banner).not.toBeNull();
    expect(screen.getByText('1 alert')).toBeDefined();
    expect(within(banner!).getByText('connection lost')).toBeDefined();
    expect(within(banner!).getByText('down-line')).toBeDefined();
  });

  it('renders "auth expired" for an unreachable line with lastSessionStatus auth_expired', () => {
    const lines = [makeLine({ name: 'expired-line', status: 'unreachable', lastSessionStatus: 'auth_expired' })];
    renderPage({ lines });
    const banner = alertBanner();
    expect(banner).not.toBeNull();
    expect(within(banner!).getByText('auth expired')).toBeDefined();
    expect(within(banner!).getByText('expired-line')).toBeDefined();
  });

  it('renders "degraded" for a degraded line', () => {
    const lines = [makeLine({ name: 'slow-line', status: 'degraded' })];
    renderPage({ lines });
    const banner = alertBanner();
    expect(banner).not.toBeNull();
    expect(within(banner!).getByText('degraded')).toBeDefined();
    expect(within(banner!).getByText('slow-line')).toBeDefined();
  });

  it('renders explicit messages for logged-out, config-error, and unknown lines', () => {
    const lines = [
      makeLine({ name: 'logout-line', status: 'logged_out' }),
      makeLine({ name: 'bad-config-line', status: 'config_error' }),
      makeLine({ name: 'unknown-line', status: 'unknown' }),
    ];
    renderPage({ lines });
    const banner = alertBanner();
    expect(banner).not.toBeNull();
    expect(screen.getByText('3 alerts')).toBeDefined();
    expect(within(banner!).getByText('logged out')).toBeDefined();
    expect(within(banner!).getByText('configuration error')).toBeDefined();
    expect(within(banner!).getByText('awaiting health signal')).toBeDefined();
  });

  it('renders no AlertBanner when all lines are healthy', () => {
    const lines = [makeLine({ name: 'a', status: 'online' }), makeLine({ name: 'b', status: 'online' })];
    renderPage({ lines });
    expect(screen.queryByText(/\d+ alerts?$/)).toBeNull();
    expect(screen.queryByText('connection lost')).toBeNull();
    expect(screen.queryByText('degraded')).toBeNull();
  });

  it('renders one alert entry per unhealthy line with the right message', () => {
    const lines = [
      makeLine({ name: 'alert-a', status: 'unreachable', lastSessionStatus: 'auth_expired' }),
      makeLine({ name: 'alert-b', status: 'degraded' }),
      makeLine({ name: 'alert-c', status: 'online' }),
      makeLine({ name: 'alert-d', status: 'unreachable', lastSessionStatus: null }),
      makeLine({ name: 'alert-e', status: 'logged_out' }),
    ];
    renderPage({ lines });
    expect(screen.getByText('4 alerts')).toBeDefined();
    const banner = alertBanner();
    expect(banner).not.toBeNull();
    expect(within(banner!).getByText('auth expired')).toBeDefined();
    expect(within(banner!).getByText('degraded')).toBeDefined();
    expect(within(banner!).getByText('connection lost')).toBeDefined();
    expect(within(banner!).getByText('logged out')).toBeDefined();
    // Healthy line 'alert-c' should NOT appear in the banner (it still
    // renders as a table row).
    expect(within(banner!).queryByText('alert-c')).toBeNull();
    expect(within(banner!).getByText('alert-a')).toBeDefined();
    expect(within(banner!).getByText('alert-b')).toBeDefined();
    expect(within(banner!).getByText('alert-d')).toBeDefined();
    expect(within(banner!).getByText('alert-e')).toBeDefined();
  });

  it('applies crit severity class on unreachable rows and warn severity on degraded rows', () => {
    const lines = [
      makeLine({ name: 'row-down', status: 'unreachable' }),
      makeLine({ name: 'row-slow', status: 'degraded' }),
      makeLine({ name: 'row-logout', status: 'logged_out' }),
      makeLine({ name: 'row-unknown', status: 'unknown' }),
      makeLine({ name: 'row-fine', status: 'online' }),
    ];
    renderPage({ lines });
    const body = tableBody();
    const downRow = within(body).getByText('row-down').closest('tr') as HTMLElement;
    const slowRow = within(body).getByText('row-slow').closest('tr') as HTMLElement;
    const logoutRow = within(body).getByText('row-logout').closest('tr') as HTMLElement;
    const unknownRow = within(body).getByText('row-unknown').closest('tr') as HTMLElement;
    const fineRow = within(body).getByText('row-fine').closest('tr') as HTMLElement;
    // C2.3: TableRow severity prop maps to soup-table-row--crit / --warn classes.
    expect(downRow.className).toContain('crit');
    expect(slowRow.className).toContain('warn');
    expect(logoutRow.className).toContain('crit');
    expect(unknownRow.className).toContain('warn');
    expect(fineRow.className).not.toContain('crit');
    expect(fineRow.className).not.toContain('warn');
  });

  it('renders a retryable fleet-load-error row instead of the empty-filtered placeholder when the lines query fails', () => {
    const linesRefetch = vi.fn();
    const feedRefetch = vi.fn();
    renderPage({
      lines: [],
      linesError: new Error('upstream 502'),
      linesRefetch,
      feedRefetch,
    });
    expect(screen.getByText(/Unable to load fleet data: upstream 502/)).toBeDefined();
    expect(screen.queryByText('No instances match the current filters')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(linesRefetch).toHaveBeenCalledTimes(1);
    expect(feedRefetch).not.toHaveBeenCalled();
  });

  it('renders a retryable fleet-load-error row when the feed query fails even if lines succeeded', () => {
    const linesRefetch = vi.fn();
    const feedRefetch = vi.fn();
    renderPage({
      lines: [makeLine({ name: 'visible-line' })],
      feedError: new Error('feed offline'),
      linesRefetch,
      feedRefetch,
    });
    expect(screen.getByText(/Unable to load fleet data: feed offline/)).toBeDefined();
    expect(screen.getByText(/Activity feed unavailable: feed offline/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(feedRefetch).toHaveBeenCalledTimes(1);
    expect(linesRefetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry activity' }));

    expect(feedRefetch).toHaveBeenCalledTimes(2);
  });

  it('renders the offline cached-data state instead of the hard error when the fleet load fails AND transport is disconnected (DD-29)', () => {
    transportMock.status = 'reconnecting';
    transportMock.isDisconnected = true;
    renderPage({
      lines: [],
      linesError: new Error('upstream 502'),
    });
    // Offline-with-cache reading, not a failure.
    expect(screen.getByText('Showing cached data')).toBeDefined();
    expect(screen.getByText('Reconnecting…')).toBeDefined();
    // The hard error message and its Retry button are NOT shown.
    expect(screen.queryByText(/Unable to load fleet data/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('still renders the hard error when the fleet load fails while transport is connected', () => {
    transportMock.status = 'connected';
    transportMock.isDisconnected = false;
    renderPage({
      lines: [],
      linesError: new Error('upstream 502'),
    });
    expect(screen.getByText(/Unable to load fleet data: upstream 502/)).toBeDefined();
    expect(screen.queryByText('Showing cached data')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. KPI filter + Mode filter + Search filter — behavior under render
// ---------------------------------------------------------------------------

describe('SoupKitchen filter behavior', () => {
  const lines: LineInstance[] = [
    makeLine({ name: 'alpha',   status: 'online',      mode: 'passive', unread: 5, messageStats: { sent: 6, received: 4, images: 0, audio: 0, documents: 0 } }),
    makeLine({ name: 'bravo',   status: 'online',      mode: 'agent',   unread: 0, messageStats: { sent: 0, received: 0, images: 0, audio: 0, documents: 0 } }),
    makeLine({ name: 'charlie', status: 'degraded',    mode: 'chat',    unread: 2, messageStats: { sent: 2, received: 1, images: 0, audio: 0, documents: 0 } }),
    makeLine({ name: 'delta',   status: 'unreachable', mode: 'passive', unread: 0, messageStats: { sent: 0, received: 0, images: 0, audio: 0, documents: 0 } }),
    makeLine({ name: 'echo',    status: 'online',      mode: 'agent',   unread: 0, phone: '+15559999999', messageStats: { sent: 4, received: 3, images: 0, audio: 0, documents: 0 } }),
  ];

  it('renders all lines by default', () => {
    renderPage({ lines });
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  });

  // C2.3: sort now fires the sort BUTTON inside the columnheader, not the th
  // directly. aria-sort remains on the <th> (columnheader role).
  it('sorts by line name and exposes aria-sort direction', () => {
    renderPage({ lines });
    const lineHeader = screen.getByRole('columnheader', { name: /^Line\b/ });
    const sortBtn = getSortButton(lineHeader);

    // First click on a new key: TableHeaderCell cycles none→asc, so first = ascending.
    fireEvent.click(sortBtn);
    expect(lineHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);

    // Second click on same key: asc→desc.
    fireEvent.click(sortBtn);
    expect(lineHeader.getAttribute('aria-sort')).toBe('descending');
    expect(visibleTableLineNames(lines)).toEqual(['echo', 'delta', 'charlie', 'bravo', 'alpha']);
  });

  it('sorts unread counts numerically and reverses direction on repeat click', () => {
    const unreadLines = [
      makeLine({ name: 'one-unread', unread: 1 }),
      makeLine({ name: 'ten-unread', unread: 10 }),
      makeLine({ name: 'two-unread', unread: 2 }),
    ];
    renderPage({ lines: unreadLines });
    const unreadHeader = screen.getByRole('columnheader', { name: /^Unread\b/ });
    const sortBtn = getSortButton(unreadHeader);

    // First click: none→asc.
    fireEvent.click(sortBtn);
    expect(unreadHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleTableLineNames(unreadLines)).toEqual(['one-unread', 'two-unread', 'ten-unread']);

    // Second click: asc→desc.
    fireEvent.click(sortBtn);
    expect(unreadHeader.getAttribute('aria-sort')).toBe('descending');
    expect(visibleTableLineNames(unreadLines)).toEqual(['ten-unread', 'two-unread', 'one-unread']);
  });

  it('preserves source order for rows tied on the active sort value', () => {
    const tiedLines = [
      makeLine({ name: 'tie-a', chatCounts: { chats: 2, groups: 0 } }),
      makeLine({ name: 'tie-b', chatCounts: { chats: 2, groups: 0 } }),
      makeLine({ name: 'tie-c', chatCounts: { chats: 4, groups: 0 } }),
    ];
    renderPage({ lines: tiedLines });
    const chatsHeader = screen.getByRole('columnheader', { name: /^Chats\b/ });

    fireEvent.click(getSortButton(chatsHeader));

    expect(visibleTableLineNames(tiedLines)).toEqual(['tie-a', 'tie-b', 'tie-c']);
  });

  it('third click on the active sort column clears sorting and restores source order', () => {
    const unsortedLines = [
      makeLine({ name: 'charlie' }),
      makeLine({ name: 'alpha' }),
      makeLine({ name: 'bravo' }),
    ];
    renderPage({ lines: unsortedLines });
    const lineHeader = screen.getByRole('columnheader', { name: /^Line\b/ });
    const sortBtn = getSortButton(lineHeader);

    fireEvent.click(sortBtn);
    expect(visibleTableLineNames(unsortedLines)).toEqual(['alpha', 'bravo', 'charlie']);
    fireEvent.click(sortBtn);
    expect(visibleTableLineNames(unsortedLines)).toEqual(['charlie', 'bravo', 'alpha']);
    fireEvent.click(sortBtn);

    expect(lineHeader.getAttribute('aria-sort')).toBeNull();
    expect(visibleTableLineNames(unsortedLines)).toEqual(['charlie', 'alpha', 'bravo']);
  });

  const sortableLines: LineInstance[] = [
    makeLine({
      name: 'middle-line',
      mode: 'chat',
      chatCounts: { chats: 5, groups: 7 },
      messageStats: { sent: 12, received: 3, images: 0, audio: 0, documents: 0 },
      tokenUsage: { input: 40, output: 10 },
      totalSessions: 3,
      provider: 'openai',
      lastActive: '2026-04-05T12:00:00.000Z',
    }),
    makeLine({
      name: 'first-line',
      mode: 'agent',
      chatCounts: { chats: 1, groups: 2 },
      messageStats: { sent: 4, received: 30, images: 0, audio: 0, documents: 0 },
      tokenUsage: { input: 5, output: 5 },
      totalSessions: 1,
      provider: 'claude-cli',
      lastActive: '2026-04-05T10:00:00.000Z',
    }),
    makeLine({
      name: 'last-line',
      mode: 'passive',
      chatCounts: { chats: 9, groups: 1 },
      messageStats: { sent: 30, received: 9, images: 0, audio: 0, documents: 0 },
      tokenUsage: { input: 200, output: 60 },
      totalSessions: 9,
      provider: 'gemini',
      lastActive: '2026-04-05T14:00:00.000Z',
    }),
  ];

  it.each([
    ['Mode', ['first-line', 'middle-line', 'last-line']],
    ['Chats', ['first-line', 'middle-line', 'last-line']],
    ['Groups', ['last-line', 'first-line', 'middle-line']],
    ['Sent', ['first-line', 'middle-line', 'last-line']],
    ['Recv', ['middle-line', 'last-line', 'first-line']],
    ['Tokens', ['first-line', 'middle-line', 'last-line']],
    ['Sessions', ['first-line', 'middle-line', 'last-line']],
    ['Provider', ['first-line', 'last-line', 'middle-line']],
    ['Active', ['first-line', 'middle-line', 'last-line']],
  ])('sorts by %s ascending through the table header control', (column, expectedOrder) => {
    renderPage({ lines: sortableLines });
    const header = screen.getByRole('columnheader', { name: new RegExp(`^${column}\\b`) });

    fireEvent.click(getSortButton(header));

    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleTableLineNames(sortableLines)).toEqual(expectedOrder);
  });

  it('clicking "Lines Connected" KPI filters to online lines only', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Lines Connected'));
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'bravo', 'echo']);
    expect(getKpiCard('Lines Connected').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a degraded-but-connected line in the "Lines Connected" filtered view (#1881)', () => {
    // The literal symptom #1881 fixes: a line whose WhatsApp transport is
    // genuinely up (fresh whatsapp.connected===true + connection.state
    // 'connected') must NOT disappear from the "Connected" filter just
    // because its control-plane health status is 'degraded'. This is a
    // regression guard on the shared isLineConnected predicate, not a new
    // behavior — it should already pass.
    const degradedConnectedLine = makeLine({
      name: 'foxtrot',
      status: 'degraded',
      stale: false,
      health: {
        status: 'ok',
        uptime_seconds: 1,
        messages_total: 0,
        whatsapp: { connected: true, connection: { state: 'connected' } },
        sqlite: { messages_total: 0, schema_version: 5 },
      },
    });
    const withDegradedConnected = [...lines, degradedConnectedLine];
    renderPage({ lines: withDegradedConnected });
    fireEvent.click(getKpiCard('Lines Connected'));
    expect(visibleTableLineNames(withDegradedConnected)).toEqual(['alpha', 'bravo', 'echo', 'foxtrot']);
  });

  it('clicking "Need Attention" KPI filters to non-online lines and errored online lines', () => {
    const attentionLines = [
      ...lines,
      makeLine({ name: 'foxtrot', status: 'logged_out', mode: 'agent' }),
      makeLine({ name: 'golf', status: 'config_error', mode: 'chat' }),
      makeLine({ name: 'hotel', status: 'unknown', mode: 'passive' }),
      makeLine({ name: 'india', status: 'online', mode: 'chat', error: 'late poll error' }),
    ];
    renderPage({ lines: attentionLines });
    fireEvent.click(getKpiCard('Need Attention'));
    expect(visibleTableLineNames(attentionLines)).toEqual(['charlie', 'delta', 'foxtrot', 'golf', 'hotel', 'india']);
  });

  it('clicking "Unread" KPI filters to lines with unread > 0', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Unread'));
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'charlie']);
  });

  it('clicking "Agent Sessions" KPI filters to agent-mode lines', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Agent Sessions'));
    expect(visibleTableLineNames(lines)).toEqual(['bravo', 'echo']);
  });

  it('clicking "Messages Sent" KPI filters to lines with sent > 0', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Messages Sent'));
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'charlie', 'echo']);
  });

  it('clicking "Messages Received" KPI filters to lines with received > 0', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Messages Received'));
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'charlie', 'echo']);
  });

  it('clicking "Media Processed" KPI filters to lines with media > 0', () => {
    const mediaLines = [
      makeLine({ name: 'has-media', messageStats: { sent: 0, received: 0, images: 3, audio: 0, documents: 0 } }),
      makeLine({ name: 'no-media',  messageStats: { sent: 5, received: 3, images: 0, audio: 0, documents: 0 } }),
      makeLine({ name: 'has-docs',  messageStats: { sent: 1, received: 1, images: 0, audio: 0, documents: 2 } }),
    ];
    renderPage({ lines: mediaLines });
    fireEvent.click(getKpiCard('Media Processed'));
    expect(visibleTableLineNames(mediaLines)).toEqual(['has-media', 'has-docs']);
  });

  it('renders mode filter pills for all, passive, chat, agent', () => {
    renderPage({ lines });
    expect(getModePill('All')).toBeDefined();
    expect(getModePill('passive')).toBeDefined();
    expect(getModePill('chat')).toBeDefined();
    expect(getModePill('agent')).toBeDefined();
  });

  it('clicking the passive mode pill filters to passive lines', () => {
    renderPage({ lines });
    fireEvent.click(getModePill('passive'));
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'delta']);
  });

  it('clicking the chat mode pill filters to chat lines', () => {
    renderPage({ lines });
    fireEvent.click(getModePill('chat'));
    expect(visibleTableLineNames(lines)).toEqual(['charlie']);
  });

  it('clicking the agent mode pill filters to agent lines', () => {
    renderPage({ lines });
    fireEvent.click(getModePill('agent'));
    expect(visibleTableLineNames(lines)).toEqual(['bravo', 'echo']);
  });

  it('combines KPI + mode filters (connected ∩ agent)', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Lines Connected'));
    fireEvent.click(getModePill('agent'));
    expect(visibleTableLineNames(lines)).toEqual(['bravo', 'echo']);
  });

  it('combines attention KPI + passive mode (just the unreachable passive line)', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Need Attention'));
    fireEvent.click(getModePill('passive'));
    expect(visibleTableLineNames(lines)).toEqual(['delta']);
  });

  it('search input filters by name case-insensitively', () => {
    renderPage({ lines });
    // C2.3: placeholder is still "Search lines..." (ToolbarSearch preserves it)
    const search = screen.getByPlaceholderText('Search lines...');
    expect(search.getAttribute('data-search-shortcut-target')).toBe('true');
    fireEvent.change(search, { target: { value: 'ALPHA' } });
    expect(visibleTableLineNames(lines)).toEqual(['alpha']);
  });

  it('search input filters by phone substring', () => {
    renderPage({ lines });
    fireEvent.change(screen.getByPlaceholderText('Search lines...'), { target: { value: '9999' } });
    expect(visibleTableLineNames(lines)).toEqual(['echo']);
  });

  it('combines KPI + mode + search filters', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Lines Connected'));
    fireEvent.click(getModePill('agent'));
    fireEvent.change(screen.getByPlaceholderText('Search lines...'), { target: { value: 'echo' } });
    expect(visibleTableLineNames(lines)).toEqual(['echo']);
  });

  it('shows empty-filter placeholder when combined filters match nothing', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Need Attention'));
    fireEvent.click(getModePill('agent'));
    expect(screen.getByText('No instances match the current filters')).toBeDefined();
  });

  it('ignores whitespace-only search input', () => {
    renderPage({ lines });
    fireEvent.change(screen.getByPlaceholderText('Search lines...'), { target: { value: '   ' } });
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  });
});

// ---------------------------------------------------------------------------
// 6. Mode-pill count badges
// ---------------------------------------------------------------------------

describe('SoupKitchen mode counts', () => {
  it('renders each mode pill with the correct count badge', () => {
    const lines = [
      makeLine({ name: 'p1', mode: 'passive' }),
      makeLine({ name: 'p2', mode: 'passive' }),
      makeLine({ name: 'a1', mode: 'agent' }),
      makeLine({ name: 'c1', mode: 'chat' }),
      makeLine({ name: 'a2', mode: 'agent' }),
    ];
    renderPage({ lines });
    expect(within(getModePill('All')).getByText('5')).toBeDefined();
    expect(within(getModePill('passive')).getByText('2')).toBeDefined();
    expect(within(getModePill('chat')).getByText('1')).toBeDefined();
    expect(within(getModePill('agent')).getByText('2')).toBeDefined();
  });

  it('omits the count badge on every mode pill when there are no lines', () => {
    renderPage({ lines: [] });
    expect(getModePill('All').textContent).toBe('All');
    expect(getModePill('passive').textContent).toBe('passive');
    expect(getModePill('chat').textContent).toBe('chat');
    expect(getModePill('agent').textContent).toBe('agent');
  });
});

// ---------------------------------------------------------------------------
// 7. KPI toggle (deselect on second click)
// ---------------------------------------------------------------------------

describe('SoupKitchen KPI toggle', () => {
  const lines = [
    makeLine({ name: 'on1', status: 'online' }),
    makeLine({ name: 'on2', status: 'online' }),
    makeLine({ name: 'down', status: 'unreachable' }),
  ];

  it('first click on a KPI activates it (aria-pressed=true)', () => {
    renderPage({ lines });
    const card = getKpiCard('Lines Connected');
    expect(card.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('true');
  });

  it('second click on the same KPI deactivates it and restores the full list', () => {
    renderPage({ lines });
    const card = getKpiCard('Lines Connected');
    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('true');
    expect(within(tableBody()).queryByText('down')).toBeNull();

    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('false');
    expect(within(tableBody()).queryByText('down')).not.toBeNull();
    expect(within(tableBody()).queryByText('on1')).not.toBeNull();
    expect(within(tableBody()).queryByText('on2')).not.toBeNull();
  });

  it('clicking a different KPI switches activation', () => {
    renderPage({ lines });
    const connected = getKpiCard('Lines Connected');
    const attention = getKpiCard('Need Attention');

    fireEvent.click(connected);
    expect(connected.getAttribute('aria-pressed')).toBe('true');
    expect(attention.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(attention);
    expect(connected.getAttribute('aria-pressed')).toBe('false');
    expect(attention.getAttribute('aria-pressed')).toBe('true');
  });

  it('chart-backed KPIs expand their chart column and collapse on second click', () => {
    renderPage({ lines });
    const messages = getKpiCard('Messages Sent');
    const messagePanel = screen.getByText('Message Volume (24h)').closest('section')!.parentElement as HTMLElement;
    const tokenPanel = screen.getByText('Token Usage (24h)').closest('section')!.parentElement as HTMLElement;

    fireEvent.click(messages);

    expect(messages.getAttribute('aria-pressed')).toBe('true');
    expect(messagePanel.style.opacity).toBe('1');
    expect(tokenPanel.style.opacity).toBe('0');

    fireEvent.click(messages);

    expect(messages.getAttribute('aria-pressed')).toBe('false');
    expect(tokenPanel.style.opacity).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// 8. Sparkline data for KPI cards
// ---------------------------------------------------------------------------

describe('SoupKitchen sparkline integration', () => {
  it('derives sparkline data from fleet metrics messageVolume', () => {
    const messageVolume = [
      { bucket: '2026-04-05T00:00:00Z', inbound: 10, outbound: 20, media: 2 },
      { bucket: '2026-04-05T01:00:00Z', inbound: 5,  outbound: 40, media: 4 },
      { bucket: '2026-04-05T02:00:00Z', inbound: 0,  outbound: 0,  media: 0 },
    ];
    const sparklines = deriveFleetMessageSparklines(messageVolume);
    expect(sparklines).toBeDefined();
    expect(sparklines!.outbound).toEqual([0.5, 1, 0]);
    expect(sparklines!.inbound).toEqual([1, 0.5, 0]);
    expect(sparklines!.media).toEqual([0.5, 1, 0]);
  });

  it('calls useFleetMetrics with the default "24h" range on first render', () => {
    renderPage({ lines: [] });
    expect(useFleetMetricsMock).toHaveBeenCalled();
    expect(useFleetMetricsMock.mock.calls[0][0]).toBe('24h');
  });

  it('switches the metrics range when the 7d range pill is clicked', () => {
    renderPage({ lines: [] });
    fireEvent.click(screen.getByText('7d'));
    const lastCall = useFleetMetricsMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('7d');
  });
});

// ---------------------------------------------------------------------------
// 9. Component structural composition — observable rendering
// ---------------------------------------------------------------------------

describe('SoupKitchen structural composition', () => {
  it('renders the Lines heading', () => {
    renderPage({ lines: [] });
    expect(screen.getByRole('heading', { name: 'Lines' })).toBeDefined();
  });

  it('renders the Metrics heading', () => {
    renderPage({ lines: [] });
    expect(screen.getByRole('heading', { name: 'Metrics' })).toBeDefined();
  });

  it('renders a search input for lines', () => {
    renderPage({ lines: [] });
    expect(screen.getByPlaceholderText('Search lines...')).toBeDefined();
    expect(screen.getByLabelText('Search lines')).toBeDefined();
  });

  it('renders the Add Line button', () => {
    renderPage({ lines: [] });
    expect(screen.getByRole('button', { name: /Add Line/ })).toBeDefined();
  });

  it('opens and closes the lazy Add Line wizard from the primary toolbar action', async () => {
    renderPage({ lines: [] });

    fireEvent.click(screen.getByRole('button', { name: /Add Line/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Add New Line' });
    expect(within(dialog).getByRole('heading', { name: 'Identity' })).toBeDefined();
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add New Line' })).toBeNull();
    });
  });

  it('renders activity feed events from the useFeed hook', () => {
    const feed: FeedEvent[] = [
      { time: '12:00', mode: 'passive', text: 'feed-event-one' },
      { time: '12:01', mode: 'agent',   text: 'feed-event-two' },
    ];
    renderPage({ lines: [], feed });
    expect(screen.getByText(/feed-event-one/)).toBeDefined();
    expect(screen.getByText(/feed-event-two/)).toBeDefined();
  });

  it('propagates iMessage from the line through ActivityFeed and renders its fleet badge', () => {
    const { container } = renderPage({
      lines: [makeLine({ name: 'imessage-line', transport: 'imessage' })],
      feed: [{
        time: '12:00',
        mode: 'chat',
        text: 'imessage-line: inbound message',
        instance: 'imessage-line',
        detail: {
          type: 'message',
          direction: 'inbound',
          senderName: 'Alex',
          preview: '*literal* _still-literal_ https://example.com',
        },
      }],
    });

    expect(screen.getByTitle('Transport: iMessage')).toBeDefined();
    expect(container.querySelector('.fc strong, .fc em, .fc s, .fc code')).toBeNull();
    expect(container.textContent).toContain('*literal* _still-literal_');
    expect(screen.getByRole('link', { name: 'https://example.com' })).toBeDefined();
  });

  it('is exported as a default React function component', async () => {
    const mod = await import('../../console/src/pages/SoupKitchen');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });

  // C2.3: Toolbar is now the filter shell — role="toolbar" with aria-label.
  it('renders a toolbar landmark with accessible label', () => {
    renderPage({ lines: [] });
    expect(screen.getByRole('toolbar', { name: 'Instance filters' })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Drawer — open / close / retarget / aria-current / missing-line
// ---------------------------------------------------------------------------

describe('SoupKitchen drawer', () => {
  const lineA = makeLine({ name: 'line-a', status: 'online', mode: 'passive', phone: '+15551111111' });
  const lineB = makeLine({ name: 'line-b', status: 'online',   mode: 'chat',  phone: '+15552222222' });

  it('drawer is closed by default', () => {
    renderPage({ lines: [lineA] });
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('clicking a row opens the drawer and shows the line name in the head', () => {
    renderPage({ lines: [lineA] });
    fireEvent.click(screen.getByText(displayInstanceName('line-a')).closest('tr')!);
    const drawer = screen.getByRole('complementary');
    expect(drawer).toBeDefined();
    // Drawer head shows the line name as title
    expect(within(drawer).getByText(displayInstanceName('line-a'))).toBeDefined();
  });

  it('selected row gets aria-current="true" when its drawer is open', () => {
    renderPage({ lines: [lineA, lineB] });
    const rowA = screen.getByText(displayInstanceName('line-a')).closest('tr')!;
    fireEvent.click(rowA);
    expect(rowA.getAttribute('aria-current')).toBe('true');
    // Other rows remain without aria-current
    const rowB = screen.getByText(displayInstanceName('line-b')).closest('tr')!;
    expect(rowB.getAttribute('aria-current')).toBeNull();
  });

  it('clicking another row while drawer is open retargets it (content swap, no close)', () => {
    renderPage({ lines: [lineA, lineB] });
    // Open for lineA
    fireEvent.click(screen.getByText(displayInstanceName('line-a')).closest('tr')!);
    const drawer = screen.getByRole('complementary');
    expect(within(drawer).getByText(displayInstanceName('line-a'))).toBeDefined();

    // Retarget to lineB — drawer stays open, content swaps
    fireEvent.click(screen.getByText(displayInstanceName('line-b')).closest('tr')!);
    expect(screen.getByRole('complementary')).toBe(drawer); // same node — no remount
    expect(within(drawer).getByText(displayInstanceName('line-b'))).toBeDefined();
    // lineA name no longer in drawer head (it was the title span)
    expect(within(drawer).queryByText(displayInstanceName('line-a'))).toBeNull();
  });

  it('aria-current follows retarget: moves from lineA to lineB', () => {
    renderPage({ lines: [lineA, lineB] });
    const rowA = screen.getByText(displayInstanceName('line-a')).closest('tr')!;
    const rowB = screen.getByText(displayInstanceName('line-b')).closest('tr')!;
    fireEvent.click(rowA);
    expect(rowA.getAttribute('aria-current')).toBe('true');
    fireEvent.click(rowB);
    expect(rowA.getAttribute('aria-current')).toBeNull();
    expect(rowB.getAttribute('aria-current')).toBe('true');
  });

  it('Escape closes the drawer', () => {
    renderPage({ lines: [lineA] });
    fireEvent.click(screen.getByText(displayInstanceName('line-a')).closest('tr')!);
    expect(screen.getByRole('complementary')).toBeDefined();

    // Escape on the drawer shell
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('close X button closes the drawer', () => {
    renderPage({ lines: [lineA] });
    fireEvent.click(screen.getByText(displayInstanceName('line-a')).closest('tr')!);
    const drawer = screen.getByRole('complementary');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('drawer KV block shows identity and provider fields', () => {
    renderPage({ lines: [lineA] });
    fireEvent.click(screen.getByText(displayInstanceName('line-a')).closest('tr')!);
    const drawer = screen.getByRole('complementary');
    expect(within(drawer).getByText('Identity')).toBeDefined();
    expect(within(drawer).getByText('Provider')).toBeDefined();
  });

  it('renders an iMessage self identity in both the line table and drawer', () => {
    const imessageLine = makeLine({
      name: 'imessage-line',
      transport: 'imessage',
      selfId: 'owner@example.com',
      phone: '+15550009999',
    });
    renderPage({ lines: [imessageLine] });

    const tableIdentity = screen.getByText('owner@example.com');
    fireEvent.click(tableIdentity.closest('tr')!);
    expect(within(screen.getByRole('complementary')).getByText('owner@example.com')).toBeDefined();
    expect(screen.queryByText('+15550009999')).toBeNull();
  });

  it('drawer log error state exposes retry for the selected line log query', () => {
    const logsRefetch = vi.fn();
    renderPage({
      lines: [lineA],
      logsError: new Error('logs offline'),
      logsRefetch,
    });

    fireEvent.click(screen.getByText(displayInstanceName('line-a')).closest('tr')!);
    const drawer = screen.getByRole('complementary');

    expect(within(drawer).getByText('Could not load logs for this line.')).toBeDefined();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry' }));
    expect(logsRefetch).toHaveBeenCalledTimes(1);
  });

  it('drawer KV swaps to lineB fields on retarget', () => {
    // Use two lines with distinguishable phone numbers
    const la = makeLine({ name: 'retarget-a', phone: '+15550001111' });
    const lb = makeLine({ name: 'retarget-b', phone: '+15550002222' });
    renderPage({ lines: [la, lb] });

    fireEvent.click(screen.getByText(displayInstanceName('retarget-a')).closest('tr')!);
    const drawer = screen.getByRole('complementary');

    // Retarget to lb
    fireEvent.click(screen.getByText(displayInstanceName('retarget-b')).closest('tr')!);
    // Drawer title is now retarget-b
    expect(within(drawer).getByText(displayInstanceName('retarget-b'))).toBeDefined();
  });

  it('renders "Line not found" when the selected line is removed from the dataset', () => {
    const { rerender } = renderPage({ lines: [lineA] });
    fireEvent.click(screen.getByText(displayInstanceName('line-a')).closest('tr')!);
    expect(screen.getByRole('complementary')).toBeDefined();

    // Re-render with the line removed — simulates a data refresh removing it
    useLinesMock.mockReturnValue({ data: [], isError: false, error: null });
    useLogsMock.mockReturnValue({ data: [], isError: false, error: null, refetch: vi.fn() });
    const toastValue: ToastContextValue = {
      toast: vi.fn(), success: vi.fn(), error: vi.fn(),
      info: vi.fn(), dismiss: vi.fn(), clear: vi.fn(),
    };
    rerender(
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          <SoupKitchen />
        </MemoryRouter>
      </ToastContext.Provider>
    );

    const drawer = screen.getByRole('complementary');
    expect(within(drawer).getByText('Line not found')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Long-value fixture — truncation class contract
// ---------------------------------------------------------------------------

describe('SoupKitchen long-value fixture', () => {
  it('renders a line with a 40+ char name without layout errors', () => {
    // This test pins the rendering contract for long names. It does NOT prove
    // CSS truncation (jsdom computes no box metrics).
    // Computed-box/trusted-event proof lives in the browser lane:
    // tests/browser/viewport-matrix.test.tsx Fleet no-overflow and LineDetail truncation cases.
    const longName = 'this-is-a-very-long-line-name-exceeding-40chars';
    const longLine = makeLine({
      name: longName,
      provider: 'a-provider-with-a-very-long-name-over-24-chars',
    });
    renderPage({ lines: [longLine] });
    expect(screen.getByText(displayInstanceName(longName))).toBeDefined();
  });
});

describe('SoupKitchen drawer focus restore after retarget (QA finding D3)', () => {
  it('Escape after retarget restores focus to the retargeted row, not the first opener', async () => {
    const la = makeLine({ name: 'focus-a', phone: '+15550003333' });
    const lb = makeLine({ name: 'focus-b', phone: '+15550004444' });
    renderPage({ lines: [la, lb] });

    const rowA = screen.getByText(displayInstanceName('focus-a')).closest('tr')!;
    const rowB = screen.getByText(displayInstanceName('focus-b')).closest('tr')!;

    act(() => { rowA.focus(); });
    fireEvent.click(rowA);
    expect(screen.getByRole('complementary')).toBeDefined();

    // Retarget to row B while open
    fireEvent.click(rowB);
    expect(screen.getByRole('complementary')).toBeDefined();

    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    await act(async () => {});
    expect(screen.queryByRole('complementary')).toBeNull();

    // Focus restores to the CURRENT originating row (B), not the first opener (A).
    expect(document.activeElement).toBe(rowB);
  });
});

// ---------------------------------------------------------------------------
// DD-15: ToolbarTimeRange adoption — chart-range seg contract
// ---------------------------------------------------------------------------

describe('SoupKitchen chart-range ToolbarTimeRange contract', () => {
  it('renders the chart-range seg as role=group with accessible label "Chart range"', () => {
    renderPage({ lines: [] });
    const seg = screen.getByRole('group', { name: 'Chart range' });
    expect(seg.getAttribute('aria-label')).toBe('Chart range');
  });

  it('marks exactly one range button aria-pressed=true after a range change', () => {
    renderPage({ lines: [] });

    const seg = screen.getByRole('group', { name: 'Chart range' });
    fireEvent.click(within(seg).getByRole('button', { name: '7d' }));

    const pressedButtons = Array.from(seg.querySelectorAll('button')).filter(
      (b) => b.getAttribute('aria-pressed') === 'true',
    );
    expect(pressedButtons).toHaveLength(1);
    expect(pressedButtons[0].textContent).toBe('7d');
  });
});

// ---------------------------------------------------------------------------
// ChartPanel error-state retry lane (SoupKitchen.tsx lines 647–701)
// Gap 4 from test-coverage-audit.md: error panel renders and onRetry refetches
// ---------------------------------------------------------------------------

describe('SoupKitchen — chart error panel renders on metrics query error', () => {
  function renderPageWithMetricsError(metricsRefetch: ReturnType<typeof vi.fn>) {
    useLinesMock.mockReturnValue({ data: [], isError: false, error: null });
    useFeedMock.mockReturnValue({ data: [], isError: false, error: null });
    useFleetMetricsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: metricsRefetch,
    });
    useLogsMock.mockReturnValue({ data: [], isError: false, error: null, refetch: vi.fn() });

    const toastValue: ToastContextValue = {
      toast: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      dismiss: vi.fn(),
      clear: vi.fn(),
    };

    return render(
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          <SoupKitchen />
        </MemoryRouter>
      </ToastContext.Provider>,
    );
  }

  it('renders "Failed to load" text in all three chart panels when metrics query errors', () => {
    renderPageWithMetricsError(vi.fn());

    const failedTexts = screen.getAllByText('Failed to load');
    expect(failedTexts.length).toBe(3);
  });

  it('each chart panel renders a Retry button when metrics query errors', () => {
    renderPageWithMetricsError(vi.fn());

    const retryBtns = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryBtns.length).toBe(3);
  });

  it('clicking Retry on any chart panel calls metricsRefetch', () => {
    const metricsRefetch = vi.fn();
    renderPageWithMetricsError(metricsRefetch);

    const retryBtns = screen.getAllByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtns[0]);
    expect(metricsRefetch).toHaveBeenCalledOnce();
  });

  it('clicking all three Retry buttons each fire metricsRefetch once each', () => {
    const metricsRefetch = vi.fn();
    renderPageWithMetricsError(metricsRefetch);

    const retryBtns = screen.getAllByRole('button', { name: 'Retry' });
    retryBtns.forEach((btn) => fireEvent.click(btn));
    expect(metricsRefetch).toHaveBeenCalledTimes(3);
  });
});

describe('SoupKitchen — chart panel degraded block (lines 472–516)', () => {
  function renderPageWithMetricsOpts(opts: {
    isError?: boolean;
    isLoading?: boolean;
    hasMessageData?: boolean;
    hasTokenData?: boolean;
    hasSessionData?: boolean;
    refetch?: ReturnType<typeof vi.fn>;
  } = {}) {
    useLinesMock.mockReturnValue({ data: [], isError: false, error: null });
    useFeedMock.mockReturnValue({ data: [], isError: false, error: null });
    useLogsMock.mockReturnValue({ data: [], isError: false, error: null, refetch: vi.fn() });
    useFleetMetricsMock.mockReturnValue({
      data: opts.isError ? undefined : {
        meta: {
          instancesQueried: 1,
          instancesFailed: 0,
          hasMessageData: opts.hasMessageData ?? false,
          hasTokenData: opts.hasTokenData ?? false,
          hasSessionData: opts.hasSessionData ?? false,
          providers: [],
        },
        messageVolume: [],
        tokenUsage: [],
        sessionActivity: [],
        tokenUsageByProvider: {},
        sessionActivityByProvider: {},
        range: '24h' as const,
      },
      isLoading: opts.isLoading ?? false,
      isError: opts.isError ?? false,
      refetch: opts.refetch ?? vi.fn(),
    });

    const toastValue: ToastContextValue = {
      toast: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      dismiss: vi.fn(),
      clear: vi.fn(),
    };

    return render(
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          <SoupKitchen />
        </MemoryRouter>
      </ToastContext.Provider>,
    );
  }

  it('renders chart shimmer placeholders while metrics are loading', () => {
    renderPageWithMetricsOpts({ isLoading: true });

    const shimmers = document.querySelectorAll('[data-testid="chart-shimmer"]');
    expect(shimmers.length).toBe(3);
  });

  it('no shimmer or "Failed to load" when metrics loaded successfully with data', () => {
    renderPageWithMetricsOpts({ hasMessageData: true, hasTokenData: true, hasSessionData: true });

    expect(screen.queryAllByText('Failed to load').length).toBe(0);
    expect(document.querySelectorAll('[data-testid="chart-shimmer"]').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ActivityFeed handler gaps (ActivityFeed.tsx lines 108–139)
// Gap 4 sibling: restart / stop confirm handlers in the ActivityFeed
// ---------------------------------------------------------------------------

describe('SoupKitchen ActivityFeed — restart and stop-confirm handlers', () => {
  function renderWithFeed(feed: FeedEvent[]) {
    useLinesMock.mockReturnValue({ data: [], isError: false, error: null });
    useFeedMock.mockReturnValue({ data: feed, isError: false, error: null });
    useLogsMock.mockReturnValue({ data: [], isError: false, error: null, refetch: vi.fn() });
    useFleetMetricsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    const toastValue: ToastContextValue = {
      toast: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      dismiss: vi.fn(),
      clear: vi.fn(),
    };

    return render(
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter>
          <SoupKitchen />
        </MemoryRouter>
      </ToastContext.Provider>,
    );
  }

  it('renders a restart action button for an actionable connection-error event', () => {
    const feed: FeedEvent[] = [
      {
        time: '12:00',
        mode: 'agent',
        text: 'alpha: connection error',
        instance: 'alpha',
        isError: true,
        detail: { type: 'connection', state: 'disconnected' },
      },
    ];
    renderWithFeed(feed);

    expect(screen.getByRole('button', { name: 'Restart alpha' })).toBeDefined();
  });

  it('renders a stop action button for an actionable connection-error event', () => {
    const feed: FeedEvent[] = [
      {
        time: '12:00',
        mode: 'agent',
        text: 'alpha: connection error',
        instance: 'alpha',
        isError: true,
        detail: { type: 'connection', state: 'disconnected' },
      },
    ];
    renderWithFeed(feed);

    expect(screen.getByRole('button', { name: 'Stop alpha instance' })).toBeDefined();
  });

  it('clicking the Stop button opens the ActivityFeed ConfirmDialog', () => {
    const feed: FeedEvent[] = [
      {
        time: '12:00',
        mode: 'agent',
        text: 'alpha: connection error',
        instance: 'alpha',
        isError: true,
        detail: { type: 'connection', state: 'disconnected' },
      },
    ];
    renderWithFeed(feed);

    fireEvent.click(screen.getByRole('button', { name: 'Stop alpha instance' }));

    // ConfirmDialog title is a span not a heading element
    expect(screen.getByText(/Stop alpha\?/)).toBeDefined();
  });

  it('ActivityFeed pause/resume toggle button is present and toggles pressed state', () => {
    const feed: FeedEvent[] = [
      { time: '12:00', mode: 'passive', text: 'feed-event' },
    ];
    renderWithFeed(feed);

    const pauseBtn = screen.getByRole('button', { name: /pause/i });
    expect(pauseBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(pauseBtn);
    expect(screen.getByRole('button', { name: /resume/i }).getAttribute('aria-pressed')).toBe('true');
  });
});
