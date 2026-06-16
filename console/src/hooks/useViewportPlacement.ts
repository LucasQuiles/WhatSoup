import { useEffect, useState } from 'react'

export type ViewportPlacement = 'above' | 'below'

/**
 * Sanctioned narrow-surface breakpoint. Below this width the Drawer switches
 * from its right-anchored placement to the modal bottom-sheet so the inspector
 * actions dock on-screen instead of sitting off the right edge. This is the
 * placement owner for that decision — viewport branching lives here, not in
 * feature code (soup/no-raw-viewport-js).
 */
export const DRAWER_BOTTOM_SHEET_QUERY = '(max-width: 640px)'

export type DrawerSurfacePlacement = 'right' | 'bottom-sheet'

/**
 * Subscribe to a media query and report its match state.
 * SSR-safe: returns `false` when `window`/`matchMedia` is unavailable.
 */
export function useMediaQuery(query: string): boolean {
  const getMatch = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false

  const [matches, setMatches] = useState<boolean>(getMatch)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/**
 * Resolve the Drawer surface placement for the current viewport width.
 * Returns 'bottom-sheet' on narrow/phone widths, 'right' otherwise.
 */
export function useDrawerPlacement(): DrawerSurfacePlacement {
  const isNarrow = useMediaQuery(DRAWER_BOTTOM_SHEET_QUERY)
  return isNarrow ? 'bottom-sheet' : 'right'
}

export interface ResolveViewportPlacementOptions {
  anchorRect: Pick<DOMRectReadOnly, 'left' | 'top'>
  estimatedCardHeight: number
  estimatedCardWidth: number
  viewportWidth?: number
}

export interface ViewportPlacementResult {
  placement: ViewportPlacement
  rightAnchored: boolean
}

export function resolveViewportPlacement({
  anchorRect,
  estimatedCardHeight,
  estimatedCardWidth,
  viewportWidth,
}: ResolveViewportPlacementOptions): ViewportPlacementResult {
  const measuredViewportWidth =
    viewportWidth ?? (typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth)

  return {
    placement: anchorRect.top - estimatedCardHeight < 0 ? 'below' : 'above',
    rightAnchored: anchorRect.left + estimatedCardWidth > measuredViewportWidth,
  }
}
