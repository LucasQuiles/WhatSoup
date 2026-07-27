/**
 * Skeleton + TableSkeleton - loading-placeholder behavior coverage.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import Skeleton, { TableSkeleton } from '../../console/src/components/Skeleton'

afterEach(() => cleanup())

function skeletonPlaceholders(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.skeleton-bar'))
}

function expectAccessibilityNeutral(container: HTMLElement) {
  expect(container.textContent).toBe('')
  expect(container.querySelector('[role], [aria-label], [aria-labelledby]')).toBeNull()
}

describe('Skeleton', () => {
  it('renders an accessibility-neutral shimmer placeholder', () => {
    const { container } = render(<Skeleton />)
    const root = container.firstElementChild as HTMLElement

    expect(skeletonPlaceholders(container)).toContain(root)
    expectAccessibilityNeutral(container)
  })

  it('allows callers to size a single placeholder without dropping shimmer', () => {
    const { container } = render(
      <Skeleton className="w-24" style={{ width: '180px', height: '12px' }} />,
    )
    const root = container.firstElementChild as HTMLElement

    expect(root.classList.contains('skeleton-bar')).toBe(true)
    expect(root.classList.contains('w-24')).toBe(true)
    expect(root.style.width).toBe('180px')
    expect(root.style.height).toBe('12px')
  })
})

describe('TableSkeleton', () => {
  it('presents repeated shimmer rows without adding accessible content', () => {
    const { container } = render(<TableSkeleton />)
    const outer = container.firstElementChild as HTMLElement
    const rows = Array.from(outer.children) as HTMLElement[]

    expect(rows.length).toBeGreaterThanOrEqual(3)
    expectAccessibilityNeutral(container)
    expect(skeletonPlaceholders(outer).length).toBeGreaterThan(rows.length)
    for (const row of rows) {
      expect(skeletonPlaceholders(row).length).toBeGreaterThanOrEqual(3)
    }
  })

  it('varies placeholder line lengths so the table state scans as loading data', () => {
    const { container } = render(<TableSkeleton />)
    // Line placeholders carry token-based widths (calc(var(--config-key-col) …),
    // migrated off raw px). Collect inline widths regardless of unit and assert
    // they vary, so the table reads as loading rows of differing length.
    const lineWidths = skeletonPlaceholders(container)
      .map(placeholder => placeholder.style.width)
      .filter(Boolean)

    expect(lineWidths.length).toBeGreaterThan(0)
    expect(new Set(lineWidths).size).toBeGreaterThan(1)
  })
})
