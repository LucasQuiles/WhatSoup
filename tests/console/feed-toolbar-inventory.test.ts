import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Anti-sprawl guard: `feed-toolbar` is a hand-rolled toolbar element
// inside ActivityFeed.tsx. The canonical path for new toolbar renderings
// is the <Toolbar> primitive (console/src/components/primitives/), which
// provides keyboard navigation, role="toolbar" ARIA semantics, and
// consistent spacing tokens. Inlining a raw `className="feed-toolbar"`
// div in new files bypasses that contract and silently diverges from
// future Toolbar API changes.
//
// This pins the CURRENT feed-toolbar consumer to an allowlist (tracked
// migration debt → <Toolbar>) and FAILS on any NEW file that introduces
// the pattern. Migrating ActivityFeed.tsx onto <Toolbar> (good!) makes
// this allowlist stale and the honesty test below prompts deletion.
// Update the allowlist only when a file is genuinely migrated — never
// add new raw consumers; use <Toolbar> instead.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

// Current raw feed-toolbar consumers — tracked debt to migrate onto <Toolbar>.
// Removing a file's feed-toolbar usage (good!) makes this allowlist stale
// and the honesty test will prompt deleting the entry.
const ALLOWLIST = new Set<string>([
  'console/src/components/ActivityFeed.tsx',
])

const FEED_TOOLBAR_RECIPE = /\bfeed-toolbar\b/

function tsxFiles(dir: string): string[] {
  return readdirSync(resolve(repoRoot, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`
    if (statSync(resolve(repoRoot, rel)).isDirectory()) return tsxFiles(rel)
    return /\.tsx$/.test(entry) ? [rel] : []
  })
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function usesFeedToolbar(rel: string): boolean {
  return readFileSync(resolve(repoRoot, rel), 'utf8')
    .split('\n')
    .some((line) => !isComment(line) && FEED_TOOLBAR_RECIPE.test(line))
}

describe('Toolbar primitive adoption — no new raw feed-toolbar pattern (anti-sprawl)', () => {
  const consumers = tsxFiles(srcRoot).filter(usesFeedToolbar)

  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(tsxFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('introduces no NEW raw feed-toolbar consumer outside the migration allowlist', () => {
    const unsanctioned = consumers.filter((p) => !ALLOWLIST.has(p))
    expect(unsanctioned.sort()).toEqual([])
  })

  it('keeps the migration allowlist honest (no stale entries after a consumer migrates onto <Toolbar>)', () => {
    const stale = [...ALLOWLIST].filter((p) => !usesFeedToolbar(p))
    expect(stale.sort()).toEqual([])
  })

  it('matches the feed-toolbar class but not an unrelated token', () => {
    expect(FEED_TOOLBAR_RECIPE.test('className="feed-toolbar"')).toBe(true)
    expect(FEED_TOOLBAR_RECIPE.test('<div className="feed-toolbar flex gap-2">')).toBe(true)
    // "toolbar" lacks the "feed-" prefix, no match
    expect(FEED_TOOLBAR_RECIPE.test('className="toolbar"')).toBe(false)
    // "notfeed-toolbar" has no word boundary before `f` (preceded by `t`), no match
    expect(FEED_TOOLBAR_RECIPE.test('className="notfeed-toolbar"')).toBe(false)
  })
})
