/**
 * LinkStep — SSE-driven QR pairing wizard step.
 *
 * Transport: Server-Sent Events (EventSource), NOT WebSocket.
 * EventSource is replaced with a controllable FakeEventSource so no real
 * network connections are opened.
 *
 * Scenarios:
 *   - initial render (waiting, no QR yet)
 *   - qr event → QR displayed, status spinner swaps to "Waiting for scan…"
 *   - connected event → success screen with "Line is live!" + "View Line" button
 *   - server-sent error event → error screen, correct heading/message
 *   - timeout error shows "Session timed out" heading
 *   - invalid QR payload → error screen
 *   - retry button resets state and re-opens the EventSource
 *   - native onerror exhausted (5 attempts) → persistent error screen
 *   - QR age timer expiry → expiring warning
 *   - no-fleet-token path: EventSource opened directly (no ticket)
 *   - fleet-token path: ticket fetched and threaded into URL
 *   - ticket-fetch failure → error without opening EventSource
 *   - QrDisplay receives the QR value via props
 *   - onComplete is called when "View Line" button clicked
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// ─── QrDisplay stub ─────────────────────────────────────────────────────────
vi.mock('../../console/src/components/QrDisplay', () => ({
  default: ({ value, size }: { value: string; size?: number }) => (
    <div data-testid="qr-display" data-value={value} data-size={size ?? 256} />
  ),
}))

// ─── FakeEventSource ────────────────────────────────────────────────────────
type ESListener = (e: MessageEvent | Event) => void

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  url: string
  readyState = FakeEventSource.OPEN
  onerror: ((event: Event) => void) | null = null
  private readonly listeners: Map<string, ESListener[]> = new Map()

  constructor(url: string) {
    this.url = url
    registry.push(this)
  }

  addEventListener(type: string, handler: ESListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type)!.push(handler)
  }

  removeEventListener(type: string, handler: ESListener): void {
    const arr = this.listeners.get(type)
    if (arr) {
      const idx = arr.indexOf(handler)
      if (idx !== -1) arr.splice(idx, 1)
    }
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }

  /** Test helper — fire a named SSE event with a data payload. */
  emit(type: string, data?: string): void {
    const handlers = this.listeners.get(type) ?? []
    const event = data !== undefined
      ? new MessageEvent(type, { data })
      : new Event(type)
    for (const h of handlers) h(event)
  }

  /** Test helper — fire the native onerror handler. */
  triggerNativeError(): void {
    this.onerror?.(new Event('error'))
  }
}

let registry: FakeEventSource[] = []

// ─── Helpers ────────────────────────────────────────────────────────────────
function latestSource(): FakeEventSource {
  if (registry.length === 0) throw new Error('no FakeEventSource created yet')
  return registry[registry.length - 1]
}

function addProductionAuthMode(): void {
  const meta = document.createElement('meta');
  meta.name = 'fleet-auth-mode';
  meta.content = 'session';
  document.head.appendChild(meta);
}

function removeFleetTokenMeta(): void {
  const metas = document.head.querySelectorAll('meta[name="fleet-auth-mode"]')
  metas.forEach((m) => m.parentNode?.removeChild(m))
}

function ticketResponse(ticket: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ticket, audience: 'sse', expiresIn: 60 }),
    text: async () => '',
  } as Response
}

// Dynamically import after all mocks are registered.
const { default: LinkStep } = await import('../../console/src/components/wizard/LinkStep')

// ─── Lifecycle ───────────────────────────────────────────────────────────────
beforeEach(() => {
  registry = []
  vi.stubGlobal('EventSource', FakeEventSource)
})

afterEach(() => {
  cleanup()
  removeFleetTokenMeta()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ─── Initial render ──────────────────────────────────────────────────────────
describe('LinkStep — initial render (waiting, no QR)', () => {
  it('shows the "Scan with WhatsApp" heading', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    expect(screen.getByText('Scan with WhatsApp')).toBeDefined()
  })

  it('shows the navigation instructions', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    expect(screen.getByText(/Linked Devices/)).toBeDefined()
  })

  it('shows "Generating QR code..." before any qr event arrives', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    expect(screen.getByText('Generating QR code...')).toBeDefined()
  })

  it('does not render QrDisplay before a qr event', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    expect(screen.queryByTestId('qr-display')).toBeNull()
  })

  it('opens EventSource to /api/lines/:name/auth (no fleet token in URL)', async () => {
    render(<LinkStep lineName="alpha-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    expect(registry[0].url).toBe('/api/lines/alpha-line/auth')
  })

  it('URL-encodes line names that contain special characters', async () => {
    render(<LinkStep lineName="line with spaces" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    expect(registry[0].url).toBe('/api/lines/line%20with%20spaces/auth')
  })
})

