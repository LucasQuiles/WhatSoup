import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Categorical-pattern guard: viewport-height units must be `dvh`, not `vh`.
// Static `vh` and Tailwind's `h-screen` shorthands ignore mobile dynamic browser
// chrome, so full-height surfaces can clip footer/actions when the URL bar moves.
// This root-suite companion pins the same zero inventory enforced by
// `soup/no-static-viewport-height` in the design resilience gate.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

// `<digits>vh` NOT inside `dvh` (the char before `vh` must not be `d`), plus the
// Tailwind full-viewport-height shorthands.
const VH_UNIT = /(?<![a-z])\d*\.?\d+vh\b/i
const H_SCREEN = /\b(?:min-|max-)?h-screen\b/

function srcFiles(dir: string): string[] {
  return readdirSync(resolve(repoRoot, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`
    if (statSync(resolve(repoRoot, rel)).isDirectory()) return srcFiles(rel)
    return /\.(?:ts|tsx|css)$/.test(entry) ? [rel] : []
  })
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** Each non-dvh viewport-height usage, keyed `file::token`. */
function usages(): string[] {
  const found: string[] = []
  for (const rel of srcFiles(srcRoot)) {
    for (const raw of readFileSync(resolve(repoRoot, rel), 'utf8').split('\n')) {
      if (isComment(raw)) continue
      const vh = raw.match(VH_UNIT)
      if (vh) found.push(`${rel}::${vh[0]}`)
      const hs = raw.match(H_SCREEN)
      if (hs) found.push(`${rel}::${hs[0]}`)
    }
  }
  return [...new Set(found)]
}

describe('viewport-height units must be dvh (categorical pattern enforcement)', () => {
  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(srcFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('keeps raw `vh` / `h-screen` at zero (use `dvh`)', () => {
    expect(usages().sort()).toEqual([])
  })

  it('matches vh/h-screen but not the sanctioned dvh forms', () => {
    expect(VH_UNIT.test('height: 100vh')).toBe(true)
    expect(VH_UNIT.test('height: 8.5vh')).toBe(true)
    expect(VH_UNIT.test('height: 100dvh')).toBe(false)
    expect(H_SCREEN.test('min-h-screen flex')).toBe(true)
    expect(H_SCREEN.test('h-dvh bg-d0')).toBe(false)
  })
})
