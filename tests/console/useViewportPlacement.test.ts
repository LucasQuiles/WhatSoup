/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  useMediaQuery,
  useDrawerPlacement,
  resolveViewportPlacement,
  DRAWER_BOTTOM_SHEET_QUERY,
} from '../../console/src/hooks/useViewportPlacement'

describe('useViewportPlacement', () => {
  describe('resolveViewportPlacement (pure function)', () => {
    it('places below when anchor top minus card height is negative', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 100, top: 20 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      // 20 - 100 = -80 < 0, so placement is 'below'
      expect(result.placement).toBe('below')
    })

    it('places above when anchor top minus card height is non-negative', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 100, top: 500 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      // 500 - 100 = 400 >= 0, so placement is 'above'
      expect(result.placement).toBe('above')
    })

    it('does not anchor right when card fits', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 100, top: 500 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      // 100 + 200 = 300 <= 1024, so rightAnchored is false
      expect(result.rightAnchored).toBe(false)
    })

    it('anchors right when card would overflow viewport', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 900, top: 500 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      // 900 + 200 = 1100 > 1024, so rightAnchored is true
      expect(result.rightAnchored).toBe(true)
    })

    it('uses provided viewportWidth when available', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 500, top: 500 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 640,
      })

      // 500 + 200 = 700 > 640, so rightAnchored is true
      expect(result.rightAnchored).toBe(true)
    })

    it('threshold calculation: placement at boundary where top equals cardHeight', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 100, top: 100 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      // 100 - 100 = 0, which is NOT < 0, so placement is 'above'
      expect(result.placement).toBe('above')
    })

    it('threshold calculation: placement below at one pixel less than cardHeight', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 100, top: 99 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      // 99 - 100 = -1 < 0, so placement is 'below'
      expect(result.placement).toBe('below')
    })

    it('right anchor boundary: exact fit at viewport edge', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 800, top: 500 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      // 800 + 200 = 1000, which is NOT > 1024, so rightAnchored is false
      expect(result.rightAnchored).toBe(false)
    })

    it('right anchor boundary: one pixel overflow', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 825, top: 500 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      // 825 + 200 = 1025 > 1024, so rightAnchored is true
      expect(result.rightAnchored).toBe(true)
    })

    it('handles zero values', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 0, top: 0 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      expect(result.placement).toBe('below')
      expect(result.rightAnchored).toBe(false)
    })

    it('handles large values', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 10000, top: 10000 },
        estimatedCardHeight: 100,
        estimatedCardWidth: 200,
        viewportWidth: 1024,
      })

      expect(result.placement).toBe('above')
      expect(result.rightAnchored).toBe(true)
    })

    it('returns correct structure with both properties', () => {
      const result = resolveViewportPlacement({
        anchorRect: { left: 100, top: 100 },
        estimatedCardHeight: 50,
        estimatedCardWidth: 100,
        viewportWidth: 500,
      })

      expect(result).toHaveProperty('placement')
      expect(result).toHaveProperty('rightAnchored')
      expect(typeof result.placement).toBe('string')
      expect(typeof result.rightAnchored).toBe('boolean')
    })
  })

  // Hook tests that use renderHook require jsdom
  describe.skipIf(!globalThis.window)('useMediaQuery and useDrawerPlacement (require jsdom)', () => {
    it('useMediaQuery returns initial match state', () => {
      const mockMatchMedia = vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
      vi.stubGlobal('matchMedia', mockMatchMedia)

      const { result } = renderHook(() => useMediaQuery('(max-width: 640px)'))
      expect(result.current).toBe(true)

      vi.unstubAllGlobals()
    })

    it('useDrawerPlacement returns bottom-sheet for narrow viewports', () => {
      const mockMatchMedia = vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
      vi.stubGlobal('matchMedia', mockMatchMedia)

      const { result } = renderHook(() => useDrawerPlacement())
      expect(result.current).toBe('bottom-sheet')

      vi.unstubAllGlobals()
    })

    it('useDrawerPlacement returns right for wide viewports', () => {
      const mockMatchMedia = vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
      vi.stubGlobal('matchMedia', mockMatchMedia)

      const { result } = renderHook(() => useDrawerPlacement())
      expect(result.current).toBe('right')

      vi.unstubAllGlobals()
    })

    it('useDrawerPlacement uses the correct query', () => {
      const mockMatchMedia = vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
      vi.stubGlobal('matchMedia', mockMatchMedia)

      renderHook(() => useDrawerPlacement())

      expect(mockMatchMedia).toHaveBeenCalledWith(DRAWER_BOTTOM_SHEET_QUERY)

      vi.unstubAllGlobals()
    })

    it('useMediaQuery listens for media query changes', () => {
      const addEventListenerSpy = vi.fn()
      const removeEventListenerSpy = vi.fn()

      const mockMatchMedia = vi.fn().mockReturnValue({
        matches: false,
        addEventListener: addEventListenerSpy,
        removeEventListener: removeEventListenerSpy,
      })
      vi.stubGlobal('matchMedia', mockMatchMedia)

      const { unmount } = renderHook(() => useMediaQuery('(max-width: 640px)'))

      expect(addEventListenerSpy).toHaveBeenCalledWith('change', expect.any(Function))

      unmount()

      expect(removeEventListenerSpy).toHaveBeenCalledWith('change', expect.any(Function))

      vi.unstubAllGlobals()
    })
  })
})
