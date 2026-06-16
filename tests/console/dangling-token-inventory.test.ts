import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Cross-tier dangling-token guard (enforcement-evolve, Window-3 G/Token-F1).
//
// design-regression.sh Check 19 only scans COMPONENT-TIER CSS for no-fallback
// var() refs, so a token consumed from a TSX Tailwind-arbitrary (e.g.
// `tracking-[var(--tracking-wide)]`) or an inline style escapes it entirely —
// which is exactly how `--tracking-wide` shipped undefined. This guard closes the
// class: every `var(--token)` reference WITHOUT a fallback, anywhere in
// console/src TSX/TS, must resolve to a token that is DEFINED — either in a CSS
// file (`--token:`) or injected at runtime via an inline style (`'--token':`).
//
// Fallback-form refs `var(--x, <fallback>)` are intentional and excluded (the
// fallback supplies a value). Template-interpolated names `var(--${x})` are
// un-resolvable statically and skipped.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const SRC = 'console/src'
const STYLES = 'console/src/styles'

// `var(--name)` with NO comma before the close paren = no fallback.
const NO_FALLBACK_REF = /var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g
// A CSS custom-property DEFINITION: `--name:` at a declaration position.
const CSS_DEF = /(^|[\s{;])(--[a-zA-Z0-9_-]+)\s*:/g
// A runtime var SET via a JS/TSX style object: `'--name':` or `"--name":`.
const TSX_SET = /['"](--[a-zA-Z0-9_-]+)['"]\s*:/g

function walk(dir: string, test: (f: string) => boolean): string[] {
  return readdirSync(resolve(repoRoot, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`
    if (statSync(resolve(repoRoot, rel)).isDirectory()) return walk(rel, test)
    return test(entry) ? [rel] : []
  })
}

const cssFiles = () => walk(STYLES, (f) => /\.css$/.test(f))
const tsxFiles = () => walk(SRC, (f) => /\.(tsx?|ts)$/.test(f))

function collect(re: RegExp, text: string, group: number): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(re)) out.add(m[group])
  return out
}

function definedTokens(): Set<string> {
  const defined = new Set<string>()
  for (const f of cssFiles()) {
    const css = readFileSync(resolve(repoRoot, f), 'utf8')
    collect(CSS_DEF, css, 2).forEach((t) => defined.add(t))
  }
  for (const f of tsxFiles()) {
    const src = readFileSync(resolve(repoRoot, f), 'utf8')
    collect(TSX_SET, src, 1).forEach((t) => defined.add(t)) // runtime-injected vars
  }
  return defined
}

describe('cross-tier dangling-token guard (enforcement)', () => {
  it('scans a non-empty source + style tree (fail-closed against a broken glob)', () => {
    expect(cssFiles().length).toBeGreaterThan(0)
    expect(tsxFiles().length).toBeGreaterThan(0)
  })

  it('every no-fallback var(--token) referenced in console/src TSX is defined (CSS or runtime)', () => {
    const defined = definedTokens()
    const dangling: string[] = []
    for (const f of tsxFiles()) {
      const src = readFileSync(resolve(repoRoot, f), 'utf8')
      for (const m of src.matchAll(NO_FALLBACK_REF)) {
        const token = m[1]
        if (!defined.has(token)) dangling.push(`${f}: var(${token})`)
      }
    }
    expect(dangling.sort()).toEqual([])
  })

  it('detects a planted dangling reference (proves the guard is not vacuous)', () => {
    const defined = definedTokens()
    const planted = 'const x = "var(--definitely-not-a-real-token-zzz)"'
    const hits = [...planted.matchAll(NO_FALLBACK_REF)].map((m) => m[1]).filter((t) => !defined.has(t))
    expect(hits).toEqual(['--definitely-not-a-real-token-zzz'])
  })

  it('ignores fallback-form refs var(--x, <fallback>) (fallback supplies the value)', () => {
    const fallbackRef = 'font: var(--type-data-sm, 400 11px/16px var(--font-mono));'
    // NO_FALLBACK_REF must not match `--type-data-sm` (it has a comma), only the
    // nested fallback `--font-mono` which is itself defined.
    const matched = [...fallbackRef.matchAll(NO_FALLBACK_REF)].map((m) => m[1])
    expect(matched).not.toContain('--type-data-sm')
  })
})
