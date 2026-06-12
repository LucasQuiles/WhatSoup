/**
 * SoupKitchen page — behavior tests.
 *
 * Renders the real component under jsdom + Testing Library and asserts on
 * observable DOM (text content, aria states, classNames that encode user-
 * visible state) rather than scanning source strings or re-implementing
 * internals in a parallel helper. The previous version of this file matched
 * substrings against the SoupKitchen source and replicated its filter / alert
 * / mode-count logic; both patterns gave green checks even when the component
 * stopped emitting the matched markup. Tracked in issue #454.
 *
 * Tests against real exported helpers (computeKpis, deriveFleetMessageSparklines,
 * text-utils) are kept as-is — they pin contracts the component depends on.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context';

// Hoisted hook mocks — must be declared before component import so the
// `vi.mock` factories below can wire them in without forward-reference TDZ
// issues. Each entry is a vi.fn whose return value we tune per-test.
const useLinesMock = vi.hoisted(() => vi.fn());
const useFeedMock = vi.hoisted(() => vi.fn());
const useFleetMetricsMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

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
  };
});

vi.mock('../../console/src/hooks/use-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-metrics')>();
  return {
    ...actual,
    useFleetMetrics: useFleetMetricsMock,
  };
});

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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import SoupKitchen from '../../console/src/pages/SoupKitchen';
import { computeKpis } from '../../console/src/lib/compute-kpis';
import { deriveFleetMessageSparklines } from '../../console/src/lib/metrics-sparklines';
import { displayInstanceName, formatPhone, formatCompact } from '../../console/src/lib/text-utils';
import type { FeedEvent, FleetMetrics, LineInstance, Mode } from '../../console/src/types';

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

interface RenderOptions {
  lines?: LineInstance[];
  feed?: FeedEvent[];
  linesError?: Error | null;
  feedError?: Error | null;
  fleetMetrics?: Partial<FleetMetrics> | null;
}

function renderPage(opts: RenderOptions = {}) {
  const lines = opts.lines ?? [];
  const feed = opts.feed ?? [];

  useLinesMock.mockReturnValue({
    data: lines,
    isError: Boolean(opts.linesError),
    error: opts.linesError ?? null,
  });
  useFeedMock.mockReturnValue({
    data: feed,
    isError: Boolean(opts.feedError),
    error: opts.feedError ?? null,
  });
  useFleetMetricsMock.mockReturnValue({
    data: opts.fleetMetrics ?? undefined,
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
 * the order produced by the component. Scoped to <tbody> so AlertBanner and
 * ModeBadge labels can't bleed in.
 */
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

// ---------------------------------------------------------------------------
// 1. Loading / empty state
// ---------------------------------------------------------------------------

