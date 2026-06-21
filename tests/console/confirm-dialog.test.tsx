/**
 * ConfirmDialog — open/close, action callbacks, variant styling, Escape handler.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfirmDialog from '../../console/src/components/ConfirmDialog'

afterEach(() => cleanup())

describe('ConfirmDialog open state', () => {
  it('returns null when open is false', () => {
    const { container } = render(
      <ConfirmDialog
        open={false}
        title="Delete chat?"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        Body copy
      </ConfirmDialog>,
    )

    expect(container.firstChild).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Body copy')).toBeNull()
  })

  it('renders title, body and dialog role with aria-modal when open', () => {
    render(
      <ConfirmDialog
        open
        title="Delete chat?"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        This action is permanent.
      </ConfirmDialog>,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Migration note (C2): Modal generates a stable aria-labelledby ID (no longer hardcoded
    // 'confirm-dialog-title'). Verify the attribute is set and non-empty.
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()

    expect(screen.getByText('Delete chat?')).toBeDefined()
    expect(screen.getByText('This action is permanent.')).toBeDefined()
  })
})

describe('ConfirmDialog actions', () => {
  it('invokes onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        Confirm body
      </ConfirmDialog>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('invokes onCancel when the Cancel footer button is clicked', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        Body
      </ConfirmDialog>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('invokes onCancel when the header close icon is clicked', () => {
    const onCancel = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={() => {}}
        onCancel={onCancel}
      >
        Body
      </ConfirmDialog>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('backdrop click does NOT dismiss: ConfirmDialog is dismissable=false (C2 migration)', () => {
    // Migration note (C2): ConfirmDialog uses Modal with dismissable=false (modal.md: destructive
    // confirms must require an explicit button). The old test asserted backdrop click dismissed;
    // this is WRONG for destructive confirms — the migration fixes this design bug.
    // The backdrop renders in a portal (document.body), so we use document.querySelector.
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        Body
      </ConfirmDialog>,
    )

    const backdrop = document.querySelector('.soup-modal-backdrop')
    expect(backdrop).not.toBeNull()
    // dismissable=false: backdrop click (pointerdown) should NOT call onCancel
    fireEvent.pointerDown(document.body)

    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not invoke onCancel when clicking inside the dialog body', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        Body
      </ConfirmDialog>,
    )

    // Click on the dialog container itself; stopPropagation should keep the
    // backdrop's onClick from firing.
    fireEvent.click(screen.getByRole('dialog'))

    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('can disable and mark the confirm button busy without invoking onConfirm', () => {
    const onConfirm = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Proceed?"
        confirmLabel="Run"
        confirmDisabled
        confirmLoading
        onConfirm={onConfirm}
        onCancel={() => {}}
      >
        Body
      </ConfirmDialog>,
    )

    const confirm = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement

    expect(confirm.disabled).toBe(true)
    expect(confirm.getAttribute('aria-busy')).toBe('true')

    fireEvent.click(confirm)

    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('ConfirmDialog labels and variants', () => {
  it('renders the custom confirmLabel when provided', () => {
    render(
      <ConfirmDialog
        open
        title="Proceed?"
        confirmLabel="Delete forever"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        Body
      </ConfirmDialog>,
    )

    const btn = screen.getByRole('button', { name: 'Delete forever' })
    expect(btn).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('defaults the confirm button to the danger variant class', () => {
    render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        Body
      </ConfirmDialog>,
    )

    // Migration note (C2): c-btn-danger replaced by soup-btn--danger (Button primitive).
    const btn = screen.getByRole('button', { name: 'Confirm' })
    expect(btn.className).toContain('soup-btn--danger')
    expect(btn.className).not.toContain('soup-btn--warning')
    expect(btn.className).not.toContain('soup-btn--primary')
  })

  it('applies the warning class when confirmVariant="warning"', () => {
    render(
      <ConfirmDialog
        open
        title="Proceed?"
        confirmVariant="warning"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        Body
      </ConfirmDialog>,
    )

    // Migration note (C2): c-btn-warning replaced by soup-btn--warning (Button primitive).
    const btn = screen.getByRole('button', { name: 'Confirm' })
    expect(btn.className).toContain('soup-btn--warning')
    expect(btn.className).not.toContain('soup-btn--danger')
    expect(btn.className).not.toContain('soup-btn--primary')
  })

  it('applies the primary class when confirmVariant="primary"', () => {
    render(
      <ConfirmDialog
        open
        title="Proceed?"
        confirmVariant="primary"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        Body
      </ConfirmDialog>,
    )

    // Migration note (C2): c-btn-primary replaced by soup-btn--primary (Button primitive).
    const btn = screen.getByRole('button', { name: 'Confirm' })
    expect(btn.className).toContain('soup-btn--primary')
    expect(btn.className).not.toContain('soup-btn--danger')
    expect(btn.className).not.toContain('soup-btn--warning')
  })

  it('keeps the Cancel button on a neutral ghost class regardless of variant', () => {
    render(
      <ConfirmDialog
        open
        title="Proceed?"
        confirmVariant="danger"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        Body
      </ConfirmDialog>,
    )

    // Migration note (C2): c-btn-ghost replaced by soup-btn--ghost (Button primitive).
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel.className).toContain('soup-btn--ghost')
    expect(cancel.className).not.toContain('soup-btn--danger')
    expect(cancel.className).not.toContain('soup-btn--warning')
    expect(cancel.className).not.toContain('soup-btn--primary')
  })

  it('renders the confirmIcon node alongside the confirm label', () => {
    render(
      <ConfirmDialog
        open
        title="Proceed?"
        confirmIcon={<span data-testid="confirm-icon">!</span>}
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        Body
      </ConfirmDialog>,
    )

    const icon = screen.getByTestId('confirm-icon')
    const btn = screen.getByRole('button', { name: /Confirm/ })
    expect(btn.contains(icon)).toBe(true)
  })
})

describe('ConfirmDialog Escape keyboard handler', () => {
  it('invokes onCancel when Escape is pressed while open', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        Body
      </ConfirmDialog>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('ignores non-Escape keys', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      >
        Body
      </ConfirmDialog>,
    )

    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: ' ' })

    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not bind the Escape listener when open is false', () => {
    const onCancel = vi.fn()

    render(
      <ConfirmDialog
        open={false}
        title="Proceed?"
        onConfirm={() => {}}
        onCancel={onCancel}
      >
        Body
      </ConfirmDialog>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('removes the Escape listener after unmount', () => {
    const onCancel = vi.fn()

    const { unmount } = render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={() => {}}
        onCancel={onCancel}
      >
        Body
      </ConfirmDialog>,
    )

    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onCancel).not.toHaveBeenCalled()
  })

  it('uses the latest onCancel callback when props change', () => {
    const first = vi.fn()
    const second = vi.fn()

    const { rerender } = render(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={() => {}}
        onCancel={first}
      >
        Body
      </ConfirmDialog>,
    )

    rerender(
      <ConfirmDialog
        open
        title="Proceed?"
        onConfirm={() => {}}
        onCancel={second}
      >
        Body
      </ConfirmDialog>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
