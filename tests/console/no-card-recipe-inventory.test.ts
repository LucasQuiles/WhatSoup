import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Anti-sprawl guard (DD-38 — CLOSEOUT STATE). card.md:60 mandates
// `card-via-primitive`. The migration is COMPLETE: every consumer renders via
// the Card primitive, and the legacy `.c-card` recipe was ABSORBED — Card.tsx
// renders `.soup-card` (primitives.css, declarations verbatim) and the
// composites recipe is deleted. With the allowlist empty this guard is the
// PROMOTED state the build spec sequenced: it hard-FAILS on ANY raw `.c-card`
// usage anywhere in console/src, so no surface can bypass the primitive.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

const CARD_RECIPE = /\bc-card\b/

// The allowlist is EMPTY by design (DD-38 closeout): the Card primitive absorbed the
// recipe as `.soup-card` (primitives.css), so NOTHING may use raw `.c-card` — including
// Card.tsx itself.
const ALLOWLIST = new Set<string>([
  // EMPTY — migration complete (DD-38 closeout). Card.tsx renders `.soup-card`
  // (the absorbed recipe in primitives.css) and no longer matches CARD_RECIPE.
  // Any entry added here is new debt: use <Card> instead.
])

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

function usesCardRecipe(rel: string): boolean {
  return readFileSync(resolve(repoRoot, rel), 'utf8')
    .split('\n')
    .some((line) => !isComment(line) && CARD_RECIPE.test(line))
}

describe('Card primitive adoption — no new raw c-card recipe (DD-38)', () => {
  const consumers = tsxFiles(srcRoot).filter(usesCardRecipe)

  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(tsxFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('introduces no NEW raw `c-card` recipe consumer outside the migration allowlist', () => {
    const unsanctioned = consumers.filter((p) => !ALLOWLIST.has(p))
    expect(unsanctioned.sort()).toEqual([])
  })

  it('keeps the migration allowlist honest (no stale entries after a consumer migrates onto <Card>)', () => {
    const stale = [...ALLOWLIST].filter((p) => !usesCardRecipe(p))
    expect(stale.sort()).toEqual([])
  })

  it('matches the recipe class but not an unrelated token', () => {
    expect(CARD_RECIPE.test('className="c-card w-full flex"')).toBe(true)
    expect(CARD_RECIPE.test('className="c-card--detail"')).toBe(true)
    expect(CARD_RECIPE.test('className="scorecard-row"')).toBe(false)
  })
})
