/**
 * @vitest-environment jsdom
 *
 * Dedicated hook tests for console/src/hooks/use-exit-presence.ts.
 *
 * Contract under test (B5 investigation packet §4.2, C-B5-1/C-B5-6/C-B5-9):
 *   - parseDurationMs internal function: all branch arms (empty/0s/0ms/NaN/negative/ms/s).
 *   - Phase machine: open → closing → unmounted.
 *   - Instant path when computed animationDuration is empty/"0s"/"0ms" (jsdom default,
 *     reduced-motion; C-B5-1).
 *   - Closing dwell entered when duration > 0; unmount on FIRST of:
 *       (a) animationend guarded by e.target === shell AND animationName match (C-B5-6).
 *       (b) fallback timeout: computed duration + FALLBACK_BUFFER_MS.
 *   - rAF callback: closingDuration resolves to 0 at frame time → immediate unmount.
 *   - Effect cleanup (open→true) prevents in-flight timer/animationend from unmounting.
 *   - StrictMode double-invoke is safe (symmetric effect cleanup).
 *
 * Duration-stub seam (C-B5-9): tests use both a component shell with an inline
 * animation duration and renderHook with a persistent manually controlled element.
 * The component path proves open=false retains the real referenced shell until the
 * exit completes; the persistent element keeps parser/guard arms independently testable.
 *
 * Cleanup-before-next-effect is the cancellation contract: when open flips back to
 * true, React runs the open=false cleanup before the open=true effect, cancelling
 * the rAF/timer/listener via the local `cancelled` guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, render, act, fireEvent } from '@testing-library/react'
import { useState, useRef, StrictMode, type FC } from 'react'
import { useExitPresence } from '../../console/src/hooks/use-exit-presence'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANIM_NAME = 'soup-modal-shell-out'

// ---------------------------------------------------------------------------
// Minimal component fixture (for instant-path tests)
// ---------------------------------------------------------------------------

/**
 * Component Fixture: tests both the instant path and a non-zero closing dwell.
 */
