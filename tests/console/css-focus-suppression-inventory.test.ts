import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Categorical-pattern guard: raw-CSS focus suppression. interaction-patterns.md
// mandates one focus recipe everywhere, never suppressed; `outline:none` is only
// safe when paired with a `:focus-visible` replacement (and is a forced-colors
// hazard otherwise). The eslint rule `soup/no-focus-suppression` ONLY scans TSX
// `outline-none` className utilities — raw `outline:none` / `outline:0` in the
// .css style files used to bypass it entirely. The promoted design-resilience
// guard now blocks any suppression without a tokenized focus-visible outline.
//
// Frozen-inventory ratchet: pin the current sanctioned suppressions (each reviewed
// to sit on a container shell or to carry a paired focus-visible replacement) and
// FAIL on any NEW raw-CSS outline suppression, forcing a reviewer to confirm a
// focus-visible replacement exists before adding it to the allowlist. Removing one
// (good!) makes its entry stale and the honesty test prompts deletion. Report-only-
// passing; promotion to a Stylelint/check-script error is Systems-coordinated.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const STYLE_FILES = [
  'console/src/styles/primitives.css',
  'console/src/styles/composites.css',
  'console/src/styles/tokens.semantic.css',
  'console/src/styles/tokens.component.css',
  'console/src/styles/tokens.primitive.css',
  'console/src/styles/index.css',
]

const SUPPRESSION = /outline:\s*(?:none|0)(?:px)?\b/
const SELECTOR_OPEN = /\{/

// Current sanctioned suppressions, keyed `file::selector` (line-number-independent).
// Each reviewed: modal/drawer shells are focusable containers with the ring applied
// via :focus-visible; the form-control reset and FeedCard each re-add the ring.
const ALLOWLIST = new Set<string>([
  'console/src/styles/primitives.css::.soup-modal-shell',
  'console/src/styles/primitives.css::.soup-drawer',
  'console/src/styles/composites.css::input, select, textarea, button',
  'console/src/styles/composites.css::.fc',
])

/** Each raw-CSS outline-suppression keyed by file + nearest enclosing selector. */
function suppressions(): string[] {
  const found: string[] = []
  for (const rel of STYLE_FILES) {
    let text: string
    try {
      text = readFileSync(resolve(repoRoot, rel), 'utf8')
    } catch {
      continue
    }
    let selector = '(file-top)'
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('/*') || line.startsWith('*')) continue
      if (SELECTOR_OPEN.test(raw)) {
        const sel = raw.slice(0, raw.indexOf('{')).trim()
        if (sel) selector = sel
      }
      if (SUPPRESSION.test(raw)) found.push(`${rel}::${selector}`)
    }
  }
  return found
}

describe('CSS focus-suppression inventory (categorical pattern enforcement)', () => {
  it('scans the style files (fail-closed against a broken read/glob)', () => {
    const present = STYLE_FILES.filter((rel) => {
      try { readFileSync(resolve(repoRoot, rel)); return true } catch { return false }
    })
    expect(present.length).toBeGreaterThan(0)
  })

  it('introduces no NEW raw-CSS outline suppression outside the sanctioned allowlist', () => {
    const unsanctioned = [...new Set(suppressions())].filter((k) => !ALLOWLIST.has(k))
    expect(unsanctioned.sort()).toEqual([])
  })

  it('keeps the suppression allowlist honest (no stale entries after one is removed)', () => {
    const present = new Set(suppressions())
    const stale = [...ALLOWLIST].filter((k) => !present.has(k))
    expect(stale.sort()).toEqual([])
  })
})
