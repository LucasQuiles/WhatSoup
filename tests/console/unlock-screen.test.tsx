/**
 * @vitest-environment jsdom
 *
 * UnlockScreen component — B1 console-lock closure.
 *
 * Covers:
 *   - Render: form, input, heading, button present
 *   - Happy path: token submit calls unlockConsole, onUnlocked fires, field clears
 *   - Error render: rejected unlock shows error alert with the message
 *   - Busy / double-submit gate: button disabled while probe is in-flight
 *   - Whitespace-token guard: blank or whitespace-only token keeps button disabled
 *   - Whitespace stripping: leading/trailing whitespace stripped before API call
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Module-level mock — declared before dynamic import per vitest hoisting rules
// ---------------------------------------------------------------------------

const mockUnlockConsole = vi.hoisted(() => vi.fn())

vi.mock('../../console/src/lib/api', () => ({
  unlockConsole: mockUnlockConsole,
}))

import UnlockScreen from '../../console/src/components/UnlockScreen'

const legacyInputOverrideClasses = [
  'bg-b1',
  'border-b3',
  'p-2',
  'rounded',
  'text-sm',
  'text-t1',
]

const legacyButtonOverrideClasses = [
  'bg-accent',
  'disabled:opacity-50',
  'p-2',
  'rounded',
  'text-b1',
]

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Render contract
// ---------------------------------------------------------------------------

describe('UnlockScreen — render', () => {
  it('renders the "Console locked" heading', () => {
    render(<UnlockScreen onUnlocked={() => {}} />)

    const heading = screen.getByRole('heading', { name: 'Console locked' })
    expect(heading.tagName).toBe('H1')
  })

  it('renders a password input with aria-label "fleet token"', () => {
    render(<UnlockScreen onUnlocked={() => {}} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.getAttribute('aria-label')).toBe('fleet token')
    expect(input.classList.contains('c-input')).toBe(true)
  })

  it('renders an Unlock submit button that is initially disabled when the token field is empty', () => {
    render(<UnlockScreen onUnlocked={() => {}} />)

    const btn = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('button becomes enabled once the user types a non-empty token', async () => {
    render(<UnlockScreen onUnlocked={() => {}} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'tok-abc' } })
    })

    const btn = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('no error alert is present on initial render', () => {
    render(<UnlockScreen onUnlocked={() => {}} />)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lets the input and button primitives own styling without legacy caller overrides', () => {
    render(<UnlockScreen onUnlocked={() => {}} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    const btn = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement

    expect(input.classList.contains('c-input')).toBe(true)
    for (const className of legacyInputOverrideClasses) {
      expect(input.classList.contains(className)).toBe(false)
    }

    expect(btn.classList.contains('soup-btn')).toBe(true)
    expect(btn.classList.contains('soup-btn--primary')).toBe(true)
    for (const className of legacyButtonOverrideClasses) {
      expect(btn.classList.contains(className)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Happy-path token submit
// ---------------------------------------------------------------------------

describe('UnlockScreen — happy path', () => {
  it('calls unlockConsole with the trimmed token and fires onUnlocked', async () => {
    mockUnlockConsole.mockResolvedValue({ expiresIn: 3600 })
    const onUnlocked = vi.fn()
    render(<UnlockScreen onUnlocked={onUnlocked} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'my-secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce())
    expect(mockUnlockConsole).toHaveBeenCalledWith('my-secret-token')
  })

  it('clears the token field after a successful unlock', async () => {
    mockUnlockConsole.mockResolvedValue({ expiresIn: 3600 })
    render(<UnlockScreen onUnlocked={() => {}} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'tok-to-clear' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => expect(mockUnlockConsole).toHaveBeenCalledOnce())
    expect(input.value).toBe('')
  })

  it('strips leading and trailing whitespace from token before calling unlockConsole', async () => {
    mockUnlockConsole.mockResolvedValue({ expiresIn: 3600 })
    const onUnlocked = vi.fn()
    render(<UnlockScreen onUnlocked={onUnlocked} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  padded-token  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce())
    expect(mockUnlockConsole).toHaveBeenCalledWith('padded-token')
  })
})

// ---------------------------------------------------------------------------
// 3. Whitespace-token guard
// ---------------------------------------------------------------------------

describe('UnlockScreen — whitespace-token guard', () => {
  it('whitespace-only token keeps the submit button disabled', () => {
    render(<UnlockScreen onUnlocked={() => {}} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })

    const btn = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('whitespace-only token is never forwarded to unlockConsole even via form submit', async () => {
    render(<UnlockScreen onUnlocked={() => {}} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })

    await act(async () => {
      fireEvent.submit(document.querySelector('form')!)
    })

    expect(mockUnlockConsole).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. Error render on failed unlock
// ---------------------------------------------------------------------------

describe('UnlockScreen — error render', () => {
  it('shows error alert text when unlockConsole rejects with an Error', async () => {
    mockUnlockConsole.mockRejectedValue(new Error('invalid token'))
    render(<UnlockScreen onUnlocked={vi.fn()} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bad-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe('invalid token')
    })
  })

  it('shows "unlock failed" fallback text when the rejection is not an Error instance', async () => {
    mockUnlockConsole.mockRejectedValue('plain string rejection')
    render(<UnlockScreen onUnlocked={vi.fn()} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bad-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe('unlock failed')
    })
  })

  it('re-enables the button after a failed unlock so the user can retry', async () => {
    mockUnlockConsole.mockRejectedValue(new Error('server error'))
    render(<UnlockScreen onUnlocked={vi.fn()} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bad-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined())
    const btn = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. Busy / double-submit gating
// ---------------------------------------------------------------------------

describe('UnlockScreen — busy gating', () => {
  it('shows "Unlocking…" text and disables the button while the probe is in-flight', async () => {
    let resolveUnlock!: () => void
    mockUnlockConsole.mockReturnValue(
      new Promise<{ expiresIn: number }>((res) => {
        resolveUnlock = () => res({ expiresIn: 3600 })
      }),
    )
    render(<UnlockScreen onUnlocked={() => {}} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'in-flight-token' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    })

    const btn = screen.getByRole('button', { name: 'Unlocking…' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    // Resolve the in-flight call and verify button returns
    await act(async () => { resolveUnlock() })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Unlock' })).toBeDefined(),
    )
  })

  it('second form submit while busy does not trigger a second API call', async () => {
    let resolveUnlock!: () => void
    mockUnlockConsole.mockReturnValue(
      new Promise<{ expiresIn: number }>((res) => {
        resolveUnlock = () => res({ expiresIn: 3600 })
      }),
    )
    render(<UnlockScreen onUnlocked={() => {}} />)

    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'tok' } })

    await act(async () => {
      fireEvent.submit(document.querySelector('form')!)
    })
    await act(async () => {
      fireEvent.submit(document.querySelector('form')!)
    })

    await act(async () => { resolveUnlock() })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlock' })).toBeDefined())

    expect(mockUnlockConsole).toHaveBeenCalledOnce()
  })
})
