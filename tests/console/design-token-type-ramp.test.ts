/**
 * DD-26: Regression — all 8 --type-* ramp tokens and 3 --r-* radius aliases
 * must be DEFINED in tokens.primitive.css so that var(--type-X, <fallback>)
 * consumers in primitives.css resolve through the token rather than the fallback.
 *
 * Pattern mirrors design-token-classes.test.ts (readFileSync + string assertion).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const readPrimitiveTokens = () =>
  readFileSync(resolve(repoRoot, 'console/src/styles/tokens.primitive.css'), 'utf8')

// ---------------------------------------------------------------------------
// Type-ramp tokens — 8 required definitions (typography.md §2, tokens-v3 §2.6)
// ---------------------------------------------------------------------------

describe('design-token type-ramp definitions (DD-26)', () => {
  const TYPE_TOKENS = [
    '--type-body',
    '--type-body-st',
    '--type-caption',
    '--type-data',
    '--type-data-sm',
    '--type-heading',
    '--type-label',
    '--type-overline',
  ] as const

  it.each(TYPE_TOKENS)('%s is defined in tokens.primitive.css', (token) => {
    const css = readPrimitiveTokens()
    // Must appear as a property definition: "  --type-<name>:" (property assignment, not a var() call)
    const definitionPattern = new RegExp(`${token.replace(/[-]/g, '\\-')}\\s*:`)
    expect(css).toMatch(definitionPattern)
  })

  it('--type-data-sm resolves to mono/400 (canonical, not the buggy 500/sans fallback)', () => {
    const css = readPrimitiveTokens()
    // The definition line must contain the canonical value
    const lines = css.split('\n')
    const defLine = lines.find((l) => /^\s*--type-data-sm\s*:/.test(l))
    expect(defLine).toBeDefined()
    expect(defLine).toContain('400')
    expect(defLine).toContain('var(--font-mono)')
  })

  it('--type-data uses mono font stack', () => {
    const css = readPrimitiveTokens()
    const lines = css.split('\n')
    const defLine = lines.find((l) => /^\s*--type-data\s*:/.test(l))
    expect(defLine).toBeDefined()
    expect(defLine).toContain('var(--font-mono)')
  })

  it('--type-heading uses semibold (600)', () => {
    const css = readPrimitiveTokens()
    const lines = css.split('\n')
    const defLine = lines.find((l) => /^\s*--type-heading\s*:/.test(l))
    expect(defLine).toBeDefined()
    expect(defLine).toContain('600')
  })

  it('--type-label uses medium (500) and sans font stack', () => {
    const css = readPrimitiveTokens()
    const lines = css.split('\n')
    const defLine = lines.find((l) => /^\s*--type-label\s*:/.test(l))
    expect(defLine).toBeDefined()
    expect(defLine).toContain('500')
    expect(defLine).toContain('var(--font-sans)')
  })
})

// ---------------------------------------------------------------------------
// Radius alias tokens — --r-1 / --r-2 / --r-3 (consumed in primitives.css as
// var(--r-N, var(--radius-*)); must be defined to collapse the fallback chain)
// ---------------------------------------------------------------------------

describe('design-token radius aliases (DD-26)', () => {
  it('--r-1 is defined and points at --radius-sm', () => {
    const css = readPrimitiveTokens()
    const lines = css.split('\n')
    const defLine = lines.find((l) => /^\s*--r-1\s*:/.test(l))
    expect(defLine).toBeDefined()
    expect(defLine).toContain('var(--radius-sm)')
  })

  it('--r-2 is defined and points at --radius-md', () => {
    const css = readPrimitiveTokens()
    const lines = css.split('\n')
    const defLine = lines.find((l) => /^\s*--r-2\s*:/.test(l))
    expect(defLine).toBeDefined()
    expect(defLine).toContain('var(--radius-md)')
  })

  it('--r-3 is defined and points at --radius-lg', () => {
    const css = readPrimitiveTokens()
    const lines = css.split('\n')
    const defLine = lines.find((l) => /^\s*--r-3\s*:/.test(l))
    expect(defLine).toBeDefined()
    expect(defLine).toContain('var(--radius-lg)')
  })
})
