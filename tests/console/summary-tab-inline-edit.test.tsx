/**
 * SummaryTab — InlineEdit adoption on agentOptions.fallbackModel (showcase §17).
 *
 * Pins that editing the fallback model through the new InlineEdit primitive
 * routes through the canonical save path: api.updateConfig with a nested
 * { agentOptions: { fallbackModel } } patch and queryClient.invalidateQueries
 * on ['lines', name], with a success toast. Mirrors the summary-tab.test.tsx
 * mocking strategy (stubbed realtime + api).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: false }),
}))

const { updateConfigMock } = vi.hoisted(() => ({
  updateConfigMock: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: vi.fn(),
    stopInstance: vi.fn(),
    updateConfig: updateConfigMock,
    getProviders: vi.fn().mockResolvedValue([]),
    getProviderStatus: vi.fn().mockResolvedValue({
      primary: { provider: null, model: null, keyPresent: null },
      fallback: { provider: null, model: null, keyPresent: null, active: false, activeUntil: null },
    }),
  },
}))

import { SummaryTab } from '../../console/src/components/line-detail/SummaryTab'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import type { LineInstance } from '../../console/src/types'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}

function withProviders(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastValue}>{node}</ToastContext.Provider>
    </QueryClientProvider>
  )
}

function makeLine(): LineInstance {
  return {
    name: 'test-line',
    phone: '+15551234567',
    mode: 'agent',
    provider: 'openai-api',
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
    activeSessions: 1,
    config: {
      agentOptions: {
        provider: 'openai-api',
        fallbackModel: 'gpt-4o',
      },
    },
  }
}

describe('SummaryTab — InlineEdit on agentOptions.fallbackModel', () => {
  it('renders the fallback model value through the InlineEdit primitive', () => {
    render(withProviders(<SummaryTab line={makeLine()} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))
    // Display button carries aria-label "Edit Fallback model"
    const editBtn = screen.getByRole('button', { name: 'Edit Fallback model' })
    expect(editBtn).toBeDefined()
    expect(editBtn.textContent).toContain('gpt-4o')
  })

  it('commits via api.updateConfig with a nested patch and invalidates the line query', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)

    render(
      <QueryClientProvider client={client}>
        <ToastContext.Provider value={toastValue}>
          <SummaryTab line={makeLine()} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />
        </ToastContext.Provider>
      </QueryClientProvider>,
    )

    // Enter edit mode
    fireEvent.click(screen.getByRole('button', { name: 'Edit Fallback model' }))
    const input = screen.getByLabelText('Fallback model') as HTMLInputElement
    expect(input.value).toBe('gpt-4o')

    // Change + commit
    fireEvent.change(input, { target: { value: 'claude-opus-4-6' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(updateConfigMock).toHaveBeenCalledTimes(1))
    expect(updateConfigMock).toHaveBeenCalledWith('test-line', {
      agentOptions: { fallbackModel: 'claude-opus-4-6' },
    })
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(1))
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['lines', 'test-line'] })
    expect(toastValue.success).toHaveBeenCalledWith('Configuration updated')
  })

  it('toasts an error and rethrows so the primitive stays in edit mode when update fails', async () => {
    updateConfigMock.mockRejectedValueOnce(new Error('network down'))

    render(withProviders(<SummaryTab line={makeLine()} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    fireEvent.click(screen.getByRole('button', { name: 'Edit Fallback model' }))
    const input = screen.getByLabelText('Fallback model') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'claude-opus-4-6' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(updateConfigMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toastValue.error).toHaveBeenCalledTimes(1))
    expect(toastValue.error).toHaveBeenCalledWith('Update failed: network down')
    // Still in edit mode (input present), so the user can retry.
    await waitFor(() => expect(screen.getByLabelText('Fallback model')).toBeDefined())
  })
})
