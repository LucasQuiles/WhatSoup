/**
 * ConfigEditDialog — actual TagInput identity-boundary integration.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'

vi.mock('../../console/src/lib/api', () => ({
  api: { updateConfig: vi.fn() },
}))

import { ConfigEditDialog } from '../../console/src/components/line-detail/ConfigEditDialog'

const toast: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => cleanup())

describe('ConfigEditDialog iMessage admin identity input', () => {
  it('does not add an AppleID after erasing unsafe boundary whitespace', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <ToastContext.Provider value={toast}>
          <ConfigEditDialog
            open={true}
            lineName="imessage-line"
            transport="imessage"
            config={{
              name: 'imessage-line',
              type: 'passive',
              transport: 'imessage',
              adminPhones: [],
              healthPort: 9095,
              accessMode: 'self_only',
            }}
            onClose={() => undefined}
          />
        </ToastContext.Provider>
      </QueryClientProvider>,
    )

    const input = screen.getByLabelText('adminPhones')
    fireEvent.change(input, { target: { value: '\uFEFFOwner@Example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.queryByRole('button', { name: /Remove owner@example\.com/i })).toBeNull()
    expect((input as HTMLInputElement).value).toBe('\uFEFFOwner@Example.com')
  })
})
