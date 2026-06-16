/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  DRAWER_BOTTOM_SHEET_QUERY,
  resolveViewportPlacement,
  useDrawerPlacement,
  useMediaQuery,
} from '../../console/src/hooks/useViewportPlacement'

const ESTIMATED_CARD_HEIGHT = 160
const ESTIMATED_CARD_WIDTH = 220

function rect(top: number, left: number): Pick<DOMRectReadOnly, 'left' | 'top'> {
  return { top, left }
}

// Controllable matchMedia stub: lets a test flip `matches` and fire the
// 'change' listener the hook subscribes to. Mirrors the jsdom stub pattern in
// tests/console/line-detail-tabs.test.tsx.
function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<() => void>()
  const mql = {
    matches: initialMatches,
    media: '',
    onchange: null,
    addEventListener: vi.fn((_event: string, cb: () => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_event: string, cb: () => void) => listeners.delete(cb)),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    set: (next: boolean) => {
      mql.matches = next
      listeners.forEach((cb) => cb())
    },
  }
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn(() => mql),
  })
  return mql
}

afterEach(() => {
  cleanup()
  // Reset matchMedia between tests (some tests install a stub, some remove it).
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: undefined })
  }
  vi.clearAllMocks()
})

describe('resolveViewportPlacement', () => {
  it('keeps the card above and left-aligned when the viewport has room', () => {
    expect(resolveViewportPlacement({
      anchorRect: rect(240, 120),
      estimatedCardHeight: ESTIMATED_CARD_HEIGHT,
      estimatedCardWidth: ESTIMATED_CARD_WIDTH,
      viewportWidth: 800,
    })).toEqual({ placement: 'above', rightAnchored: false })
  })

  it('places the card below when an above card would clip the viewport top', () => {
    expect(resolveViewportPlacement({
      anchorRect: rect(50, 120),
      estimatedCardHeight: ESTIMATED_CARD_HEIGHT,
      estimatedCardWidth: ESTIMATED_CARD_WIDTH,
      viewportWidth: 800,
    })).toEqual({ placement: 'below', rightAnchored: false })
  })

  it('right-anchors the card when its estimated width would clip the viewport right edge', () => {
    expect(resolveViewportPlacement({
      anchorRect: rect(240, 700),
      estimatedCardHeight: ESTIMATED_CARD_HEIGHT,
      estimatedCardWidth: ESTIMATED_CARD_WIDTH,
      viewportWidth: 800,
    })).toEqual({ placement: 'above', rightAnchored: true })
  })

  it('falls back to window.innerWidth when viewportWidth is omitted', () => {
    const original = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 500 })
    try {
      // left(400) + width(220) = 620 > 500 -> right-anchored via the window fallback branch.
      expect(resolveViewportPlacement({
        anchorRect: rect(240, 400),
        estimatedCardHeight: ESTIMATED_CARD_HEIGHT,
        estimatedCardWidth: ESTIMATED_CARD_WIDTH,
      })).toEqual({ placement: 'above', rightAnchored: true })
    } finally {
      Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: original })
    }
  })

})

describe('useMediaQuery', () => {
  it('returns the current match state and reacts to change events', () => {
    const mql = stubMatchMedia(false)
    const { result } = renderHook(() => useMediaQuery('(max-width: 640px)'))
    expect(result.current).toBe(false)
    expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function))

    act(() => mql.set(true))
    expect(result.current).toBe(true)
  })

  it('removes its change listener on unmount', () => {
    const mql = stubMatchMedia(true)
    const { result, unmount } = renderHook(() => useMediaQuery('(max-width: 640px)'))
    expect(result.current).toBe(true)
    unmount()
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('is SSR-safe: returns false when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: undefined })
    const { result } = renderHook(() => useMediaQuery('(max-width: 640px)'))
    expect(result.current).toBe(false)
  })
})

describe('useDrawerPlacement', () => {
  it('resolves to bottom-sheet on narrow viewports', () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useDrawerPlacement())
    expect(result.current).toBe('bottom-sheet')
  })

  it('resolves to right anchor on wide viewports', () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useDrawerPlacement())
    expect(result.current).toBe('right')
  })

  it('uses the sanctioned narrow-surface breakpoint query', () => {
    expect(DRAWER_BOTTOM_SHEET_QUERY).toBe('(max-width: 640px)')
  })
})
