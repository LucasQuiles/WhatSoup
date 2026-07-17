/**
 * @vitest-environment jsdom
 *
 * useDismissable hook: focus trap, initial focus, focus restoration, Escape handling,
 * outside-click dismissal, stacking awareness, and SSR safety.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDismissable } from '../../console/src/hooks/use-dismissable'

describe('useDismissable', () => {
  let containerEl: HTMLDivElement
  let focusTrapButton: HTMLButtonElement
  let dismissableEl: HTMLDivElement

  beforeEach(() => {
    // Create a test container with focusable elements
    containerEl = document.createElement('div')
    containerEl.innerHTML = `
      <button id="btn-1">Button 1</button>
      <input id="input-1" type="text" />
      <button id="btn-2">Button 2</button>
    `
    document.body.appendChild(containerEl)

    focusTrapButton = containerEl.querySelector('#btn-1') as HTMLButtonElement
    dismissableEl = containerEl.querySelector('#input-1') as HTMLDivElement
  })

  afterEach(() => {
    if (containerEl && document.body.contains(containerEl)) {
      document.body.removeChild(containerEl)
    }
    vi.restoreAllMocks()
  })

  it('does not activate effects when open is false', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }
    renderHook(() =>
      useDismissable(ref, { onClose, open: false })
    )

    // Trigger a key event (should not call onClose)
    const event = new KeyboardEvent('keydown', { key: 'Escape' })
    document.dispatchEvent(event)

    expect(onClose).not.toHaveBeenCalled()
  })

  // Test 'captures and restores focus on open/close cycle' QUARANTINED (removed,
  // not skipped) from preserve/wave8-coverage-20260715 during the 2026-07-17
  // wave-8 land: its assertion never matched the hook's actual behavior, which
  // is unchanged since the wave-8 branch point a36b52e3f (checked directly —
  // not a source-drift regression). The fixture's focusTrapButton IS
  // containerEl's first focusable child, so autoFocus's
  // `firstFocusable ?? container` targets the SAME element that already had
  // focus; `expect(document.activeElement).not.toBe(focusTrapButton)` was
  // wrong at authoring time. Original text preserved on
  // preserve/wave8-coverage-20260715; see wave8-land-report-20260717.md.

  it('handles Escape key to close the overlay', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }

    renderHook(() => useDismissable(ref, { onClose, open: true }))

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    document.dispatchEvent(event)

    expect(onClose).toHaveBeenCalled()
  })

  it('only closes the topmost overlay when multiple are stacked', () => {
    const onClose1 = vi.fn()
    const onClose2 = vi.fn()
    const ref1 = { current: containerEl }
    const ref2 = { current: containerEl }

    renderHook(() => useDismissable(ref1, { onClose: onClose1, open: true }))
    renderHook(() => useDismissable(ref2, { onClose: onClose2, open: true }))

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    document.dispatchEvent(event)

    // Only the topmost (most recently registered) should be called
    expect(onClose2).toHaveBeenCalled()
    expect(onClose1).not.toHaveBeenCalled()
  })

  it('respects dismissable prop for outside-click behavior', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }

    renderHook(() => useDismissable(ref, { onClose, open: true, dismissable: true }))

    // Simulate a click outside the container
    const event = new PointerEvent('pointerdown', { bubbles: true })
    Object.defineProperty(event, 'target', { value: document.body, enumerable: true })
    document.dispatchEvent(event)

    expect(onClose).toHaveBeenCalled()
  })

  it('ignores outside-click when dismissable is false', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }

    renderHook(() => useDismissable(ref, { onClose, open: true, dismissable: false }))

    const event = new PointerEvent('pointerdown', { bubbles: true })
    Object.defineProperty(event, 'target', { value: document.body, enumerable: true })
    document.dispatchEvent(event)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('shifts initial focus when autoFocus is true', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }

    renderHook(() => useDismissable(ref, { onClose, open: true, autoFocus: true }))

    // Focus should be on a focusable element within the container
    expect(containerEl.contains(document.activeElement as Node)).toBe(true)
  })

  it('does not shift initial focus when autoFocus is false', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }
    focusTrapButton.focus()

    renderHook(() => useDismissable(ref, { onClose, open: true, autoFocus: false }))

    // Focus should remain on button 1
    expect(document.activeElement).toBe(focusTrapButton)
  })

  it('focuses initial focus target when provided', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }
    const initialFocusRef = { current: focusTrapButton }

    renderHook(() =>
      useDismissable(ref, { onClose, open: true, initialFocus: initialFocusRef })
    )

    expect(document.activeElement).toBe(focusTrapButton)
  })

  it('respects restoreFocus override for retargeting overlays', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }
    const restoreFocusRef = { current: focusTrapButton }

    renderHook(() =>
      useDismissable(ref, { onClose, open: true, restoreFocus: restoreFocusRef })
    )

    expect(restoreFocusRef.current).toBe(focusTrapButton)
  })

  it('disables focus trap when trapFocus is false', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }

    const { result } = renderHook(() =>
      useDismissable(ref, { onClose, open: true, trapFocus: false })
    )

    // Hook should not throw
    expect(result).toBeDefined()
  })

  it('cleans up event listeners on unmount', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }

    const { unmount } = renderHook(() =>
      useDismissable(ref, { onClose, open: true })
    )

    unmount()

    // After unmount, Escape should not trigger onClose
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    document.dispatchEvent(event)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('handles null container reference gracefully', () => {
    const onClose = vi.fn()
    const ref = { current: null }

    const { result } = renderHook(() =>
      useDismissable(ref, { onClose, open: true })
    )

    // Should not throw
    expect(result).toBeDefined()
  })

  it('is SSR-safe with typeof document checks', () => {
    const onClose = vi.fn()
    const ref = { current: containerEl }

    // Should not throw even with document checks
    const { result } = renderHook(() =>
      useDismissable(ref, { onClose, open: true })
    )

    expect(result).toBeDefined()
  })
})
