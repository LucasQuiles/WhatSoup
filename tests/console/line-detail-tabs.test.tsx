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
  default: () => null,
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
  it('renders 7 base tabs as role=tab inside a labeled tablist', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'chat' }) });
    });
    const list = screen.getByRole('tablist', { name: 'Line detail tabs' });
    expect(within(list).getAllByRole('tab')).toHaveLength(7);
  });

  it('renders 9 tabs when the line is MCP-capable (passive mode)', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'passive' }) });
    });
    expect(screen.getAllByRole('tab')).toHaveLength(9);
  });

  it('renders 9 tabs when the line is agent mode without sandboxPerChat', async () => {
    await act(async () => {
      renderLineDetail({ line: makeLine({ name: 'test-line', mode: 'agent', sandboxPerChat: false }) });
    });
    expect(screen.getAllByRole('tab')).toHaveLength(9);
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
});

describe('LineDetail tab query error states', () => {
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
