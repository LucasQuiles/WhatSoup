/**
 * Ceremony motion contract (13-ceremony-motion §2/§3) — source-scan pin.
 *
 * The browser suite runs globally under prefers-reduced-motion: reduce, so
 * the removal law is computed-proof there (viewport-matrix journey legs).
 * This file pins the PLAY contract from the stylesheet source: ≤800ms,
 * single iteration, ends at opacity 0, radial accent gradient, hatch-scoped
 * class, and the reduced-motion removal block — the acceptance-gate text.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const css = readFileSync(resolve(repoRoot, 'console/src/styles/journey.css'), 'utf8')

describe('ceremony glow — the 13-§2 one-shot contract', () => {
  it('plays once, ≤800ms, ease-out, both fill (ends at the final state)', () => {
    const rule = css.match(/\.journey-glow\s*{[^}]*animation:\s*([^;]+);/)
    expect(rule, 'glow rule with animation shorthand').toBeTruthy()
    const anim = rule![1]!
    expect(anim).toContain('journey-glowplay')
    // duration must be ≤ 800ms — parse it, don't eyeball it
    const dur = anim.match(/(\d+(?:\.\d+)?)s/)
    expect(dur).toBeTruthy()
    expect(parseFloat(dur![1]!)).toBeLessThanOrEqual(0.8)
    // single play (explicit iteration count 1) + fill both (holds the end state)
    expect(anim).toMatch(/\b1\b/)
    expect(anim).toContain('both')
  })

  it('is radial, accent-hued, and fades to opacity 0 at 100%', () => {
    expect(css).toMatch(/\.journey-glow\s*{[^}]*radial-gradient\(circle, color-mix\(in srgb, var\(--accent-v35\)/)
    const keyframes = css.match(/@keyframes journey-glowplay\s*{([\s\S]*?)}\s*}/)
    expect(keyframes).toBeTruthy()
    expect(keyframes![1]).toMatch(/100%\s*{[^}]*opacity:\s*0/)
  })

  it('the glow class is journey-scoped (banned elsewhere by name)', () => {
    expect(css).toContain('.journey-glow')
    // never a generic .glow selector that could leak to other surfaces
    expect(css).not.toMatch(/(^|\s)\.glow\s*[{,]/)
  })

  it('reduced-motion removes the animation (13-§3: removal, not speed-up)', () => {
    const rm = css.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*?)}\s*}/)
    expect(rm).toBeTruthy()
    expect(rm![1]).toMatch(/\.journey-glow/)
    expect(rm![1]).toContain('animation: none')
    // avatar pop removed too — instant final state
    expect(rm![1]).toMatch(/\.journey-av/)
  })
})
