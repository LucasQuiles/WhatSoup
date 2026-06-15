/**
 * @vitest-environment jsdom
 *
 * use-dismissable dark branch tests (coverage-audit gap 5).
 *
 * Covers the three previously-uncovered arms:
 *   (a) Lines 170–173: Tab inside an overlay with ZERO focusable children must
 *       preventDefault and hold focus — the "empty container Tab trap".
 *   (b) Line 177: Shift+Tab recovery arm — when focus has escaped the container,
 *       Shift+Tab must re-enter the container by focusing the last focusable element.
 *   (c) Line 240: outside-click stacking guard — a pointerdown on a lower (non-topmost)
 *       dismissable overlay must NOT call its onClose; only the topmost overlay closes.
 *
 * These tests use Modal (which delegates to useDismissable) because Modal is the
 * canonical integration surface of the hook (interaction-patterns.md §2).
 *
 * The stacked-Escape single-fire is already covered in primitives-modal.test.tsx;
 * these cases cover the parallel stacked-outside-click and Tab-trap contracts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { useRef, useState } from 'react'
import type { FC } from 'react'
import { Modal, ModalHeader, ModalBody } from '../../console/src/components/primitives/Modal'

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// (a) Tab trap on empty container (lines 170–173)
// ---------------------------------------------------------------------------

describe('useDismissable — Tab trap: empty container (lines 170–173)', () => {
  it('Tab inside an overlay with no focusable children calls preventDefault', () => {
    // Render a Modal whose body contains NO interactive elements.
    // The hook's handleTab branch at line 170 fires: focusable.length === 0 → preventDefault.
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose}>
        <ModalBody>
          {/* intentionally zero focusable children */}
          <p data-testid="non-focusable">No buttons here</p>
        </ModalBody>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog')
    // Focus the container itself (the dialog) — focus is "inside" but has no focusable children
    act(() => { dialog.focus() })

    // Dispatch Tab and capture whether preventDefault was called
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    const preventDefaultSpy = vi.spyOn(tabEvent, 'preventDefault')
    document.dispatchEvent(tabEvent)

    expect(preventDefaultSpy).toHaveBeenCalled()
  })

  it('Shift+Tab inside an overlay with no focusable children calls preventDefault', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose}>
        <ModalBody>
          <p>No buttons here</p>
        </ModalBody>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog')
    act(() => { dialog.focus() })

    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    const preventDefaultSpy = vi.spyOn(tabEvent, 'preventDefault')
    document.dispatchEvent(tabEvent)

    expect(preventDefaultSpy).toHaveBeenCalled()
  })
})

describe('useDismissable — Tab trap: roving tabIndex boundary', () => {
  it('ignores tabIndex=-1 roving buttons when detecting the forward-Tab boundary', () => {
    const onClose = vi.fn()
    render(
      <>
        <button type="button" data-testid="outside">Outside</button>
        <Modal open onClose={onClose}>
          <ModalHeader title="Roving Trap" onClose={onClose} />
          <ModalBody>
            <button type="button" data-testid="active-tab">Active tab</button>
            <button type="button" tabIndex={-1} data-testid="roving-tab">
              Inactive roving tab
            </button>
          </ModalBody>
        </Modal>
      </>,
    )

    const activeTab = screen.getByTestId('active-tab')
    const closeBtn = screen.getByRole('button', { name: 'Close dialog' })
    act(() => { activeTab.focus() })

    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    const preventDefaultSpy = vi.spyOn(tabEvent, 'preventDefault')
    document.dispatchEvent(tabEvent)

    expect(preventDefaultSpy).toHaveBeenCalled()
    expect(document.activeElement).toBe(closeBtn)
  })
})

// ---------------------------------------------------------------------------
// (b) Shift+Tab recovery arm (line 177): focus escaped container → re-enter
// ---------------------------------------------------------------------------

describe('useDismissable — Shift+Tab recovery when focus is outside container (line 177)', () => {
  it('Shift+Tab from outside the container calls preventDefault and re-focuses the last element inside', () => {
    // Render an outside button and the modal to have a concrete outside target
    const { container } = render(
      <>
        <button type="button" data-testid="outside-btn">Outside</button>
        <Modal open onClose={() => {}}>
          <ModalHeader title="Recovery Test" onClose={() => {}} />
          <ModalBody>
            <button type="button" data-testid="btn-first">First</button>
            <button type="button" data-testid="btn-last">Last</button>
          </ModalBody>
        </Modal>
      </>,
    )

    const btnLast = screen.getByTestId('btn-last')
    const outsideBtn = screen.getByTestId('outside-btn')

    // Simulate focus having "escaped" the container by focusing the outside button
    act(() => { outsideBtn.focus() })

    // Verify focus is indeed outside the modal container
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(false)

    // Dispatch Shift+Tab — the recovery arm fires and re-enters the container at last
    const tabEvent = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    const preventDefaultSpy = vi.spyOn(tabEvent, 'preventDefault')
    document.dispatchEvent(tabEvent)

    // The recovery arm calls e.preventDefault() and last.focus()
    expect(preventDefaultSpy).toHaveBeenCalled()
    expect(document.activeElement).toBe(btnLast)
  })
})

