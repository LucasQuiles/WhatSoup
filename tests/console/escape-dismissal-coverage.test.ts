import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

// Categorical detection — complements `soup/no-inline-dismiss-handler`.
//
// That ESLint rule only fires on `event.key === 'Escape'` *inside a useEffect*.
// It is blind to every other hand-rolled Escape-dismissal form: `useCallback` /
// `onKeyDown` handlers, `useLayoutEffect`, `keyCode === 27`, `event.code ===
// 'Escape'`, the legacy `'Esc'` value, `switch/case`, and `[...].includes(key)`.
// This source scan nets the whole class regardless of wrapper, so a future
// hand-rolled dismissal in any of those forms cannot slip past CI just because
// it dodged the rule's narrow AST selector.
//
// Policy: overlay/global Escape dismissal must live in the canonical hook
// (use-dismissable.ts). Any other file that detects Escape must be an explicit,
// justified entry in ALLOWLIST — otherwise this fails and forces a conscious
// choice: migrate to useDismissable, or document a sanctioned local handler.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

// All hand-rolled Escape-detection forms (any key property, any value, any wrapper).
const ESCAPE_DISMISSAL_RE =
  /(?:\.key|\.code)\s*===?\s*['"](?:Escape|Esc)['"]|key(?:Code)?\s*===?\s*27|which\s*===?\s*27|case\s*['"](?:Escape|Esc)['"]|\[\s*['"]Esc(?:ape)?['"][^\]]*\]\s*\.includes/

// The single sanctioned owner of overlay Escape/outside-click behavior.
const CANONICAL_OWNER = 'console/src/hooks/use-dismissable.ts'

// Explicitly-justified local handlers (NOT global dismissal → not useDismissable's job).
// Each entry is a tracked exception, visible here rather than hidden in a syntax gap.
const ALLOWLIST = new Map<string, string>([
  [
    'console/src/components/MessageBubble.tsx',
    'Local hover/focus-detail onKeyDown with stopPropagation (one-layer law §2); ' +
      'scoped to the bubble, not a global overlay — intentionally not useDismissable.',
  ],
  [
    'console/src/components/primitives/Tooltip.tsx',
    'Local hover/focus tooltip onKeyDown with stopPropagation (one-layer law §2); ' +
      'Esc dismisses the bubble without moving focus off the trigger (showcase §24) — ' +
      'scoped to the anchored bubble, not a global overlay, so intentionally not useDismissable.',
  ],
  [
    'console/src/components/primitives/InlineEdit.tsx',
    'Field-level edit-in-place onKeyDown (showcase §17): Esc cancels the edit and reverts ' +
      'the draft, staying on the same control — it is not an overlay/global dismissal and moves ' +
      'no focus, so useDismissable (focus-trap + stack) would be wrong here.',
  ],
])

function tsxFiles(dir: string): string[] {
  return readdirSync(resolve(repoRoot, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`
    if (statSync(resolve(repoRoot, rel)).isDirectory()) return tsxFiles(rel)
    return /\.(?:ts|tsx)$/.test(entry) ? [rel] : []
  })
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function fileHasHandRolledEscape(relPath: string): boolean {
  return readFileSync(resolve(repoRoot, relPath), 'utf8')
    .split('\n')
    .some((line) => !isComment(line) && ESCAPE_DISMISSAL_RE.test(line))
}

describe('escape-dismissal categorical coverage', () => {
  const offenderFiles = tsxFiles(srcRoot)
    .filter((p) => resolve(repoRoot, p) !== resolve(repoRoot, CANONICAL_OWNER))
    .filter(fileHasHandRolledEscape)
    .map((p) => relative(repoRoot, resolve(repoRoot, p)))

  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(tsxFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('finds no hand-rolled Escape dismissal outside the canonical hook + allowlist', () => {
    const unsanctioned = offenderFiles.filter((p) => !ALLOWLIST.has(p))
    expect(unsanctioned).toEqual([])
  })

  it('keeps the allowlist honest — every entry still actually rolls its own Escape', () => {
    const stale = [...ALLOWLIST.keys()].filter((p) => !fileHasHandRolledEscape(p))
    expect(stale).toEqual([])
  })

  it('detector catches every Escape form the narrow ESLint rule misses', () => {
    const forms = [
      "if (e.key === 'Escape') close()", // useCallback/onKeyDown form (rule needs useEffect)
      "if (e.code === 'Escape') close()",
      "if (e.key === 'Esc') close()",
      'if (e.keyCode === 27) close()',
      'if (e.which === 27) close()',
      "switch (e.key) { case 'Escape': close() }",
      "if (['Escape','Esc'].includes(e.key)) close()",
    ]
    for (const form of forms) expect(ESCAPE_DISMISSAL_RE.test(form)).toBe(true)
    // comments and unrelated keys must NOT trip it
    expect(ESCAPE_DISMISSAL_RE.test("// pressing Escape closes the menu")).toBe(false)
    expect(ESCAPE_DISMISSAL_RE.test("if (e.key === 'Enter') submit()")).toBe(false)
  })
})