// ─── Fleet-token path ────────────────────────────────────────────────────────
describe('LinkStep — fleet-token path', () => {
  it('mints an sse ticket and threads it into the EventSource URL', async () => {
    addProductionAuthMode()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(ticketResponse('sse-ticket-abc')),
    )

    render(<LinkStep lineName="beta" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    expect(registry[0].url).toBe('/api/lines/beta/auth?ticket=sse-ticket-abc')
  })

  it('sets error state when the ticket fetch rejects (no EventSource opened)', async () => {
    addProductionAuthMode()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('network down')),
    )

    render(<LinkStep lineName="gamma" onComplete={vi.fn()} />)
    await waitFor(() =>
      expect(screen.queryByText('Authentication failed')).not.toBeNull(),
    )
    expect(screen.getByText(/Unable to authenticate with the fleet server/)).toBeDefined()
    expect(registry).toHaveLength(0)
  })
})

// ─── qr event ────────────────────────────────────────────────────────────────
describe('LinkStep — qr event handling', () => {
  it('renders QrDisplay with the decoded QR value after receiving a qr event', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('qr', JSON.stringify('fake-qr-payload-1'))
    })

    const qr = screen.getByTestId('qr-display')
    expect(qr.getAttribute('data-value')).toBe('fake-qr-payload-1')
  })

  it('swaps from "Generating QR code..." to "Waiting for scan..." after a qr event', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('qr', 'raw-qr-payload')
    })

    expect(screen.queryByText('Generating QR code...')).toBeNull()
    expect(screen.getByText('Waiting for scan...')).toBeDefined()
  })

  it('updates the QR value when a second qr event arrives', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('qr', 'first-qr')
    })
    expect(screen.getByTestId('qr-display').getAttribute('data-value')).toBe('first-qr')

    act(() => {
      latestSource().emit('qr', 'second-qr')
    })
    expect(screen.getByTestId('qr-display').getAttribute('data-value')).toBe('second-qr')
  })

  it('passes size=256 to QrDisplay by default', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('qr', 'sz-payload')
    })

    expect(screen.getByTestId('qr-display').getAttribute('data-size')).toBe('256')
  })

  it('enters error state when the qr event carries an invalid payload', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('qr', '   ')
    })

    expect(screen.getByText('Authentication failed')).toBeDefined()
    expect(screen.getByText(/invalid QR code/)).toBeDefined()
    expect(registry[0].readyState).toBe(FakeEventSource.CLOSED)
  })

  it('clears a previous error when retry opens a new EventSource and a valid qr event arrives', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('qr', '')
    })
    expect(screen.getByText('Authentication failed')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    await waitFor(() => expect(registry).toHaveLength(2))

    act(() => {
      latestSource().emit('qr', 'recovery-qr')
    })

    expect(screen.queryByText('Authentication failed')).toBeNull()
    expect(screen.getByTestId('qr-display').getAttribute('data-value')).toBe('recovery-qr')
  })
})

// ─── connected event ─────────────────────────────────────────────────────────
describe('LinkStep — connected event', () => {
  it('can render the already-linked connected state without opening EventSource', () => {
    const onComplete = vi.fn()
    render(<LinkStep lineName="my-line" onComplete={onComplete} alreadyLinked />)

    expect(registry).toHaveLength(0)
    expect(screen.getByText('Line is live!')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'View Line' }))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('transitions to the success screen showing "Line is live!"', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('connected')
    })

    expect(screen.getByText('Line is live!')).toBeDefined()
  })

  it('displays the lineName in the success description', async () => {
    render(<LinkStep lineName="prod-line-1" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('connected')
    })

    expect(screen.getByText(/prod-line-1/)).toBeDefined()
    expect(screen.getByText(/is now connected and running/)).toBeDefined()
  })

  it('renders a "View Line" button on the success screen', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('connected')
    })

    expect(screen.getByRole('button', { name: 'View Line' })).toBeDefined()
  })

  it('calls onComplete when "View Line" is clicked', async () => {
    const onComplete = vi.fn()
    render(<LinkStep lineName="my-line" onComplete={onComplete} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('connected')
    })

    fireEvent.click(screen.getByRole('button', { name: 'View Line' }))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('closes the EventSource on connected', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    const src = latestSource()

    act(() => {
      src.emit('connected')
    })

    expect(src.readyState).toBe(FakeEventSource.CLOSED)
  })

  it('does not show QrDisplay in the connected state', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('connected')
    })

    expect(screen.queryByTestId('qr-display')).toBeNull()
  })
})

// ─── server-sent error event ─────────────────────────────────────────────────
describe('LinkStep — server-sent error event', () => {
  it('shows "Authentication failed" heading on a generic error', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('error', JSON.stringify('Login failed'))
    })

    expect(screen.getByText('Authentication failed')).toBeDefined()
    expect(screen.getByText('Login failed')).toBeDefined()
  })

  it('shows "Session timed out" heading when the error message contains "timed out"', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('error', JSON.stringify({ message: 'Session timed out after 60s' }))
    })

    expect(screen.getByText('Session timed out')).toBeDefined()
  })

  it('shows the fallback error text when the error event carries no data', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('error', '')
    })

    expect(screen.getByText('Authentication failed')).toBeDefined()
    expect(screen.getByText('Connection lost')).toBeDefined()
    expect(screen.queryByText(/unexpected error/)).toBeNull()
  })

  it('closes the EventSource on a server-sent error event', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))
    const src = latestSource()

    act(() => {
      src.emit('error', 'bad')
    })

    expect(src.readyState).toBe(FakeEventSource.CLOSED)
  })

  it('renders a "Try Again" button on the error screen', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('error', 'fail')
    })

    expect(screen.getByRole('button', { name: 'Try Again' })).toBeDefined()
  })
})

