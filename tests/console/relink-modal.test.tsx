/**
 * RelinkModal — open/close, ARIA, Escape, backdrop, listener cleanup.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../../console/src/components/wizard/LinkStep', () => ({
  __esModule: true,
  default: ({ onComplete }: { onComplete: () => void }) => (
    <section aria-label="Pairing instructions">
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

describe('RelinkModal open/close state', () => {
  it('renders nothing when open=false', () => {
    const { container, queryByRole } = render(
      <RelinkModal lineName="alpha" open={false} onClose={vi.fn()} onLinked={vi.fn()} />,
    )

    expect(queryByRole('dialog')).toBeNull()
    expect(container.querySelector('.c-dialog-backdrop')).toBeNull()
    expect(container.childElementCount).toBe(0)
  })

  it('renders the dialog title and pairing content when open=true', () => {
    render(
      <RelinkModal lineName="alpha" open={true} onClose={vi.fn()} onLinked={vi.fn()} />,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('relink-dialog-title')

    const title = screen.getByText('Re-link alpha')
    expect(title.id).toBe('relink-dialog-title')
    expect(dialog.contains(title)).toBe(true)

    const close = screen.getByLabelText('Close')
    expect(close.tagName).toBe('BUTTON')
    expect(dialog.contains(close)).toBe(true)
    expect(screen.getByRole('region', { name: 'Pairing instructions' })).toBeDefined()
    expect(screen.getByText('Scan the QR code to reconnect this WhatsApp line.')).toBeDefined()
  })
})

describe('RelinkModal close affordances', () => {
  it('invokes onClose when the header close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('invokes onClose when the backdrop is clicked as a cancel action', () => {
    const onClose = vi.fn()
    const { container } = render(
      <RelinkModal lineName="alpha" open={true} onClose={onClose} onLinked={vi.fn()} />,
    )

    const backdrop = container.querySelector('.c-dialog-backdrop')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not invoke onClose when the dialog body is clicked (stopPropagation)', () => {
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
