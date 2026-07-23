/**
 * App.tsx behavior coverage.
 *
 * Tests routing, App-owned count wiring, keyboard shortcut behavior, and
 * update-check integration while stubbing route pages that are covered in
 * their own focused tests.
 *
 * @vitest-environment jsdom
 */
import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';
import {
  render, screen, fireEvent, act, cleanup, waitFor,
} from '@testing-library/react';
import {
  createElement, type ReactNode,
} from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any dynamic imports
// ---------------------------------------------------------------------------

let mockLines: Array<{ status: string; unread?: number; name?: string }> | undefined = undefined;
vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: mockLines }),
}));

// Mutable update-check state so individual tests can override
let mockUpdateData: Record<string, unknown> | undefined = undefined;
let mockShowUpdateModal = false;
let mockStaticVersion = 'unknown';
const mockOpenUpdateModal = vi.fn();
const mockCloseUpdateModal = vi.fn();
vi.mock('../../console/src/hooks/use-update-check', () => ({
  useUpdateCheck: () => ({
    data: mockUpdateData,
    showUpdateModal: mockShowUpdateModal,
    openUpdateModal: mockOpenUpdateModal,
    closeUpdateModal: mockCloseUpdateModal,
  }),
  getStaticVersion: () => mockStaticVersion,
}));

// The NavRail chrome renders inside the test tree and calls useRealtime
// Mutable realtime flag. Defaults to connected so the ConnectionBanner
// (DD-29) stays hidden for the routing/nav suites, preserving their DOM;
// the transport suite below flips it to drive the recovery toast.
let wsConnected = true;
vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: wsConnected }),
  RealtimeProvider: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

// Stub heavy lazy pages — prevents real chunk loading in jsdom
vi.mock('../../console/src/pages/SoupKitchen', () => ({
  default: () => createElement(
    'div',
    { 'data-testid': 'page-soup-kitchen' },
    'SoupKitchen',
    createElement('input', {
      'aria-label': 'Stub global search',
      'data-search-shortcut-target': 'true',
      defaultValue: 'needle',
    }),
  ),
}));
vi.mock('../../console/src/pages/LineDetail', () => ({
  default: () => createElement('div', { 'data-testid': 'page-line-detail' }, 'LineDetail'),
}));
vi.mock('../../console/src/pages/Inbox', () => ({
  default: () => createElement('div', { 'data-testid': 'page-inbox' }, 'Inbox'),
}));
vi.mock('../../console/src/pages/Operator', () => ({
  default: () => createElement('div', { 'data-testid': 'page-ops' }, 'Ops'),
}));
vi.mock('../../console/src/components/UpdateModal', () => ({
  default: ({ open, currentSha, lines }: { open: boolean; onClose: () => void; currentSha: string; lines: unknown[] }) =>
    open
      ? createElement('div', { 'data-testid': 'update-modal' }, `UpdateModal ${currentSha} lines:${lines.length}`)
      : null,
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after vi.mock declarations)
// ---------------------------------------------------------------------------
import App from '../../console/src/App';
import { ToastProvider } from '../../console/src/hooks/use-toast';

// ---------------------------------------------------------------------------
// Test render helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function renderApp(initialPath = '/') {
  const client = makeClient();
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [initialPath] },
        createElement(
          ToastProvider,
          null,
          createElement(App),
        ),
      ),
    ),
  );
}

beforeEach(() => {
  mockLines = undefined;
  mockUpdateData = undefined;
  mockShowUpdateModal = false;
  mockStaticVersion = 'unknown';
  mockOpenUpdateModal.mockClear();
  mockCloseUpdateModal.mockClear();
  wsConnected = true;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. DOM rendering — default route
// ---------------------------------------------------------------------------

describe('App renders — default route /', () => {
  it('renders the SoupKitchen stub on root path', async () => {
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      expect(screen.getByTestId('page-soup-kitchen')).toBeDefined();
    });
  });

  it('does not render other page stubs on root path', async () => {
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      expect(screen.queryByTestId('page-inbox')).toBeNull();
      expect(screen.queryByTestId('page-ops')).toBeNull();
    });
  });

  it('renders the chrome rail landmark with correct aria-label', async () => {
    await act(async () => { renderApp('/'); });
    const nav = screen.getByRole('navigation');
    expect(nav.getAttribute('aria-label')).toBe('Main navigation');
  });
});

// ---------------------------------------------------------------------------
// 2. DOM rendering — each named route
// ---------------------------------------------------------------------------

describe('App renders — /inbox route', () => {
  it('renders the Inbox stub', async () => {
    await act(async () => { renderApp('/inbox'); });
    await waitFor(() => {
      expect(screen.getByTestId('page-inbox')).toBeDefined();
    });
  });

  it('does not render SoupKitchen stub on /inbox', async () => {
    await act(async () => { renderApp('/inbox'); });
    await waitFor(() => {
      expect(screen.queryByTestId('page-soup-kitchen')).toBeNull();
    });
  });
});

describe('App renders — /ops route', () => {
  it('renders the Ops stub', async () => {
    await act(async () => { renderApp('/ops'); });
    await waitFor(() => {
      expect(screen.getByTestId('page-ops')).toBeDefined();
    });
  });
});

