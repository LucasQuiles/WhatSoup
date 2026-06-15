export type ViewportPlacement = 'above' | 'below'

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
