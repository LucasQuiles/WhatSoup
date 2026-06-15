import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Perceivable-law guard: typography.md §2 mandates a hard legibility floor —
// "Minimum data text is 12px (`--type-data-sm`); nothing in the product renders
// smaller." Raw values are blocked elsewhere, but the 12px floor itself has had
// ZERO mechanical enforcement, and the spec's own ramp contradicts it:
// typography.md:76 records that `--text-xs` (9.6px) "dies below the 12px floor".
//
// This pins the CURRENT sub-floor `--text-*` size tokens to an allowlist (tracked
// debt → raise to >=12px or migrate consumers onto `--text-data`/`--type-caption`)
// and FAILS on any NEW sub-floor token, so the ramp cannot accrete more
// below-floor rungs while the existing three are burned down. Report-only-passing
// today; a regression ratchet, not a clean gate.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const PRIMITIVE_TOKENS = 'console/src/styles/tokens.primitive.css'

// typography.md §2 — the legibility floor, in px.
const FLOOR_PX = 12
const PX_PER_REM = 16

// Current below-floor size tokens — tracked debt. Raising a token to >=12px (good!)
// or deleting it makes its entry stale and the honesty test below prompts removal.
const SUBFLOOR_ALLOWLIST = new Set<string>([
  '--text-xs', // 9.6px  — spec-acknowledged dead (typography.md:76)
  '--text-label', // 10.4px
  '--text-sm', // 11.2px
])

// `--text-<name>: <N>rem|px;` size declarations. Excludes `--text-*--line-height`
// companions (unitless / line-height, not a font size).
const SIZE_TOKEN = /^\s*(--text-[a-z0-9-]+)\s*:\s*([\d.]+)(rem|px)\s*;/

interface SizeToken {
  name: string
  px: number
}

function sizeTokens(): SizeToken[] {
  return readFileSync(resolve(repoRoot, PRIMITIVE_TOKENS), 'utf8')
    .split('\n')
    .map((line) => {
      const m = SIZE_TOKEN.exec(line)
      if (!m) return null
      const name = m[1]
      if (name.endsWith('--line-height')) return null
      const value = Number.parseFloat(m[2])
      const px = m[3] === 'rem' ? value * PX_PER_REM : value
      return { name, px }
    })
    .filter((t): t is SizeToken => t !== null)
}

function subFloor(): SizeToken[] {
  return sizeTokens().filter((t) => t.px < FLOOR_PX)
}

describe('typography legibility floor (perceivable-law ratchet)', () => {
  it('parses a non-empty type scale (fail-closed against a broken read/regex)', () => {
    expect(sizeTokens().length).toBeGreaterThan(0)
  })

  it('introduces no NEW `--text-*` size token below the 12px floor', () => {
    const unsanctioned = subFloor()
      .map((t) => t.name)
      .filter((name) => !SUBFLOOR_ALLOWLIST.has(name))
    expect(unsanctioned).toEqual([])
  })

  it('keeps the sub-floor debt allowlist honest (no stale entries after a token is raised/removed)', () => {
    const belowFloor = new Set(subFloor().map((t) => t.name))
    const stale = [...SUBFLOOR_ALLOWLIST].filter((name) => !belowFloor.has(name))
    expect(stale).toEqual([])
  })

  it('detects a sub-floor rem value but not an at-floor one', () => {
    const parse = (line: string) => {
      const m = SIZE_TOKEN.exec(line)
      return m ? (m[3] === 'rem' ? Number.parseFloat(m[2]) * PX_PER_REM : Number.parseFloat(m[2])) : null
    }
    expect(parse('  --text-tiny: 0.6rem;')).toBeLessThan(FLOOR_PX)
    expect(parse('  --text-data: 0.78rem;')).toBeGreaterThanOrEqual(FLOOR_PX)
    expect(parse('  --text-xs--line-height: 1.4;')).toBeNull()
  })
})
