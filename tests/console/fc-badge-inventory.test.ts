import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Anti-sprawl guard: `fc-badge` is a hand-rolled tone-badge dialect living
// inside FeedCard.tsx. The canonical path for new badge renderings is the
// <Badge> primitive (console/src/components/primitives/Badge.tsx), which
// owns accessible role/aria markup and the design-token colour ramp.
// Inlining fc-badge* classes in new files bypasses that contract and
// silently diverges from future token updates.
//
// This pins the CURRENT fc-badge consumers to an allowlist (tracked
// migration debt → <Badge>) and FAILS on any NEW file that reaches for
// fc-badge directly. Migrating FeedCard.tsx onto <Badge> (good!) makes
// this allowlist stale and the honesty test below prompts deletion.
// Update the allowlist only when a file is genuinely migrated — never
// add new raw consumers; use <Badge> instead.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

// Current raw fc-badge consumers — tracked debt to migrate onto <Badge>.
// Removing a file's fc-badge usage (good!) makes this allowlist stale and
// the honesty test will prompt deleting the entry.
const ALLOWLIST = new Set<string>([
  'console/src/components/FeedCard.tsx',
])

const FC_BADGE_RECIPE = /\bfc-badge\b/

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

function usesFcBadge(rel: string): boolean {
  return readFileSync(resolve(repoRoot, rel), 'utf8')
    .split('\n')
    .some((line) => !isComment(line) && FC_BADGE_RECIPE.test(line))
}

describe('Badge primitive adoption — no new raw fc-badge dialect (anti-sprawl)', () => {
  const consumers = tsxFiles(srcRoot).filter(usesFcBadge)

  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(tsxFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('introduces no NEW raw fc-badge consumer outside the migration allowlist', () => {
    const unsanctioned = consumers.filter((p) => !ALLOWLIST.has(p))
    expect(unsanctioned.sort()).toEqual([])
  })

  it('keeps the migration allowlist honest (no stale entries after a consumer migrates onto <Badge>)', () => {
    const stale = [...ALLOWLIST].filter((p) => !usesFcBadge(p))
    expect(stale.sort()).toEqual([])
  })

  it('matches the fc-badge class but not an unrelated token', () => {
    expect(FC_BADGE_RECIPE.test('className="fc-badge fc-badge--ok"')).toBe(true)
    expect(FC_BADGE_RECIPE.test('className={`fc-badge ${tone}`}')).toBe(true)
    // "badge" has no "fc-" prefix, no match
    expect(FC_BADGE_RECIPE.test('className="badge"')).toBe(false)
    // "notfc-badge" has no word boundary before `f` (preceded by `t`), no match
    expect(FC_BADGE_RECIPE.test('className="notfc-badge"')).toBe(false)
  })
})
