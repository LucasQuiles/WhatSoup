import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Anti-sprawl guard (DD-38). card.md:60 mandates `card-via-primitive`, but no
// Card.tsx exists yet — 13 files render the raw `.c-card` CSS recipe directly.
// This pins those 13 current consumers to an allowlist (tracked migration debt →
// the future Card primitive, scoped in 06-implementation/card-primitive-build-spec.md)
// and FAILS on any NEW file that reaches for the raw recipe, so new cards cannot
// bypass the primitive while the existing ones migrate. Migrating a file off
// `c-card` (good!) makes its entry stale and the honesty test prompts deletion.
// Report-only-passing; promote to a resilience/eslint error once the allowlist
// empties and `.c-card` is deleted from composites.css.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

const CARD_RECIPE = /\bc-card\b/

// Current raw-recipe consumers — tracked debt to migrate onto <Card>.
const ALLOWLIST = new Set<string>([
  'console/src/components/ActiveHoursHeatmap.tsx',
  'console/src/components/ErrorBoundary.tsx',
  'console/src/components/MessageBubble.tsx',
  'console/src/components/line-detail/AccessTab.tsx',
  'console/src/components/line-detail/GroupCard.tsx',
  'console/src/components/line-detail/LogsTab.tsx',
  'console/src/components/line-detail/MetricsTab.tsx',
  'console/src/components/line-detail/ProvidersKeysCard.tsx',
  'console/src/components/line-detail/ScheduledMessageRow.tsx',
  'console/src/components/line-detail/SummaryTab.tsx',
  'console/src/pages/Inbox.tsx',
  'console/src/pages/Ops.tsx',
  'console/src/pages/SoupKitchen.tsx',
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
