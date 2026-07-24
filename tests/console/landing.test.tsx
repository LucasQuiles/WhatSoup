/**
 * Landing (welcome splash) — v3.5 first-run surface contracts (T5 b-10;
 * mockup splash.html SSOT).
 *
 * DISPOSITION RECORD (this file previously pinned the v3 landing):
 *   SURVIVED (re-pinned against the v3.5 anatomy): hero as sole page h1 with
 *   the accent on "fleet."; supporting hero copy present; main landmark
 *   labelled by the hero; three proof cards with HEADINGS at the correct
 *   hierarchy level (h2 — the v3.5 component was corrected from h3 to keep
 *   the no-skipped-levels law this suite exists to enforce); nameplate with
 *   the accent U and the passive-mode tick; CTA as a real focusable button
 *   with real navigation; design-token hygiene (no legacy aliases, no raw
 *   inline styles).
 *   CHANGED per the mockup SSOT: copy deck is the v3.5 text (not the v3
 *   "operations console" prose); the CTA pair is Hatch→/hatch + Fleet→/;
 *   spacing binds through --journey-* tokens (the v3 --sp-* page classes are
 *   gone with the old page).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const navigateMock = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateMock }
})

vi.mock('../../console/src/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn(), setTheme: vi.fn() }),
}))

import Landing from '../../console/src/pages/Landing'

function renderLanding() {
  return render(
    <MemoryRouter>
      <Landing />
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('Landing — hero', () => {
  it('renders the hero heading as the page h1', () => {
    const { container } = renderLanding()
    const h1s = container.querySelectorAll('h1')
    expect(h1s.length).toBe(1)
    expect(h1s[0]!.textContent).toContain('Run your agents')
    expect(h1s[0]!.textContent).toContain('fleet.')
  })

  it('accents the word "fleet." with the accent span', () => {
    const { container } = renderLanding()
    const accent = container.querySelector('h1 .journey-accent')
    expect(accent).not.toBeNull()
    expect(accent!.textContent).toBe('fleet.')
  })

  it('renders the supporting hero copy (the v3.5 deck)', () => {
    const { container } = renderLanding()
    const sub = container.querySelector('.journey-splash-sub')
    expect(sub).not.toBeNull()
    expect(sub!.textContent).toContain('One calm console for every channel')
  })

  it('exposes a single <main> landmark labelled by the hero heading', () => {
    const { container } = renderLanding()
    const mains = container.querySelectorAll('main')
    expect(mains.length).toBe(1)
    const labelledBy = mains[0]!.getAttribute('aria-labelledby')
    expect(labelledBy).toBe('splash-h1')
    expect(container.querySelector(`#${labelledBy}`)!.tagName).toBe('H1')
  })
})

describe('Landing — proof triptych', () => {
  it('renders three cards in mockup order with h2 headings (hierarchy law)', () => {
    const { container } = renderLanding()
    const props = [...container.querySelectorAll('.journey-prop')]
    expect(props.length).toBe(3)
    expect(props[0]!.textContent).toContain('01 — Hatch')
    expect(props[1]!.textContent).toContain('02 — Command')
    expect(props[2]!.textContent).toContain('03 — Trust')
    for (const prop of props) {
      // the heading hierarchy is the point — h2 under the sole h1, never a skip
      expect(prop.querySelector('h2')).not.toBeNull()
    }
  })

  it('renders the supporting copy for each proof card', () => {
    const { container } = renderLanding()
    expect(container.textContent).toContain('Pick a kind, link a channel')
    expect(container.textContent).toContain('Real-time fleet across all your channels')
    expect(container.textContent).toContain('Grants decide what agents can see and do')
  })
})

describe('Landing — nameplate', () => {
  it('renders the SOUP wordmark with the accent U', () => {
    const { container } = renderLanding()
    const wm = container.querySelector('.journey-hero__plate .journey-wm')
    expect(wm).not.toBeNull()
    expect(wm!.textContent).toBe('SOUP')
    expect(wm!.querySelector('b')!.textContent).toBe('U')
  })

  it('renders the passive-mode tick (never the action accent)', () => {
    const { container } = renderLanding()
    const tick = container.querySelector('.journey-hero__tick')
    expect(tick).not.toBeNull()
    // the tick consumes --mode-passive-solid (heritage teal) — class-contract;
    // the computed color proof is the browser suite's domain
  })
})

describe('Landing — CTAs', () => {
  it('navigates: hatch CTA → /hatch, fleet CTA → /', () => {
    const { container } = renderLanding()
    fireEvent.click(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Hatch your first agent'))!,
    )
    expect(navigateMock).toHaveBeenCalledWith('/hatch')
    fireEvent.click(
      [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open the Fleet'))!,
    )
    expect(navigateMock).toHaveBeenCalledWith('/')
  })

  it('keeps both CTAs real focusable buttons', () => {
    const { container } = renderLanding()
    const ctas = [...container.querySelectorAll('.journey-cta button')]
    expect(ctas.length).toBe(2)
    for (const cta of ctas) {
      expect(cta.tagName).toBe('BUTTON')
      expect((cta as HTMLButtonElement).disabled).toBe(false)
    }
  })
})

describe('Landing — design hygiene', () => {
  it('carries no legacy v3 color/surface class aliases in the markup', () => {
    const { container } = renderLanding()
    const html = container.innerHTML
    for (const legacy of ['text-text-1', 'text-text-2', 'bg-surface-base', 'text-accent']) {
      expect(html).not.toContain(legacy)
    }
  })

  it('carries no inline style attributes (spacing binds through tokens in the stylesheet)', () => {
    const { container } = renderLanding()
    const styled = container.querySelectorAll('[style]')
    expect(styled.length).toBe(0)
  })

  it('watermarks are decorative: aria-hidden (L7 imagery law)', () => {
    const { container } = renderLanding()
    const glyphs = container.querySelectorAll('.journey-wm-glyph')
    expect(glyphs.length).toBe(2)
    for (const g of glyphs) {
      expect(g.getAttribute('aria-hidden')).toBe('true')
    }
  })
})
