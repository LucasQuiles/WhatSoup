/** @vitest-environment jsdom */
/**
 * LineDetail tablist contract (B1): Tabs primitive adoption, keyboard nav,
 * accent underline class, conditional MCP tabs.
 *
 * Render harness: MemoryRouter + QueryClientProvider + ToastContext.
 * All data hooks stubbed via vi.hoisted. framer-motion matchMedia stubbed.
 * RelinkModal (lazy) stubbed so Suspense resolves synchronously.
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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context';
import type { LineInstance } from '../../console/src/types';
import { api } from '../../console/src/lib/api';

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any component import
// ---------------------------------------------------------------------------

const useParamsMock = vi.hoisted(() => vi.fn(() => ({ name: 'test-line' })));
const navigateMock = vi.hoisted(() => vi.fn());

const useLineMock = vi.hoisted(() => vi.fn());
const useTypingMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useChatsMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useMessagesMock = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const useAccessMock = vi.hoisted(() => vi.fn((): {
  data?: unknown[];
  isLoading?: boolean;
  error?: Error | null;
  refetch?: () => unknown;
} => ({ data: [] })));
const useLogsMock = vi.hoisted(() => vi.fn((): {
  data?: unknown[];
  isLoading?: boolean;
  error?: Error | null;
  refetch?: () => unknown;
} => ({ data: [] })));

const useMetricsMock = vi.hoisted(() => vi.fn(() => ({
  data: undefined,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
})));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useParams: useParamsMock,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../../console/src/hooks/use-fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-fleet')>();
  return {
    ...actual,
    useLine: useLineMock,
    useChats: useChatsMock,
    useMessages: useMessagesMock,
    useAccess: useAccessMock,
    useLogs: useLogsMock,
    useTyping: useTypingMock,
  };
});

vi.mock('../../console/src/hooks/use-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-metrics')>();
  return {
    ...actual,
    useMetrics: useMetricsMock,
  };
});

// Stub the lazy RelinkModal so Suspense resolves synchronously in jsdom
vi.mock('../../console/src/components/RelinkModal', () => ({
  default: ({
    lineName,
    open,
    onClose,
    onLinked,
  }: {
    lineName: string;
    open: boolean;
    onClose: () => void;
    onLinked: () => void;
  }) => open ? (
    <div role="dialog" aria-label={`Re-link ${lineName}`}>
      <button type="button" onClick={onClose}>Close re-link</button>
      <button type="button" onClick={onLinked}>Mark linked</button>
    </div>
  ) : null,
}));

// Stub api — LineDetail calls api.restart / api.deleteLine
vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: vi.fn(() => Promise.resolve()),
    deleteLine: vi.fn(() => Promise.resolve()),
  },
}));

// ---------------------------------------------------------------------------
// matchMedia stub — framer-motion probes this in jsdom
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Component import (after mocks)
// ---------------------------------------------------------------------------

import LineDetail from '../../console/src/pages/LineDetail';
import ErrorBoundary from '../../console/src/components/ErrorBoundary';

// ---------------------------------------------------------------------------
// Test data factories + render helper
// ---------------------------------------------------------------------------

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'test-line',
    phone: '+15550001234',
    mode: 'chat',
    status: 'online',
    accessMode: 'open',
    healthPort: 9100,
    uptime: '2h',
    messagesTotal: 50,
    health: null,
    heartbeat: [],
    lastActive: new Date().toISOString(),
    error: null,
    linkedStatus: 'linked',
    ...overrides,
  };
}

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
};

function renderLineDetail(opts: { line?: LineInstance } = {}) {
  const line = opts.line ?? makeLine();
  useLineMock.mockReturnValue({ data: line });
  useParamsMock.mockReturnValue({ name: line.name });

  return renderLineDetailRoute(line.name);
}

function renderLineDetailRoute(routeName: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastValue}>
        <MemoryRouter initialEntries={[`/lines/${routeName}`]}>
          <ErrorBoundary>
            <LineDetail />
          </ErrorBoundary>
        </MemoryRouter>
      </ToastContext.Provider>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LineDetail tablist (Tabs primitive)', () => {
  it('renders 8 base tabs as role=tab inside a labeled tablist', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });
    const list = screen.getByRole('tablist', { name: 'Line detail tabs' });
    expect(within(list).getAllByRole('tab')).toHaveLength(8);
  });

  it('renders 10 tabs when the line is MCP-capable (passive mode)', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'passive' }) });
    });
    expect(screen.getAllByRole('tab')).toHaveLength(10);
  });

  it('renders 10 tabs when the line is agent mode without sandboxPerChat', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'agent', sandboxPerChat: false }) });
    });
    expect(screen.getAllByRole('tab')).toHaveLength(10);
  });

  it('ArrowRight + Enter activates the next tab; focus alone does not switch panels', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });
    const summary = screen.getByRole('tab', { name: /Summary/ });
    summary.focus();
    fireEvent.keyDown(summary, { key: 'ArrowRight' });
    const mode = screen.getByRole('tab', { name: /Mode/ });
    expect(document.activeElement).toBe(mode);
    expect(summary.getAttribute('aria-selected')).toBe('true'); // manual activation — focus did not switch
    fireEvent.keyDown(mode, { key: 'Enter' });
    expect(mode.getAttribute('aria-selected')).toBe('true');
  });

  it('selected tab carries the accent underline class (class contract — not visual proof)', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });
    expect(screen.getByRole('tab', { name: /Summary/ }).className).toContain('soup-tab--selected');
  });

  it('the tab row is a governed x-scroll region (soup-tabs class contract)', async () => {
    // Class contract only; scrollWidth overflow proof lives in the browser lane:
    // tests/browser/viewport-matrix.test.tsx LineDetail 9-tab x-scroll cases.
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });
    expect(screen.getByRole('tablist', { name: 'Line detail tabs' }).className).toContain('soup-tabs');
  });

  it('the single panel wrapper carries tabpanel role + id + aria-labelledby', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });
    const panel = screen.getByRole('tabpanel');
    expect(panel.id).toBe('tabpanel-summary');
    expect(panel.getAttribute('aria-labelledby')).toBe('tab-summary');
  });
});

describe('LineDetail header — primitive buttons + overflow contract', () => {
  it('back/re-link-or-restart/delete render as soup buttons with accessible names', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', status: 'online' }) });
    });
    expect(screen.getByRole('button', { name: 'Back' }).className).toContain('soup-actbtn');
    expect(screen.getByRole('button', { name: 'Restart' }).className).toContain('soup-btn--ghost');
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('soup-btn--danger');
  });

  it('the line name carries the truncation contract (class-only; box metrics are D7)', async () => {
    // Computed-box/trusted-event proof lives in the browser lane:
    // tests/browser/viewport-matrix.test.tsx LineDetail h1 truncation cases.
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'a-very-long-line-name-that-should-not-blow-out-the-header-row' }) });
    });
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.className).toContain('truncate');
  });
});

describe('LineDetail missing-line route state', () => {
  it('renders the loading skeleton while the line query is still pending', async () => {
    useParamsMock.mockReturnValue({ name: 'loading-line' });
    useLineMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = renderLineDetailRoute('loading-line'));
    });

    expect(container.querySelectorAll('.animate-shimmer').length).toBeGreaterThan(0);
    expect(screen.queryByRole('tablist', { name: 'Line detail tabs' })).toBeNull();
  });

  it('renders a retryable not-found state instead of a permanent loading skeleton', async () => {
    const refetch = vi.fn();
    useParamsMock.mockReturnValue({ name: 'missing-line' });
    useLineMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('not found'),
      refetch,
    });

    await act(async () => {
      renderLineDetailRoute('missing-line');
    });

    expect(screen.getByText('Line not found')).toBeDefined();
    expect(screen.getByText('missing-line may have been deleted or renamed.')).toBeDefined();
    expect(screen.queryByRole('tablist', { name: 'Line detail tabs' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry line' }));
    expect(refetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Back to fleet' }));
    expect(navigateMock).toHaveBeenCalledWith('/');
  });

  it('renders generic line-load failures with the original error and retry action', async () => {
    const refetch = vi.fn();
    useParamsMock.mockReturnValue({ name: 'broken-line' });
    useLineMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('health endpoint unavailable'),
      refetch,
    });

    await act(async () => {
      renderLineDetailRoute('broken-line');
    });

    expect(screen.getByText('Failed to load line')).toBeDefined();
    expect(screen.getByText('health endpoint unavailable')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry line' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('LineDetail tab query error states', () => {
  it('renders access and log loading states while their tab queries are pending', async () => {
    useAccessMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    useLogsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });

    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Access/ }));
    });
    await waitFor(() => expect(screen.getByText('Loading access list...')).toBeDefined());

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Logs/ }));
    });
    await waitFor(() => expect(screen.getByText('Loading logs...')).toBeDefined());
  });

  it('surfaces access query errors with retry instead of rendering an empty access list', async () => {
    const refetch = vi.fn();
    useAccessMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('access socket down'),
      refetch,
    });

    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Access/ }));
    });

    await waitFor(() => expect(screen.getByText('Failed to load access list')).toBeDefined());
    expect(screen.getByText('access socket down')).toBeDefined();
    expect(screen.queryByText('Allowed (0)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces log query errors with retry instead of rendering an empty log stream', async () => {
    const refetch = vi.fn();
    useLogsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('log tail unavailable'),
      refetch,
    });

    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Logs/ }));
    });

    await waitFor(() => expect(screen.getByText('Failed to load logs')).toBeDefined());
    expect(screen.getByText('log tail unavailable')).toBeDefined();
    expect(screen.queryByText('No log entries.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('LineDetail header workflows', () => {
  it('navigates back to the fleet from the header action', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', status: 'online' }) });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(navigateMock).toHaveBeenCalledWith('/');
  });

  it('requests a restart from the header action and reports success', async () => {
    vi.mocked(api.restart).mockResolvedValueOnce({ status: 'ok', instance: 'test-line' });

    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', status: 'online' }) });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    expect(toastValue.info).toHaveBeenCalledWith('Restarting test-line...');
    expect(api.restart).toHaveBeenCalledWith('test-line');
    await waitFor(() => expect(toastValue.success).toHaveBeenCalledWith('test-line restart requested'));
  });

  it('reports restart failures from the header action', async () => {
    vi.mocked(api.restart).mockRejectedValueOnce(new Error('supervisor unavailable'));

    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', status: 'online' }) });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    expect(toastValue.info).toHaveBeenCalledWith('Restarting test-line...');
    await waitFor(() => expect(toastValue.error).toHaveBeenCalledWith('Restart failed: supervisor unavailable'));
  });

  it('opens the re-link action instead of restart for unlinked lines', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', linkedStatus: 'unlinked' }) });
    });

    expect(screen.getByRole('button', { name: 'Re-link' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Re-link' }));

    expect(within(screen.getByRole('dialog', { name: 'Re-link test-line' })).getByRole('button', { name: 'Close re-link' })).toBeDefined();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Re-link test-line' })).getByRole('button', { name: 'Close re-link' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Re-link test-line' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Re-link' }));

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Re-link test-line' })).getByRole('button', { name: 'Mark linked' }));

    expect(toastValue.success).toHaveBeenCalledWith('test-line re-linked!');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Re-link test-line' })).toBeNull());
  });

  it('deletes a line from the header confirmation and navigates back to operator', async () => {
    vi.mocked(api.deleteLine).mockResolvedValueOnce({ deleted: 'test-line' });

    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', status: 'online' }) });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete test-line?')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(api.deleteLine).toHaveBeenCalledWith('test-line'));
    expect(toastValue.success).toHaveBeenCalledWith('test-line deleted');
    expect(navigateMock).toHaveBeenCalledWith('/operator');
    await waitFor(() => expect(screen.queryByText('Delete test-line?')).toBeNull());
  });

  it('keeps the user on the page when header delete fails', async () => {
    vi.mocked(api.deleteLine).mockRejectedValueOnce(new Error('permission denied'));

    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', status: 'online' }) });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(() => expect(toastValue.error).toHaveBeenCalledWith('Delete failed: permission denied'));
    expect(navigateMock).not.toHaveBeenCalledWith('/operator');
    await waitFor(() => expect(screen.queryByText('Delete test-line?')).toBeNull());
  });

  it('cancels header delete without calling the API', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', status: 'online' }) });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(api.deleteLine).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Delete test-line?')).toBeNull());
  });
});

describe('LineDetail page-level dialogs', () => {
  it('opens the config editor from the summary tab when config is present', async () => {
    await act(async () => {
      renderLineDetail({
        line: makeLine({
          name: 'test-line',
          mode: 'chat',
          config: { type: 'chat', agentOptions: { provider: 'openai' } },
        }),
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(within(screen.getByRole('dialog')).getByText('Edit Configuration')).toBeDefined();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens and closes the mode switch dialog from the summary tab', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Change Mode' }));
    expect(within(screen.getByRole('dialog')).getByText('Switch test-line Mode')).toBeDefined();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByText('Switch test-line Mode')).toBeNull());
  });

  it('opens page-level dialogs from the mode tab controls', async () => {
    await act(async () => {
      renderLineDetail({
        line: makeLine({
          name: 'test-line',
          mode: 'chat',
          config: { type: 'chat', agentOptions: { provider: 'openai' } },
        }),
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Mode/ }));
    });
    await waitFor(() => expect(screen.getByRole('tabpanel').id).toBe('tabpanel-mode'));
    const panel = within(screen.getByRole('tabpanel'));

    fireEvent.click(panel.getByRole('button', { name: 'Edit Configuration' }));
    expect(within(screen.getByRole('dialog')).getByText('Edit Configuration')).toBeDefined();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(panel.getByRole('button', { name: 'Change Mode' }));
    expect(within(screen.getByRole('dialog')).getByText('Switch test-line Mode')).toBeDefined();
  });
});

describe('LineDetail tab render boundaries', () => {
  it('contains a render crash to the active tab and resets the boundary on tab switch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useAccessMock.mockReturnValue({
      data: [null],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    try {
      await act(async () => {
        renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: /Access/ }));
      });

      await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
      expect(screen.getByRole('heading', { level: 1, name: 'test-line' })).toBeDefined();
      expect(screen.getByRole('tablist', { name: 'Line detail tabs' })).toBeDefined();
      expect(screen.getByText('This page crashed')).toBeDefined();
      expect(screen.getByText(/Cannot read properties/)).toBeDefined();

      await act(async () => {
        fireEvent.click(screen.getByRole('tab', { name: /Summary/ }));
      });

      await waitFor(() => expect(screen.queryByText(/Cannot read properties/)).toBeNull());
      expect(screen.getByRole('tabpanel').id).toBe('tabpanel-summary');
      expect(screen.getByRole('tablist', { name: 'Line detail tabs' })).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
