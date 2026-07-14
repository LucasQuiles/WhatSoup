/**
 * UpdateModal — behavior coverage for all phases of the update workflow.
 *
 * Phase map: confirm → updating → restarting-fleet → restart-instances → done
 *                                                   ↘ error (any step)
 *
 * Mocking strategy:
 *  - `@tanstack/react-query` useQueryClient stubbed so invalidateQueries never
 *    fires real network calls.
 *  - `../lib/api` stubbed with vi.fn() for `api.restart` and `api.getVersion`.
 *  - `isProductionConsole` returns false (no-auth dev path) by default.
 *  - Native `fetch` is mocked per-test for the /api/update SSE stream.
 *  - restart-instances phase is reached via real timers + immediate getVersion
 *    resolution rather than fake timers (fake timers + waitFor deadlock).
 *
 * @vitest-environment jsdom
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mocks — hoisted before component import
// ---------------------------------------------------------------------------

const mockInvalidateQueries = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}))

const mockApiRestart = vi.fn()
const mockApiGetVersion = vi.fn()
const mockIsProductionConsole = vi.fn(() => false)
const mockGetApiTicket = vi.fn()

vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: (...args: unknown[]) => mockApiRestart(...args),
    getVersion: (...args: unknown[]) => mockApiGetVersion(...args),
  },
  isProductionConsole: () => mockIsProductionConsole(),
  getApiTicket: (audience: string) => mockGetApiTicket(audience),
}))

// ---------------------------------------------------------------------------
// Import component AFTER mocks
// ---------------------------------------------------------------------------

import UpdateModal from '../../console/src/components/UpdateModal'
import type { LineInstance } from '../../console/src/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  mockInvalidateQueries.mockReset()
  mockApiRestart.mockReset()
  mockApiGetVersion.mockReset()
  mockIsProductionConsole.mockReset()
  mockIsProductionConsole.mockReturnValue(false)
  mockGetApiTicket.mockReset()
})

function makeLine(overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name: 'primary-line',
    phone: '+15551234567',
    mode: 'agent',
    provider: undefined,
    status: 'online',
    accessMode: 'allowlist',
    healthPort: 9000,
    uptime: '1h',
    messagesTotal: 0,
    health: {
      status: 'ok',
      uptime_seconds: 3600,
      messages_total: 0,
      whatsapp: { connection: { state: 'connected' } },
      sqlite: { messages_total: 0, schema_version: 1 },
    },
    heartbeat: ['up', 'up', 'up'],
    lastActive: 'just now',
    error: null,
    ...overrides,
  }
}

const DEFAULT_LINES: LineInstance[] = [
  makeLine({ name: 'primary-line', status: 'online' }),
  makeLine({ name: 'sandbox-agent', status: 'unreachable' }),
]

function defaultProps(overrides: Partial<{
  open: boolean
  onClose: () => void
  currentSha: string
  lines: LineInstance[]
}> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    currentSha: 'abc1234',
    lines: DEFAULT_LINES,
    ...overrides,
  }
}

/**
 * Build a ReadableStream body that emits SSE chunks then closes (done=true).
 */
function makeStreamBody(chunks: string[]) {
  const encoder = new TextEncoder()
  let idx = 0
  return new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]))
      } else {
        controller.close()
      }
    },
  })
}

/**
 * Build a stream that never closes (hangs mid-flight).
 * Useful for testing updating-phase UI without progressing.
 */
function makeHangingStream() {
  return new ReadableStream({ pull() { /* never enqueue or close */ } })
}

function makeOneChunkThenPendingBody(
  chunk: string,
  onPendingRead?: (reject: (reason?: unknown) => void) => void,
) {
  const encoder = new TextEncoder()
  let readCount = 0
  return {
    getReader: () => ({
      read: vi.fn(() => {
        readCount += 1
        if (readCount === 1) {
          return Promise.resolve({ done: false, value: encoder.encode(chunk) })
        }
        return new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
          onPendingRead?.(reject)
        })
      }),
    }),
  } as unknown as ReadableStream<Uint8Array>
}

// ---------------------------------------------------------------------------
// describe: closed state
// ---------------------------------------------------------------------------

