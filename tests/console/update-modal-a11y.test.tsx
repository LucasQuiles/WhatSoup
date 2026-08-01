/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UpdateModal from '../../console/src/components/UpdateModal'
import { api } from '../../console/src/lib/api'
import type { LineInstance } from '../../console/src/types'

vi.mock('../../console/src/lib/api', async (importOriginal) => {
  // apiSse/SseRequestError stay REAL — these tests stub global fetch and rely
  // on the actual SSE-parsing implementation under test, not a bypass of it.
  const actual = await importOriginal<typeof import('../../console/src/lib/api')>()
  return {
    ...actual,
    api: {
      getVersion: vi.fn(),
      restart: vi.fn(),
    },
    getApiTicket: vi.fn(),
    isProductionConsole: vi.fn(() => false),
  }
})

const getVersionMock = api.getVersion as unknown as ReturnType<typeof vi.fn>

const onlineLine: LineInstance = {
  name: 'line-one',
  mode: 'chat',
  phone: '15555550001',
  status: 'online',
  accessMode: 'private',
  healthPort: 9101,
  uptime: '1h',
  messagesTotal: 12,
  health: null,
  heartbeat: ['up'],
  lastActive: '2026-05-13T00:00:00Z',
  error: null,
}

function renderModal(overrides: Partial<{
  open: boolean
  onClose: () => void
  currentSha: string
  lines: LineInstance[]
}> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  const props = {
    open: true,
    onClose: vi.fn(),
    currentSha: 'old-sha',
    lines: [onlineLine],
    ...overrides,
  }

  render(
    <QueryClientProvider client={queryClient}>
      <UpdateModal {...props} />
    </QueryClientProvider>,
  )

  return props
}

function mockFinishedUpdateStream() {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: vi.fn(async () => ({ done: true, value: undefined })),
      }),
    },
  })))
}

beforeEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  getVersionMock.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('UpdateModal close controls', () => {
  it('keeps the header close button labelled "Close dialog" and the confirm Cancel button text-labelled', () => {
    renderModal()

    // The header X ActionButton uses label="Close dialog" (modal.md anatomy, wave-3 migration)
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' })
    expect(closeBtn.getAttribute('aria-label')).toBe('Close dialog')

    const cancelButton = screen.getByRole('button', { name: 'Cancel' })
    expect(cancelButton.getAttribute('aria-label')).toBeNull()
  })

  it('keeps the error-phase Close button text-labelled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await screen.findByText('Update failed: 500')
    // Header X is "Close dialog"; error-phase footer button is "Close" — no collision
    const textCloseButton = screen.getByRole('button', { name: 'Close' })
    expect(textCloseButton.textContent).toBe('Close')
    expect(textCloseButton.getAttribute('aria-label')).toBeNull()
    const retryButton = screen.getByRole('button', { name: 'Try again' })
    expect(retryButton.getAttribute('aria-label')).toBeNull()
  })

  it('keeps the restart-instance Skip button text-labelled', async () => {
    mockFinishedUpdateStream()
    getVersionMock.mockResolvedValue({ sha: 'new-sha' })
    renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    await screen.findByText('Waiting for fleet server...')
    await waitFor(() => {
      expect(screen.getByText('Restart instances with update?')).toBeDefined()
    }, { timeout: 3_000 })
    const skipButton = screen.getByRole('button', { name: 'Skip' })
    expect(skipButton.getAttribute('aria-label')).toBeNull()

    fireEvent.click(skipButton)
  })
})
