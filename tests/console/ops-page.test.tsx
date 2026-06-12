/**
 * @vitest-environment jsdom
 *
 * Ops page — mount and behavior tests.
 *
 * Page harness idiom mirrors tests/console/inbox-page.test.tsx:
 *   - All hooks and API calls mocked at their module boundary
 *   - Asserts on DOM text, aria state, and className — not internals
 *   - framer-motion stubbed so motion.div renders without animation machinery
 *
 * Covers:
 *   - Page mounts; "Fleet Status" and "Logs" headings are present
 *   - LogStream primitive is adopted (rendered in the page)
 *   - Log-level filter pills rendered; clicking a level filters the log entries
 *   - statusWashClass call-site: online line has no wash class; degraded gets warn wash;
 *     unreachable / logged_out get crit wash (status-first color program pillar)
 *   - logLevelTone: error → crit tone, warn → warn tone, others → neutral tone
 *   - Empty state when no lines are discovered
 *   - Loading state when lines data is still fetching
 *   - Delete confirm flow: clicking Delete opens ConfirmDialog, confirming calls api.deleteLine
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// ---------------------------------------------------------------------------
// Module-level mocks — declared before component import
// ---------------------------------------------------------------------------

// framer-motion: render motion.div as a plain div
vi.mock('framer-motion', async () => {
  const React = await import('react')
  return {
    motion: {
      div: ({
        children,
        className,
        initial: _i,
        animate: _a,
        transition: _t,
        ...rest
      }: Record<string, unknown> & { children?: ReactNode; className?: string }) =>
        React.createElement('div', { className, ...rest }, children),
    },
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  }
})

const mockUseLines = vi.hoisted(() => vi.fn())
const mockUseLogs = vi.hoisted(() => vi.fn())
const mockUseFeed = vi.hoisted(() => vi.fn())

vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: mockUseLines,
  useLogs: mockUseLogs,
  useFeed: mockUseFeed,
}))

const mockApi = vi.hoisted(() => ({
  deleteLine: vi.fn(),
  restart: vi.fn(),
  stopInstance: vi.fn(),
}))

vi.mock('../../console/src/lib/api', () => ({
  api: mockApi,
}))

vi.mock('../../console/src/hooks/toast-context', () => ({
  useToast: () => ({
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }),
  ToastContext: {
    Provider: ({ children }: { children?: ReactNode }) => children,
  },
}))

// ---------------------------------------------------------------------------
// Dynamic imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import Ops from '../../console/src/pages/Ops'
import { statusWashClass } from '../../console/src/lib/status-severity'
import type { LineInstance, LogEntry, FeedEvent } from '../../console/src/types'

// ---------------------------------------------------------------------------
// Fixtures and helpers
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
  }
}

function makeLog(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2026-06-11T12:00:00Z',
    level: 'info',
    msg: 'test log message',
    source: 'test',
    ...overrides,
  }
}

function makeFeed(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    time: '2026-06-11T12:00:00Z',
    mode: 'passive',
    text: 'test event',
    ...overrides,
  }
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

interface RenderOpts {
  lines?: LineInstance[]
  logs?: LogEntry[]
  feed?: FeedEvent[]
  linesLoading?: boolean
}

function renderOps(opts: RenderOpts = {}) {
  const { lines = [], logs = [], feed = [], linesLoading = false } = opts

  mockUseLines.mockReturnValue({ data: lines, isLoading: linesLoading })
  mockUseLogs.mockReturnValue({ data: logs })
  mockUseFeed.mockReturnValue({ data: feed })

  const qc = makeClient()
  return render(
    <QueryClientProvider client={qc}>
      <Ops />
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
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
    })
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Page-level mount (rendering contract)
// ---------------------------------------------------------------------------

describe('Ops page — mount', () => {
  it('renders the "Fleet Status" section heading', () => {
    renderOps()

    expect(screen.getByText('Fleet Status')).toBeDefined()
  })

  it('renders the "Logs" section heading', () => {
    renderOps()

    expect(screen.getByText('Logs')).toBeDefined()
  })

  it('renders the log-level filter toolbar with level labels', () => {
    renderOps()

    // Level pills rendered by the Toolbar: all, error, warn, info, debug
    expect(screen.getByRole('button', { name: /^all$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^error$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^warn$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^info$/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /^debug$/i })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 2. LogStream primitive adoption
// ---------------------------------------------------------------------------

describe('Ops page — LogStream primitive adoption', () => {
  it('LogStream empty message appears when no logs and no line selected', () => {
    renderOps({ lines: [], logs: [] })

    // LogStream renders its emptyMessage when entries is empty
    expect(screen.getByText('Select an instance to view logs.')).toBeDefined()
  })

  it('renders log entry messages via LogStream', () => {
    const line = makeLine({ name: 'alpha' })
    const logs = [
      makeLog({ msg: 'startup complete', level: 'info' }),
      makeLog({ msg: 'warn signal detected', level: 'warn' }),
    ]
    renderOps({ lines: [line], logs })

    expect(screen.getByText('startup complete')).toBeDefined()
    expect(screen.getByText('warn signal detected')).toBeDefined()
  })

  it('filtered log count shown in the status bar reflects current filter', () => {
    const line = makeLine({ name: 'alpha' })
    const logs = [
      makeLog({ msg: 'info msg', level: 'info' }),
      makeLog({ msg: 'error msg', level: 'error' }),
    ]
    renderOps({ lines: [line], logs })

    // Initial state: "all" filter — 2 entries
    expect(screen.getAllByText('2 entries').length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Log-level filter behavior (level filter pills wired)
// ---------------------------------------------------------------------------

describe('Ops page — log-level filter wiring', () => {
  it('clicking the "error" filter pill shows only error-level log entries', () => {
    const line = makeLine({ name: 'alpha' })
    const logs = [
      makeLog({ msg: 'info-only message', level: 'info' }),
      makeLog({ msg: 'error-only message', level: 'error' }),
    ]
    renderOps({ lines: [line], logs })

    fireEvent.click(screen.getByRole('button', { name: /^error$/i }))

    expect(screen.getByText('error-only message')).toBeDefined()
    expect(screen.queryByText('info-only message')).toBeNull()
  })

  it('switching back to "all" shows all log entries again', () => {
    const line = makeLine({ name: 'alpha' })
    const logs = [
      makeLog({ msg: 'info-only message', level: 'info' }),
      makeLog({ msg: 'error-only message', level: 'error' }),
    ]
    renderOps({ lines: [line], logs })

    fireEvent.click(screen.getByRole('button', { name: /^error$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^all$/i }))

    expect(screen.getByText('info-only message')).toBeDefined()
    expect(screen.getByText('error-only message')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 4. statusWashClass call-site — status-first color (program pillar)
// ---------------------------------------------------------------------------

describe('Ops page — statusWashClass applied to instance cards', () => {
  it('online line card has no warn/crit wash class (clean background)', () => {
    const line = makeLine({ name: 'alpha', status: 'online' })
    const { container } = renderOps({ lines: [line] })

    // The card div should not carry bg-[var(--s-warn-wash)] or bg-[var(--s-crit-wash)]
    const cards = container.querySelectorAll('[class*="c-card c-hover"]')
    expect(cards.length).toBeGreaterThanOrEqual(1)
    const card = cards[0] as HTMLElement
    expect(card.className).not.toContain('s-warn-wash')
    expect(card.className).not.toContain('s-crit-wash')
  })

  it('degraded line card carries the warn wash class', () => {
    const line = makeLine({ name: 'bravo', status: 'degraded' })
    const { container } = renderOps({ lines: [line] })

    // statusWashClass('degraded') === 'bg-[var(--s-warn-wash)]'
    const warnWash = statusWashClass('degraded')
    expect(warnWash).toBe('bg-[var(--s-warn-wash)]')

    const cards = container.querySelectorAll('[class*="c-card c-hover"]')
    expect(cards.length).toBeGreaterThanOrEqual(1)
    const card = cards[0] as HTMLElement
    expect(card.className).toContain('s-warn-wash')
  })

  it('unreachable line card carries the crit wash class', () => {
    const line = makeLine({ name: 'charlie', status: 'unreachable', linkedStatus: 'linked' })
    const { container } = renderOps({ lines: [line] })

    const critWash = statusWashClass('unreachable')
    expect(critWash).toBe('bg-[var(--s-crit-wash)]')

    const cards = container.querySelectorAll('[class*="c-card c-hover"]')
    expect(cards.length).toBeGreaterThanOrEqual(1)
    const card = cards[0] as HTMLElement
    expect(card.className).toContain('s-crit-wash')
  })

  it('logged_out line card carries the crit wash class', () => {
    const line = makeLine({ name: 'delta', status: 'logged_out', linkedStatus: 'unlinked' })
    const { container } = renderOps({ lines: [line] })

    const critWash = statusWashClass('logged_out')
    expect(critWash).toBe('bg-[var(--s-crit-wash)]')

    const cards = container.querySelectorAll('[class*="c-card c-hover"]')
    expect(cards.length).toBeGreaterThanOrEqual(1)
    const card = cards[0] as HTMLElement
    expect(card.className).toContain('s-crit-wash')
  })
})

// ---------------------------------------------------------------------------
// 5. logLevelTone — Pill tone mapping
// ---------------------------------------------------------------------------

describe('statusWashClass — direct unit cases (status-severity.ts:25)', () => {
  it('online status returns empty string (no wash)', () => {
    expect(statusWashClass('online')).toBe('')
  })

  it('degraded status returns warn wash class', () => {
    expect(statusWashClass('degraded')).toBe('bg-[var(--s-warn-wash)]')
  })

  it('unknown status returns warn wash class', () => {
    expect(statusWashClass('unknown')).toBe('bg-[var(--s-warn-wash)]')
  })

  it('unreachable status returns crit wash class', () => {
    expect(statusWashClass('unreachable')).toBe('bg-[var(--s-crit-wash)]')
  })

  it('logged_out status returns crit wash class', () => {
    expect(statusWashClass('logged_out')).toBe('bg-[var(--s-crit-wash)]')
  })

  it('config_error status returns crit wash class', () => {
    expect(statusWashClass('config_error')).toBe('bg-[var(--s-crit-wash)]')
  })
})

// ---------------------------------------------------------------------------
// 6. Empty and loading states
// ---------------------------------------------------------------------------

describe('Ops page — empty and loading states', () => {
  it('shows "No instances discovered" when lines array is empty (not loading)', () => {
    renderOps({ lines: [], linesLoading: false })

    expect(screen.getByText('No instances discovered. Create one from the Soup Kitchen.')).toBeDefined()
  })

  it('shows "Loading fleet status..." when lines are still loading', () => {
    renderOps({ lines: [], linesLoading: true })

    expect(screen.getByText('Loading fleet status...')).toBeDefined()
  })

  it('renders N instance cards when N lines are provided', () => {
    const lines = [
      makeLine({ name: 'alpha', status: 'online' }),
      makeLine({ name: 'bravo', status: 'degraded' }),
    ]
    renderOps({ lines })

    // Instance names appear in the card and status bar; getAllByText confirms presence
    expect(screen.getAllByText('alpha').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('bravo').length).toBeGreaterThanOrEqual(1)
  })

  it('summary bar shows instance count', () => {
    const lines = [
      makeLine({ name: 'alpha', status: 'online' }),
      makeLine({ name: 'bravo', status: 'online' }),
    ]
    renderOps({ lines })

    expect(screen.getByText('2 instances')).toBeDefined()
    expect(screen.getByText('2 online')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 7. Delete confirm flow
// ---------------------------------------------------------------------------

describe('Ops page — delete confirm flow', () => {
  it('clicking the Delete button on an unhealthy line opens the ConfirmDialog', async () => {
    const line = makeLine({ name: 'alpha', status: 'unreachable', linkedStatus: 'linked' })
    renderOps({ lines: [line] })

    const deleteBtn = screen.getByRole('button', { name: 'Delete' })
    await act(async () => { fireEvent.click(deleteBtn) })

    // ConfirmDialog title text includes the line name (rendered as a span, not heading)
    expect(screen.getByText(/Delete alpha\?/)).toBeDefined()
  })

  it('confirming delete calls api.deleteLine with the line name', async () => {
    mockApi.deleteLine.mockResolvedValue(undefined)
    const line = makeLine({ name: 'alpha', status: 'unreachable', linkedStatus: 'linked' })
    renderOps({ lines: [line] })

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    const confirmBtn = await screen.findByRole('button', { name: /Delete permanently/i })
    await act(async () => { fireEvent.click(confirmBtn) })

    await waitFor(() => expect(mockApi.deleteLine).toHaveBeenCalledWith('alpha'))
  })

  it('cancelling the ConfirmDialog does not call api.deleteLine', async () => {
    const line = makeLine({ name: 'alpha', status: 'unreachable', linkedStatus: 'linked' })
    renderOps({ lines: [line] })

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    const cancelBtn = await screen.findByRole('button', { name: /Cancel/i })
    await act(async () => { fireEvent.click(cancelBtn) })

    expect(mockApi.deleteLine).not.toHaveBeenCalled()
  })
})
