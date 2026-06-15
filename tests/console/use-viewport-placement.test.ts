import { describe, expect, it } from 'vitest'
import { resolveViewportPlacement } from '../../console/src/hooks/useViewportPlacement'

const ESTIMATED_CARD_HEIGHT = 160
const ESTIMATED_CARD_WIDTH = 220

function rect(top: number, left: number): Pick<DOMRectReadOnly, 'left' | 'top'> {
  return { top, left }
}

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
})
