// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mockInvalidateQueries = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}))

const mockApiRestart = vi.fn()
const mockApiGetVersion = vi.fn()

vi.mock('../../console/src/lib/api', async (importOriginal) => {
  // apiSse/SseRequestError stay REAL — these tests stub global fetch and rely
  // on the actual SSE-parsing implementation under test, not a bypass of it.
  const actual = await importOriginal<typeof import('../../console/src/lib/api')>()
  return {
    ...actual,
    api: {
      restart: (...args: unknown[]) => mockApiRestart(...args),
      getVersion: (...args: unknown[]) => mockApiGetVersion(...args),
    },
    isProductionConsole: () => false,
    getApiTicket: vi.fn(),
  }
})

import UpdateModal from '../../console/src/components/UpdateModal'
import type { LineInstance } from '../../console/src/types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockInvalidateQueries.mockReset()
  mockApiRestart.mockReset()
  mockApiGetVersion.mockReset()
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

const DEFAULT_LINES: LineInstance[] = [makeLine()]

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

describe('UpdateModal - F-058: SSE error phase sticky on stream close', () => {
  it('preserves error phase when SSE emits error event then stream closes', async () => {
    const errChunk = 'event: error\ndata: {"message":"git pull failed","step":"pull"}\n\n'
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, body: makeStreamBody([errChunk]) })
    ))

    render(
      <UpdateModal
        open={true}
        onClose={vi.fn()}
        currentSha="abc1234"
        lines={DEFAULT_LINES}
      />
    )

    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)

    await waitFor(() => {
      expect(screen.getByText('git pull failed')).toBeDefined()
    })

    expect(screen.queryByText('Waiting for fleet server...')).toBeNull()
    expect(mockApiGetVersion).not.toHaveBeenCalled()
  })

  it('preserves error phase when multiple SSE chunks are emitted before close', async () => {
    const progressChunk = 'event: progress\ndata: {"step":"pull","status":"running"}\n\n'
    const errChunk = 'event: error\ndata: {"message":"install failed","step":"install"}\n\n'
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: true, body: makeStreamBody([progressChunk, errChunk]) })
    ))

    render(
      <UpdateModal
        open={true}
        onClose={vi.fn()}
        currentSha="abc1234"
        lines={DEFAULT_LINES}
      />
    )

    const updateBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Update'))!
    fireEvent.click(updateBtn)

    await waitFor(() => {
      expect(screen.getByText('install failed')).toBeDefined()
    })

    expect(screen.queryByText('Waiting for fleet server...')).toBeNull()
    expect(mockApiGetVersion).not.toHaveBeenCalled()
  })
})
