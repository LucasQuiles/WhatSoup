/**
 * Landing.tsx — the SOUP splash / landing page (showcase §view-brand reproduction).
 *
 * Faithful reproduction of the showcase brand/hero in v3 design-system vocabulary:
 *   - the SOUP nameplate (teal tick + spaced-caps mark), rendered inline per brand.md §1
 *     (the shared Nameplate component is not yet on main);
 *   - the "Run your agents like a fleet." hero with the electric-blue accent on "fleet.";
 *   - the three value-prop cards — Spin up a Line / Watch it breathe / Heal before it hurts —
 *     each with its index overline, supporting copy, and a shape-driven glyph;
 *   - a primary CTA into the console ("Open the Fleet" → navigate to /).
 *
 * Layout follows layout-density.md composition: a Container caps the measure; every gap is
 * owned by the parent (no margins between siblings). Type stays inside the v3 closed ramp —
 * brand.md §1.4 sanctions a round, tightly-tracked display read for the landing surface, but
 * the named ramp (largest sans tier) carries it; no marketing-scale raw font sizes.
 *
 * Motion: entrance fade/rise honours prefers-reduced-motion via the page-local
 * MotionConfig reducedMotion="user" (motion.md reduced-motion contract).
 */
import { type FC, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { MotionConfig, motion } from 'framer-motion'
import { Card, Button } from '../components/primitives'

// motion.md easing — the standard entrance curve; reduced-motion strips it at MotionConfig.
const EASE = [0.22, 1, 0.36, 1] as const

// ---------------------------------------------------------------------------
// SOUP nameplate (brand.md §1) — inline lockup: teal tick + spaced-caps wordmark.
// Tick: --mode-passive-solid (heritage teal, deliberately NOT the action accent).
// Wordmark: IBM Plex Mono 600, uppercase, +0.38em tracking with the mandatory −0.38em
// trailing-space cancellation (§1.2 rule 1) so the lockup centres on its corrected box.
// ---------------------------------------------------------------------------
const Nameplate: FC = () => (
  <span className="flex items-center gap-[var(--sp-3)] select-none">
    <span
      aria-hidden="true"
      className="w-[var(--sp-2)] h-[var(--sp-2)] rounded-[var(--r-1)] bg-mode-passive-solid"
    />
    <span
      // brand.md §1.1 — the wordmark is a fixed 4-glyph mark; nowrap is the locked
      // lockup geometry, not a truncation risk. title carries the full value (no clip).
      title="SOUP"
      className="font-mono font-semibold uppercase text-text-1 text-data whitespace-nowrap tracking-[0.38em] [margin-inline-end:-0.38em]"
    >
      SOUP
    </span>
  </span>
)

// ---------------------------------------------------------------------------
// Value-prop glyphs — shape-driven (color.md §6: shape, not colour alone), drawn in
// accent ink at low opacity to echo the showcase triptych without a second hue.
// ---------------------------------------------------------------------------
const ProvisionGlyph: FC = () => (
  <svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect x="8" y="9" width="16" height="3" rx="1.5" fill="var(--accent)" opacity="0.20" />
    <rect x="8" y="14" width="11" height="3" rx="1.5" fill="var(--accent)" opacity="0.14" />
    <rect x="8" y="19" width="14" height="3" rx="1.5" fill="var(--accent)" opacity="0.09" />
  </svg>
)
const MonitorGlyph: FC = () => (
  <svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle cx="16" cy="16" r="7" fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.18" />
    <circle cx="16" cy="16" r="2.5" fill="var(--accent)" opacity="0.18" />
  </svg>
)
const RecoverGlyph: FC = () => (
  <svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 7 A9 9 0 1 1 7 16" fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.18" strokeLinecap="round" />
    <path d="M16 4 l3 3 -3 3" fill="none" stroke="var(--accent)" strokeWidth="2" opacity="0.18" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

interface ValueProp {
  index: string
  glyph: ReactNode
  title: string
  copy: string
}

// Showcase §view-brand triptych copy — locked vocabulary (Line, not WhatsApp).
const VALUE_PROPS: ValueProp[] = [
  {
    index: '01 / Provision',
    glyph: <ProvisionGlyph />,
    title: 'Spin up a Line',
    copy: 'Name it, link it, pick a mode — agent, chat, or passive. The wizard provisions a workspace and a scoped MCP socket in one pass.',
  },
  {
    index: '02 / Monitor',
    glyph: <MonitorGlyph />,
    title: 'Watch it breathe',
    copy: 'Live heartbeats, neutral traffic counters, and per-provider token spend. Attention is a metric, not a vibe.',
  },
  {
    index: '03 / Recover',
    glyph: <RecoverGlyph />,
    title: 'Heal before it hurts',
    copy: 'The durability engine catches dead-letters and runtime skew, then restarts the right unit — before the chat goes quiet.',
  },
]

const Landing: FC = () => {
  const navigate = useNavigate()

  return (
    <MotionConfig reducedMotion="user">
      <main
        aria-labelledby="landing-hero-title"
        // The splash is its own top-level scroll owner; min-h-0 proves the axis floor
        // so the content lane can shrink-and-scroll rather than overflow its parent.
        className="h-dvh min-h-0 overflow-y-auto bg-surface-base text-text-1"
      >
        {/* Container — caps the measure, owns vertical rhythm via gap (no sibling margins). */}
        <div className="flex flex-col gap-[var(--sp-12)] mx-auto max-w-[var(--landing-max-w)] w-full py-[var(--sp-12)] px-[var(--sp-6)] sm:px-[var(--sp-8)]">
          {/* Brand row — the nameplate sits alone at the top of the splash. */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            <Nameplate />
          </motion.div>

          {/* Hero — the headline + supporting copy + CTA, stacked with owned gap. */}
          <motion.section
            className="flex flex-col gap-[var(--sp-6)]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.05 }}
          >
            <p className="font-mono uppercase text-accent text-sm tracking-[var(--tracking-wide)]">
              Multi-channel agent infrastructure
            </p>
            <h1
              id="landing-hero-title"
              className="font-[family-name:var(--font-display)] font-black text-text-1 text-4xl tracking-[var(--tracking-tighter)] max-w-[var(--landing-hero-measure)]"
            >
              Run your agents like a <span className="text-accent">fleet.</span>
            </h1>
            <p className="font-sans text-text-2 text-lg leading-relaxed max-w-[var(--landing-prose-measure)]">
              SOUP is the operations console for conversational agents — provision a Line on any
              channel, watch it breathe, and recover it before anyone notices. No drift, no
              guesswork, no sterile dashboards.
            </p>
            <div className="flex items-center gap-[var(--sp-3)] flex-wrap">
              <Button
                variant="primary"
                onClick={() => navigate('/')}
                iconEnd={<span aria-hidden="true">&rarr;</span>}
              >
                Open the Fleet
              </Button>
            </div>
          </motion.section>

          {/* Value-prop triptych — three cards; the grid owns the gutter via gap. */}
          <motion.section
            aria-label="What SOUP does"
            className="grid grid-cols-1 gap-[var(--sp-4)] md:grid-cols-3"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
          >
            {VALUE_PROPS.map((vp) => (
              <Card key={vp.title} className="flex flex-col gap-[var(--sp-3)] p-[var(--sp-6)]">
                <span aria-hidden="true">{vp.glyph}</span>
                <span className="font-mono uppercase text-accent text-sm tracking-[var(--tracking-label)]">
                  {vp.index}
                </span>
                <h2 className="font-[family-name:var(--font-display)] font-semibold text-text-1 text-xl tracking-[var(--tracking-tight)]">
                  {vp.title}
                </h2>
                <p className="font-sans text-text-2 text-body leading-relaxed">{vp.copy}</p>
              </Card>
            ))}
          </motion.section>

          {/* Closing line — echoes the showcase sign-off; the accent carries identity only. */}
          <motion.p
            className="font-mono text-text-3 text-sm tracking-[var(--tracking-pill)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, ease: EASE, delay: 0.18 }}
          >
            SOUP — fleet operations for conversational agents
          </motion.p>
        </div>
      </main>
    </MotionConfig>
  )
}

export default Landing