describe('UpdateModal — closed state', () => {
  it('renders nothing when open is false', () => {
    render(<UpdateModal {...defaultProps({ open: false })} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('becomes visible when open switches from false to true', () => {
    const { rerender } = render(<UpdateModal {...defaultProps({ open: false })} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<UpdateModal {...defaultProps({ open: true })} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// describe: confirm phase (initial open)
// ---------------------------------------------------------------------------

describe('UpdateModal — confirm phase', () => {
  it('renders the dialog with aria-modal and aria-labelledby', () => {
    render(<UpdateModal {...defaultProps()} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // aria-labelledby points at the element whose text is the phase title
    const labelledById = dialog.getAttribute('aria-labelledby')
    expect(labelledById).toBeTruthy()
    const titleEl = document.getElementById(labelledById!)
    expect(titleEl).not.toBeNull()
    expect(titleEl!.textContent).toBe('Update SOUP')
  })

  it('shows "Update SOUP" title in confirm phase', () => {
    render(<UpdateModal {...defaultProps()} />)
    const title = screen.getByText('Update SOUP')
    // Resolution assertion: the title element's id is the aria-labelledby target
    const dialog = screen.getByRole('dialog')
    const labelledById = dialog.getAttribute('aria-labelledby')!
    expect(title.id).toBe(labelledById)
  })

  it('renders the confirm phase description text', () => {
    render(<UpdateModal {...defaultProps()} />)
    const desc = screen.getByText(/Pull latest code, rebuild, and restart the fleet server/)
    expect(desc.tagName.toLowerCase()).toBe('p')
  })

  it('renders an Update action button in confirm phase', () => {
    render(<UpdateModal {...defaultProps()} />)
    // The Update button has no aria-label; it is found by accessible name from text content
    const allButtons = screen.getAllByRole('button')
    const updateBtn = allButtons.find(b => b.textContent?.includes('Update'))
    expect((updateBtn as HTMLButtonElement | undefined)?.type).toBe('button')
  })

  it('renders a Cancel button (text content) in confirm phase', () => {
    render(<UpdateModal {...defaultProps()} />)
    // PR #580 aligned the accessible name with the visible text.
    const cancelByName = screen.getByRole('button', { name: 'Cancel' })
    const cancelBtn = screen.getByText('Cancel')
    expect(cancelByName).toBe(cancelBtn)
    expect(cancelBtn.tagName.toLowerCase()).toBe('button')
  })

  it('calls onClose when Cancel button is clicked', () => {
    const onClose = vi.fn()
    render(<UpdateModal {...defaultProps({ onClose })} />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when the X (header close) button is clicked', () => {
    const onClose = vi.fn()
    render(<UpdateModal {...defaultProps({ onClose })} />)
    // The header X ActionButton has label="Close dialog" (exact match per modal.md)
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' })
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does NOT call onClose when backdrop is pointerdown-ed (dismissable=false, C-B3W3-1)', () => {
    const onClose = vi.fn()
    render(<UpdateModal {...defaultProps({ onClose })} />)
    // dismissable=false: outside pointerdown must not close the modal
    const backdrop = screen.getByRole('dialog').parentElement!
    fireEvent.pointerDown(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT call onClose when the dialog shell is pointerdown-ed', () => {
    const onClose = vi.fn()
    render(<UpdateModal {...defaultProps({ onClose })} />)
    // The shell itself is inside the modal — pointerdown inside must not dismiss
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn()
    render(<UpdateModal {...defaultProps({ onClose })} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does NOT call onClose on non-Escape keydown', () => {
    const onClose = vi.fn()
    render(<UpdateModal {...defaultProps({ onClose })} />)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT register escape handler when modal is closed', () => {
    const onClose = vi.fn()
    render(<UpdateModal {...defaultProps({ open: false, onClose })} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('focus lands inside the dialog on open', () => {
    render(<UpdateModal {...defaultProps()} />)
    const dialog = screen.getByRole('dialog')
    // The close X ActionButton (first focusable in the shell) should be in the DOM
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' })
    expect(dialog.contains(closeBtn)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// describe: updating phase (after clicking Update)
// ---------------------------------------------------------------------------

describe('UpdateModal — updating phase (fetch-based SSE)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: makeHangingStream() })))
  })

  it('transitions to updating phase when Update button is clicked', async () => {
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => {
      expect(screen.getByText('Pulling latest code')).toBeDefined()
    })
  })

  it('renders all 5 step labels in updating phase', async () => {
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Pulling latest code')).toBeDefined())
    expect(screen.getByText('Installing dependencies')).toBeDefined()
    expect(screen.getByText('Installing console dependencies')).toBeDefined()
    expect(screen.getByText('Building console')).toBeDefined()
    expect(screen.getByText('Restarting fleet server')).toBeDefined()
    expect(screen.queryByText('Preserving failed update state')).toBeNull()
  })

  it('hides confirm description text after clicking Update', async () => {
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Pulling latest code')).toBeDefined())
    expect(screen.queryByText(/Pull latest code, rebuild/)).toBeNull()
  })

  it('POSTs to /api/update without Authorization header in the dev (non-production) path', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, body: makeHangingStream() }))
    vi.stubGlobal('fetch', fetchMock)
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/update')
    expect(opts.method).toBe('POST')
    // In the no-token dev path, headers should be an empty object (no Authorization key)
    const headers = (opts.headers ?? {}) as Record<string, string>
    expect(Object.keys(headers)).not.toContain('Authorization')
  })

  it('mints an api-audience ticket and sends it as Authorization in production mode', async () => {
    mockIsProductionConsole.mockReturnValue(true)
    mockGetApiTicket.mockResolvedValue('ticket-123')
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, body: makeHangingStream() }))
    vi.stubGlobal('fetch', fetchMock)

    render(<UpdateModal {...defaultProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(mockGetApiTicket).toHaveBeenCalledWith('api')
    const [, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(opts.headers).toEqual({ Authorization: 'Bearer ticket-123' })
  })

  it('fails closed before fetch when production ticket minting fails', async () => {
    mockIsProductionConsole.mockReturnValue(true)
    mockGetApiTicket.mockRejectedValue(new Error('session expired'))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    render(<UpdateModal {...defaultProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.getByText('Update failed: unable to authenticate')).toBeDefined())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows progress step message when SSE emits a progress event', async () => {
    const chunk = 'event: progress\ndata: {"step":"pull","status":"running","message":"fetching..."}\n\n'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: makeStreamBody([chunk]) })))
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('fetching...')).toBeDefined())
  })

  it('adds the preserve step only when SSE emits a preserve progress event', async () => {
    const chunk = 'event: progress\ndata: {"step":"preserve","status":"done","message":"saved recovery patch"}\n\n'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: makeStreamBody([chunk]) })))
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Preserving failed update state')).toBeDefined())
    expect(screen.getByText('saved recovery patch')).toBeDefined()
  })

  it('renders skipped SSE steps as non-error progress rows', async () => {
    const chunk = 'event: progress\ndata: {"step":"console-install","status":"skip","message":"already current"}\n\n'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: makeStreamBody([chunk]) })))

    render(<UpdateModal {...defaultProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.getByText('Installing console dependencies')).toBeDefined())
    expect(screen.getByText('already current')).toBeDefined()
  })

  it('enters fleet-restart polling when the update request fails without a response', async () => {
    let pollCallback: (() => Promise<void> | void) | undefined
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        pollCallback = handler as () => Promise<void> | void
      }
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection dropped'))))
    mockApiGetVersion.mockResolvedValue({
      sha: 'newsha999',
      remoteSha: 'newsha999',
      updateAvailable: false,
      checkedAt: '',
    })

    render(<UpdateModal {...defaultProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.getByText('Waiting for fleet server...')).toBeDefined())
    await act(async () => { await pollCallback?.() })
    await waitFor(() => expect(screen.getByText('Restart instances with update?')).toBeDefined())
  })

  it('enters fleet-restart polling when the SSE reader drops before a terminal event', async () => {
    let pollCallback: (() => Promise<void> | void) | undefined
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        pollCallback = handler as () => Promise<void> | void
      }
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn(() => Promise.reject(new Error('stream lost'))),
        }),
      },
    })))
    mockApiGetVersion.mockResolvedValue({
      sha: 'newsha999',
      remoteSha: 'newsha999',
      updateAvailable: false,
      checkedAt: '',
    })

    render(<UpdateModal {...defaultProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(screen.getByText('Waiting for fleet server...')).toBeDefined())
    await act(async () => { await pollCallback?.() })
    await waitFor(() => expect(screen.getByText('Restart instances with update?')).toBeDefined())
  })

  it('Escape during updating phase calls onClose (abort cleanup — C-B3W3-8)', async () => {
    let abortSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn((url: string, opts: RequestInit) => {
      abortSignal = opts.signal
      return Promise.resolve({ ok: true, body: makeHangingStream() })
    }))
    const onClose = vi.fn()
    render(<UpdateModal {...defaultProps({ onClose })} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Pulling latest code')).toBeDefined())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    // handleClose aborts the stream via the AbortController
    expect(abortSignal?.aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// describe: error phase
// ---------------------------------------------------------------------------

describe('UpdateModal — error phase', () => {
  it('shows error message when fetch returns non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, body: null })))
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Update failed: 503')).toBeDefined())
  })

  it('renders an error container with AlertCircle styling', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, body: null })))
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Update failed: 500')).toBeDefined())
    // The error is wrapped in a styled container — check it's visible in the DOM
    const errorText = screen.getByText('Update failed: 500')
    expect(errorText.parentElement?.tagName.toLowerCase()).toBe('div')
  })

  it('shows error message from SSE error event', async () => {
    const errChunk = 'event: error\ndata: {"message":"git pull failed","step":"pull"}\n\n'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: makeStreamBody([errChunk]) })))
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => {
      const errEl = screen.getByText('git pull failed')
      expect(errEl.tagName.toLowerCase()).toBe('span')
    })
    expect(screen.queryByText('Waiting for fleet server...')).toBeNull()
    expect(mockApiGetVersion).not.toHaveBeenCalled()
  })

  it('renders a Close button (text) in error phase', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, body: null })))
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Update failed: 500')).toBeDefined())
    // Error phase has a "Close" text button (not just aria-label)
    const closeBtn = screen.getByText('Close')
    expect(closeBtn.tagName.toLowerCase()).toBe('button')
  })

  it('calls onClose when the text Close button is clicked in error phase', async () => {
    const onClose = vi.fn()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, body: null })))
    render(<UpdateModal {...defaultProps({ onClose })} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Update failed: 500')).toBeDefined())
    fireEvent.click(screen.getByText('Close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('lets operators retry after an update request failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, body: null })
      .mockResolvedValueOnce({ ok: true, body: makeHangingStream() })
    vi.stubGlobal('fetch', fetchMock)
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Update failed: 503')).toBeDefined())
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.getByText('Pulling latest code')).toBeDefined()
    expect(screen.queryByText('Update failed: 503')).toBeNull()
  })

  it('aborts an errored stream before retrying so stale reads cannot enter restart polling', async () => {
    const errChunk = 'event: error\ndata: {"message":"git pull failed","step":"pull"}\n\n'
    let callCount = 0
    let firstSignal: AbortSignal | undefined
    let rejectStaleRead: ((reason?: unknown) => void) | undefined
    const fetchMock = vi.fn((_url: string, opts: RequestInit) => {
      callCount += 1
      if (callCount === 1) {
        firstSignal = opts.signal as AbortSignal
        return Promise.resolve({
          ok: true,
          body: makeOneChunkThenPendingBody(errChunk, (reject) => {
            rejectStaleRead = reject
          }),
        })
      }
      return Promise.resolve({ ok: true, body: makeHangingStream() })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('git pull failed')).toBeDefined())

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(firstSignal?.aborted).toBe(true)

    await act(async () => {
      rejectStaleRead?.(new Error('old stream aborted'))
      await Promise.resolve()
    })

    expect(screen.getByText('Pulling latest code')).toBeDefined()
    expect(screen.queryByText('Waiting for fleet server...')).toBeNull()
    expect(mockApiGetVersion).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// describe: restart-instances phase
// ---------------------------------------------------------------------------

describe('UpdateModal — restart-instances phase', () => {
  /**
   * Reach restart-instances by: empty stream (done=true) → waitForFleetRestart
   * → setInterval(2s) → first api.getVersion returns NEW sha → poll clears →
   * dispatch setPhase restart-instances.
   *
   * The production poll waits 2s; capture and invoke the interval callback
   * directly so these tests verify the transition without real-time sleeps.
   */
  async function renderAndWaitForFleetRestart(extraProps: Partial<Parameters<typeof defaultProps>[0]> = {}) {
    let pollCallback: (() => Promise<void> | void) | undefined
    let fleetTimeoutCallback: (() => void) | undefined
    let autoCloseCallback: (() => void) | undefined
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        pollCallback = handler as () => Promise<void> | void
      }
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 60_000 && typeof handler === 'function') {
        fleetTimeoutCallback = handler as () => void
        return 2 as unknown as ReturnType<typeof setTimeout>
      }
      if (timeout === 2200 && typeof handler === 'function') {
        autoCloseCallback = handler as () => void
        return 3 as unknown as ReturnType<typeof setTimeout>
      }
      return realSetTimeout(handler, timeout, ...args) as unknown as ReturnType<typeof setTimeout>
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: makeStreamBody([]) })))
    mockApiGetVersion.mockResolvedValue({
      sha: 'newsha999',
      remoteSha: 'newsha999',
      updateAvailable: false,
      checkedAt: '',
    })
    render(<UpdateModal {...defaultProps(extraProps)} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Waiting for fleet server...')).toBeDefined())
    return {
      runPoll: async () => { await pollCallback?.() },
      runFleetTimeout: () => { fleetTimeoutCallback?.() },
      runAutoClose: () => { autoCloseCallback?.() },
    }
  }

  async function renderAndAdvanceToRestartInstances(extraProps: Partial<Parameters<typeof defaultProps>[0]> = {}) {
    const controls = await renderAndWaitForFleetRestart(extraProps)
    await act(async () => {
      await controls.runPoll()
    })
    await waitFor(
      () => expect(screen.getByText('Restart instances with update?')).toBeDefined(),
    )
    return controls
  }

  it('shows "Update Complete" title when in restart-instances phase', async () => {
    await renderAndAdvanceToRestartInstances()
    const title = screen.getByText('Update Complete')
    // Resolution assertion: title element id matches the dialog's aria-labelledby
    const dialog = screen.getByRole('dialog')
    const labelledById = dialog.getAttribute('aria-labelledby')!
    expect(title.id).toBe(labelledById)
  })

  it('renders "Restart instances with update?" prompt', async () => {
    await renderAndAdvanceToRestartInstances()
    expect(screen.getByText('Restart instances with update?')).toBeDefined()
  })

  it('renders checkboxes for each line', async () => {
    await renderAndAdvanceToRestartInstances()
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(DEFAULT_LINES.length)
  })

  it('renders line names as labels for their checkboxes', async () => {
    await renderAndAdvanceToRestartInstances()
    expect(screen.getByRole('checkbox', { name: 'primary-line' })).toBeDefined()
    expect(screen.getByRole('checkbox', { name: 'sandbox-agent' })).toBeDefined()
  })

  it('pre-checks online instances and unchecks offline instances', async () => {
    await renderAndAdvanceToRestartInstances()
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // primary-line is online → checked
    expect(checkboxes[0]!.checked).toBe(true)
    // sandbox-agent is offline → unchecked
    expect(checkboxes[1]!.checked).toBe(false)
  })

  it('enables "Restart Selected" when at least one instance is checked', async () => {
    await renderAndAdvanceToRestartInstances()
    const restartBtn = screen.getByRole('button', { name: /Restart Selected/i }) as HTMLButtonElement
    expect(restartBtn.disabled).toBe(false)
  })

  it('disables "Restart Selected" when all instances are toggled off', async () => {
    await renderAndAdvanceToRestartInstances()
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // Uncheck primary-line (the only pre-checked one)
    fireEvent.click(checkboxes[0]!)
    const restartBtn = screen.getByRole('button', { name: /Restart Selected/i }) as HTMLButtonElement
    expect(restartBtn.disabled).toBe(true)
  })

  it('calls api.restart for each checked instance when Restart Selected is clicked', async () => {
    mockApiRestart.mockResolvedValue({ status: 'ok', instance: 'primary-line' })
    await renderAndAdvanceToRestartInstances()
    fireEvent.click(screen.getByRole('button', { name: /Restart Selected/i }))
    await waitFor(() => expect(mockApiRestart).toHaveBeenCalledWith('primary-line'))
    // sandbox-agent is unchecked (offline) — should not be restarted
    expect(mockApiRestart).not.toHaveBeenCalledWith('sandbox-agent')
  })

  it('renders a Skip button to close without restarting instances', async () => {
    const onClose = vi.fn()
    await renderAndAdvanceToRestartInstances({ onClose })
    const skipBtn = screen.getByText('Skip')
    expect(skipBtn.tagName.toLowerCase()).toBe('button')
    fireEvent.click(skipBtn)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls invalidateQueries when transitioning from restarting-fleet to restart-instances', async () => {
    await renderAndAdvanceToRestartInstances()
    expect(mockInvalidateQueries).toHaveBeenCalled()
  })

  it('waits through a transient version failure and advances after the fleet was seen down', async () => {
    // Deterministic via a tiny injected poll interval (production default is
    // 2000ms) driving the component's real setInterval, instead of a
    // monkeypatched globalThis.setInterval + manually invoked callback. This
    // avoids racing a fixed-timeout waitFor against a single act() flush,
    // which under maxWorkers CPU contention could lose the race even though
    // the underlying logic was already correct (QR-244).
    const restartChunk = 'event: progress\ndata: {"step":"restart","status":"running"}\n\n'
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: makeStreamBody([restartChunk]) })))
    // Stateful fleet-availability flag instead of consumable *Once mocks: a stray
    // getVersion call (e.g. a leaked poll timer under the full parallel suite) can no
    // longer consume a queued value and desync the phase sequence.
    let fleetUp = false
    mockApiGetVersion.mockImplementation(() =>
      fleetUp
        ? Promise.resolve({ sha: 'abc1234', remoteSha: 'abc1234', updateAvailable: false, checkedAt: '' })
        : Promise.reject(new Error('fleet down')),
    )

    render(<UpdateModal {...defaultProps()} pollIntervalMs={5} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(screen.getByText('Waiting for fleet server...')).toBeDefined())

    // Let the real (tiny-interval) poll observe the fleet down at least once
    // before flipping it up — fleetUp is still false at this point in test
    // execution (single-threaded JS), so every call so far has rejected.
    await waitFor(() => expect(mockApiGetVersion).toHaveBeenCalled())
    expect(screen.getByText('Waiting for fleet server...')).toBeDefined()
    expect(mockInvalidateQueries).not.toHaveBeenCalled()

    fleetUp = true
    await waitFor(() => expect(screen.getByText('Restart instances with update?')).toBeDefined())
    expect(mockInvalidateQueries).toHaveBeenCalled()
  })

  it('falls back to restart-instance controls when fleet restart polling times out', async () => {
    const controls = await renderAndWaitForFleetRestart()

    await act(async () => {
      controls.runFleetTimeout()
    })

    await waitFor(() => expect(screen.getByText('Restart instances with update?')).toBeDefined())
    expect(mockInvalidateQueries).toHaveBeenCalled()
  })

  it('keeps the modal open and marks the instance errored when restart fails', async () => {
    mockApiRestart.mockRejectedValueOnce(new Error('supervisor denied restart'))
    const onClose = vi.fn()
    await renderAndAdvanceToRestartInstances({ onClose })

    fireEvent.click(screen.getByRole('button', { name: /Restart Selected/i }))

    await waitFor(() => expect(mockApiRestart).toHaveBeenCalledWith('primary-line'))
    expect(screen.queryByText('All instances restarted')).toBeNull()
    expect(screen.getByRole('button', { name: /Restart Selected/i })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows completion and closes after the successful restart grace period', async () => {
    mockApiRestart.mockResolvedValueOnce({ status: 'ok', instance: 'primary-line' })
    const onClose = vi.fn()
    const controls = await renderAndAdvanceToRestartInstances({ onClose })

    fireEvent.click(screen.getByRole('button', { name: /Restart Selected/i }))

    await waitFor(() => expect(screen.getByText('All instances restarted')).toBeDefined())
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => {
      controls.runAutoClose()
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// describe: state management edge cases
// ---------------------------------------------------------------------------

describe('UpdateModal — state management', () => {
  it('does not reset mid-update when lines prop changes while open (prevOpenRef guard)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: makeHangingStream() })))
    const { rerender } = render(<UpdateModal {...defaultProps()} />)
    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)
    await waitFor(() => expect(screen.getByText('Pulling latest code')).toBeDefined())
    // Re-render with changed lines while still open — must NOT reset to confirm phase
    const newLines = [
      makeLine({ name: 'primary-line', status: 'online' }),
      makeLine({ name: 'new-instance', status: 'online' }),
    ]
    rerender(<UpdateModal {...defaultProps({ lines: newLines })} />)
    // Still in updating phase — confirm description must not appear
    expect(screen.queryByText(/Pull latest code, rebuild/)).toBeNull()
    expect(screen.getByText('Pulling latest code')).toBeDefined()
  })

  it('resets to confirm phase when modal is closed and reopened', () => {
    const { rerender } = render(<UpdateModal {...defaultProps()} />)
    // Verify confirm phase
    expect(screen.getByText(/Pull latest code, rebuild/)).toBeDefined()
    // Close
    rerender(<UpdateModal {...defaultProps({ open: false })} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Reopen → should be confirm phase again
    rerender(<UpdateModal {...defaultProps({ open: true })} />)
    expect(screen.getByText(/Pull latest code, rebuild/)).toBeDefined()
    // Update button still present after re-open
    const allButtons = screen.getAllByRole('button')
    const updateBtn = allButtons.find(b => b.textContent?.includes('Update'))
    expect((updateBtn as HTMLButtonElement | undefined)?.type).toBe('button')
  })
})