describe('App renders — v3.5 route shells (T5 b-02)', () => {
  it('/operator redirects to the canonical /ops surface', async () => {
    await act(async () => { renderApp('/operator'); });
    await waitFor(() => {
      expect(screen.getByTestId('page-ops')).toBeDefined();
    });
  });

  it('stub surfaces render the honest placeholder naming their bead', async () => {
    // T5 b-06: /dream-lab graduated off the stub onto the real v3.5 surface.
    const cases: Array<[string, string, string]> = [
      ['/agents', 'Agents', 'b-04'],
      ['/skills', 'Skills Hub', 'b-05'],
      ['/deployments', 'Deployments', 'b-08'],
      ['/settings', 'Settings', 'b-09'],
    ];
    for (const [path, surface, bead] of cases) {
      cleanup();
      await act(async () => { renderApp(path); });
      // Pin the unique bead sentence (the rail also renders the surface
      // name, so the name alone cannot prove the stub loaded).
      await waitFor(() => {
        expect(screen.getByText(new RegExp(`lands with bead ${bead}`))).toBeDefined();
      });
      expect(screen.getAllByText(surface).length).toBeGreaterThan(0);
    }
  });
});

describe('App renders — /lines/:name route', () => {
  it('renders the LineDetail stub on /lines/primary-line', async () => {
    await act(async () => { renderApp('/lines/primary-line'); });
    await waitFor(() => {
      expect(screen.getByTestId('page-line-detail')).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Wildcard / unknown route redirect
// ---------------------------------------------------------------------------

describe('App — wildcard redirect', () => {
  it('unknown route falls back to / and renders SoupKitchen', async () => {
    await act(async () => { renderApp('/does-not-exist'); });
    await waitFor(() => {
      expect(screen.getByTestId('page-soup-kitchen')).toBeDefined();
      expect(screen.queryByTestId('page-inbox')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. ErrorBoundary catches per-route errors
// ---------------------------------------------------------------------------

describe('App — ErrorBoundary catches route errors', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders error UI with "This page crashed" when a child throws', async () => {
    const { default: ErrorBoundary } = await import('../../console/src/components/ErrorBoundary');
    const Bomb = () => { throw new Error('route-crash'); };

    render(createElement(ErrorBoundary, null, createElement(Bomb)));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This page crashed');
    cleanup();
  });

  it('retry button resets the error boundary and re-renders the child', async () => {
    const { default: ErrorBoundary } = await import('../../console/src/components/ErrorBoundary');
    let shouldThrow = true;
    const Bomb = () => {
      if (shouldThrow) throw new Error('route-crash');
      return createElement('div', { 'data-testid': 'recovered' }, 'recovered-ok');
    };

    render(createElement(ErrorBoundary, null, createElement(Bomb)));
    const retryButton = screen.getByRole('button', { name: /retry/i });
    shouldThrow = false;
    fireEvent.click(retryButton);
    expect(screen.getByTestId('recovered').textContent).toBe('recovered-ok');
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// 5. KeyboardShortcutsHelp modal toggle
// ---------------------------------------------------------------------------

describe('App — KeyboardShortcutsHelp modal', () => {
  it('shortcuts help dialog is not visible by default', async () => {
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('pressing ? opens the keyboard shortcuts dialog', async () => {
    await act(async () => { renderApp('/'); });
    await act(async () => { fireEvent.keyDown(document, { key: '?' }); });
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
    });
  });

  it('pressing Cmd+K opens the command palette (showcase §17)', async () => {
    await act(async () => { renderApp('/'); });

    // Palette is closed until ⌘K. (The old binding focused a search box; v1
    // repurposes ⌘K to open the command palette — nav + jump-to-line.)
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    await act(async () => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });

    await waitFor(() => {
      const palette = screen.getByRole('dialog', { name: 'Command palette' });
      expect(palette.getAttribute('aria-modal')).toBe('true');
    });
  });

  it('clicking the backdrop closes the dialog (onClose prop)', async () => {
    await act(async () => { renderApp('/'); });
    await act(async () => { fireEvent.keyDown(document, { key: '?' }); });
    await waitFor(() => screen.getByRole('dialog'));
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement!;
    // Real browsers fire pointerdown before click; outside dismissal is owned by
    // useDismissable's pointerdown handler (single owner — no backdrop onClick).
    await act(async () => { fireEvent.pointerDown(backdrop); fireEvent.click(backdrop); });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('number shortcuts navigate between App routes', async () => {
    await act(async () => { renderApp('/'); });
    await waitFor(() => screen.getByTestId('page-soup-kitchen'));

    await act(async () => { fireEvent.keyDown(document, { key: '2' }); });
    await waitFor(() => {
      expect(screen.getByTestId('page-inbox')).toBeDefined();
      expect(screen.queryByTestId('page-soup-kitchen')).toBeNull();
    });

    await act(async () => { fireEvent.keyDown(document, { key: '3' }); });
    await waitFor(() => {
      expect(screen.getByTestId('page-ops')).toBeDefined();
      expect(screen.queryByTestId('page-inbox')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Chrome counts and update-available integration
// ---------------------------------------------------------------------------

describe('App — chrome counts and update check integration', () => {
  it('does not render UpdateModal when no update data', async () => {
    mockUpdateData = undefined;
    await act(async () => { renderApp('/'); });
    expect(screen.queryByTestId('update-modal')).toBeNull();
  });

  it('chrome header renders with no attention pill (no lines data → 0 alerts)', async () => {
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      // h1 law: the surface owns the h1 — the chrome title is a styled span.
      expect(document.querySelector('.chrome-title')?.textContent).toBe('Fleet');
    });
    expect(screen.queryByText(/need.*attention/)).toBeNull();
  });

  it('derives chrome alert pill and rail unread count from line data', async () => {
    mockLines = [
      { name: 'primary', status: 'online', unread: 2 },
      { name: 'sandbox', status: 'degraded', unread: 3 },
      { name: 'operator', status: 'unreachable' },
    ];

    await act(async () => { renderApp('/'); });

    await waitFor(() => {
      // degraded + unreachable → 2 lines needing attention (header pill);
      // 2 + 3 unread → the rail's sr-only inbox count.
      expect(screen.getByText('2 lines need attention')).toBeDefined();
      expect(screen.getByText('5 unread')).toBeDefined();
    });
  });

  it('line detail route keeps Fleet active in the rail', async () => {
    await act(async () => { renderApp('/lines/primary-line'); });

    await waitFor(() => screen.getByTestId('page-line-detail'));
    const fleetLink = screen.getByRole('link', { name: 'Fleet' });
    expect(fleetLink.getAttribute('aria-current')).toBe('page');
  });

  it('static version is shown in the rail when update data has not loaded', async () => {
    mockStaticVersion = 'static-sha';

    await act(async () => { renderApp('/'); });

    await waitFor(() => {
      expect(screen.getByText('vstatic-sha')).toBeDefined();
    });
  });

  it('update sha from query data overrides static version in the rail', async () => {
    mockStaticVersion = 'static-sha';
    mockUpdateData = { sha: 'live-sha', remoteSha: 'new-sha', updateAvailable: true };
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      // The chrome header includes a theme toggle button; use the update button's aria-label for specificity
      const btn = screen.getByRole('button', { name: /Update available/ });
      expect(btn.textContent).toContain('live-sha');
      expect(btn.textContent).toContain('new-sha');
      expect(btn.textContent).not.toContain('static-sha');
    });
  });

  it('clicking the update button calls openUpdateModal', async () => {
    mockUpdateData = { sha: 'live-sha', remoteSha: 'new-sha', updateAvailable: true };
    await act(async () => { renderApp('/'); });
    // The chrome header includes a theme toggle button; click the update button specifically
    await waitFor(() => screen.getByRole('button', { name: /Update available/ }));
    fireEvent.click(screen.getByRole('button', { name: /Update available/ }));
    expect(mockOpenUpdateModal).toHaveBeenCalledTimes(1);
  });

  it('renders UpdateModal with the current sha and line list when open', async () => {
    mockShowUpdateModal = true;
    mockUpdateData = { sha: 'live-sha', remoteSha: 'new-sha', updateAvailable: true };
    mockLines = [
      { name: 'primary', status: 'online', unread: 1 },
      { name: 'sandbox', status: 'degraded' },
    ];

    await act(async () => { renderApp('/'); });

    await waitFor(() => {
      expect(screen.getByTestId('update-modal').textContent).toBe('UpdateModal live-sha lines:2');
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Connection-status surface (DD-29)
// ---------------------------------------------------------------------------

describe('App — connection-status surface', () => {
  it('hides the ConnectionBanner while the realtime socket is connected', async () => {
    wsConnected = true;
    await act(async () => { renderApp('/'); });
    await waitFor(() => screen.getByTestId('page-soup-kitchen'));
    // No live status region is rendered when connected.
    expect(
      screen.queryByText(/showing the last known data|you're offline/i),
    ).toBeNull();
  });

  it('shows the reconnecting banner when the realtime socket is down', async () => {
    wsConnected = false;
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      expect(screen.getByText(/showing the last known data/i)).toBeDefined();
    });
  });

  it('raises a "Connection restored" toast on a disconnected→connected transition', async () => {
    wsConnected = false;
    // Stable tree: a single client/router/provider structure we re-render in
    // place so App stays MOUNTED across the transition (a remount would re-seed
    // the transport hook's previous-status and swallow the recovery edge).
    const client = makeClient();
    const tree = createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(ToastProvider, null, createElement(App)),
      ),
    );
    let rerender: (ui: React.ReactElement) => void;
    await act(async () => {
      const r = render(tree);
      rerender = r.rerender;
    });
    await waitFor(() => screen.getByText(/showing the last known data/i));
    expect(screen.queryByText('Connection restored')).toBeNull();

    // Recover the socket; re-render the SAME element so App updates, not remounts.
    wsConnected = true;
    await act(async () => {
      rerender!(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            createElement(ToastProvider, null, createElement(App)),
          ),
        ),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Connection restored')).toBeDefined();
    });
  });
});