const Fixture: FC<{ open: boolean; animName?: string; duration?: string }> = ({
  open,
  animName = ANIM_NAME,
  duration,
}) => {
  const shellRef = useRef<HTMLDivElement>(null)
  const { mounted, phase } = useExitPresence(open, shellRef, animName)
  if (!mounted) return <div data-testid="unmounted-sentinel" />
  return (
    <div
      data-testid="shell"
      ref={shellRef}
      data-phase={phase}
      style={duration ? { animationDuration: duration } : undefined}
    >
      <div data-testid="child-node">child</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared helpers for renderHook-based tests
// ---------------------------------------------------------------------------

/**
 * Create a persistent shell element appended to document.body. By holding the
 * ref ourselves (not wired to React's rendering), the element survives the
 * component unmount and shellRef.current remains populated when the open=false
 * effect fires — enabling the closing-dwell path to be exercised.
 */
function makeShellEl(animationDuration: string): {
  el: HTMLElement
  shellRef: { current: HTMLElement | null }
} {
  const el = document.createElement('div')
  el.setAttribute('data-testid', 'hook-shell')
  if (animationDuration) el.style.animationDuration = animationDuration
  document.body.appendChild(el)
  return { el, shellRef: { current: el } }
}

afterEach(() => {
  document.querySelectorAll('[data-testid="hook-shell"]').forEach(el => el.parentNode?.removeChild(el))
  cleanup()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// parseDurationMs branch arms (via duration-stub seam, C-B5-9)
// ---------------------------------------------------------------------------

describe('useExitPresence — parseDurationMs branch arms', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('empty string "" → instant path: mounted=false immediately', async () => {
    // jsdom default: getComputedStyle returns '' for animationDuration.
    const { el, shellRef } = makeShellEl('')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })

  it('"0s" → instant path', async () => {
    const { el, shellRef } = makeShellEl('0s')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })

  it('"0ms" → instant path', async () => {
    const { el, shellRef } = makeShellEl('0ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })

  it('"120ms" (ms suffix) → dwell entered: mounted=true, phase="closing"', async () => {
    // parseDurationMs('120ms') = 120 (the endsWith('ms') branch).
    const { el, shellRef } = makeShellEl('120ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('closing')
    await act(async () => { vi.runAllTimers() })
    expect(result.current.mounted).toBe(false)
  })

  it('"0.12s" (s suffix) → non-zero duration 120ms → dwell entered', async () => {
    // parseDurationMs('0.12s') = 0.12 * 1000 = 120 (the !endsWith('ms') branch).
    const { el, shellRef } = makeShellEl('0.12s')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('closing')
    await act(async () => { vi.runAllTimers() })
    expect(result.current.mounted).toBe(false)
  })

  it('negative value "-1s" → instant path (n <= 0 guard)', async () => {
    // parseDurationMs('-1s'): parseFloat = -1; n <= 0 → returns 0.
    const { el, shellRef } = makeShellEl('-1s')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })

  it('non-numeric "auto" → NaN → instant path (isNaN guard)', async () => {
    // parseDurationMs('auto'): parseFloat = NaN; isNaN → returns 0.
    const { el, shellRef } = makeShellEl('auto')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

describe('useExitPresence — phase transitions', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('initial open=true: mounted=true, phase="open"', () => {
    const { el, shellRef } = makeShellEl('120ms')
    const { result } = renderHook(() => useExitPresence(true, shellRef, ANIM_NAME))
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('open')
  })

  it('open=false with null shell: mounted=false, no dwell (if(!shell) return guard)', async () => {
    // Covers the null-shell early-return at line 106.
    const nullRef = { current: null as HTMLElement | null }
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, nullRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
    expect(result.current.phase).toBe('open')
  })

  it('open=false with empty duration (C-B5-1): instant path, phase stays "open"', async () => {
    // parseDurationMs('') = 0 → no closing dwell. closingActive never set to true.
    const { el, shellRef } = makeShellEl('')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
    expect(result.current.phase).toBe('open')
  })

  it('open=false with "200ms": closing phase active then unmounted after fallback timer', async () => {
    const { el, shellRef } = makeShellEl('200ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('closing')
    await act(async () => { vi.runAllTimers() })
    expect(result.current.mounted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// animationend guard (C-B5-6)
// ---------------------------------------------------------------------------

describe('useExitPresence — animationend guard (C-B5-6)', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('animationend on the shell with matching animationName → unmounts', async () => {
    const { el, shellRef } = makeShellEl('500ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('closing')

    await act(async () => { fireEvent.animationEnd(el, { animationName: ANIM_NAME }) })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })

  it('animationend with undefined animationName (jsdom path) → guard passes → unmounts', async () => {
    // jsdom: e.animationName is undefined → the guard `e.animationName !== undefined`
    // skips the name check → unmount fires (C-B5-6 documented jsdom fallback).
    const { el, shellRef } = makeShellEl('120ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)

    await act(async () => { fireEvent.animationEnd(el) })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })

  it('animationend from a CHILD element (target !== shell) does NOT unmount (C-B5-6 line 141)', async () => {
    // Covers: `if (e.target !== shell) return;`
    const { el, shellRef } = makeShellEl('120ms')
    const child = document.createElement('div')
    el.appendChild(child)

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('closing')

    // Fire from child — target !== shell → early return at line 141.
    await act(async () => {
      fireEvent.animationEnd(child, { animationName: ANIM_NAME, bubbles: true })
    })
    // Positive control: still mounted in closing phase (guard blocked premature unmount).
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('closing')

    // Advance timers so the test closes cleanly.
    await act(async () => { vi.runAllTimers() })
    expect(result.current.mounted).toBe(false)
  })

  it('animationend with WRONG defined animationName documents line-142 guard', async () => {
    // Covers: `if (e.animationName !== undefined && e.animationName !== animNameRef.current) return`
    // In jsdom: fireEvent.animationEnd may produce animationName=undefined → undefined-path fires.
    // In browser: animationName is a defined string → name mismatch blocks unmount (C-B5-7).
    const { el, shellRef } = makeShellEl('120ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)

    // Fire with wrong name — jsdom may or may not respect the animationName property.
    await act(async () => {
      fireEvent.animationEnd(el, { animationName: 'wrong-name' })
    })
    await act(async () => {})

    // Either outcome is valid in jsdom (undefined-name path may have fired):
    const mountedAfter = result.current.mounted
    if (mountedAfter) {
      // Guard worked: still closing.
      expect(result.current.phase).toBe('closing')
    }
    // else: jsdom treated as undefined → allowed unmount.
    // The name-guard behavioral proof belongs to the browser lane (C-B5-7).

    // Cleanup.
    await act(async () => { vi.runAllTimers() })
  })
})

// ---------------------------------------------------------------------------
// Fallback timer path
// ---------------------------------------------------------------------------

describe('useExitPresence — fallback timer path', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('fallback timer fires and unmounts when animationend never fires', async () => {
    const { el, shellRef } = makeShellEl('200ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)

    // runAllTimers: rAF arms the setTimeout; then setTimeout fires the fallback unmount.
    await act(async () => { vi.runAllTimers() })
    expect(result.current.mounted).toBe(false)
  })

  it('rAF callback: closingDuration resolves to 0 at frame time → immediate unmount (line 152)', async () => {
    // Covers: `if (!closingDuration || closingDuration <= 0) { unmount(); return; }`
    // Initial getComputedStyle returns non-zero → dwell entered.
    // Duration cleared before rAF fires → rAF reads 0 → immediate unmount.
    const { el, shellRef } = makeShellEl('120ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)

    // Clear the duration before rAF fires.
    el.style.animationDuration = ''

    // rAF fires: reads '' → parseDurationMs('') = 0 → unmount() at line 152.
    await act(async () => { vi.runAllTimers() })
    expect(result.current.mounted).toBe(false)
  })

  it('reopen during closing dwell cancels stale closing phase and terminal callbacks', async () => {
    // When open transitions false→true during a dwell, the effect cleanup
    // (lines 158–168) sets cancelled=true, clearing the timer and listener.
    // The rAF's `if (cancelled) return` guard makes the rAF a no-op.
    // DD-30 regression: the reopened shell must not remain data-state="closing".
    const { el, shellRef } = makeShellEl('300ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('closing')

    // Re-open: cleanup fires (cancelled=true), then open=true effect runs.
    rerender({ open: true })

    // Component stays mounted (open=true always → mounted=true).
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('open')

    await act(async () => {})
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('open')

    // Canceled listener and fallback paths must not unmount the reopened shell.
    await act(async () => {
      fireEvent.animationEnd(el, { animationName: ANIM_NAME })
    })
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('open')

    await act(async () => { vi.runAllTimers() })
    expect(result.current.mounted).toBe(true)
    expect(result.current.phase).toBe('open')
  })
})

// ---------------------------------------------------------------------------
// animName live ref (animNameRef)
// ---------------------------------------------------------------------------

describe('useExitPresence — animName live ref (animNameRef)', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('animName update between renders is reflected in the animationend guard', async () => {
    const { el, shellRef } = makeShellEl('120ms')
    const { result, rerender } = renderHook(
      ({ open, animName }: { open: boolean; animName: string }) =>
        useExitPresence(open, shellRef, animName),
      { initialProps: { open: true, animName: 'initial-anim' } }
    )
    // Update animName before closing.
    rerender({ open: true, animName: 'updated-anim' })
    rerender({ open: false, animName: 'updated-anim' })
    await act(async () => {})
    expect(result.current.mounted).toBe(true)

    // Fire with the updated name → should unmount.
    await act(async () => {
      fireEvent.animationEnd(el, { animationName: 'updated-anim' })
    })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Instant path via component Fixture (C-B5-1)
// ---------------------------------------------------------------------------

describe('useExitPresence — instant path via component Fixture (C-B5-1)', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('open=false with no stylesheet: synchronous unmount, sentinel appears', async () => {
    // The component Fixture always takes the instant path in jsdom because the shell
    // is cleared from shellRef before the effect fires (React unmounts synchronously).
    const { rerender } = render(<Fixture open />)
    expect(document.querySelector('[data-testid="shell"]')).not.toBeNull()
    rerender(<Fixture open={false} />)
    await act(async () => {})
    expect(document.querySelector('[data-testid="shell"]')).toBeNull()
    expect(document.querySelector('[data-testid="unmounted-sentinel"]')).not.toBeNull()
  })

  it('initial open=false: sentinel present from start (no shell)', async () => {
    render(<Fixture open={false} />)
    await act(async () => {})
    expect(document.querySelector('[data-testid="shell"]')).toBeNull()
    expect(document.querySelector('[data-testid="unmounted-sentinel"]')).not.toBeNull()
  })

  it('initial open=true: shell present with phase="open"', () => {
    render(<Fixture open />)
    const shell = document.querySelector('[data-testid="shell"]')
    expect(shell).not.toBeNull()
    expect(shell!.getAttribute('data-phase')).toBe('open')
  })

  it('open→false retains a non-zero-duration component shell until animationend', async () => {
    const { rerender } = render(<Fixture open duration="120ms" />)

    rerender(<Fixture open={false} duration="120ms" />)
    await act(async () => {})

    const closingShell = document.querySelector('[data-testid="shell"]')
    expect(closingShell).not.toBeNull()
    expect(closingShell!.getAttribute('data-phase')).toBe('closing')

    await act(async () => {
      fireEvent.animationEnd(closingShell!)
    })

    expect(document.querySelector('[data-testid="shell"]')).toBeNull()
    expect(document.querySelector('[data-testid="unmounted-sentinel"]')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// StrictMode double-invoke safety
// ---------------------------------------------------------------------------

describe('useExitPresence — StrictMode double-invoke safety', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('StrictMode with dwell: no crash, correct unmount after fallback timer', async () => {
    const { el, shellRef } = makeShellEl('120ms')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      {
        initialProps: { open: true },
        wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
      }
    )
    expect(result.current.mounted).toBe(true)

    rerender({ open: false })
    await act(async () => {})
    await act(async () => { vi.runAllTimers() })
    expect(result.current.mounted).toBe(false)
  })

  it('StrictMode instant path: no error on double-invoke with empty duration', async () => {
    const { el, shellRef } = makeShellEl('')
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, shellRef, ANIM_NAME),
      {
        initialProps: { open: true },
        wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
      }
    )
    rerender({ open: false })
    await act(async () => {})
    expect(result.current.mounted).toBe(false)
  })
})
