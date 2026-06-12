/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import LinkStep from '../../console/src/components/wizard/LinkStep'

afterEach(() => {
  cleanup()
  document.head.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function addProductionAuthMode(): void {
  const meta = document.createElement('meta')
  meta.name = 'fleet-auth-mode'
  meta.content = 'session'
  document.head.appendChild(meta)
}

class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readonly url: string
  readyState = FakeEventSource.CONNECTING
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    sources.push(this)
  }

  addEventListener(): void {
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }
}

const sources: FakeEventSource[] = []

function ticketResponse(ticket: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ticket, audience: 'sse', expiresIn: 60 }),
    text: async () => '',
  } as Response
}

describe('LinkStep SSE ticket reconnects', () => {
  it('mints a fresh sse ticket after a native EventSource error', async () => {
    addProductionAuthMode()
    sources.length = 0
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ticketResponse('sse-ticket-1'))
      .mockResolvedValueOnce(ticketResponse('sse-ticket-2'))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', FakeEventSource)

    render(<LinkStep lineName="alpha" onComplete={vi.fn()} />)

    await waitFor(() => expect(sources).toHaveLength(1))
    expect(sources[0].url).toBe('/api/lines/alpha/auth?ticket=sse-ticket-1')

    sources[0].onerror?.(new Event('error'))

    await waitFor(() => expect(sources).toHaveLength(2))
    expect(sources[0].readyState).toBe(FakeEventSource.CLOSED)
    expect(sources[1].url).toBe('/api/lines/alpha/auth?ticket=sse-ticket-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
