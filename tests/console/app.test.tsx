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

// Nav renders inside the test tree and calls useRealtime
vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: false }),
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
vi.mock('../../console/src/pages/Ops', () => ({
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

  it('renders the Nav element with correct aria-label', async () => {
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

  it('pressing Cmd+K focuses the mounted search shortcut target', async () => {
    await act(async () => { renderApp('/'); });
    const search = await screen.findByLabelText('Stub global search');

    expect(document.activeElement).not.toBe(search);
    await act(async () => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });

    expect(document.activeElement).toBe(search);
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
// 6. Nav counts and update-available integration
// ---------------------------------------------------------------------------

describe('App — nav counts and update check integration', () => {
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

  it('derives Nav alert and unread counts from line data', async () => {
    mockLines = [
      { name: 'primary', status: 'online', unread: 2 },
      { name: 'sandbox', status: 'degraded', unread: 3 },
      { name: 'operator', status: 'unreachable' },
    ];

    await act(async () => { renderApp('/'); });

    await waitFor(() => {
      expect(screen.getByText('2 alerts')).toBeDefined();
      expect(screen.getByText('5')).toBeDefined();
    });
  });

  it('line detail route keeps Fleet active in Nav', async () => {
    await act(async () => { renderApp('/lines/primary-line'); });

    await waitFor(() => screen.getByTestId('page-line-detail'));
    const fleetLink = screen.getByText('Fleet').closest('a');
    expect(fleetLink?.getAttribute('aria-current')).toBe('page');
  });

  it('static version is shown in Nav when update data has not loaded', async () => {
    mockStaticVersion = 'static-sha';

    await act(async () => { renderApp('/'); });

    await waitFor(() => {
      expect(screen.getByText('vstatic-sha')).toBeDefined();
    });
  });

  it('update sha from query data overrides static version in Nav', async () => {
    mockStaticVersion = 'static-sha';
    mockUpdateData = { sha: 'live-sha', remoteSha: 'new-sha', updateAvailable: true };
    await act(async () => { renderApp('/'); });
    await waitFor(() => {
      // C1: Nav now includes a theme toggle button; use the update button's aria-label for specificity
      const btn = screen.getByRole('button', { name: /Update available/ });
      expect(btn.textContent).toContain('live-sha');
      expect(btn.textContent).toContain('new-sha');
      expect(btn.textContent).not.toContain('static-sha');
    });
  });

  it('clicking the update button calls openUpdateModal', async () => {
    mockUpdateData = { sha: 'live-sha', remoteSha: 'new-sha', updateAvailable: true };
    await act(async () => { renderApp('/'); });
    // C1: Nav now includes a theme toggle button; click the update button specifically
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
