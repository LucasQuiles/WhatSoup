import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Anti-sprawl guard (DD-38). card.md:60 mandates `card-via-primitive`. Card.tsx IS
// built (f315b1a5) and a further wave of consumers has migrated onto it (ErrorBoundary,
// LogsTab, then AccessTab, ScheduledMessageRow, Inbox, Ops; MessageBubble's panel is on
// <Card> but the surface still carries the `c-card--detail` modifier so it stays a recipe
// consumer). The remaining files still render the raw `.c-card` CSS recipe.
// This pins those remaining consumers to an allowlist (tracked migration debt →
// the Card primitive, scoped in 06-implementation/card-primitive-build-spec.md)
// and FAILS on any NEW file that reaches for the raw recipe, so new cards cannot
// bypass the primitive while the existing ones migrate. Migrating a file off
// `c-card` (good!) makes its entry stale and the honesty test prompts deletion.
// Report-only-passing; promote to a resilience/eslint error once the allowlist
// empties and `.c-card` is deleted from composites.css.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

const CARD_RECIPE = /\bc-card\b/

// Card.tsx IS the primitive — the single sanctioned home of the `.c-card` recipe. It is not
// migration debt; it stays allowlisted until `.c-card` is renamed/absorbed at the end of the
// migration. Every OTHER entry is a raw-recipe consumer still owed a migration onto <Card>.
const ALLOWLIST = new Set<string>([
  'console/src/components/primitives/Card.tsx',
  'console/src/components/ActiveHoursHeatmap.tsx',
  // MessageBubble MIGRATED off the recipe (DD-43): its detail panel now renders via the
  // HoverCard primitive and the `.c-card--detail` modifier was deleted, so it is no
  // longer a raw `c-card` consumer (removed from this allowlist per the honesty test).
  'console/src/components/line-detail/GroupCard.tsx',
  'console/src/components/line-detail/MetricsTab.tsx',
  // ProvidersKeysCard MIGRATED (W2-S4): its sole c-card surface now renders via the Card
  // primitive (the motion wrapper is kept outside), so it no longer uses the raw recipe.
  'console/src/components/line-detail/SummaryTab.tsx',
  'console/src/pages/SoupKitchen.tsx',
  // MIGRATED onto <Card> (DD-38): ErrorBoundary.tsx, line-detail/LogsTab.tsx, pages/Operator.tsx,
  // line-detail/AccessTab.tsx, line-detail/ScheduledMessageRow.tsx, Inbox.tsx
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