describe('SoupKitchen loading state', () => {
  it('renders with empty lines array when data is not yet loaded', () => {
    // When useLines returns { data: undefined }, the component defaults to []
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
      health: { status: 'ok', uptime_seconds: 3600, messages_total: 130, connection: { state: 'open' }, sqlite: { messages_total: 130, schema_version: 1 },
        runtime: { agent: { activeSessions: 2, lastSessionStatus: null, lastSessionStartedAt: null } } } }),
    makeLine({ name: 'charlie', status: 'degraded', mode: 'chat', messageStats: { sent: 20, received: 30, images: 0, audio: 0, documents: 0 } }),
    makeLine({ name: 'delta', status: 'unreachable', mode: 'passive', lastSessionStatus: 'auth_expired' }),
  ];

  const kpis = computeKpis(lines);

  it('computes connected count correctly', () => {
    expect(kpis.connected).toBe(2); // alpha + bravo
  });

  it('computes need attention count correctly', () => {
    expect(kpis.needAttention).toBe(2); // charlie (degraded) + delta (unreachable)
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

  it('renders all 7 KPI cards with the expected labels', () => {
    renderPage({ lines });
    const expected = [
      'Lines Connected',
      'Need Attention',
      'Messages Sent',
      'Messages Received',
      'Agent Sessions',
      'Unread',
      'Media Processed',
    ];
    for (const label of expected) {
      // getKpiCard throws if the label isn't found exactly once on a KPI card,
      // which is exactly the contract we want here.
      expect(getKpiCard(label)).toBeDefined();
    }
  });

  it('renders the computed KPI values on the cards', () => {
    renderPage({ lines });
    expect(within(getKpiCard('Lines Connected')).getByText('2')).toBeDefined();
    expect(within(getKpiCard('Need Attention')).getByText('2')).toBeDefined();
    expect(within(getKpiCard('Messages Sent')).getByText('170')).toBeDefined();
    expect(within(getKpiCard('Messages Received')).getByText('310')).toBeDefined();
    expect(within(getKpiCard('Agent Sessions')).getByText('2')).toBeDefined();
    expect(within(getKpiCard('Media Processed')).getByText('21')).toBeDefined();
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
    const expected = ['Mode', 'Line', 'Chats', 'Groups', 'Unread', 'Sent', 'Recv', 'Tokens', 'Sessions', 'Provider', 'Tags', 'Active'];
    for (const col of expected) {
      expect(screen.getByRole('columnheader', { name: new RegExp(`^${col}\\b`) })).toBeDefined();
    }
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
    // operator-agent (agent mode) should expose its totalSessions value
    const agentRow = screen.getByText(displayInstanceName('operator-agent')).closest('tr') as HTMLElement;
    expect(tableCell(agentRow, 8).textContent).toBe('47');

    // primary-line (passive mode) should show em-dash in the Sessions column.
    const passiveRow = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    expect(tableCell(passiveRow, 8).textContent).toBe('—');
    // And the passive row must NOT contain "47"
    expect(within(passiveRow).queryByText('47')).toBeNull();
  });

  it('navigates to /lines/<name> when a row is clicked', () => {
    renderPage({ lines });
    const row = screen.getByText(displayInstanceName('primary-line')).closest('tr') as HTMLElement;
    fireEvent.click(row);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('/lines/primary-line');
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
    ];
    renderPage({ lines });
    expect(screen.getByText('3 alerts')).toBeDefined();
    const banner = alertBanner();
    expect(banner).not.toBeNull();
    expect(within(banner!).getByText('auth expired')).toBeDefined();
    expect(within(banner!).getByText('degraded')).toBeDefined();
    expect(within(banner!).getByText('connection lost')).toBeDefined();
    // Healthy line 'alert-c' should NOT appear in the banner (it still
    // renders as a table row).
    expect(within(banner!).queryByText('alert-c')).toBeNull();
    // And the three unhealthy ones should all be linked from the banner.
    expect(within(banner!).getByText('alert-a')).toBeDefined();
    expect(within(banner!).getByText('alert-b')).toBeDefined();
    expect(within(banner!).getByText('alert-d')).toBeDefined();
  });

  it('applies error wash class on unreachable rows and warn wash on degraded rows', () => {
    const lines = [
      makeLine({ name: 'row-down', status: 'unreachable' }),
      makeLine({ name: 'row-slow', status: 'degraded' }),
      makeLine({ name: 'row-fine', status: 'online' }),
    ];
    renderPage({ lines });
    const body = tableBody();
    const downRow = within(body).getByText('row-down').closest('tr') as HTMLElement;
    const slowRow = within(body).getByText('row-slow').closest('tr') as HTMLElement;
    const fineRow = within(body).getByText('row-fine').closest('tr') as HTMLElement;
    expect(downRow.className).toContain('s-crit-wash');
    expect(slowRow.className).toContain('s-warn-wash');
    expect(fineRow.className).not.toContain('s-crit-wash');
    expect(fineRow.className).not.toContain('s-warn-wash');
  });

  it('renders a fleet-load-error row instead of the empty-filtered placeholder when the lines query fails', () => {
    renderPage({
      lines: [],
      linesError: new Error('upstream 502'),
    });
    expect(screen.getByText(/Unable to load fleet data: upstream 502/)).toBeDefined();
    expect(screen.queryByText('No instances match the current filters')).toBeNull();
  });

  it('renders a fleet-load-error row when the feed query fails even if lines succeeded', () => {
    renderPage({
      lines: [makeLine({ name: 'visible-line' })],
      feedError: new Error('feed offline'),
    });
    expect(screen.getByText(/Unable to load fleet data: feed offline/)).toBeDefined();
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

  it('sorts by line name and exposes aria-sort direction', () => {
    renderPage({ lines });
    const lineHeader = screen.getByRole('columnheader', { name: /^Line\b/ });

    fireEvent.click(lineHeader);
    expect(lineHeader.getAttribute('aria-sort')).toBe('descending');
    expect(visibleTableLineNames(lines)).toEqual(['echo', 'delta', 'charlie', 'bravo', 'alpha']);

    fireEvent.click(lineHeader);
    expect(lineHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  });

  it('sorts unread counts numerically and reverses direction on repeat click', () => {
    const unreadLines = [
      makeLine({ name: 'one-unread', unread: 1 }),
      makeLine({ name: 'ten-unread', unread: 10 }),
      makeLine({ name: 'two-unread', unread: 2 }),
    ];
    renderPage({ lines: unreadLines });
    const unreadHeader = screen.getByRole('columnheader', { name: /^Unread\b/ });

    fireEvent.click(unreadHeader);
    expect(unreadHeader.getAttribute('aria-sort')).toBe('descending');
    expect(visibleTableLineNames(unreadLines)).toEqual(['ten-unread', 'two-unread', 'one-unread']);

    fireEvent.click(unreadHeader);
    expect(unreadHeader.getAttribute('aria-sort')).toBe('ascending');
    expect(visibleTableLineNames(unreadLines)).toEqual(['one-unread', 'two-unread', 'ten-unread']);
  });

  it('clicking "Lines Connected" KPI filters to online lines only', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Lines Connected'));
    expect(visibleTableLineNames(lines)).toEqual(['alpha', 'bravo', 'echo']);
    expect(getKpiCard('Lines Connected').getAttribute('aria-pressed')).toBe('true');
  });

  it('clicking "Need Attention" KPI filters to degraded + unreachable lines', () => {
    renderPage({ lines });
    fireEvent.click(getKpiCard('Need Attention'));
    expect(visibleTableLineNames(lines)).toEqual(['charlie', 'delta']);
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
    // Scoped to the toolbar pill container — ModeBadge labels in rows are not
    // candidates here.
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
    fireEvent.change(screen.getByPlaceholderText('Search lines...'), { target: { value: 'ALPHA' } });
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
    // FilterPill suppresses the badge span when count === 0, so each pill
    // contains only its label text node. Asserting the absence of any digit
    // pins that suppression to user-visible output.
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
    // The unreachable line should be filtered out of the table body. The
    // AlertBanner still names it, so we scope the query to <tbody>.
    expect(within(tableBody()).queryByText('down')).toBeNull();

    fireEvent.click(card);
    expect(card.getAttribute('aria-pressed')).toBe('false');
    // All three rows visible again
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
    // The most recent invocation should pass '7d'
    const lastCall = useFleetMetricsMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('7d');
  });
});

// ---------------------------------------------------------------------------
// 9. Component structural composition — observable rendering
// ---------------------------------------------------------------------------

describe('SoupKitchen structural composition', () => {
  it('renders the Instances heading', () => {
    renderPage({ lines: [] });
    expect(screen.getByRole('heading', { name: 'Instances' })).toBeDefined();
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

  it('renders activity feed events from the useFeed hook', () => {
    const feed: FeedEvent[] = [
      { time: '12:00', mode: 'passive', text: 'feed-event-one' },
      { time: '12:01', mode: 'agent',   text: 'feed-event-two' },
    ];
    renderPage({ lines: [], feed });
    expect(screen.getByText(/feed-event-one/)).toBeDefined();
    expect(screen.getByText(/feed-event-two/)).toBeDefined();
  });

  it('is exported as a default React function component', async () => {
    const mod = await import('../../console/src/pages/SoupKitchen');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});
