import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Categorical-pattern guard: viewport-height units must be `dvh`, not `vh`.
// Static `vh` (and the Tailwind `h-screen`/`min-h-screen`/`max-h-screen` = 100vh
// shorthands) ignore mobile dynamic browser chrome, so full-height surfaces clip
// their footer/actions when the URL bar shows/hides. `dvh` is the established
// convention here (the app shell `h-dvh`, `100dvh`, and `--modal-max-h:85dvh` all
// use it — DD-40 fixed the modal token). But raw `vh` outliers remain unguarded:
// the existing `no-vw-font-size` resilience rule covers font-size vw only, not
// height vh.
//
// Frozen-inventory ratchet: pin the current non-dvh usages and FAIL on any NEW
// `vh`/`h-screen`, so the convention can't regress while the outliers migrate to
// dvh. Report-only-passing; promotion to a check-design-resilience rule is
// Systems-coordinated.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

// `<digits>vh` NOT inside `dvh` (the char before `vh` must not be `d`), plus the
// Tailwind full-viewport-height shorthands.
const VH_UNIT = /(?<![a-z])\d+vh\b/i
const H_SCREEN = /\b(?:min-|max-)?h-screen\b/

// Current non-dvh usages — tracked debt to migrate to dvh. Removing one (good!)
// makes its entry stale and the honesty test prompts deletion.
const ALLOWLIST = new Set<string>([
  'console/src/styles/primitives.css::8vh',
  'console/src/components/UnlockScreen.tsx::min-h-screen',
])

function srcFiles(dir: string): string[] {
  return readdirSync(resolve(repoRoot, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`
    if (statSync(resolve(repoRoot, rel)).isDirectory()) return srcFiles(rel)
    return /\.(?:tsx|css)$/.test(entry) ? [rel] : []
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

  it('introduces no NEW raw `vh` / `h-screen` (use `dvh`)', () => {
    const unsanctioned = usages().filter((k) => !ALLOWLIST.has(k))
    expect(unsanctioned.sort()).toEqual([])
  })

  it('keeps the migration allowlist honest (no stale entries after one moves to dvh)', () => {
    const present = new Set(usages())
    const stale = [...ALLOWLIST].filter((k) => !present.has(k))
    expect(stale.sort()).toEqual([])
  })

  it('matches vh/h-screen but not the sanctioned dvh forms', () => {
    expect(VH_UNIT.test('height: 100vh')).toBe(true)
    expect(VH_UNIT.test('height: 100dvh')).toBe(false)
    expect(H_SCREEN.test('min-h-screen flex')).toBe(true)
    expect(H_SCREEN.test('h-dvh bg-d0')).toBe(false)
  })
})
