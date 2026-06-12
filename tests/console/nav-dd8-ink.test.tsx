/**
 * Nav — DD-8 Option B ink-tier evidence for the "Polling" badge.
 * @vitest-environment jsdom
 *
 * Asserts that the "Polling" connection-status badge carries text-t2 (AA ink)
 * after the DD-8 essential-text correction.
 *
 * Decision-package classification (package §2.1):
 *   "Nav 'Polling' badge — ESSENTIAL — a degraded-transport status rendered at
 *    ghost (its healthy sibling 'Live' gets text-s-ok). Redundancy is icon +
 *    title attr only."
 *   Option B: text-t5 → text-t2 (7.60:1 dark / 6.03:1 light on every bed).
 *
 * Positive-control pattern for negatives: text-t5 absence assertions are
 * each paired with a text-t2 presence assertion on the same element so a
 * broken selector cannot produce a vacuous pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { createElement } from 'react'

let wsConnected = false

vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: wsConnected }),
}))

import Nav from '../../console/src/components/Nav'

function renderNav(props: Record<string, unknown> = {}) {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: ['/'] },
      createElement(Nav, { onUpdateClick: vi.fn(), ...props } as Record<string, unknown>),
    ),
  )
}

beforeEach(() => {
  wsConnected = false
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// DD-8 — "Polling" badge ink tier (package §2.1 Nav "Polling" badge)
// Classification: ESSENTIAL — sole rendering of degraded-transport status.
// Option B: container span text-t5 → text-t2.
// ---------------------------------------------------------------------------

describe('Nav DD-8 — Polling badge carries text-t2 not text-t5 (Option B)', () => {
  it('Polling span has text-t2 class (AA ink — package §2.1)', () => {
    wsConnected = false
    const { container } = renderNav()

    // The "Polling" text is inside the badge span.
    expect(screen.getByText('Polling')).toBeDefined()

    // Walk up to the parent span that carries the ink class.
    const pollingText = screen.getByText('Polling')
    const badgeSpan = pollingText.closest('span[class*="flex items-center"]') as HTMLElement
    // Positive control: the badge span must exist.
    expect(badgeSpan).not.toBeNull()
    // AA ink assertion: text-t2 must be present on the badge.
    expect(badgeSpan.className).toContain('text-t2')
  })

  it('Polling span does NOT carry text-t5 (ghost tier absent — DD-8 §2.1)', () => {
    wsConnected = false
    renderNav()

    const pollingText = screen.getByText('Polling')
    const badgeSpan = pollingText.closest('span[class*="flex items-center"]') as HTMLElement
    // Positive control proved this element exists above.
    // Ghost-tier absence: regression to text-t5 is caught here.
    expect(badgeSpan.className).not.toContain('text-t5')
  })

  it('Live badge retains text-s-ok (Polling promotion must not affect Live state)', () => {
    // Positive control: the Live healthy sibling must keep its status color.
    // This ensures the ink change is scoped to the Polling branch only.
    wsConnected = true
    renderNav()

    expect(screen.getByText('Live')).toBeDefined()
    const liveText = screen.getByText('Live')
    const liveBadge = liveText.closest('span[class*="flex items-center"]') as HTMLElement
    expect(liveBadge).not.toBeNull()
    expect(liveBadge.className).toContain('text-s-ok')
    expect(liveBadge.className).not.toContain('text-t5')
    expect(liveBadge.className).not.toContain('text-t2')
  })

  it('Polling badge does not render when connected (positive-control for Polling scope)', () => {
    // When wsConnected=true the Polling badge is absent — proves the text-t2
    // assertion above is exercising the real Polling code path, not a stale element.
    wsConnected = true
    renderNav()
    expect(screen.queryByText('Polling')).toBeNull()
  })
})
