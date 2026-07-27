/**
 * Ops page — fleet summary, log filtering, instance actions, and design-token wiring.
 * @vitest-environment jsdom
 *
 * Asserts on DOM text, aria state, and className — not internals. framer-motion is
 * stubbed so motion.div renders without animation machinery.
 *
 * The Operator page is migrated onto the <Card> primitive: the two outer panels are
 * `<Card variant="base">` and each line card is a non-interactive
 * `<Card variant="status-edge">` carrying a wash + the severity edge channel. The
 * per-line selection affordance is an explicit inner <button> (so the FleetRowMenu
 * kebab's own <button> is never nested), and Restart/Stop/Delete route through that
 * kebab menu (FleetRowMenu → Menu primitive → ConfirmDialog for destructive items),
 * while Re-link stays a dedicated button for unlinked lines. These suites cover both
 * the behavioral contract (fleet states, log filtering, line selection, kebab
 * actions) and the design-class contract (status-first washes, neutral traffic ink,
 * statusWashClass unit cases).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import { statusWashClass } from '../../console/src/lib/status-severity'
import type { FeedEvent, LineInstance, LogEntry } from '../../console/src/types'

const useLinesMock = vi.hoisted(() => vi.fn())
const useFeedMock = vi.hoisted(() => vi.fn())
const useLogsMock = vi.hoisted(() => vi.fn())
const restartMock = vi.hoisted(() => vi.fn())
const stopInstanceMock = vi.hoisted(() => vi.fn())
const deleteLineMock = vi.hoisted(() => vi.fn())
const invalidateQueriesMock = vi.hoisted(() => vi.fn())

vi.mock('framer-motion', async () => {
  const React = await import('react')
  return {
    motion: {
      div: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
        React.createElement('div', props, children),
    },
  }
})

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  }
})

vi.mock('../../console/src/hooks/use-fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-fleet')>()
  return {
    ...actual,
    useLines: useLinesMock,
    useFeed: useFeedMock,
    useLogs: useLogsMock,
  }
})

vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: restartMock,
    stopInstance: stopInstanceMock,
    deleteLine: deleteLineMock,
  },
}))

vi.mock('../../console/src/components/RelinkModal', () => ({
  default: ({
    lineName,
    open,
    onClose,
    onLinked,
  }: {
    lineName: string
    open: boolean
    onClose: () => void
    onLinked: () => void
  }) => open ? (
    <div role="dialog" aria-label={`Relink ${lineName}`}>
      <span>Relink modal for {lineName}</span>
      <button type="button" onClick={onLinked}>finish relink</button>
      <button type="button" onClick={onClose}>close relink</button>
    </div>
  ) : null,
}))

import Ops from '../../console/src/pages/Operator'

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'alpha',
    phone: '+15550001111',
    mode: 'passive',
    status: 'online',
    accessMode: 'open',
    healthPort: 9101,
    uptime: '1h',
    messagesTotal: 12,
    health: {
      status: 'ok',
      uptime_seconds: 60,
      messages_total: 12,
      whatsapp: { connection: { state: 'connected' } },
      sqlite: { messages_total: 12, schema_version: 1 },
    },
    heartbeat: ['up', 'up', 'slow'],
    lastActive: '2026-06-15T01:00:00.000Z',
    error: null,
    linkedStatus: 'linked',
    messagesToday: 3,
    ...overrides,
  }
}

function makeLog(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2026-06-15T01:02:03.000Z',
    level: 'info',
    source: 'runtime',
    msg: 'started',
    ...overrides,
  }
}

function makeToast(): ToastContextValue {
  return {
    toast: vi.fn(() => 1),
    success: vi.fn(() => 1),
    error: vi.fn(() => 1),
    info: vi.fn(() => 1),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }
}

interface RenderOptions {
  lines?: LineInstance[]
  feed?: FeedEvent[]
  logsByLine?: Record<string, LogEntry[]>
  loading?: boolean
  linesError?: unknown
  feedError?: unknown
  logsError?: unknown
  linesRefetch?: ReturnType<typeof vi.fn>
  feedRefetch?: ReturnType<typeof vi.fn>
  logsRefetch?: ReturnType<typeof vi.fn>
}

function renderOps(opts: RenderOptions = {}) {
  const logsByLine = opts.logsByLine ?? {}
  const toast = makeToast()
  const linesRefetch = opts.linesRefetch ?? vi.fn()
  const feedRefetch = opts.feedRefetch ?? vi.fn()
  const logsRefetch = opts.logsRefetch ?? vi.fn()

  useLinesMock.mockReturnValue({
    data: opts.lines ?? [],
    isLoading: opts.loading ?? false,
    error: opts.linesError ?? null,
    refetch: linesRefetch,
  })
  useFeedMock.mockReturnValue({
    data: opts.feed ?? [],
    error: opts.feedError ?? null,
    refetch: feedRefetch,
  })
  useLogsMock.mockImplementation((lineName: string) => ({
    data: logsByLine[lineName] ?? [],
    error: opts.logsError ?? null,
    refetch: logsRefetch,
  }))

  const result = render(
    // T5 b-09a: Ops now consumes useSearchParams for the Metrics tab deep
    // link — the harness wraps it in a router (behavior unchanged).
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <Ops />
      </ToastContext.Provider>
    </MemoryRouter>,
  )

  return { ...result, toast, linesRefetch, feedRefetch, logsRefetch }
}

beforeEach(() => {
  if (!window.matchMedia) {
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

describe('Ops page fleet states', () => {
  it('renders loading and empty states from the lines query', () => {
    const { rerender } = renderOps({ loading: true })

    expect(screen.getByText('Loading fleet status...')).toBeDefined()

    useLinesMock.mockReturnValue({ data: [], isLoading: false, error: null, refetch: vi.fn() })
    useFeedMock.mockReturnValue({ data: [], error: null, refetch: vi.fn() })
    useLogsMock.mockReturnValue({ data: [], error: null, refetch: vi.fn() })

    rerender(
      <MemoryRouter>
        <ToastContext.Provider value={makeToast()}>
          <Ops />
        </ToastContext.Provider>
      </MemoryRouter>,
    )

    expect(screen.getByText('No Lines discovered. Create one from the Fleet.')).toBeDefined()
    expect(screen.getAllByText('0 entries')).toHaveLength(2)
    expect(screen.getByText('Select an instance to view logs.')).toBeDefined()
  })

  it('summarizes health, alerts, and mode-specific runtime counters', () => {
    const lines = [
      makeLine({ name: 'alpha', mode: 'passive', unread: 2, messagesToday: 5 }),
      makeLine({
        name: 'beta',
        phone: '+15550002222',
        mode: 'chat',
        status: 'degraded',
        // Explicit fresh transport signal so this fixture isolates the
        // needAttention count (connectivityUnknown covered separately below).
        health: { status: 'degraded', uptime_seconds: 60, messages_total: 8, whatsapp: { connected: false, connection: { state: 'disconnected' } }, sqlite: { messages_total: 8, schema_version: 1 } },
        queueDepth: 4,
        enrichmentUnprocessed: 1,
        messagesToday: 8,
      }),
      makeLine({
        name: 'gamma',
        phone: '+15550003333',
        mode: 'agent',
        status: 'unreachable',
        health: { status: 'unreachable', uptime_seconds: 0, messages_total: 0, whatsapp: { connected: false, connection: { state: 'disconnected' } }, sqlite: { messages_total: 0, schema_version: 1 } },
        activeSessions: 1,
        messagesToday: 0,
      }),
    ]
    // Historical feed alerts (criterion 2) — deliberately DIFFERENT count from
    // the line-derived unhealthy count below, proving the two are independent.
    const feed: FeedEvent[] = [
      { time: '2026-06-15T01:00:00.000Z', mode: 'agent', text: 'beta degraded', isError: true },
      { time: '2026-06-15T01:01:00.000Z', mode: 'chat', text: 'gamma unreachable', isError: true },
      { time: '2026-06-15T00:00:00.000Z', mode: 'passive', text: 'alpha reconnect blip', isError: true },
    ]

    renderOps({ lines, feed })

    // Historical feed alert count (criterion 2) — separate label, separate number.
    expect(screen.getByText('3 feed alerts')).toBeDefined()
    expect(screen.getByText('3 Lines')).toBeDefined()
    expect(screen.getByText('1 online')).toBeDefined()
    // Current-line-health headline (criterion 1) — derived from line status,
    // NOT from the feed's 3 alerts above.
    expect(screen.getByText('2 unhealthy')).toBeDefined()
    expect(screen.getByText('5 msgs')).toBeDefined()
    expect(screen.getByText('2 unread')).toBeDefined()
    expect(screen.getByText('q:4')).toBeDefined()
    expect(screen.getByText('enrich:1')).toBeDefined()
    expect(screen.getByText('1 session')).toBeDefined()
  })

  it('renders N instance cards when N lines are provided and counts them in the summary bar', () => {
    const lines = [
      makeLine({ name: 'alpha', status: 'online' }),
      makeLine({ name: 'bravo', phone: '+15550002222', status: 'online' }),
    ]
    renderOps({ lines })

    // Instance names appear in the card and status bar; getAllByText confirms presence
    expect(screen.getAllByText('alpha').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('bravo').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('2 Lines')).toBeDefined()
    expect(screen.getByText('2 online')).toBeDefined()
  })
})

// #1882 — the "all healthy" / "N unhealthy" headline must come from the
// CURRENT line snapshot (computeKpis), never from feed.filter(isError). The
// five scenarios below are the acceptance-criteria list verbatim.
describe('Ops page — health summary derived from current line state, not the feed (#1882)', () => {
  it('scenario 1: current degraded state renders correctly with an EMPTY feed', () => {
    const lines = [
      makeLine({ name: 'alpha', status: 'online' }),
      makeLine({ name: 'beta', phone: '+15550002222', status: 'degraded' }),
    ]
    renderOps({ lines, feed: [] })

    // The feed has NOTHING; feed.filter(isError) would have wrongly shown
    // "all healthy". The line snapshot says otherwise.
    expect(screen.getByText('1 unhealthy')).toBeDefined()
    expect(screen.queryByText('all healthy')).toBeNull()
  })

  it('scenario 2: recovered lines render "all healthy" despite an OLD error feed entry', () => {
    const lines = [
      makeLine({ name: 'alpha', status: 'online' }),
      makeLine({ name: 'beta', phone: '+15550002222', status: 'online' }),
    ]
    const feed: FeedEvent[] = [
      { time: '2020-01-01T00:00:00.000Z', mode: 'chat', text: 'beta: old disconnect', isError: true },
    ]
    renderOps({ lines, feed })

    // Both lines are online NOW — the headline reflects that even though a
    // stale error entry still sits in the feed.
    expect(screen.getByText('all healthy')).toBeDefined()
    expect(screen.queryByText(/unhealthy/)).toBeNull()
    // The old entry still surfaces, but labeled historical, never "unhealthy".
    expect(screen.getByText('1 feed alert')).toBeDefined()
  })

  it('scenario 3: unrelated feed warnings never count toward "unhealthy"', () => {
    const lines = [makeLine({ name: 'alpha', status: 'online' })]
    const feed: FeedEvent[] = [
      { time: '2026-06-15T01:00:00.000Z', mode: 'passive', text: 'alpha: queue backlog warning', isError: true },
      { time: '2026-06-15T01:01:00.000Z', mode: 'passive', text: 'alpha: tool error reported', isError: true },
    ]
    renderOps({ lines, feed })

    expect(screen.getByText('all healthy')).toBeDefined()
    expect(screen.getByText('2 feed alerts')).toBeDefined()
  })

  it('scenario 4: a degrade/recover cycle is reflected on rerender even though the feed missed it', () => {
    const onlineLines = [makeLine({ name: 'alpha', status: 'online' })]
    const { rerender } = renderOps({ lines: onlineLines, feed: [] })
    expect(screen.getByText('all healthy')).toBeDefined()

    // Simulate the exact defect this issue reports: the line degrades and
    // recovers, but the feed's request-timed synthesis never captured either
    // transition (feed stays [] throughout — the historical list is
    // genuinely blind here). The summary must still track it because it
    // never depended on the feed to begin with.
    useLinesMock.mockReturnValue({
      data: [makeLine({ name: 'alpha', status: 'degraded' })],
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    })
    rerender(
      <MemoryRouter>
        <ToastContext.Provider value={makeToast()}>
          <Ops />
        </ToastContext.Provider>
      </MemoryRouter>,
    )
    expect(screen.getByText('1 unhealthy')).toBeDefined()

    useLinesMock.mockReturnValue({ data: onlineLines, isLoading: false, error: null, refetch: vi.fn() })
    rerender(
      <MemoryRouter>
        <ToastContext.Provider value={makeToast()}>
          <Ops />
        </ToastContext.Provider>
      </MemoryRouter>,
    )
    expect(screen.getByText('all healthy')).toBeDefined()
  })

  it('scenario 5: two concurrent renders of the same line snapshot agree with each other', () => {
    const lines = [makeLine({ name: 'alpha', status: 'degraded' })]

    // Two independent "clients" (renders) reading the SAME lines snapshot.
    // The old feed-diff mechanism raced concurrent requests against one
    // shared process-global previousStatuses map; computeKpis is a pure
    // function of `lines`, so both clients must agree regardless of order.
    useLinesMock.mockReturnValue({ data: lines, isLoading: false, error: null, refetch: vi.fn() })
    useFeedMock.mockReturnValue({ data: [], error: null, refetch: vi.fn() })
    useLogsMock.mockImplementation(() => ({ data: [], error: null, refetch: vi.fn() }))

    const clientA = render(
      <MemoryRouter>
        <ToastContext.Provider value={makeToast()}>
          <Ops />
        </ToastContext.Provider>
      </MemoryRouter>,
    )
    const clientB = render(
      <MemoryRouter>
        <ToastContext.Provider value={makeToast()}>
          <Ops />
        </ToastContext.Provider>
      </MemoryRouter>,
    )

    expect(within(clientA.container).getByText('1 unhealthy')).toBeDefined()
    expect(within(clientB.container).getByText('1 unhealthy')).toBeDefined()

    clientA.unmount()
    clientB.unmount()
  })

  it('connectivity-unknown coverage surfaces beside the unhealthy count, not folded into it', () => {
    const lines = [
      makeLine({ name: 'alpha', status: 'online' }),
      makeLine({
        name: 'beta',
        phone: '+15550002222',
        status: 'degraded',
        // No whatsapp.connected in the health body — transport state unproven
        // this poll (#1881 isLineConnectivityUnknown), distinct from needAttention.
        health: {
          status: 'degraded',
          uptime_seconds: 5,
          messages_total: 0,
          whatsapp: { connection: { state: 'connecting' } },
          sqlite: { messages_total: 0, schema_version: 1 },
        },
      }),
    ]
    renderOps({ lines })

    expect(screen.getByText('1 unhealthy')).toBeDefined()
    expect(screen.getByText('1 unknown')).toBeDefined()
  })
})

describe('Ops page log stream', () => {
  it('LogStream empty message appears when no logs and no line selected', () => {
    renderOps({ lines: [], logsByLine: {} })

    expect(screen.getByText('Select an instance to view logs.')).toBeDefined()
  })

  it('uses the first line by default, switches lines, and filters logs by level', () => {
    const lines = [
      makeLine({ name: 'alpha' }),
      makeLine({ name: 'beta', phone: '+15550002222', status: 'degraded', mode: 'agent' }),
    ]

    renderOps({
      lines,
      logsByLine: {
        alpha: [
          makeLog({ level: 'info', msg: 'alpha started' }),
          makeLog({ level: 'error', msg: 'alpha failed', source: 'provider' }),
        ],
        beta: [
          makeLog({ level: 'warn', msg: 'beta degraded', source: 'health' }),
        ],
      },
    })

    expect(useLogsMock).toHaveBeenLastCalledWith('alpha')
    expect(screen.getByText('alpha started')).toBeDefined()
    expect(screen.getByText('alpha failed')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'error' }))
    expect(screen.queryByText('alpha started')).toBeNull()
    expect(screen.getByText('alpha failed')).toBeDefined()
    expect(screen.getAllByText('1 entries')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Select beta' }))
    expect(useLogsMock).toHaveBeenLastCalledWith('beta')
    expect(screen.getByText('No error logs for beta.')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'warn' }))
    expect(screen.getByText('beta degraded')).toBeDefined()
    expect(screen.getByText('health')).toBeDefined()
  })

  it('selects a fleet instance via keyboard (Enter) — ISM-06 keyboard access', () => {
    renderOps({
      lines: [makeLine({ name: 'alpha' }), makeLine({ name: 'beta', status: 'degraded' })],
      logsByLine: {},
    })

    // ISM-06: the selection affordance is the sanctioned interactive <Card>, which
    // renders a real, keyboard-operable <button> through the primitive (a native
    // button activates on Enter/Space without custom key handling).
    const betaSelect = screen.getByRole('button', { name: 'Select beta' })
    expect(betaSelect.tagName).toBe('BUTTON')
    // No button-in-button: the FleetRowMenu kebab trigger is a SIBLING of the
    // selection button, never a descendant of it.
    const kebab = screen.getByRole('button', { name: 'Actions for beta' })
    expect(betaSelect.contains(kebab)).toBe(false)

    // A native button click is the keyboard-equivalent activation path.
    fireEvent.click(betaSelect)
    expect(useLogsMock).toHaveBeenLastCalledWith('beta')
  })

  it('switching back to "all" shows all log entries again', () => {
    const line = makeLine({ name: 'alpha' })
    renderOps({
      lines: [line],
      logsByLine: {
        alpha: [
          makeLog({ level: 'info', msg: 'info-only message' }),
          makeLog({ level: 'error', msg: 'error-only message' }),
        ],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: /^error$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^all$/i }))

    expect(screen.getByText('info-only message')).toBeDefined()
    expect(screen.getByText('error-only message')).toBeDefined()
  })
})

// Locate a line card (the <Card variant="status-edge"> container) by its line
// name. The card hosts the named selection <button>; its closest `.soup-card`
// ancestor is the line card itself (the outer panels are <Card variant="base">
// which also render `.soup-card`, so we must anchor on the per-line selection
// button rather than blindly indexing all `.soup-card` nodes).
function lineCard(name: string): HTMLElement {
  const selectBtn = screen.getByRole('button', { name: `Select ${name}` })
  const card = selectBtn.closest('.soup-card') as HTMLElement | null
  if (!card) throw new Error(`line card for ${name} not found`)
  return card
}

describe('Ops page — statusWashClass applied to instance cards (status-first color)', () => {
  it('renders agent session counts as neutral traffic ink', () => {
    const line = makeLine({ name: 'agent-line', mode: 'agent', activeSessions: 2 })
    renderOps({ lines: [line] })

    const sessionCount = screen.getByText('2 sessions')
    expect(sessionCount.getAttribute('style')).toContain('--text-2')
    expect(sessionCount.className).not.toContain('text-m-agt')
  })

  it('online line card has no warn/crit wash and no status edge (clean, no sole edge signal)', () => {
    renderOps({ lines: [makeLine({ name: 'alpha', status: 'online' })] })

    const card = lineCard('alpha')
    expect(card.className).not.toContain('s-warn-wash')
    expect(card.className).not.toContain('s-crit-wash')
    // status-edge container, but online lines carry no edge channel.
    expect(card.style.borderLeftColor).toBe('')
  })

  it('degraded line card carries the warn wash AND a warn status edge (edge is an extra signal)', () => {
    renderOps({ lines: [makeLine({ name: 'bravo', phone: '+15550002222', status: 'degraded' })] })

    // statusWashClass('degraded') === 'bg-[var(--s-warn-wash)]'
    expect(statusWashClass('degraded')).toBe('bg-[var(--s-warn-wash)]')

    const card = lineCard('bravo')
    // Wash co-signal (carried on the card itself).
    expect(card.className).toContain('s-warn-wash')
    // The status-edge channel is keyed to the warn-solid token — an ADDITIONAL
    // signal alongside the wash + StatusDot shape, never the sole one.
    expect(card.style.borderLeftColor).toBe('var(--status-warn-solid)')
    // Shape co-signal: the StatusDot renders a role="img" status shape inside the
    // card, so severity survives forced-colors / colour-blindness without the edge.
    expect(card.querySelector('[role="img"]')).not.toBeNull()
  })

  it('unreachable line card carries the crit wash AND a crit status edge', () => {
    renderOps({ lines: [makeLine({ name: 'charlie', phone: '+15550003333', status: 'unreachable', linkedStatus: 'linked' })] })

    expect(statusWashClass('unreachable')).toBe('bg-[var(--s-crit-wash)]')

    const card = lineCard('charlie')
    expect(card.className).toContain('s-crit-wash')
    expect(card.style.borderLeftColor).toBe('var(--status-crit-solid)')
  })

  it('logged_out line card carries the crit wash AND a crit status edge', () => {
    renderOps({ lines: [makeLine({ name: 'delta', phone: '+15550004444', status: 'logged_out', linkedStatus: 'unlinked' })] })

    expect(statusWashClass('logged_out')).toBe('bg-[var(--s-crit-wash)]')

    const card = lineCard('delta')
    expect(card.className).toContain('s-crit-wash')
    expect(card.style.borderLeftColor).toBe('var(--status-crit-solid)')
  })
})

describe('statusWashClass — direct unit cases (status-severity.ts)', () => {
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

describe('Ops page — retryable error states', () => {
  it('renders a retryable fleet-status error when the lines query fails', () => {
    const linesRefetch = vi.fn()

    renderOps({
      lines: [],
      linesError: new Error('fleet API down'),
      linesRefetch,
    })

    expect(screen.getByText('Failed to load fleet status: fleet API down')).toBeDefined()
    expect(screen.queryByText('No Lines discovered. Create one from the Fleet.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry fleet status' }))

    expect(linesRefetch).toHaveBeenCalledTimes(1)
  })

  it('renders a retryable alerts error when the feed query fails', () => {
    const feedRefetch = vi.fn()

    renderOps({
      feedError: new Error('feed API down'),
      feedRefetch,
    })

    expect(screen.getByText('alerts unavailable')).toBeDefined()
    expect(screen.getByText('Activity feed unavailable: feed API down')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Retry alerts' }))

    expect(feedRefetch).toHaveBeenCalledTimes(1)
  })

  it('renders a retryable log error instead of a no-logs empty state when logs query fails', () => {
    const logsRefetch = vi.fn()
    const line = makeLine({ name: 'alpha' })

    renderOps({
      lines: [line],
      logsError: new Error('logs API down'),
      logsRefetch,
    })

    expect(screen.getByText('Failed to load logs: logs API down')).toBeDefined()
    expect(screen.queryByText('No logs for alpha.')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(logsRefetch).toHaveBeenCalledTimes(1)
  })
})

// Open the per-line kebab (FleetRowMenu trigger) and return the menu item by
// accessible name. The Menu primitive portals its surface to document.body, so
// the items are queryable from `screen` after the trigger is clicked.
function openKebab(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }))
}

describe('Ops page instance actions (per-line kebab — FleetRowMenu)', () => {
  it('exposes a kebab menu on EVERY line card (not just unhealthy ones)', () => {
    renderOps({
      lines: [
        makeLine({ name: 'alpha', status: 'online' }),
        makeLine({ name: 'beta', phone: '+15550002222', status: 'degraded' }),
      ],
    })

    // Both the healthy and unhealthy line expose the lifecycle kebab — the old
    // unhealthy-only inline Restart/Delete row is gone; the kebab owns those now.
    expect(screen.getByRole('button', { name: 'Actions for alpha' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Actions for beta' })).toBeDefined()
    // No standalone inline Restart/Delete buttons remain on the page.
    expect(screen.queryByRole('button', { name: /^Restart$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull()
  })

  it('requests restart via the kebab and reports success or failure', async () => {
    restartMock.mockResolvedValueOnce({ status: 'ok', instance: 'beta' })
    const { toast } = renderOps({
      lines: [makeLine({ name: 'beta', status: 'degraded', mode: 'agent', linkedStatus: 'linked' })],
    })

    openKebab('beta')
    fireEvent.click(screen.getByRole('menuitem', { name: /Restart/ }))

    expect(toast.info).toHaveBeenCalledWith('Restarting beta...')
    await waitFor(() => expect(restartMock).toHaveBeenCalledWith('beta'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('beta restart requested'))

    restartMock.mockRejectedValueOnce(new Error('systemd timeout'))
    openKebab('beta')
    fireEvent.click(screen.getByRole('menuitem', { name: /Restart/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Restart failed: systemd timeout'))
  })

  it('stops a line via the kebab only after confirming (destructive route)', async () => {
    stopInstanceMock.mockResolvedValueOnce({ status: 'ok' })
    const { toast } = renderOps({
      lines: [makeLine({ name: 'beta', status: 'online', linkedStatus: 'linked' })],
    })

    openKebab('beta')
    fireEvent.click(screen.getByRole('menuitem', { name: /Stop/ }))

    // Confirm gate: api.stopInstance must NOT fire on the menu click alone.
    expect(stopInstanceMock).not.toHaveBeenCalled()
    expect(screen.getByText('Stop beta?')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Stop line' }))

    await waitFor(() => expect(stopInstanceMock).toHaveBeenCalledWith('beta'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('beta stop requested'))
  })

  it('opens the relink modal for unlinked instances and invalidates lines after relink', async () => {
    const { toast } = renderOps({
      lines: [makeLine({ name: 'beta', status: 'logged_out', linkedStatus: 'unlinked' })],
    })

    // Re-link stays a dedicated button (FleetRowMenu does not cover re-link).
    fireEvent.click(screen.getByRole('button', { name: /Re-link/ }))

    expect(await screen.findByRole('dialog', { name: 'Relink beta' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'finish relink' }))

    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['lines'] })
      expect(toast.success).toHaveBeenCalledWith('Instance re-linked!')
    })
    expect(screen.queryByRole('dialog', { name: 'Relink beta' })).toBeNull()
  })

  it('does not render a Re-link button for linked instances', () => {
    renderOps({
      lines: [makeLine({ name: 'beta', status: 'degraded', linkedStatus: 'linked' })],
    })

    expect(screen.queryByRole('button', { name: /Re-link/ })).toBeNull()
  })

  it('confirms deletion via the kebab, clears the dialog, and reports success or API errors', async () => {
    deleteLineMock.mockResolvedValueOnce({ deleted: 'beta' })
    const { toast } = renderOps({
      lines: [makeLine({ name: 'beta', status: 'degraded', linkedStatus: 'linked' })],
    })

    openKebab('beta')
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete line/ }))
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText('Delete beta?')).toBeDefined()
    // Confirm gate: deleteLine must not fire on the menu click.
    expect(deleteLineMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(deleteLineMock).toHaveBeenCalledWith('beta'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('beta deleted'))
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['lines'] })
    expect(screen.queryByText('Delete beta?')).toBeNull()

    deleteLineMock.mockRejectedValueOnce(new Error('permission denied'))
    openKebab('beta')
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete line/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Delete failed: permission denied'))
    expect(screen.queryByText('Delete beta?')).toBeNull()
  })

  it('cancelling the delete ConfirmDialog does not call api.deleteLine', () => {
    renderOps({
      lines: [makeLine({ name: 'beta', status: 'unreachable', linkedStatus: 'linked' })],
    })

    openKebab('beta')
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete line/ }))

    const dialog = screen.getByRole('dialog')
    const cancelBtn = within(dialog).getByRole('button', { name: /Cancel/i })
    fireEvent.click(cancelBtn)

    expect(deleteLineMock).not.toHaveBeenCalled()
  })

  it('delete failure reports non-Error rejection text to the operator', async () => {
    deleteLineMock.mockRejectedValueOnce('database unavailable')
    const { toast } = renderOps({
      lines: [makeLine({ name: 'alpha', status: 'unreachable', linkedStatus: 'linked' })],
    })

    openKebab('alpha')
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete line/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Delete failed: database unavailable')
    })
  })
})
