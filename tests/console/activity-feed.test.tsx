/**
 * ActivityFeed action, filter, and snapshot regressions.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ActivityFeed from '../../console/src/components/ActivityFeed'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import type { FeedEvent } from '../../console/src/types'

const navigateMock = vi.hoisted(() => vi.fn())
const restartMock = vi.hoisted(() => vi.fn())
const stopInstanceMock = vi.hoisted(() => vi.fn())

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: (...args: unknown[]) => restartMock(...args),
    stopInstance: (...args: unknown[]) => stopInstanceMock(...args),
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  navigateMock.mockReset()
  restartMock.mockReset()
  stopInstanceMock.mockReset()
})

function toastValue(overrides: Partial<ToastContextValue> = {}): ToastContextValue {
  return {
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  }
}

function renderFeed(events: FeedEvent[], toast = toastValue()) {
  const result = render(
    <ToastContext.Provider value={toast}>
      <ActivityFeed events={events} />
    </ToastContext.Provider>,
  )
  return { ...result, toast }
}

function event(overrides: Partial<FeedEvent> = {}): FeedEvent {
  return {
    time: '2026-06-14T12:00:00.000Z',
    mode: 'chat',
    text: 'line-a: activity',
    instance: 'line-a',
    detail: { type: 'generic' },
    ...overrides,
  }
}

function installClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return writeText
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ActivityFeed filters and snapshots', () => {
  it('shows per-filter counts and filters by feed detail type', () => {
    renderFeed([
      event({
        time: '2026-06-14T12:00:00.000Z',
        text: 'line-a: inbound hello',
        detail: {
          type: 'message',
          direction: 'inbound',
          messageId: 'msg-1',
          senderName: 'Alex',
          preview: 'hello',
        },
      }),
      event({
        time: '2026-06-14T12:00:01.000Z',
        instance: 'line-main',
        isError: true,
        detail: { type: 'connection', statusCode: 428, reason: 'connectionLost' },
      }),
      event({
        time: '2026-06-14T12:00:02.000Z',
        instance: 'line-main',
        detail: { type: 'tool_error', toolName: 'search', error: 'tool exploded' },
      }),
      event({
        time: '2026-06-14T12:00:03.000Z',
        instance: 'line-health',
        detail: { type: 'health', status: 'logged_out' },
      }),
      event({
        time: '2026-06-14T12:00:04.000Z',
        detail: { type: 'session', action: 'resume', sessionId: 'abcdef1234' },
      }),
      event({
        time: '2026-06-14T12:00:05.000Z',
        text: 'line-a: generic event',
      }),
    ])

    expect(screen.getByRole('button', { name: /^all\s*6$/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^msgs\s*1$/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^conn\s*1$/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^errors\s*3$/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^health\s*1$/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /^sessions\s*1$/ })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /^msgs\s*1$/ }))
    expect(screen.getByText('hello')).toBeDefined()
    expect(screen.queryByText('tool exploded')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^conn\s*1$/ }))
    expect(screen.getByText('connection lost')).toBeDefined()
    expect(screen.queryByText('Alex')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^errors\s*3$/ }))
    expect(screen.getByText('connection lost')).toBeDefined()
    expect(screen.getByText('tool exploded')).toBeDefined()
    expect(screen.getByText('logged out')).toBeDefined()
    expect(screen.queryByText('resume')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^health\s*1$/ }))
    expect(screen.getByText('logged out')).toBeDefined()
    expect(screen.queryByText('connection lost')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^sessions\s*1$/ }))
    expect(screen.getByText('resume')).toBeDefined()
    expect(screen.queryByText('connection lost')).toBeNull()
  })

  it('renders filter-specific empty states', () => {
    renderFeed([
      event({
        detail: { type: 'message', direction: 'inbound', messageId: 'msg-only', preview: 'only message' },
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'errors' }))
    expect(screen.getByText('No errors')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'sessions' }))
    expect(screen.getByText('No activity')).toBeDefined()
  })

  it('freezes the event list while paused and resumes live props afterward', () => {
    const { rerender, toast } = renderFeed([
      event({
        detail: { type: 'message', direction: 'inbound', messageId: 'old', preview: 'old message' },
      }),
    ])

    const pause = screen.getByRole('button', { name: 'pause' })
    fireEvent.click(pause)
    expect(screen.getByRole('button', { name: 'resume' }).getAttribute('aria-pressed')).toBe('true')

    rerender(
      <ToastContext.Provider value={toast}>
        <ActivityFeed events={[
          event({
            time: '2026-06-14T12:00:10.000Z',
            detail: { type: 'message', direction: 'inbound', messageId: 'new', preview: 'new message' },
          }),
        ]} />
      </ToastContext.Provider>,
    )

    expect(screen.getByText('old message')).toBeDefined()
    expect(screen.queryByText('new message')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'resume' }))

    expect(screen.getByText('new message')).toBeDefined()
    expect(screen.queryByText('old message')).toBeNull()
  })
})

describe('ActivityFeed actions', () => {
  it('navigates to conversations and reports copy success and failure through toast', async () => {
    const writeText = installClipboard()
    const { toast } = renderFeed([
      event({
        instance: 'line-main',
        text: 'line-main: inbound',
        detail: {
          type: 'message',
          direction: 'inbound',
          messageId: 'msg-copy',
          preview: 'copy me',
          conversationKey: 'chat key/1',
        },
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }))
    expect(navigateMock).toHaveBeenCalledWith('/inbox?line=line-main&chat=chat%20key%2F1')

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('copy me')
      expect(toast.success).toHaveBeenCalledWith('Copied to clipboard')
    })

    const failingWrite = installClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    await waitFor(() => {
      expect(failingWrite).toHaveBeenCalledWith('copy me')
      expect(toast.error).toHaveBeenCalledWith('Failed to copy')
    })
  })

  it('restarts only the newest actionable event per instance and ignores duplicate pending actions', async () => {
    const restart = deferred()
    restartMock.mockReturnValue(restart.promise)
    const { toast } = renderFeed([
      event({
        time: '2026-06-14T12:00:01.000Z',
        instance: 'line-main',
        isError: true,
        detail: { type: 'connection', statusCode: 428, reason: 'connectionLost' },
      }),
      event({
        time: '2026-06-14T12:00:02.000Z',
        instance: 'line-main',
        isError: true,
        detail: { type: 'connection', statusCode: 500, reason: 'timedOut' },
      }),
    ])

    expect(screen.getAllByRole('button', { name: 'Restart line-main' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Stop line-main instance' })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Restart line-main' }))
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Restart line-main' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop line-main instance' }))

    expect(restartMock).toHaveBeenCalledTimes(1)
    expect(restartMock).toHaveBeenCalledWith('line-main')
    expect(toast.info).toHaveBeenCalledWith('Restarting line-main...')
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => restart.resolve())

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('line-main restart requested')
    })
  })

  it('reports restart failures', async () => {
    restartMock.mockRejectedValue(new Error('service manager unavailable'))
    const { toast } = renderFeed([
      event({
        instance: 'line-main',
        isError: true,
        detail: { type: 'connection', statusCode: 428, reason: 'connectionLost' },
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Restart line-main' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to restart: service manager unavailable')
    })
  })

  it('confirms, cancels, succeeds, and fails stop requests through the dialog workflow', async () => {
    const stop = deferred()
    stopInstanceMock.mockReturnValueOnce(stop.promise)
    const { toast } = renderFeed([
      event({
        instance: 'line-main',
        isError: true,
        detail: { type: 'connection', statusCode: 428, reason: 'connectionLost' },
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Stop line-main instance' }))
    expect(screen.getByRole('dialog')).toBeDefined()
    expect(screen.getByText('Stop line-main?')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(stopInstanceMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Stop line-main instance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop instance' }))

    expect(stopInstanceMock).toHaveBeenCalledWith('line-main')
    expect(toast.info).toHaveBeenCalledWith('Stopping line-main...')
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => stop.resolve())
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('line-main stop requested')
    })

    stopInstanceMock.mockRejectedValueOnce(new Error('permission denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop line-main instance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop instance' }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to stop: permission denied')
    })
  })

  it('does not expose recovery actions for superseded connection or health events', () => {
    renderFeed([
      event({
        instance: 'line-main',
        detail: { type: 'connection', state: 'connected' },
      }),
      event({
        time: '2026-06-14T12:00:01.000Z',
        instance: 'line-main',
        isError: true,
        detail: { type: 'connection', statusCode: 428, reason: 'connectionLost' },
      }),
      event({
        time: '2026-06-14T12:00:02.000Z',
        instance: 'line-health',
        detail: { type: 'health', status: 'online' },
      }),
      event({
        time: '2026-06-14T12:00:03.000Z',
        instance: 'line-health',
        detail: { type: 'health', status: 'logged_out' },
      }),
    ])

    expect(screen.getByText('connected')).toBeDefined()
    expect(screen.getByText('logged out')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Restart line-main' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop line-main instance' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart line-health' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop line-health instance' })).toBeNull()
  })
})