// ─── retry / restart ─────────────────────────────────────────────────────────
describe('LinkStep — retry / restart', () => {
  it('"Try Again" resets to waiting state and opens a new EventSource', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('error', 'forced fail')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))

    await waitFor(() => expect(registry).toHaveLength(2))
    expect(screen.queryByText('Authentication failed')).toBeNull()
    expect(screen.getByText('Scan with WhatsApp')).toBeDefined()
  })

  it('"Try Again" resets the retry count so onerror can cycle again', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    act(() => {
      latestSource().emit('error', 'fail')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    await waitFor(() => expect(registry).toHaveLength(2))

    // One native error on the fresh source should not show the persistent error.
    act(() => {
      latestSource().triggerNativeError()
    })
    await waitFor(() => expect(registry).toHaveLength(3))
    expect(screen.queryByText('Authentication failed')).toBeNull()
  })
})

// ─── native onerror retry exhaustion ─────────────────────────────────────────
describe('LinkStep — native onerror exhaustion', () => {
  it('shows a persistent error after 5 consecutive native onerror events', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    await waitFor(() => expect(registry).toHaveLength(1))

    for (let attempt = 0; attempt < 5; attempt++) {
      act(() => {
        latestSource().triggerNativeError()
      })
      if (attempt < 4) {
        // eslint-disable-next-line no-await-in-loop -- sequential retry probing requires ordered awaits; expires 2026-12-31
        await waitFor(() => expect(registry).toHaveLength(attempt + 2))
      }
    }

    await waitFor(() =>
      expect(screen.queryByText('Authentication failed')).not.toBeNull(),
    )
    expect(screen.getByText(/multiple attempts/)).toBeDefined()
  })
})

// ─── QR age timer ─────────────────────────────────────────────────────────────
// Fake-timer tests: EventSource is already stubbed in beforeEach, so it is
// created synchronously during render — no waitFor needed here. We switch to
// fake timers after render to avoid the waitFor+fake-timer deadlock that occurs
// under --pool=forks.
describe('LinkStep — QR age / expiry warning', () => {
  it('shows the expiry warning after the QR age exceeds 45 seconds', () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    // EventSource is constructed synchronously by FakeEventSource stub.
    expect(registry).toHaveLength(1)

    vi.useFakeTimers()
    try {
      act(() => {
        latestSource().emit('qr', 'aging-qr')
      })

      act(() => {
        vi.advanceTimersByTime(46_000)
      })

      expect(screen.getByText(/QR code expiring soon/)).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the QR age to 0 when a new qr event arrives', () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    expect(registry).toHaveLength(1)

    vi.useFakeTimers()
    try {
      act(() => {
        latestSource().emit('qr', 'first-qr')
      })

      act(() => {
        vi.advanceTimersByTime(46_000)
      })
      expect(screen.getByText(/QR code expiring soon/)).toBeDefined()

      // A fresh qr event must reset the age counter and stop showing the warning.
      act(() => {
        latestSource().emit('qr', 'fresh-qr')
      })

      expect(screen.queryByText(/QR code expiring soon/)).toBeNull()
      expect(screen.getByText('Waiting for scan...')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows "Waiting for scan..." before the expiry threshold', () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    expect(registry).toHaveLength(1)

    vi.useFakeTimers()
    try {
      act(() => {
        latestSource().emit('qr', 'young-qr')
      })

      act(() => {
        vi.advanceTimersByTime(10_000)
      })

      expect(screen.getByText('Waiting for scan...')).toBeDefined()
      expect(screen.queryByText(/QR code expiring soon/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the expiry warning after retry + new qr event', async () => {
    render(<LinkStep lineName="my-line" onComplete={vi.fn()} />)
    expect(registry).toHaveLength(1)

    vi.useFakeTimers()
    try {
      // Emit a QR and advance past the expiry threshold to show the warning.
      act(() => {
        latestSource().emit('qr', 'aging-qr')
      })
      act(() => {
        vi.advanceTimersByTime(46_000)
      })
      expect(screen.getByText(/QR code expiring soon/)).toBeDefined()

      // Switch back to real timers before triggering async retry flow.
      vi.useRealTimers()

      // Fire an error to reach the error screen, then click "Try Again".
      act(() => {
        latestSource().emit('error', 'forced-fail')
      })
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))

      // A second EventSource must be opened.
      await waitFor(() => expect(registry).toHaveLength(2))

      // Emit a fresh QR on the new source — expiry warning must be gone.
      act(() => {
        latestSource().emit('qr', 'fresh-qr')
      })

      expect(screen.queryByText(/QR code expiring soon/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
