/**
 * Landing (welcome splash) — v3.5 first-run surface (T5 b-10; mockup
 * splash.html SSOT). Hero + proof triptych + glyph watermarks (L7 imagery:
 * abstract glyph geometry, opacity 0.04–0.05, pointer-events none).
 * Journey register throughout; theme toggle is real (useTheme).
 */
import { useNavigate } from 'react-router-dom'
import type { FC } from 'react'
import { useTheme } from '../hooks/use-theme'
import { Button } from '../components/primitives/Button'

const PROPS = [
  {
    n: '01 — Hatch',
    h: 'An agent in minutes',
    p: 'Pick a kind, link a channel, watch it come alive. Persona, brain and permissions included.',
  },
  {
    n: '02 — Command',
    h: 'Every line in view',
    p: 'Real-time fleet across all your channels and deployments. Attention finds you, not the reverse.',
  },
  {
    n: '03 — Trust',
    h: 'You stay in charge',
    p: 'Grants decide what agents can see and do. Every self-suggested change waits for your approval.',
  },
] as const

const Landing: FC = () => {
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()

  return (
    <main className="journey-splash" aria-labelledby="splash-h1">
      <Button
        variant="ghost"
        className="journey-theme-toggle"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        theme
      </Button>
      {/* L7 watermarks — abstract glyph geometry, decorative only */}
      <svg className="journey-wm-glyph journey-wm-glyph--g1" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1a7 7 0 0 0-6 10.5L1 15l3.6-1A7 7 0 1 0 8 1z" />
      </svg>
      <svg className="journey-wm-glyph journey-wm-glyph--g2" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" />
      </svg>

      <div className="journey-hero">
        <div className="journey-hero__plate">
          <span className="journey-hero__tick" />
          <span className="journey-wm journey-wm--hero">
            SO<b>U</b>P
          </span>
        </div>
        <h1 id="splash-h1">
          Run your agents
          <br />
          like a <span className="journey-accent">fleet.</span>
        </h1>
        <p className="journey-splash-sub">
          One calm console for every channel — WhatsApp, Signal, iMessage, socials and more. Hatch
          an agent, give it a line, and watch it work.
        </p>
        <div className="journey-cta">
          <Button variant="primary" className="journey-splash__primary" onClick={() => navigate('/hatch')}>
            Hatch your first agent →
          </Button>
          <Button variant="ghost" className="journey-splash__ghost" onClick={() => navigate('/')}>
            Open the Fleet
          </Button>
        </div>
      </div>

      <div className="journey-props">
        {PROPS.map((prop) => (
          <div key={prop.n} className="journey-prop">
            <div className="journey-prop__n">{prop.n}</div>
            <h3>{prop.h}</h3>
            <p>{prop.p}</p>
          </div>
        ))}
      </div>
    </main>
  )
}

export default Landing
