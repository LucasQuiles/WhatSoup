/**
 * Motion system contract (T5 b-11) — 13-ceremony-motion.md acceptance gate,
 * source-pinned:
 *  - §1: EXACTLY ONE ambient loop product-wide, on the live status disc,
 *    opacity 1→.35→1, 2400ms ease-in-out.
 *  - §3: reduced-motion = removal (ambient loop off, lift static).
 *  - §4: retired loops stay retired (no breathe-ring/breathe/typing-bounce/
 *    shimmer anywhere in console styles).
 *  - Lift idiom within the 160–200ms budget.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const stylesDir = resolve(import.meta.dirname, '../../console/src/styles')
const read = (f: string) => readFileSync(resolve(stylesDir, f), 'utf8')
const motionCss = read('motion.css')
const allCss = readdirSync(stylesDir)
  .filter((f) => f.endsWith('.css'))
  .map((f) => `${f}\n${read(f)}`)
  .join('\n')

describe('ambient loop — exactly one, spec-exact, live disc only (13-§1)', () => {
  it('declares ambient-disc: opacity pulse 1→.35→1 at 2400ms ease-in-out infinite', () => {
    const keyframes = motionCss.match(/@keyframes ambient-disc\s*{([\s\S]*?)}\s*}/)
    expect(keyframes).toBeTruthy()
    expect(keyframes![1]).toMatch(/0%,\s*100%\s*{\s*opacity:\s*1/)
    expect(keyframes![1]).toMatch(/50%\s*{\s*opacity:\s*0\.35/)
    const rule = motionCss.match(/\.soup-shape--ok\.soup-shape--live\s*{[^}]*animation:\s*([^;]+);/)
    expect(rule).toBeTruthy()
    expect(rule![1]).toContain('ambient-disc')
    expect(rule![1]).toContain('2400ms')
    expect(rule![1]).toContain('ease-in-out')
    expect(rule![1]).toContain('infinite')
  })

  it('is the ONLY infinite animation across console styles', () => {
    const hits = [...allCss.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)]
    const names = hits.map((h) => h[1])
    expect([...new Set(names)]).toEqual(['ambient-disc'])
  })

  it('the v3 loop family stays retired (13-§4)', () => {
    for (const banned of ['breathe-ring', 'typing-bounce', 'shimmer']) {
      expect(allCss).not.toContain(`@keyframes ${banned}`)
    }
    expect(allCss).not.toContain('animate-shimmer')
    expect(allCss).not.toContain('animate-breathe')
  })
})

describe('lift idiom — within the 160–200ms budget (13-§1)', () => {
  it('hover translateY(-2px) + shadow at 180ms ease-out', () => {
    expect(motionCss).toMatch(/\.lift\s*{[^}]*transition:[^}]*transform 180ms ease-out/)
    expect(motionCss).toMatch(/\.lift:hover\s*{[^}]*transform:\s*translateY\(-2px\)/)
    expect(motionCss).toMatch(/\.lift:hover\s*{[^}]*box-shadow:\s*var\(--shadow-lift-v35\)/)
  })
})

describe('reduced-motion law — removal, not speed-up (13-§3)', () => {
  it('the ambient loop is removed and lift becomes static under reduce', () => {
    const rm = motionCss.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*?)}\s*}/)
    expect(rm).toBeTruthy()
    expect(rm![1]).toMatch(/\.soup-shape--ok\.soup-shape--live\s*{\s*animation:\s*none/)
    expect(rm![1]).toMatch(/\.lift[^{]*{[^}]*transition:\s*none/)
    expect(rm![1]).toMatch(/transform:\s*none/)
  })
})
