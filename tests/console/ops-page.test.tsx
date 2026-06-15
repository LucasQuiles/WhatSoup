/**
 * Ops page — fleet summary, log filtering, and instance actions.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import type { FeedEvent, LineInstance, LogEntry } from '../../console/src/types'

const useLinesMock = vi.hoisted(() => vi.fn())
const useFeedMock = vi.hoisted(() => vi.fn())
const useLogsMock = vi.hoisted(() => vi.fn())
const restartMock = vi.hoisted(() => vi.fn())
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

import Ops from '../../console/src/pages/Ops'

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
      connection: { state: 'connected' },
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
}

function renderOps(opts: RenderOptions = {}) {
  const logsByLine = opts.logsByLine ?? {}
  const toast = makeToast()

  useLinesMock.mockReturnValue({
    data: opts.lines ?? [],
    isLoading: opts.loading ?? false,
  })
  useFeedMock.mockReturnValue({ data: opts.feed ?? [] })
  useLogsMock.mockImplementation((lineName: string) => ({ data: logsByLine[lineName] ?? [] }))

  const result = render(
    <ToastContext.Provider value={toast}>
      <Ops />
    </ToastContext.Provider>,
  )

  return { ...result, toast }
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

describe('Ops page fleet states', () => {
  it('renders loading and empty states from the lines query', () => {
    const { rerender } = renderOps({ loading: true })

    expect(screen.getByText('Loading fleet status...')).toBeDefined()

    useLinesMock.mockReturnValue({ data: [], isLoading: false })
    useFeedMock.mockReturnValue({ data: [] })
    useLogsMock.mockReturnValue({ data: [] })

    rerender(
      <ToastContext.Provider value={makeToast()}>
        <Ops />
      </ToastContext.Provider>,
    )

    expect(screen.getByText('No instances discovered. Create one from the Soup Kitchen.')).toBeDefined()
    expect(screen.getAllByText('0 entries')).toHaveLength(2)
    expect(screen.getByText('Select an instance to view logs')).toBeDefined()
  })

  it('summarizes health, alerts, and mode-specific runtime counters', () => {
    const lines = [
      makeLine({ name: 'alpha', mode: 'passive', unread: 2, messagesToday: 5 }),
      makeLine({
        name: 'beta',
        phone: '+15550002222',
        mode: 'chat',
        status: 'degraded',
        queueDepth: 4,
        enrichmentUnprocessed: 1,
        messagesToday: 8,
      }),
      makeLine({
        name: 'gamma',
        phone: '+15550003333',
        mode: 'agent',
        status: 'unreachable',
        activeSessions: 1,
        messagesToday: 0,
      }),
    ]
    const feed: FeedEvent[] = [
      { time: '2026-06-15T01:00:00.000Z', mode: 'agent', text: 'beta degraded', isError: true },
      { time: '2026-06-15T01:01:00.000Z', mode: 'chat', text: 'gamma unreachable', isError: true },
    ]

    renderOps({ lines, feed })

    expect(screen.getByText('2 alerts')).toBeDefined()
    expect(screen.getByText('3 instances')).toBeDefined()
    expect(screen.getByText('1 online')).toBeDefined()
    expect(screen.getByText('2 unhealthy')).toBeDefined()
    expect(screen.getByText('5 msgs')).toBeDefined()
    expect(screen.getByText('2 unread')).toBeDefined()
    expect(screen.getByText('q:4')).toBeDefined()
    expect(screen.getByText('enrich:1')).toBeDefined()
    expect(screen.getByText('1 session')).toBeDefined()
  })
})

describe('Ops page log stream', () => {
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

    fireEvent.click(screen.getByText('beta').closest('.c-card') as HTMLElement)
    expect(useLogsMock).toHaveBeenLastCalledWith('beta')
    expect(screen.getByText('No error logs for beta')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'warn' }))
    expect(screen.getByText('beta degraded')).toBeDefined()
    expect(screen.getByText('health')).toBeDefined()
  })
})

describe('Ops page instance actions', () => {
  it('requests restart for unhealthy linked instances and reports success or failure', async () => {
    restartMock.mockResolvedValueOnce({ status: 'ok', instance: 'beta' })
    const { toast } = renderOps({
      lines: [makeLine({ name: 'beta', status: 'degraded', mode: 'agent', linkedStatus: 'linked' })],
    })

    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))

    expect(toast.info).toHaveBeenCalledWith('Restarting beta...')
    await waitFor(() => expect(restartMock).toHaveBeenCalledWith('beta'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('beta restart requested'))

    restartMock.mockRejectedValueOnce(new Error('systemd timeout'))
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed: systemd timeout'))
  })

  it('opens the relink modal for unhealthy unlinked instances and invalidates lines after relink', async () => {
    const { toast } = renderOps({
      lines: [makeLine({ name: 'beta', status: 'logged_out', linkedStatus: 'unlinked' })],
    })

    fireEvent.click(screen.getByRole('button', { name: /Re-link/ }))

    expect(await screen.findByRole('dialog', { name: 'Relink beta' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'finish relink' }))

    await waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['lines'] })
      expect(toast.success).toHaveBeenCalledWith('Instance re-linked!')
    })
    expect(screen.queryByRole('dialog', { name: 'Relink beta' })).toBeNull()
  })

  it('confirms deletion, clears the dialog, and reports success or API errors', async () => {
    deleteLineMock.mockResolvedValueOnce({ deleted: 'beta' })
    const { toast } = renderOps({
      lines: [makeLine({ name: 'beta', status: 'degraded', linkedStatus: 'linked' })],
    })

    fireEvent.click(screen.getByRole('button', { name: /Delete/ }))
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText('Delete beta?')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(deleteLineMock).toHaveBeenCalledWith('beta'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('beta deleted'))
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['lines'] })
    expect(screen.queryByText('Delete beta?')).toBeNull()

    deleteLineMock.mockRejectedValueOnce(new Error('permission denied'))
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Delete failed: permission denied'))
    expect(screen.queryByText('Delete beta?')).toBeNull()
  })
})
