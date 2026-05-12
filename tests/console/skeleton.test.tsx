/**
 * Skeleton + TableSkeleton — pure-render coverage.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import Skeleton, { TableSkeleton } from '../../console/src/components/Skeleton'

afterEach(() => cleanup())

describe('Skeleton', () => {
  it('renders a single div with the shimmer animation class by default', () => {
    const { container } = render(<Skeleton />)
    const divs = container.querySelectorAll('div')
    expect(divs.length).toBe(1)
    const root = divs[0] as HTMLDivElement
    expect(root.className).toContain('animate-shimmer')
  })

  it('appends caller className while preserving animate-shimmer', () => {
    const { container } = render(<Skeleton className="w-10 h-4 rounded" />)
    const root = container.querySelector('div') as HTMLDivElement
    expect(root.className).toContain('animate-shimmer')
    expect(root.className).toContain('w-10')
    expect(root.className).toContain('h-4')
    expect(root.className).toContain('rounded')
  })

  it('forwards inline style for width/height customization', () => {
    const { container } = render(<Skeleton style={{ width: '180px', height: '12px' }} />)
    const root = container.querySelector('div') as HTMLDivElement
    expect(root.style.width).toBe('180px')
    expect(root.style.height).toBe('12px')
  })

  it('handles missing optional props without crashing or extra whitespace classes', () => {
    const { container } = render(<Skeleton />)
    const root = container.querySelector('div') as HTMLDivElement
    // className defaults to '' so classList ends up just ['animate-shimmer'].
    expect(Array.from(root.classList)).toEqual(['animate-shimmer'])
    // No style attribute means cssText is empty.
    expect(root.style.cssText).toBe('')
  })
})

describe('TableSkeleton', () => {
  it('renders a vertical container with 5 row wrappers (one per loop iteration)', () => {
    const { container } = render(<TableSkeleton />)
    const outer = container.firstElementChild as HTMLElement
    expect(outer.className).toContain('flex-col')
    expect(outer.className).toContain('gap-3')
    // Each row is a direct flex child of the outer container.
    const rows = outer.querySelectorAll(':scope > div')
    expect(rows.length).toBe(5)
    for (const row of Array.from(rows)) {
      expect((row as HTMLElement).className).toContain('flex')
      expect((row as HTMLElement).className).toContain('items-center')
    }
  })

  it('composes each row from Skeleton instances (4 shimmer cells + 1 spacer)', () => {
    const { container } = render(<TableSkeleton />)
    const rows = (container.firstElementChild as HTMLElement).querySelectorAll(':scope > div')
    for (const row of Array.from(rows)) {
      const children = (row as HTMLElement).querySelectorAll(':scope > div')
      // 4 Skeletons + 1 flex-1 spacer.
      expect(children.length).toBe(5)
      const shimmerCells = Array.from(children).filter(c =>
        (c as HTMLElement).className.includes('animate-shimmer'),
      )
      expect(shimmerCells.length).toBe(4)
      const spacer = Array.from(children).find(c =>
        (c as HTMLElement).className.includes('flex-1'),
      )
      expect(spacer).toBeTruthy()
    }
  })

  it('varies the second-cell width per row index (140, 160, 180, 200, 220 px)', () => {
    const { container } = render(<TableSkeleton />)
    const rows = (container.firstElementChild as HTMLElement).querySelectorAll(':scope > div')
    const widths: string[] = []
    rows.forEach(row => {
      const cells = (row as HTMLElement).querySelectorAll(':scope > div')
      // Second skeleton in the row carries the inline width.
      const second = cells[1] as HTMLElement
      widths.push(second.style.width)
    })
    expect(widths).toEqual(['140px', '160px', '180px', '200px', '220px'])
  })

  it('applies size classes to fixed cells (dot, badge, trailing)', () => {
    const { container } = render(<TableSkeleton />)
    const firstRow = (container.firstElementChild as HTMLElement)
      .querySelector(':scope > div') as HTMLElement
    const cells = firstRow.querySelectorAll(':scope > div')
    const dot = cells[0] as HTMLElement
    const badge = cells[2] as HTMLElement
    const trailing = cells[4] as HTMLElement
    expect(dot.className).toContain('rounded-full')
    expect(dot.className).toContain('w-2')
    expect(badge.className).toContain('rounded')
    expect(badge.className).toContain('w-15')
    expect(trailing.className).toContain('w-10')
  })
})
