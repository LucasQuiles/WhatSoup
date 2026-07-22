/**
 * RelinkModal — open/close, ARIA, Escape, backdrop, listener cleanup.
 * Updated for B3 wave-1 Modal migration (was: ad-hoc backdrop; now: Modal dismissable=true).
 *
 * Changes from pre-migration version:
 *   - .c-dialog-backdrop → .soup-modal-backdrop (Modal portal class)
 *   - Close button label Close → Close dialog (ModalHeader ActionButton)
 *   - aria-labelledby: literal id check → resolution check (Modal auto-generates id)
 *   - Backdrop dismissal: fireEvent.click → fireEvent.pointerDown (useDismissable contract)
 *   - container.querySelector / container.childElementCount → screen / document queries (portal)
 *   - NEW: focus restoration to opener; initial focus lands inside dialog
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import type { FC } from 'react'

vi.mock('../../console/src/components/wizard/LinkStep', () => ({
  __esModule: true,
  default: ({ onComplete, transport }: { onComplete: () => void; transport?: string | null }) => (
    <section aria-label="Pairing instructions" data-transport={transport ?? ''}>
      <p>Scan the QR code to reconnect this WhatsApp line.</p>
      <button type="button" onClick={onComplete}>Finish pairing</button>
    </section>
  ),
}))

import RelinkModal from '../../console/src/components/RelinkModal'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Fixture with trigger for focus-restoration tests
// ---------------------------------------------------------------------------

const RelinkFixture: FC<{ onClose?: () => void; onLinked?: () => void }> = ({
  onClose,
  onLinked = vi.fn(),
}) => {
  const [open, setOpen] = useState(false)
  const close = () => {
    setOpen(false)
    onClose?.()
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Re-link
      </button>
      <RelinkModal lineName="alpha" open={open} onClose={close} onLinked={onLinked} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Open/close gate
// ---------------------------------------------------------------------------

describe('RelinkModal open/close state', () => {
  it('renders nothing when open=false', () => {
    render(
      <RelinkModal lineName="alpha" open={false} onClose={vi.fn()} onLinked={vi.fn()} />,
    )

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.soup-modal-backdrop')).toBeNull()
  })

  it('renders the dialog title and pairing content when open=true', () => {
    render(
      <RelinkModal lineName="alpha" open={true} onClose={vi.fn()} onLinked={vi.fn()} />,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    // aria-labelledby resolves to the element whose text is "Re-link alpha"
    const labelledById = dialog.getAttribute('aria-labelledby')
    expect(labelledById).toBeTruthy()
    const titleEl = document.getElementById(labelledById!)
    expect(titleEl).not.toBeNull()
    expect(titleEl!.textContent).toBe('Re-link alpha')

    expect(screen.getByRole('region', { name: 'Pairing instructions' })).toBeDefined()
    expect(screen.getByText('Scan the QR code to reconnect this WhatsApp line.')).toBeDefined()
  })

  it('passes the line transport to LinkStep so non-Baileys relinks cannot open QR auth', () => {
    render(
      <RelinkModal
        lineName="signal-line"
        transport="signal"
        open={true}
        onClose={vi.fn()}
        onLinked={vi.fn()}
      />,
    )

    expect(screen.getByRole('region', { name: 'Pairing instructions' }).getAttribute('data-transport')).toBe('signal')
  })
})

// ---------------------------------------------------------------------------
// Close affordances
// ---------------------------------------------------------------------------

describe('RelinkModal close affordances', () => {
  it('invokes onClose when the header close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    // ModalHeader ActionButton label is "Close dialog" (not "Close")
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('invokes onClose when the backdrop receives pointerdown (dismissable=true cancel action)', () => {
    const onClose = vi.fn()
    render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    // Modal portals to document.body — use document.querySelector, not container
    const backdrop = document.querySelector('.soup-modal-backdrop')
    expect(backdrop).not.toBeNull()
    // useDismissable listens on pointerdown (not click); fire the full sequence
    fireEvent.pointerDown(backdrop as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not invoke onClose when the dialog body is clicked', () => {
    const onClose = vi.fn()
    render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('invokes onLinked when pairing completes', () => {
    const onLinked = vi.fn()
    render(
      <RelinkModal lineName="alpha" open={true} onClose={vi.fn()} onLinked={onLinked} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Finish pairing' }))
    expect(onLinked).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Keyboard handling
// ---------------------------------------------------------------------------

describe('RelinkModal keyboard handling', () => {
  it('calls onClose when Escape is pressed while open', () => {
    const onClose = vi.fn()
    render(<RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores non-Escape keys', () => {
    const onClose = vi.fn()
    render(<RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />)

    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: ' ' })
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('ignores Escape while closed', () => {
    const onClose = vi.fn()
    render(<RelinkModal lineName="alpha" open={false} onClose={onClose} onLinked={vi.fn()} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('stops handling Escape after unmount', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    unmount()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(0)
  })

  it('stops handling Escape after the modal closes on rerender', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    rerender(<RelinkModal lineName="alpha" open={false} onClose={onClose} onLinked={vi.fn()} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(0)
  })
})

// ---------------------------------------------------------------------------
// Focus behavior (NEW — Modal gains trap + restoration)
// ---------------------------------------------------------------------------

describe('RelinkModal focus behavior', () => {
  it('restores focus to the opener element after closing', async () => {
    render(<RelinkFixture />)
    const opener = screen.getByRole('button', { name: 'Re-link' })
    act(() => { opener.focus() })
    fireEvent.click(opener)

    // Close via Escape
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => {})

    expect(document.activeElement).toBe(opener)
  })

  it('initial focus lands inside the dialog on open (not the opener)', () => {
    render(
      <RelinkModal lineName="alpha" open={true} onClose={vi.fn()} onLinked={vi.fn()} />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})
