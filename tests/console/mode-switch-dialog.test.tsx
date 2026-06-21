/**
 * ModeSwitchDialog — radio selection, confirm flow, no-op same-mode, error path, queryClient invalidation.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'

const updateConfig = vi.fn<(name: string, patch: Record<string, unknown>) => Promise<unknown>>()
const restart = vi.fn<(name: string) => Promise<unknown>>()

vi.mock('../../console/src/lib/api', () => ({
  api: {
    get updateConfig() { return updateConfig },
    get restart() { return restart },
  },
}))

// Import after vi.mock so the component picks up the mocked module.
const { ModeSwitchDialog } = await import('../../console/src/components/line-detail/ModeSwitchDialog')

function makeHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const toast: ToastContextValue = {
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  }
  const onClose = vi.fn()
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
  return { queryClient, toast, onClose, invalidateSpy }
}

type Harness = ReturnType<typeof makeHarness>

function renderDialog(h: Harness, currentMode: 'passive' | 'chat' | 'agent' = 'passive', lineName = 'demo-line'): ReactElement {
  return render(
    <QueryClientProvider client={h.queryClient}>
      <ToastContext.Provider value={h.toast}>
        <ModeSwitchDialog currentMode={currentMode} lineName={lineName} onClose={h.onClose} />
      </ToastContext.Provider>
    </QueryClientProvider>,
  ) as unknown as ReactElement
}

beforeEach(() => {
  updateConfig.mockReset()
  restart.mockReset()
})

afterEach(() => cleanup())

describe('ModeSwitchDialog — rendering and current-mode marker', () => {
  it('renders the title with the line name and the dialog body description', () => {
    const h = makeHarness()
    renderDialog(h, 'passive', 'lima')

    expect(screen.getByText('Switch lima Mode')).toBeDefined()
    expect(screen.getByText(/Select the operating mode for this instance/i)).toBeDefined()
  })

  it('renders all three mode options with their labels and descriptions', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    expect(screen.getByText('Passive')).toBeDefined()
    expect(screen.getByText('Chat')).toBeDefined()
    expect(screen.getByText('Agent')).toBeDefined()
    expect(screen.getByText(/Listen and store messages\. No responses\./)).toBeDefined()
    expect(screen.getByText(/API-powered responses with access control\./)).toBeDefined()
    expect(screen.getByText(/Full autonomous agent with tool use\./)).toBeDefined()
  })

  it('marks the currentMode option with the "current" tag and only that one', () => {
    const h = makeHarness()
    renderDialog(h, 'chat')

    const currentTags = screen.getAllByText('current')
    expect(currentTags).toHaveLength(1)
    // The "current" tag is a sibling of the "Chat" label inside the same button row.
    const chatRow = screen.getByText('Chat').closest('button') as HTMLButtonElement
    expect(chatRow).toBeTruthy()
    expect(chatRow.contains(currentTags[0])).toBe(true)
  })

  it('starts with the confirm button labeled "No change" when no selection has been made', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    expect(screen.getByRole('button', { name: 'No change' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /Switch to/ })).toBeNull()
    // Warning banner only shows when the selection differs from current.
    expect(screen.queryByText(/This will restart the instance/)).toBeNull()
  })
})

describe('ModeSwitchDialog — selecting a different mode', () => {
  it('relabels the confirm button to "Switch to <mode>" once a different option is picked', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    fireEvent.click(screen.getByText('Agent'))

    expect(screen.getByRole('button', { name: 'Switch to agent' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'No change' })).toBeNull()
  })

  it('shows the restart-warning banner when the selection differs from current', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    fireEvent.click(screen.getByText('Chat'))

    expect(screen.getByText(/This will restart the instance\. Active sessions will be interrupted\./)).toBeDefined()
  })

  it('hides the warning banner when the user selects the current mode again', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    fireEvent.click(screen.getByText('Chat'))
    expect(screen.getByText(/This will restart the instance/)).toBeDefined()

    fireEvent.click(screen.getByText('Passive'))

    expect(screen.queryByText(/This will restart the instance/)).toBeNull()
    expect(screen.getByRole('button', { name: 'No change' })).toBeDefined()
  })
})

describe('ModeSwitchDialog — confirm flow (no-op same mode)', () => {
  it('closes immediately without firing api when confirming with the unchanged mode', async () => {
    const h = makeHarness()
    renderDialog(h, 'agent')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No change' }))
    })

    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(updateConfig).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect(h.toast.success).not.toHaveBeenCalled()
    expect(h.invalidateSpy).not.toHaveBeenCalled()
  })
})

describe('ModeSwitchDialog — confirm flow (mode change)', () => {
  it('calls updateConfig then restart with the line name and selected mode', async () => {
    updateConfig.mockResolvedValue(undefined)
    restart.mockResolvedValue(undefined)
    const h = makeHarness()
    renderDialog(h, 'passive', 'demo-line')

    fireEvent.click(screen.getByText('Agent'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to agent' }))
    })

    expect(updateConfig).toHaveBeenCalledWith('demo-line', { type: 'agent' })
    expect(restart).toHaveBeenCalledWith('demo-line')
    // updateConfig must be issued before restart so the new mode is persisted first.
    expect(updateConfig.mock.invocationCallOrder[0]).toBeLessThan(restart.mock.invocationCallOrder[0])
  })

  it('emits a success toast and invalidates the ["lines", lineName] query on success', async () => {
    updateConfig.mockResolvedValue(undefined)
    restart.mockResolvedValue(undefined)
    const h = makeHarness()
    renderDialog(h, 'passive', 'demo-line')

    fireEvent.click(screen.getByText('Chat'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to chat' }))
    })

    expect(h.toast.success).toHaveBeenCalledWith(expect.stringContaining('chat'))
    expect(h.invalidateSpy).toHaveBeenCalledTimes(1)
    expect(h.invalidateSpy).toHaveBeenCalledWith({ queryKey: ['lines', 'demo-line'] })
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the confirm action single-flight while the mode switch is pending', async () => {
    let resolveUpdate!: () => void
    updateConfig.mockReturnValue(new Promise<void>(resolve => {
      resolveUpdate = resolve
    }))
    restart.mockResolvedValue(undefined)
    const h = makeHarness()
    renderDialog(h, 'passive', 'demo-line')

    fireEvent.click(screen.getByText('Agent'))

    const confirmButton = screen.getByRole('button', { name: 'Switch to agent' }) as HTMLButtonElement
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)

    expect(updateConfig).toHaveBeenCalledTimes(1)
    expect(confirmButton.disabled).toBe(true)

    await act(async () => {
      resolveUpdate()
      await Promise.resolve()
    })

    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
  })
})

describe('ModeSwitchDialog — error path', () => {
  it('emits an error toast, stays open, and does NOT invalidate when updateConfig rejects', async () => {
    updateConfig.mockRejectedValue(new Error('boom-update'))
    const h = makeHarness()
    renderDialog(h, 'passive', 'demo-line')

    fireEvent.click(screen.getByText('Agent'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to agent' }))
    })

    expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('boom-update'))
    expect(h.toast.success).not.toHaveBeenCalled()
    expect(h.invalidateSpy).not.toHaveBeenCalled()
    expect(h.onClose).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    // Confirm button is back in interactive state for retry.
    expect(screen.getByRole('button', { name: 'Switch to agent' })).toBeDefined()
  })

  it('emits an error toast when restart rejects after a successful updateConfig', async () => {
    updateConfig.mockResolvedValue(undefined)
    restart.mockRejectedValue(new Error('boom-restart'))
    const h = makeHarness()
    renderDialog(h, 'passive', 'demo-line')

    fireEvent.click(screen.getByText('Chat'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch to chat' }))
    })

    expect(updateConfig).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(h.toast.error).toHaveBeenCalledWith(expect.stringContaining('boom-restart'))
    expect(h.invalidateSpy).not.toHaveBeenCalled()
    expect(h.onClose).not.toHaveBeenCalled()
  })
})

describe('ModeSwitchDialog — cancel and dismiss', () => {
  it('calls onClose without firing api when Cancel is clicked', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    fireEvent.click(screen.getByText('Agent'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(updateConfig).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('calls onClose without firing api when Escape is pressed', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    fireEvent.click(screen.getByText('Chat'))
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(updateConfig).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('calls onClose when the close (X) header button is clicked', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))

    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(updateConfig).not.toHaveBeenCalled()
  })
})

describe('ModeSwitchDialog — a11y (selection state)', () => {
  it('groups the mode options and reflects selection via aria-pressed', () => {
    const h = makeHarness()
    renderDialog(h, 'passive')

    expect(screen.getByRole('group', { name: /operating mode/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Passive/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Chat/ }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: /Chat/ }))
    expect(screen.getByRole('button', { name: /Chat/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Passive/ }).getAttribute('aria-pressed')).toBe('false')
  })
})
