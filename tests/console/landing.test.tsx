/**
 * Landing — SOUP splash/landing page coverage (showcase §view-brand reproduction).
 *
 * Real assertions: the hero heading renders with the "fleet." accent, the three
 * value props render with their copy, the CTA navigates to "/", the SOUP nameplate
 * is present (teal tick + spaced-caps mark), and no legacy/raw design tokens leak
 * into the rendered markup.
 *
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const navigateMock = vi.hoisted(() => vi.fn())

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

import Landing from '../../console/src/pages/Landing'

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/welcome']}>
      <Landing />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  navigateMock.mockReset()
})

describe('Landing — hero', () => {
  it('renders the hero heading as the page h1', () => {
    renderLanding()
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('Run your agents like a fleet.')
  })

  it('accents the word "fleet." with the electric-blue accent token', () => {
    renderLanding()
    const accent = screen.getByText('fleet.')
    // The accent word is a <span> carrying the accent ink utility, not the heading itself.
    expect(accent.tagName).toBe('SPAN')
    expect(accent.className).toContain('text-accent')
  })

  it('renders the supporting hero copy describing conversational agents and Lines', () => {
    renderLanding()
    expect(
      screen.getByText(/operations console for conversational agents/i),
    ).toBeInTheDocument()
  })

  it('exposes a single <main> landmark labelled by the hero heading', () => {
    renderLanding()
    const main = screen.getByRole('main')
    expect(main).toBeInTheDocument()
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(main.getAttribute('aria-labelledby')).toBe(h1.id)
  })
})

describe('Landing — value props', () => {
  const titles = ['Spin up a Line', 'Watch it breathe', 'Heal before it hurts']

  it('renders all three value-prop titles as level-2 headings', () => {
    renderLanding()
    for (const title of titles) {
      expect(
        screen.getByRole('heading', { level: 2, name: title }),
      ).toBeInTheDocument()
    }
  })

  it('renders the supporting copy for each value prop', () => {
    renderLanding()
    expect(screen.getByText(/provisions a workspace and a scoped MCP socket/i)).toBeInTheDocument()
    expect(screen.getByText(/Attention is a metric, not a vibe/i)).toBeInTheDocument()
    expect(screen.getByText(/restarts the right unit/i)).toBeInTheDocument()
  })

  it('renders the value props inside the labelled region', () => {
    renderLanding()
    const region = screen.getByRole('region', { name: /what soup does/i })
    expect(within(region).getByRole('heading', { name: 'Spin up a Line' })).toBeInTheDocument()
  })
})

describe('Landing — nameplate', () => {
  it('renders the SOUP nameplate wordmark in spaced-caps mono', () => {
    renderLanding()
    const mark = screen.getByText('SOUP')
    expect(mark.className).toContain('font-mono')
    expect(mark.className).toContain('uppercase')
    // brand.md §1.2 rule 1 — trailing-tracking cancellation keeps the lockup centred.
    expect(mark.className).toContain('[margin-inline-end:-0.38em]')
  })

  it('renders the heritage-teal tick (mode-passive), never the action accent', () => {
    const { container } = renderLanding()
    const tick = container.querySelector('.bg-mode-passive-solid')
    expect(tick).not.toBeNull()
    // The tick must not borrow the action accent.
    expect(tick?.className).not.toContain('bg-accent')
  })
})

describe('Landing — CTA', () => {
  it('navigates to the console root when the primary CTA is clicked', () => {
    renderLanding()
    const cta = screen.getByRole('button', { name: /enter console/i })
    fireEvent.click(cta)
    expect(navigateMock).toHaveBeenCalledTimes(1)
    expect(navigateMock).toHaveBeenCalledWith('/')
  })

  it('keeps the CTA keyboard-focusable as a real button', () => {
    renderLanding()
    const cta = screen.getByRole('button', { name: /enter console/i })
    expect(cta.tagName).toBe('BUTTON')
    cta.focus()
    expect(cta).toHaveFocus()
  })
})

describe('Landing — design-token hygiene', () => {
  it('emits no legacy color/surface aliases or raw px font sizes in the markup', () => {
    const { container } = renderLanding()
    const html = container.innerHTML
    // Legacy alias vocabulary banned by the v3 cutover.
    expect(html).not.toMatch(/--color-/)
    expect(html).not.toMatch(/--b[123]\b/)
    expect(html).not.toMatch(/\bbg-d[0-9]\b/)
    expect(html).not.toMatch(/\btext-t[0-9]\b/)
    // No raw px/rem font-size arbitraries on the type tiers.
    expect(html).not.toMatch(/text-\[[0-9]/)
    // No legacy half-step spacing tokens.
    expect(html).not.toMatch(/--sp-[0-9]h\b/)
  })

  it('binds spacing through --sp-* gap tokens, not ad-hoc pixel gaps', () => {
    const { container } = renderLanding()
    const html = container.innerHTML
    expect(html).toMatch(/gap-\[var\(--sp-/)
    // Sibling rhythm is owned by the parent's gap — no raw pixel gaps.
    expect(html).not.toMatch(/gap-\[[0-9]+px\]/)
  })
})
