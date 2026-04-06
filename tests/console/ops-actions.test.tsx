/**
 * Ops page component tests — console/src/pages/Ops.tsx
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context';
import type { LineInstance, LogEntry, FeedEvent } from '../../console/src/types';

function makeLine(o: Partial<LineInstance> = {}): LineInstance {
  return { name: 'primary-line', phone: '+1 555-000-1234', mode: 'passive', status: 'online', accessMode: 'allowAll', healthPort: 9100, uptime: '2d', messagesTotal: 42, health: null, heartbeat: ['up','up','up','up','up'], lastActive: '2026-04-05T10:00:00Z', error: null, messagesToday: 10, ...o };
}
function makeLog(o: Partial<LogEntry> = {}): LogEntry {
  return { timestamp: '2026-04-05T12:00:00Z', level: 'info', msg: 'Test log', source: 'core', ...o };
}
function makeFeed(o: Partial<FeedEvent> = {}): FeedEvent {
  return { time: '2026-04-05T12:00:00Z', mode: 'passive', text: 'evt', isError: false, ...o };
}

let mLines: LineInstance[] = [];
let mLogs: LogEntry[] = [];
let mFeed: FeedEvent[] = [];
let mDelete: Mock;
let mRestart: Mock;
const mToast: ToastContextValue = { toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() };

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: mLines }),
  useLogs: () => ({ data: mLogs }),
  useFeed: () => ({ data: mFeed }),
}));
vi.mock('../../console/src/hooks/toast-context', async () => {
  const actual = await vi.importActual('../../console/src/hooks/toast-context');
  return { ...actual, useToast: () => mToast };
});
vi.mock('../../console/src/lib/api', () => ({
  api: { deleteLine: (...a: unknown[]) => mDelete(...a), restart: (...a: unknown[]) => mRestart(...a) },
}));
vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: false }),
  RealtimeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('framer-motion', () => ({
  motion: { div: ({ children, initial, animate, exit, transition, whileHover, whileTap, variants, layout, layoutId, ...rest }: Record<string, unknown>) => createElement('div', rest, children as ReactNode) },
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc },
      createElement(ToastContext.Provider, { value: mToast }, children));
}

let Ops: typeof import('../../console/src/pages/Ops').default;
afterEach(() => { cleanup(); });
beforeEach(async () => {
  vi.clearAllMocks();
  mLines = []; mLogs = []; mFeed = [];
  mDelete = vi.fn().mockResolvedValue({ deleted: 'ok' });
  mRestart = vi.fn().mockResolvedValue({ status: 'ok', instance: 'test' });
  Ops = (await import('../../console/src/pages/Ops')).default;
});

// Helper: get the fleet status panel (first major child div)
function getFleetPanel(container: HTMLElement): HTMLElement {
  const topDiv = container.firstElementChild as HTMLElement;
  return topDiv.children[0] as HTMLElement;
}

function getLogPanel(container: HTMLElement): HTMLElement {
  const topDiv = container.firstElementChild as HTMLElement;
  return topDiv.children[1] as HTMLElement;
}

// ---------------------------------------------------------------------------
// Instance list rendering
// ---------------------------------------------------------------------------

describe('Ops — instance list rendering', () => {
  it('renders Fleet Status heading', () => {
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('Fleet Status')).toBeDefined();
  });

  it('renders instance cards with name and phone', () => {
    mLines = [
      makeLine({ name: 'alpha-line', phone: '+1 555-000-1234' }),
      makeLine({ name: 'beta-bot', phone: '+1 555-000-5678', mode: 'chat' }),
    ];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getByText('alpha-line')).toBeDefined();
    expect(within(fleet).getByText('+1 555-000-1234')).toBeDefined();
    expect(within(fleet).getByText('beta-bot')).toBeDefined();
    expect(within(fleet).getByText('+1 555-000-5678')).toBeDefined();
  });

  it('shows instance and online counts', () => {
    mLines = [
      makeLine({ name: 'x1', status: 'online' }),
      makeLine({ name: 'x2', status: 'online' }),
      makeLine({ name: 'x3', status: 'degraded' }),
    ];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getByText('3 lines')).toBeDefined();
    expect(within(fleet).getByText('2 online')).toBeDefined();
  });

  it('shows "all healthy" when no feed alerts', () => {
    mLines = [makeLine()]; mFeed = [makeFeed()];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getByText('all healthy')).toBeDefined();
  });

  it('shows plural alert count for multiple errors', () => {
    mLines = [makeLine()]; mFeed = [makeFeed({ isError: true }), makeFeed({ isError: true })];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('2 alerts')).toBeDefined();
  });

  it('shows singular "alert" for exactly 1 error', () => {
    mLines = [makeLine()]; mFeed = [makeFeed({ isError: true })];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('1 alert')).toBeDefined();
  });

  it('shows message count per instance', () => {
    mLines = [makeLine({ messagesToday: 77 })];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('77 msgs')).toBeDefined();
  });

  it('uppercases single-char instance names', () => {
    mLines = [makeLine({ name: 'q' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getAllByText('Q').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Action buttons for unhealthy instances
// ---------------------------------------------------------------------------

describe('Ops — action buttons for unhealthy lines', () => {
  it('hides action buttons for online instances', () => {
    mLines = [makeLine({ name: 'healthy-one', status: 'online' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).queryByText('Restart')).toBeNull();
    expect(within(fleet).queryByText('Delete')).toBeNull();
    expect(within(fleet).queryByText('Re-link')).toBeNull();
  });

  it('shows Restart and Delete for degraded', () => {
    mLines = [makeLine({ name: 'sick-one', status: 'degraded' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getAllByText('Restart').length).toBeGreaterThanOrEqual(1);
    expect(within(fleet).getAllByText('Delete').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Restart and Delete for unreachable', () => {
    mLines = [makeLine({ name: 'down-one', status: 'unreachable' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getAllByText('Restart').length).toBeGreaterThanOrEqual(1);
    expect(within(fleet).getAllByText('Delete').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Re-link instead of Restart when unlinked', () => {
    mLines = [makeLine({ name: 'unlinked-one', status: 'degraded', linkedStatus: 'unlinked' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getAllByText('Re-link').length).toBeGreaterThanOrEqual(1);
    expect(within(fleet).queryByText('Restart')).toBeNull();
    expect(within(fleet).getAllByText('Delete').length).toBeGreaterThanOrEqual(1);
  });

  it('shows Restart (not Re-link) when linkedStatus is linked', () => {
    mLines = [makeLine({ name: 'linked-one', status: 'unreachable', linkedStatus: 'linked' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getAllByText('Restart').length).toBeGreaterThanOrEqual(1);
    expect(within(fleet).queryByText('Re-link')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Restart action
// ---------------------------------------------------------------------------

describe('Ops — restart action', () => {
  it('calls api.restart and toasts on success', async () => {
    mLines = [makeLine({ name: 'sick-line', status: 'degraded' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    const restartBtn = within(fleet).getAllByText('Restart')[0];
    fireEvent.click(restartBtn);
    expect(mToast.info).toHaveBeenCalledWith('Restarting sick-line...');
    expect(mRestart).toHaveBeenCalledWith('sick-line');
    await waitFor(() => expect(mToast.success).toHaveBeenCalledWith('sick-line restart requested'));
  });

  it('shows error toast on restart failure', async () => {
    mRestart.mockRejectedValue(new Error('conn refused'));
    mLines = [makeLine({ name: 'fail-line', status: 'degraded' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    fireEvent.click(within(fleet).getAllByText('Restart')[0]);
    await waitFor(() => expect(mToast.error).toHaveBeenCalledWith('Failed: conn refused'));
  });
});

// ---------------------------------------------------------------------------
// Delete confirmation dialog
// ---------------------------------------------------------------------------

describe('Ops — delete confirmation dialog', () => {
  it('opens dialog on Delete click', () => {
    mLines = [makeLine({ name: 'doomed', status: 'unreachable' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    expect(screen.queryByRole('dialog')).toBeNull();
    const fleet = getFleetPanel(container);
    fireEvent.click(within(fleet).getAllByText('Delete')[0]);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('Delete doomed?')).toBeDefined();
    expect(screen.getByText('Delete permanently')).toBeDefined();
  });

  it('warns about permanent data loss', () => {
    mLines = [makeLine({ name: 'my-inst', status: 'degraded' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    fireEvent.click(within(fleet).getAllByText('Delete')[0]);
    expect(screen.getByText(/cannot be undone/)).toBeDefined();
  });

  it('calls api.deleteLine on confirm', async () => {
    mLines = [makeLine({ name: 'gone', status: 'unreachable' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    fireEvent.click(within(fleet).getAllByText('Delete')[0]);
    fireEvent.click(screen.getByText('Delete permanently'));
    await waitFor(() => {
      expect(mDelete).toHaveBeenCalledWith('gone');
      expect(mToast.success).toHaveBeenCalledWith('gone deleted');
    });
  });

  it('shows error toast on delete failure', async () => {
    mDelete.mockRejectedValue(new Error('permission denied'));
    mLines = [makeLine({ name: 'prot', status: 'degraded' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    fireEvent.click(within(fleet).getAllByText('Delete')[0]);
    fireEvent.click(screen.getByText('Delete permanently'));
    await waitFor(() => expect(mToast.error).toHaveBeenCalledWith('Delete failed: permission denied'));
  });

  it('closes dialog on Cancel', () => {
    mLines = [makeLine({ name: 'saved', status: 'degraded' })];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    fireEvent.click(within(fleet).getAllByText('Delete')[0]);
    expect(screen.getByRole('dialog')).toBeDefined();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Log stream rendering
// ---------------------------------------------------------------------------

describe('Ops — log stream', () => {
  it('renders log messages', () => {
    mLines = [makeLine()]; mLogs = [makeLog({ msg: 'Connection up' }), makeLog({ msg: 'Rate warn', level: 'warn' })];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('Connection up')).toBeDefined();
    expect(screen.getByText('Rate warn')).toBeDefined();
  });

  it('shows empty state when no logs', () => {
    mLines = [makeLine({ name: 'quiet' })]; mLogs = [];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const logPanel = getLogPanel(container);
    expect(within(logPanel).getByText(/No.*logs for quiet/)).toBeDefined();
  });

  it('shows "Select a line" with empty fleet', () => {
    mLines = []; mLogs = [];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const logPanel = getLogPanel(container);
    expect(within(logPanel).getAllByText('Select a line to view logs').length).toBeGreaterThanOrEqual(1);
  });

  it('renders filter pills for each log level', () => {
    mLines = [makeLine()];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const logPanel = getLogPanel(container);
    const buttons = logPanel.querySelectorAll('button');
    const buttonTexts = Array.from(buttons).map(b => b.textContent?.trim());
    expect(buttonTexts).toContain('all');
    expect(buttonTexts).toContain('error');
    expect(buttonTexts).toContain('warn');
    expect(buttonTexts).toContain('info');
    expect(buttonTexts).toContain('debug');
  });

  it('shows entry count', () => {
    mLines = [makeLine()]; mLogs = [makeLog(), makeLog(), makeLog()];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getAllByText('3 entries').length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Log level filtering
// ---------------------------------------------------------------------------

describe('Ops — log filtering', () => {
  it('filters logs by level when pill is clicked', () => {
    mLines = [makeLine()]; mLogs = [
      makeLog({ msg: 'info-msg-xyz', level: 'info' }),
      makeLog({ msg: 'error-msg-xyz', level: 'error' }),
      makeLog({ msg: 'warn-msg-xyz', level: 'warn' }),
    ];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const logPanel = getLogPanel(container);
    expect(screen.getByText('info-msg-xyz')).toBeDefined();
    expect(screen.getByText('error-msg-xyz')).toBeDefined();
    const errorPill = Array.from(logPanel.querySelectorAll('button')).find(b => b.textContent?.trim() === 'error');
    fireEvent.click(errorPill!);
    expect(screen.getByText('error-msg-xyz')).toBeDefined();
    expect(screen.queryByText('info-msg-xyz')).toBeNull();
    expect(screen.queryByText('warn-msg-xyz')).toBeNull();
  });

  it('returns to all logs when "all" pill clicked', () => {
    mLines = [makeLine()]; mLogs = [
      makeLog({ msg: 'info-aaa', level: 'info' }),
      makeLog({ msg: 'error-bbb', level: 'error' }),
    ];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const logPanel = getLogPanel(container);
    const pills = Array.from(logPanel.querySelectorAll('button'));
    fireEvent.click(pills.find(b => b.textContent?.trim() === 'error')!);
    expect(screen.queryByText('info-aaa')).toBeNull();
    fireEvent.click(pills.find(b => b.textContent?.trim() === 'all')!);
    expect(screen.getByText('info-aaa')).toBeDefined();
    expect(screen.getByText('error-bbb')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mode-specific runtime stats
// ---------------------------------------------------------------------------

describe('Ops — mode-specific stats', () => {
  it('shows unread count for passive mode', () => {
    mLines = [makeLine({ mode: 'passive', unread: 5 })];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('5 unread')).toBeDefined();
  });

  it('shows queue depth and enrichment for chat mode', () => {
    mLines = [makeLine({ mode: 'chat', queueDepth: 3, enrichmentUnprocessed: 7 })];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('q:3')).toBeDefined();
    expect(screen.getByText('enrich:7')).toBeDefined();
  });

  it('shows plural sessions for agent mode', () => {
    mLines = [makeLine({ mode: 'agent', activeSessions: 2 })];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('2 sessions')).toBeDefined();
  });

  it('uses singular "session" for 1 active session', () => {
    mLines = [makeLine({ mode: 'agent', activeSessions: 1 })];
    render(createElement(Ops), { wrapper: wrap() });
    expect(screen.getByText('1 session')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Empty fleet state
// ---------------------------------------------------------------------------

describe('Ops — empty fleet', () => {
  it('renders without errors and shows zero counts', () => {
    mLines = [];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    expect(within(fleet).getByText('0 lines')).toBeDefined();
    expect(within(fleet).getByText('0 online')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Line card click selection
// ---------------------------------------------------------------------------

describe('Ops — line card selection', () => {
  it('updates active line on card click', () => {
    mLines = [makeLine({ name: 'line-a' }), makeLine({ name: 'line-b' })]; mLogs = [];
    const { container } = render(createElement(Ops), { wrapper: wrap() });
    const fleet = getFleetPanel(container);
    fireEvent.click(within(fleet).getByText('line-b'));
    expect(within(fleet).getAllByText('line-b').length).toBeGreaterThanOrEqual(1);
  });
});
