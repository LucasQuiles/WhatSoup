/**
 * App.tsx — integration-shape tests.
 *
 * Tests the routing topology, provider wiring, Suspense/ErrorBoundary
 * placement, and keyboard-shortcut/update-check behaviours declared
 * in console/src/App.tsx.
 *
 * Strategy
 * --------
 * App.tsx is a lean 74-line root (no QueryClientProvider, no BrowserRouter —
 * those live in main.tsx). We render it inside the provider stack it expects
 * (QueryClientProvider → MemoryRouter → ToastProvider) using the same RTL +
 * MemoryRouter-replace pattern as nav-status.test.tsx.
 *
 * Heavy lazy pages (SoupKitchen, LineDetail, Inbox, Ops, UpdateModal) are
 * stubbed at the module level so jsdom never fetches real chunks.
 * Hook dependencies (use-fleet, use-update-check, use-keyboard-shortcuts,
 * use-websocket) are mocked to stable no-op returns so no real API calls
 * or WebSocket connections occur.
 *
 * Source surprises
 * ----------------
 * - All four pages AND UpdateModal are lazy-loaded (5 lazy() calls total).
 * - Nav and KeyboardShortcutsHelp are eagerly imported.
 * - Providers (QueryClientProvider, BrowserRouter, RealtimeProvider, ToastProvider)
 *   all live in main.tsx — App itself has zero provider declarations.
 * - alertCount / unreadCount are derived inline from useLines() data, not from
 *   a separate hook or context.
 * - useKeyboardShortcuts receives only { onHelp } — no onSearch at the App level.
 * - getStaticVersion reads a <meta name="fleet-version"> DOM tag; returns 'unknown'
 *   when absent (no such tag in jsdom).
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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Source text helper — used for structural assertions that don't need DOM
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, '../..');
const appSource = readFileSync(resolve(repoRoot, 'console/src/App.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any dynamic imports
// ---------------------------------------------------------------------------

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: undefined }),
}));

// Mutable update-check state so individual tests can override
let mockUpdateData: Record<string, unknown> | undefined = undefined;
const mockOpenUpdateModal = vi.fn();
const mockCloseUpdateModal = vi.fn();
vi.mock('../../console/src/hooks/use-update-check', () => ({
  useUpdateCheck: () => ({
    data: mockUpdateData,
    showUpdateModal: false,
    openUpdateModal: mockOpenUpdateModal,
    closeUpdateModal: mockCloseUpdateModal,
  }),
  // Returns 'unknown' (default) — no <meta> tag in jsdom
  getStaticVersion: () => 'unknown',
}));

// Capture the onHelp callback that App passes to useKeyboardShortcuts
// so tests can invoke it directly rather than synthesising keydown events.
let capturedOnHelp: (() => void) | undefined;
vi.mock('../../console/src/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: (handlers: { onHelp?: () => void }) => {
    capturedOnHelp = handlers?.onHelp;
  },
}));

// Nav renders inside the test tree and calls useRealtime
vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: false }),
  RealtimeProvider: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

// Stub heavy lazy pages — prevents real chunk loading in jsdom
vi.mock('../../console/src/pages/SoupKitchen', () => ({
  default: () => createElement('div', { 'data-testid': 'page-soup-kitchen' }, 'SoupKitchen'),
}));
vi.mock('../../console/src/pages/LineDetail', () => ({
  default: () => createElement('div', { 'data-testid': 'page-line-detail' }, 'LineDetail'),
}));
vi.mock('../../console/src/pages/Inbox', () => ({
  default: () => createElement('div', { 'data-testid': 'page-inbox' }, 'Inbox'),
}));
vi.mock('../../console/src/pages/Ops', () => ({
  default: () => createElement('div', { 'data-testid': 'page-ops' }, 'Ops'),
}));
vi.mock('../../console/src/components/UpdateModal', () => ({
  default: ({ open }: { open: boolean; onClose: () => void; currentSha: string; lines: unknown[] }) =>
    open ? createElement('div', { 'data-testid': 'update-modal' }, 'UpdateModal') : null,
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
  mockUpdateData = undefined;
  mockOpenUpdateModal.mockClear();
  mockCloseUpdateModal.mockClear();
  capturedOnHelp = undefined;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Source-text structural assertions (no DOM — zero-cost)
// ---------------------------------------------------------------------------

describe('App.tsx source structure', () => {
  it('imports Routes and Route from react-router-dom', () => {
    expect(appSource).toContain("from 'react-router-dom'");
    expect(appSource).toContain('Routes');
    expect(appSource).toContain('Route');
  });

  it('all four page routes use lazy() for code splitting', () => {
    expect(appSource).toContain("lazy(() => import('./pages/SoupKitchen'))");
    expect(appSource).toContain("lazy(() => import('./pages/LineDetail'))");
    expect(appSource).toContain("lazy(() => import('./pages/Inbox'))");
    expect(appSource).toContain("lazy(() => import('./pages/Ops'))");
  });

  it('UpdateModal is also lazy-loaded (modal code splitting)', () => {
    expect(appSource).toContain("lazy(() => import('./components/UpdateModal'))");
  });

  it('each page route is wrapped in an ErrorBoundary', () => {
    const routeSection = appSource.slice(
      appSource.indexOf('<Routes>'),
      appSource.indexOf('</Routes>'),
    );
    const boundaryCount = (routeSection.match(/<ErrorBoundary>/g) ?? []).length;
    expect(boundaryCount).toBe(4);
  });

  it('wildcard * route redirects to / with Navigate replace', () => {
    expect(appSource).toContain('path="*"');
    expect(appSource).toContain('<Navigate to="/" replace />');
  });

  it('page Routes are inside a Suspense with PageLoader fallback', () => {
    expect(appSource).toContain('<Suspense fallback={<PageLoader />}>');
  });

  it('UpdateModal sits in its own Suspense with null fallback', () => {
    expect(appSource).toContain('<Suspense fallback={null}>');
    const nullFallbackIdx = appSource.indexOf('fallback={null}');
    const updateModalIdx = appSource.indexOf('UpdateModal', nullFallbackIdx);
    expect(updateModalIdx).toBeGreaterThan(nullFallbackIdx);
  });

  it('calls useKeyboardShortcuts with an onHelp handler', () => {
    expect(appSource).toContain('useKeyboardShortcuts');
    expect(appSource).toContain('onHelp');
  });

  it('KeyboardShortcutsHelp is NOT lazy-loaded (eagerly imported)', () => {
    expect(appSource).toContain("import { KeyboardShortcutsHelp }");
    expect(appSource).not.toContain("lazy(() => import('./components/KeyboardShortcutsHelp'))");
  });

  it('Nav is NOT lazy-loaded (eagerly imported)', () => {
    expect(appSource).toContain("import Nav from './components/Nav'");
    expect(appSource).not.toContain("lazy(() => import('./components/Nav'))");
  });

  it('/lines/:name route uses a dynamic :name param', () => {
    expect(appSource).toContain('path="/lines/:name"');
  });

  it('alertCount is derived from lines where status !== "online"', () => {
    expect(appSource).toContain("l.status !== 'online'");
    expect(appSource).toContain('alertCount');
  });

  it('unreadCount is reduced over lines using l.unread', () => {
    expect(appSource).toContain('unreadCount');
    expect(appSource).toContain('l.unread');
  });

  it('PageLoader renders "Loading..." text (JSX text node)', () => {
    // Source contains the JSX text node — single-quoted in JSX, not a JS string literal
    expect(appSource).toContain('Loading...');
  });

  it('PageLoader node is inside a Suspense before Routes', () => {
    const suspenseIdx = appSource.indexOf('<Suspense fallback={<PageLoader />}>');
    const routesIdx = appSource.indexOf('<Routes>');
    expect(suspenseIdx).toBeGreaterThan(0);
    expect(routesIdx).toBeGreaterThan(suspenseIdx);
  });
});

// ---------------------------------------------------------------------------
// 2. DOM rendering — default route
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

  it('renders the Nav element with correct aria-label', async () => {
    await act(async () => { renderApp('/'); });
    const nav = screen.getByRole('navigation');
    expect(nav.getAttribute('aria-label')).toBe('Main navigation');
  });
});

// ---------------------------------------------------------------------------
// 3. DOM rendering — each named route
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

describe('App renders — /lines/:name route', () => {
  it('renders the LineDetail stub on /lines/primary-line', async () => {
    await act(async () => { renderApp('/lines/primary-line'); });
    await waitFor(() => {
      expect(screen.getByTestId('page-line-detail')).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Wildcard / unknown route redirect
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
// 5. ErrorBoundary catches per-route errors
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
// 6. KeyboardShortcutsHelp modal toggle
// ---------------------------------------------------------------------------

describe('App — KeyboardShortcutsHelp modal', () => {
  it('shortcuts help dialog is not visible by default', async () => {
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('App passes an onHelp callback to useKeyboardShortcuts', async () => {
    await act(async () => { renderApp('/'); });
    // The mock captures the handlers object; onHelp must be a function
    expect(typeof capturedOnHelp).toBe('function');
  });

  it('invoking the onHelp callback opens the keyboard shortcuts dialog', async () => {
    await act(async () => { renderApp('/'); });
    await act(async () => { capturedOnHelp?.(); });
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
    });
  });

  it('clicking the backdrop closes the dialog (onClose prop)', async () => {
    await act(async () => { renderApp('/'); });
    // Open
    await act(async () => { capturedOnHelp?.(); });
    await waitFor(() => screen.getByRole('dialog'));
    // Close via backdrop click (onClose prop)
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement!;
    await act(async () => { fireEvent.click(backdrop); });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Update-available integration
// ---------------------------------------------------------------------------

describe('App — update check integration', () => {
  it('does not render UpdateModal when no update data', async () => {
    mockUpdateData = undefined;
    await act(async () => { renderApp('/'); });
    expect(screen.queryByTestId('update-modal')).toBeNull();
  });

  it('nav shows "All systems operational" (no lines data → 0 alerts)', async () => {
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      expect(screen.getByText('All systems operational')).toBeDefined();
    });
  });

  it('update sha from query data overrides static version in Nav', async () => {
    mockUpdateData = { sha: 'live-sha', remoteSha: 'new-sha', updateAvailable: true };
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      const btn = screen.getByRole('button');
      // Nav renders: "live-sha → new-sha" inside the update button
      expect(btn.textContent).toContain('live-sha');
      expect(btn.textContent).toContain('new-sha');
    });
  });

  it('clicking the update button calls openUpdateModal', async () => {
    mockUpdateData = { sha: 'live-sha', remoteSha: 'new-sha', updateAvailable: true };
    await act(async () => { renderApp('/'); });
    await waitFor(() => screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));
    expect(mockOpenUpdateModal).toHaveBeenCalledTimes(1);
  });
});
