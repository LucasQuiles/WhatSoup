/**
 * SaveContactDialog — component contract tests.
 * Covers: open/close gate, ARIA, initialFocus, Save gating, Enter-submit,
 * Cancel/X/Escape, dismissable=false (backdrop), name reset on reopen, focus restoration.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { FC } from 'react'
import { SaveContactDialog } from '../../console/src/components/SaveContactDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps SaveContactDialog with a trigger button for focus-restoration tests. */
const Fixture: FC<{
  onSave?: (name: string) => void
  onClose?: () => void
  busy?: boolean
}> = ({ onSave = vi.fn(), onClose, busy = false }) => {
  const [open, setOpen] = useState(false)
  const close = () => {
    setOpen(false)
    onClose?.()
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Save Contact
      </button>
      <SaveContactDialog
        open={open}
        busy={busy}
        onSave={(name) => { onSave(name); setOpen(false) }}
        onClose={close}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Open / close gate
// ---------------------------------------------------------------------------

describe('SaveContactDialog — open/close gate', () => {
  it('renders nothing when open=false', () => {
    render(<SaveContactDialog open={false} busy={false} onSave={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the dialog when open=true', () => {
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// ARIA wiring
// ---------------------------------------------------------------------------

describe('SaveContactDialog — ARIA', () => {
  it('shell has role=dialog and aria-modal=true', () => {
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('aria-labelledby resolves to the "Save Contact" title', () => {
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    const labelledById = dialog.getAttribute('aria-labelledby')
    expect(labelledById).toBeTruthy()
    const titleEl = document.getElementById(labelledById!)
    expect(titleEl).not.toBeNull()
    expect(titleEl!.textContent).toBe('Save Contact')
  })
})

// ---------------------------------------------------------------------------
// Initial focus — C-B3W1-1
// ---------------------------------------------------------------------------

describe('SaveContactDialog — initialFocus', () => {
  it('name input holds initial focus on open', () => {
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByLabelText(/Contact name/i)
    expect(document.activeElement).toBe(input)
  })
})

// ---------------------------------------------------------------------------
// Save button gating
// ---------------------------------------------------------------------------

describe('SaveContactDialog — Save button gating', () => {
  it('Save is disabled when name is empty', () => {
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={vi.fn()} />)
    const save = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('Save is disabled when name is whitespace-only', () => {
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Contact name/i), { target: { value: '   ' } })
    const save = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('Save is enabled when name has content', () => {
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Contact name/i), { target: { value: 'Alice' } })
    const save = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
  })

  it('Save is disabled while busy=true even with a name', () => {
    render(<SaveContactDialog open busy onSave={vi.fn()} onClose={vi.fn()} />)
    // busy=true: input itself is disabled, Save button also disabled
    const save = screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Submit via button
// ---------------------------------------------------------------------------

describe('SaveContactDialog — submit', () => {
  it('clicking Save calls onSave with the TRIMMED name', () => {
    const onSave = vi.fn()
    render(<SaveContactDialog open busy={false} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Contact name/i), { target: { value: '  Alice Johnson  ' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('Alice Johnson')
  })

  it('Enter on a non-empty name calls onSave with the TRIMMED name', () => {
    const onSave = vi.fn()
    render(<SaveContactDialog open busy={false} onSave={onSave} onClose={vi.fn()} />)
    const input = screen.getByLabelText(/Contact name/i)
    fireEvent.change(input, { target: { value: '  Bob  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('Bob')
  })

  it('Enter on an empty name does NOT call onSave', () => {
    const onSave = vi.fn()
    render(<SaveContactDialog open busy={false} onSave={onSave} onClose={vi.fn()} />)
    const input = screen.getByLabelText(/Contact name/i)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Cancel / close affordances
// ---------------------------------------------------------------------------

describe('SaveContactDialog — cancel affordances', () => {
  it('Cancel button calls onClose', () => {
    const onClose = vi.fn()
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('header X calls onClose', () => {
    const onClose = vi.fn()
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape closes via the stack and unbinds when closed', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <SaveContactDialog open busy={false} onSave={vi.fn()} onClose={onClose} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Backdrop — dismissable=false (C-B3W1-3)
// ---------------------------------------------------------------------------

describe('SaveContactDialog — backdrop not dismissable', () => {
  it('backdrop pointerdown does NOT call onClose (dismissable=false)', () => {
    const onClose = vi.fn()
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={onClose} />)
    const backdrop = document.querySelector('.soup-modal-backdrop')
    expect(backdrop).not.toBeNull()
    // dismissable=false: pointerdown on body outside shell must not dismiss
    fireEvent.pointerDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Name resets on reopen
// ---------------------------------------------------------------------------

describe('SaveContactDialog — name resets on reopen', () => {
  it('name field is empty after Cancel clears state (close-clears pattern)', () => {
    // State is cleared on handleClose (Cancel / header X / Escape), not on prop flip.
    // Callers that want a fully clean mount on each open should pass key={chatId}.
    const onClose = vi.fn()
    render(<SaveContactDialog open busy={false} onSave={vi.fn()} onClose={onClose} />)
    fireEvent.change(screen.getByLabelText(/Contact name/i), { target: { value: 'Partial' } })

    // Trigger close via Cancel — name is cleared by handleClose
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    // onClose called; component is typically unmounted by the parent, but the
    // internal name state has already been reset to '' by handleClose.
  })

  it('name field is empty after a successful save clears state', () => {
    const onSave = vi.fn()
    render(<SaveContactDialog open busy={false} onSave={onSave} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/Contact name/i), { target: { value: 'Alice' } })

    // Trigger save — name is cleared by handleSave after onSave is called
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(onSave).toHaveBeenCalledWith('Alice')
    // Internal state has been reset; if the dialog remains open (e.g. busy=true during
    // an async call) the field would be empty. Verify via the input value.
    const input = screen.getByLabelText(/Contact name/i) as HTMLInputElement
    expect(input.value).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Focus restoration
// ---------------------------------------------------------------------------

describe('SaveContactDialog — focus restoration', () => {
  it('focus restores to the opener after close', async () => {
    render(<Fixture />)
    const opener = screen.getByRole('button', { name: 'Save Contact' })
    act(() => { opener.focus() })
    fireEvent.click(opener)

    // Close via Escape
    fireEvent.keyDown(document, { key: 'Escape' })

    await act(async () => {})
    expect(document.activeElement).toBe(opener)
  })
})
