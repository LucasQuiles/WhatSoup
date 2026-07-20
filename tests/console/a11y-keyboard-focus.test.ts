import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Regression guard for the a11y/keyboard sub-slice (ISM-03 / ISM-06).
// The focus ring is CSS-only (jsdom can't verify computed outline), so we pin the
// rule that wires it: the global :focus-visible outline must cover the two element
// classes that previously had NO keyboard focus indicator —
//   - role="radio" CardSelector options (divs with roving tabindex) — WCAG 2.4.7
//   - keyboard-focusable cards (.soup-card[tabindex] — the DD-38-absorbed
//     recipe, now owned by the Card primitive in primitives.css)
const composites = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'console/src/styles/composites.css'),
  'utf8',
)
const primitives = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'console/src/styles/primitives.css'),
  'utf8',
)

describe('a11y keyboard focus-ring coverage (ISM-03/ISM-06)', () => {
  it('the focus-visible ring rule covers role=radio CardSelector options', () => {
    expect(composites).toContain('[role="radio"]:focus-visible')
  })

  it('the focus-visible ring rule covers keyboard-focusable cards', () => {
    expect(primitives).toContain('.soup-card[tabindex]:focus-visible')
  })

  it('the rule rings with the real focus token (not a stub/empty selector)', () => {
    expect(composites).toContain('outline: 2px solid var(--focus-ring)')
  })
})
