/**
 * Behavioral contract-lock for KpiCard.
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import KpiCard from '../../console/src/components/KpiCard'
import { KPI_COLOR_TOKENS } from '../../console/src/lib/color-semantics'

afterEach(() => cleanup())

type KpiCardProps = {
  value: string | number
  label: string
  color: string
  onClick?: () => void
  active?: boolean
  sparkData?: number[]
  suffix?: string
}

function renderCard(props: Partial<KpiCardProps> = {}) {
  const merged: KpiCardProps = {
    value: 1,
    label: 'Requests',
    color: 'text-s-ok',
    ...props,
  }

  render(<KpiCard {...merged} />)

  return screen.getByRole('button', {
    name: new RegExp(String.raw`${merged.value}${merged.suffix ? String.raw`\s*${merged.suffix}` : ''}\s*${merged.label}`, 'i'),
  })
}

describe('KpiCard root behavior', () => {
  it('renders as a named button with inactive pressed state by default', () => {
    const card = renderCard({ value: 42, label: 'Lines Connected' })

    expect(card.tagName).toBe('BUTTON')
    expect(card.getAttribute('type')).toBe('button')
    expect(card.getAttribute('aria-pressed')).toBe('false')
    expect(within(card).getByText('42')).toBeDefined()
    expect(within(card).getByText('Lines Connected')).toBeDefined()
  })

  it('reflects active state through aria-pressed and visible DOM styling', () => {
    const card = renderCard({ active: true })

    expect(card.getAttribute('aria-pressed')).toBe('true')
    expect(card.style.background).toBe('var(--surface-raised)')
    expect(card.style.border).toBe(`var(--bw) solid ${KPI_COLOR_TOKENS['text-s-ok']}`)
    expect(card.style.boxShadow).toBe('var(--shadow-inset)')
  })

  it('keeps inactive state visually neutral', () => {
    const card = renderCard({ active: false })

    expect(card.getAttribute('aria-pressed')).toBe('false')
    expect(card.style.background).toBe('var(--surface-raised)')
    expect(card.style.border).toBe('var(--bw) solid var(--border-hairline)')
    expect(card.style.boxShadow).toBe('none')
  })

  it('calls the supplied click handler from the rendered button', () => {
    const onClick = vi.fn()
    const card = renderCard({ onClick })

    fireEvent.click(card)

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('uses the canonical root class tokens on the button', () => {
    const card = renderCard()

    expect(card.classList.contains('cursor-pointer')).toBe(true)
    expect(card.classList.contains('select-none')).toBe(true)
    expect(card.classList.contains('relative')).toBe(true)
    expect(card.classList.contains('overflow-hidden')).toBe(true)
    expect(card.classList.contains('c-kpi-pad')).toBe(true)
    expect(card.classList.contains('c-kpi-hover')).toBe(true)
    expect(card.classList.contains('rounded-md')).toBe(true)
  })
})

describe('KpiCard value, label, and suffix', () => {
  it('renders a numeric value and label in their observable containers', () => {
    const card = renderCard({ value: 42, label: 'OPS', color: 'text-s-ok' })
    const value = within(card).getByText('42')
    const label = within(card).getByText('OPS')

    expect(value.classList.contains('c-kpi-value')).toBe(true)
    expect(value.classList.contains('text-s-ok')).toBe(true)
    expect(label.classList.contains('c-label')).toBe(true)
    expect(label.classList.contains('uppercase')).toBe(true)
  })

  it('preserves string values verbatim', () => {
    const card = renderCard({ value: 'N/A', label: 'OPS' })

    expect(within(card).getByText('N/A')).toBeDefined()
  })

  it('omits the suffix when one is not supplied', () => {
    const card = renderCard({ value: 42, label: 'Latency' })

    expect(within(card).queryByText('ms')).toBeNull()
  })

  it('renders the suffix as visible adjacent text with suffix styling', () => {
    const card = renderCard({ value: 42, label: 'Latency', suffix: 'ms' })
    const suffix = within(card).getByText('ms')

    expect(suffix.tagName).toBe('SPAN')
    expect(suffix.classList.contains('text-data')).toBe(true)
    expect(suffix.classList.contains('font-normal')).toBe(true)
  })
})

describe('KpiCard sparkline DOM', () => {
  it('does not render a sparkline without at least two samples', () => {
    const withoutData = renderCard({ label: 'No Data' })
    expect(withoutData.querySelector('svg')).toBeNull()

    cleanup()
    const emptyData = renderCard({ label: 'Empty Data', sparkData: [] })
    expect(emptyData.querySelector('svg')).toBeNull()

    cleanup()
    const singleSample = renderCard({ label: 'Single Sample', sparkData: [0.5] })
    expect(singleSample.querySelector('svg')).toBeNull()
  })

  it('renders a sparkline SVG for two or more samples', () => {
    const card = renderCard({ sparkData: [0.2, 0.8] })

    expect(card.querySelector('svg')).toBeDefined()
  })

  it('exposes the plotted sparkline shape through rendered SVG attributes', () => {
    const card = renderCard({ sparkData: [0, 0.25, 1] })
    const svg = card.querySelector('svg')
    const polygon = card.querySelector('polygon')
    const polyline = card.querySelector('polyline')

    expect(svg?.getAttribute('viewBox')).toBe('0 0 2 1')
    expect(polygon?.getAttribute('points')).toBe('0,1 0,1 1,0.75 2,0 2,1')
    expect(polyline?.getAttribute('points')).toBe('0,1 1,0.75 2,0')
    expect(polyline?.getAttribute('fill')).toBe('none')
  })

  it('wires the rendered polygon fill to the rendered gradient id', () => {
    const card = renderCard({ sparkData: [0.4, 0.6] })
    const gradient = card.querySelector('linearGradient')
    const polygon = card.querySelector('polygon')

    const gradientId = gradient?.getAttribute('id')
    expect(gradientId).toBeTruthy()
    expect(polygon?.getAttribute('fill')).toBe(`url(#${gradientId})`)
  })
})

describe('KpiCard color variants', () => {
  const expectedMap = Object.entries(KPI_COLOR_TOKENS)

  for (const [token, cssVar] of expectedMap) {
    it(`renders ${token} as the active border and sparkline stroke`, () => {
      const card = renderCard({
        color: token,
        active: true,
        sparkData: [0.1, 0.9],
      })
      const polyline = card.querySelector('polyline')
      const stops = card.querySelectorAll('stop')

      expect(card.style.border).toBe(`var(--bw) solid ${cssVar}`)
      expect(polyline?.getAttribute('stroke')).toBe(cssVar)
      expect(stops).toHaveLength(2)
      expect(stops[0]?.getAttribute('stop-color')).toBe(cssVar)
      expect(stops[1]?.getAttribute('stop-color')).toBe(cssVar)
    })
  }

  it('falls back to currentColor for unknown active and sparkline colors', () => {
    const card = renderCard({
      color: 'text-unknown-xyz',
      active: true,
      sparkData: [0.1, 0.9],
    })

    expect(card.style.border).toBe('var(--bw) solid currentColor')
    expect(card.querySelector('polyline')?.getAttribute('stroke')).toBe('currentColor')
  })
})
