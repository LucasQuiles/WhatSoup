/**
 * Regression test for F-058: UpdateModal SSE error phase sticky on stream close.
 *
 * Before the fix, when the SSE stream emitted an `error` event and then closed
 * normally, the done-branch unconditionally called waitForFleetRestart() which
 * dispatched setPhase('restarting-fleet'), overwriting the error phase.
 *
 * After the fix (phaseRef guard), the done-branch checks phaseRef.current and
 * skips waitForFleetRestart() when the phase is already 'error'.
 *
 * This test uses makeStreamBody (error chunk + close) without any hanging-stream
 * workaround. The error message must remain visible after the stream closes.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mocks — hoisted before component import
// ---------------------------------------------------------------------------

const mockInvalidateQueries = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}))

const mockApiRestart = vi.fn()
const mockApiGetVersion = vi.fn()

vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: (...args: unknown[]) => mockApiRestart(...args),
    getVersion: (...args: unknown[]) => mockApiGetVersion(...args),
  },
  getFleetToken: () => null,
  getApiTicket: vi.fn(),
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
      connection: { state: 'connected' },
      sqlite: { messages_total: 0, schema_version: 1 },
    },
    heartbeat: ['up', 'up', 'up'],
    lastActive: 'just now',
    error: null,
    ...overrides,
  }
}

const DEFAULT_LINES: LineInstance[] = [makeLine()]

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

// ---------------------------------------------------------------------------
// F-058 regression tests
// ---------------------------------------------------------------------------

describe('UpdateModal — F-058: SSE error phase sticky on stream close', () => {
  it('preserves error phase when SSE emits error event then stream closes', async () => {
    // Stream emits an error event and then immediately closes (done=true).
    // Before the fix: done-branch called waitForFleetRestart() → setPhase('restarting-fleet')
    //   which overwrote the error phase, hiding the error from the user.
    // After the fix: phaseRef.current === 'error' so waitForFleetRestart() is skipped.
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

    // Error message must appear and persist — not be replaced by fleet-restart UI
    await waitFor(() => {
      expect(screen.getByText('git pull failed')).toBeDefined()
    })

    // Error phase must still be showing — "restarting fleet" spinner must NOT appear
    expect(screen.queryByText('Waiting for fleet server...')).toBeNull()

    // api.getVersion must NOT have been called (waitForFleetRestart was skipped)
    expect(mockApiGetVersion).not.toHaveBeenCalled()
  })

  it('preserves error phase when multiple SSE chunks are emitted before close', async () => {
    // Two-chunk scenario: progress then error, then stream closes.
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
