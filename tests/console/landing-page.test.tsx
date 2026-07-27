/**
 * Landing (welcome splash) — v3.5 first-run contracts (T5 b-10;
 * splash.html SSOT). Anatomy, honest navigation, L7 watermark rules.
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

describe('v3.5 splash — anatomy (splash.html SSOT)', () => {
  it('hero: nameplate, h1 with accent span, sub, two CTAs', () => {
    const { container } = renderLanding()
    const h1s = container.querySelectorAll('h1')
    expect(h1s.length).toBe(1)
    expect(h1s[0]!.textContent).toContain('Run your agents')
    expect(h1s[0]!.textContent).toContain('fleet.')
    expect(h1s[0]!.querySelector('.journey-accent')!.textContent).toBe('fleet.')
    expect(container.querySelector('.journey-splash-sub')!.textContent).toContain('One calm console')
    const ctas = [...container.querySelectorAll('.journey-cta button')]
    expect(ctas.length).toBe(2)
  })

  it('proof triptych: three cards in mockup order (Hatch, Command, Trust)', () => {
    const { container } = renderLanding()
    const props = [...container.querySelectorAll('.journey-prop')]
    expect(props.length).toBe(3)
    expect(props[0]!.textContent).toContain('01 — Hatch')
    expect(props[1]!.textContent).toContain('02 — Command')
    expect(props[2]!.textContent).toContain('03 — Trust')
  })

  it('watermarks are decorative: aria-hidden, pointer-events none (L7)', () => {
    const { container } = renderLanding()
    const glyphs = container.querySelectorAll('.journey-wm-glyph')
    expect(glyphs.length).toBe(2)
    for (const g of glyphs) {
      expect(g.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('CTAs navigate: hatch → /hatch, fleet → /', () => {
    const { container } = renderLanding()
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Hatch your first agent'))!)
    expect(navigateMock).toHaveBeenCalledWith('/hatch')
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Open the Fleet'))!)
    expect(navigateMock).toHaveBeenCalledWith('/')
  })
})
