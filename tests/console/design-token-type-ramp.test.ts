/**
 * DD-26 bridge regression — the 8 currently consumed --type-* tokens and
 * 3 --r-* radius aliases must be DEFINED in tokens.primitive.css so that
 * var(--type-X, <fallback>) consumers in primitives.css resolve through the
 * token rather than the fallback.
 *
 * This is intentionally a consumed-token fallback bridge, not proof that the
 * final 12-token type-ramp spec is closed. The missing spec tokens and current
 * size/value mismatch remain tracked by DD-26/DD-37.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const readPrimitiveTokens = () =>
  readFileSync(resolve(repoRoot, 'console/src/styles/tokens.primitive.css'), 'utf8')
const readPrimitivesCss = () =>
  readFileSync(resolve(repoRoot, 'console/src/styles/primitives.css'), 'utf8')
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const readPrimitiveTokenDefinitions = () => {
  const css = stripCssComments(readPrimitiveTokens())
  const defs = new Map<string, string>()
  for (const line of css.split('\n')) {
    const match = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/)
    if (match) defs.set(match[1], match[2].trim().replace(/\s+/g, ' '))
  }
  return defs
}

// ---------------------------------------------------------------------------
// Type-ramp bridge tokens — 8 consumed definitions. The full spec has 12.
// ---------------------------------------------------------------------------

describe('design-token type-ramp definitions (DD-26)', () => {
  const FULL_SPEC_TYPE_TOKENS = [
    '--type-display',
    '--type-title',
    '--type-heading',
    '--type-body',
    '--type-body-st',
    '--type-label',
    '--type-caption',
    '--type-overline',
    '--type-data-lg',
    '--type-data',
    '--type-data-sm',
    '--type-nameplate',
  ] as const

  const BRIDGE_TYPE_VALUES = {
    // Promoted from pending → bridge: the display tier (--type-display / --type-title)
    // is now implemented at its tokens-v3.md §2.6 spec value (F-TYPE-3 display-tier slice).
    '--type-display': '600 26px/32px var(--font-sans)',
    '--type-title': '600 19px/24px var(--font-sans)',
    '--type-body': '400 13px/20px var(--font-sans)',
    '--type-body-st': '500 13px/20px var(--font-sans)',
    '--type-caption': '400 11px/16px var(--font-sans)',
    '--type-data': '400 12px/16px var(--font-mono)',
    '--type-data-sm': '400 11px/16px var(--font-mono)',
    '--type-heading': '600 13px/20px var(--font-sans)',
    '--type-label': '500 11px/16px var(--font-sans)',
    '--type-overline': '500 10px/16px var(--font-sans)',
    // Promoted from pending → bridge: the SOUP nameplate (brand.md §1) is now a
    // consumed token (Nav lockup), so it must resolve through the token. Value
    // matches tokens-v3.md §2.6 (600 14/24 mono); tracking/margin live at the lockup.
    '--type-nameplate': '600 14px/24px var(--font-mono)',
  } as const

  const PENDING_SPEC_TOKENS = [
    '--type-data-lg',
  ] as const

  const DIVERGENT_FINAL_SPEC_VALUES = {
    '--type-heading': '600 15px/20px var(--font-sans)',
    '--type-data-sm': '400 12px/16px var(--font-mono)',
    '--type-overline': '600 11px/16px var(--font-sans)',
  } as const

  it('bridge and pending inventories cover the full 12-token type-ramp spec', () => {
    const accounted = new Set([...Object.keys(BRIDGE_TYPE_VALUES), ...PENDING_SPEC_TOKENS])
    expect(accounted).toEqual(new Set(FULL_SPEC_TYPE_TOKENS))
  })

  it.each(Object.entries(BRIDGE_TYPE_VALUES))('%s is defined with the exact bridge fallback value', (token, value) => {
    const defs = readPrimitiveTokenDefinitions()
    expect(defs.get(token)).toBe(value)
  })

  it('every primitives.css --type-* fallback matches its canonical bridge value (no divergence)', () => {
    // Guards the seg-btn / log-msg class of bug: a `var(--type-X, <fallback>)`
    // consumer whose inline fallback diverges from the canonical token, so the
    // wrong weight/font renders whenever the token fails to resolve.
    const css = stripCssComments(readPrimitivesCss())
    const divergences: string[] = []
    for (const [token, canonical] of Object.entries(BRIDGE_TYPE_VALUES)) {
      const re = new RegExp(`var\\(\\s*${token}\\s*,\\s*([^)]*\\([^)]*\\)[^)]*|[^)]*)\\)`, 'g')
      for (const m of css.matchAll(re)) {
        const fallback = m[1].trim().replace(/\s+/g, ' ')
        if (fallback && fallback !== canonical) {
          divergences.push(`${token}: fallback "${fallback}" != canonical "${canonical}"`)
        }
      }
    }
    expect(divergences).toEqual([])
  })

  it('pending spec-only type tokens remain explicit DD-26/DD-37 debt', () => {
    const defs = readPrimitiveTokenDefinitions()
    for (const token of PENDING_SPEC_TOKENS) {
      expect(defs.has(token)).toBe(false)
    }
  })

  it.each(Object.entries(DIVERGENT_FINAL_SPEC_VALUES))(
    '%s bridge value is exact but still differs from the final spec ramp',
    (token, specValue) => {
      const defs = readPrimitiveTokenDefinitions()
      const bridgeToken = token as keyof typeof DIVERGENT_FINAL_SPEC_VALUES
      const bridgeValue = BRIDGE_TYPE_VALUES[bridgeToken]
      expect(defs.get(bridgeToken)).toBe(bridgeValue)
      expect(bridgeValue).not.toBe(specValue)
    },
  )
})

// ---------------------------------------------------------------------------
// Radius alias tokens — --r-1 / --r-2 / --r-3 (consumed in primitives.css as
// var(--r-N, var(--radius-*)); must be defined to collapse the fallback chain)
// ---------------------------------------------------------------------------

describe('design-token radius aliases (DD-26)', () => {
  it('--r-1 is defined and points at --radius-sm', () => {
    const defs = readPrimitiveTokenDefinitions()
    expect(defs.get('--r-1')).toBe('var(--radius-sm)')
  })

  it('--r-2 is defined and points at --radius-md', () => {
    const defs = readPrimitiveTokenDefinitions()
    expect(defs.get('--r-2')).toBe('var(--radius-md)')
  })

  it('--r-3 is defined and points at --radius-lg', () => {
    const defs = readPrimitiveTokenDefinitions()
    expect(defs.get('--r-3')).toBe('var(--radius-lg)')
  })

  it('radius aliases are consumed by primitives.css fallback chains', () => {
    const css = stripCssComments(readPrimitivesCss())
    expect(css).toContain('var(--r-1, var(--radius-sm))')
    expect(css).toContain('var(--r-2, var(--radius-md))')
    expect(css).toContain('var(--r-3, var(--radius-lg))')
  })
})