// ---------------------------------------------------------------------------
// Initial focus target selection:
// caller-provided contained refs win; outside refs fall back to first focusable.
// ---------------------------------------------------------------------------

describe('useDismissable — initial focus target selection', () => {
  it('focuses a caller-provided initialFocus ref when it is inside the modal', () => {
    const InitialFocusFixture: FC = () => {
      const preferredRef = useRef<HTMLButtonElement>(null)
      return (
        <Modal open onClose={() => {}} initialFocus={preferredRef}>
          <ModalBody>
            <button type="button">First</button>
            <button ref={preferredRef} type="button" data-testid="preferred">Preferred</button>
          </ModalBody>
        </Modal>
      )
    }

    render(<InitialFocusFixture />)

    expect(document.activeElement).toBe(screen.getByTestId('preferred'))
  })

  it('ignores an initialFocus ref outside the modal and focuses the first element inside', () => {
    const OutsideInitialFocusFixture: FC = () => {
      const outsideRef = useRef<HTMLButtonElement>(null)
      return (
        <>
          <button ref={outsideRef} type="button" data-testid="outside">Outside</button>
          <Modal open onClose={() => {}} initialFocus={outsideRef}>
            <ModalBody>
              <button type="button" data-testid="first-inside">First inside</button>
              <button type="button">Second inside</button>
            </ModalBody>
          </Modal>
        </>
      )
    }

    render(<OutsideInitialFocusFixture />)

    expect(document.activeElement).toBe(screen.getByTestId('first-inside'))
  })
})

// ---------------------------------------------------------------------------
// (c) Outside-click stacking guard (line 240):
// Only the TOPMOST dismissable overlay closes on a pointerdown outside.
// ---------------------------------------------------------------------------

describe('useDismissable — stacked outside-click single-fire (line 240)', () => {
  /**
   * Fixture: two simultaneously-open dismissable Modals.
   * The "inner" modal is rendered second so it's the topmost entry in _overlayStack.
   */
  const StackedDismissable: FC<{
    outerClose: () => void
    innerClose: () => void
  }> = ({ outerClose, innerClose }) => {
    const [outerOpen, setOuterOpen] = useState(true)
    const [innerOpen, setInnerOpen] = useState(true)

    return (
      <>
        <Modal
          open={outerOpen}
          onClose={() => { setOuterOpen(false); outerClose() }}
          dismissable
        >
          <ModalBody>
            <button type="button" data-testid="outer-btn">Outer</button>
          </ModalBody>
        </Modal>
        <Modal
          open={innerOpen}
          onClose={() => { setInnerOpen(false); innerClose() }}
          dismissable
        >
          <ModalBody>
            <button type="button" data-testid="inner-btn">Inner</button>
          </ModalBody>
        </Modal>
      </>
    )
  }

  it('a pointerdown outside both stacked overlays closes ONLY the topmost (inner) modal', () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()

    render(<StackedDismissable outerClose={outerClose} innerClose={innerClose} />)

    // Both modals are open. Pointerdown on document.body (outside both containers).
    fireEvent.pointerDown(document.body)

    // Only the topmost (inner) modal should close
    expect(innerClose).toHaveBeenCalledOnce()
    expect(outerClose).not.toHaveBeenCalled()
  })

  it('a second pointerdown outside (after inner closes) closes the outer modal', () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()

    const { rerender } = render(
      <StackedDismissable outerClose={outerClose} innerClose={innerClose} />,
    )

    // First outside click — inner closes
    fireEvent.pointerDown(document.body)
    expect(innerClose).toHaveBeenCalledOnce()
    expect(outerClose).not.toHaveBeenCalled()

    // Now render with inner closed (simulate controlled state update)
    const OuterOnly: FC<{ onClose: () => void }> = ({ onClose }) => (
      <Modal open onClose={onClose} dismissable>
        <ModalBody>
          <button type="button">Outer</button>
        </ModalBody>
      </Modal>
    )
    rerender(<OuterOnly onClose={outerClose} />)

    // Second outside click — outer closes
    fireEvent.pointerDown(document.body)
    expect(outerClose).toHaveBeenCalledOnce()
  })

  it('a pointerdown INSIDE the topmost overlay does NOT fire its onClose', () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()

    render(<StackedDismissable outerClose={outerClose} innerClose={innerClose} />)

    // Click inside the inner modal's content
    fireEvent.pointerDown(screen.getByTestId('inner-btn'))

    expect(innerClose).not.toHaveBeenCalled()
    expect(outerClose).not.toHaveBeenCalled()
  })
})
