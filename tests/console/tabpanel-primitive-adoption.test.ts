import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

// Anti-sprawl guard: hand-rolled `role="tabpanel"` markup with hardcoded
// `id="tabpanel-*"` / `aria-labelledby="tab-*"` string literals duplicates the
// TabPanel primitive's contract and silently de-associates if Tabs ever moves to
// useId. This pins the CURRENT hand-rolled sites to an allowlist (tracked
// migration debt → <TabPanel>) and FAILS on any NEW hand-rolled tabpanel, so the
// pattern cannot spread further while the existing sites are migrated.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

// The canonical owner of the tabpanel role — the primitive itself, not a consumer.
const PRIMITIVE_OWNER = 'console/src/components/primitives/Tabs.tsx'

// Current hand-rolled tabpanel sites — tracked debt to migrate onto <TabPanel>.
// Removing a site's hand-rolled tabpanel (good!) makes this allowlist stale and
// the honesty test below will prompt deleting the entry.
const ALLOWLIST = new Set<string>([
  'console/src/components/wizard/ConfigStep.tsx',
  'console/src/components/wizard/ModelAuthStep.tsx',
  'console/src/components/line-detail/GroupDetailModal.tsx',
  'console/src/pages/LineDetail.tsx',
])

const ROLE_TABPANEL = /role="tabpanel"/

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

function fileHandRollsTabpanel(relPath: string): boolean {
  return readFileSync(resolve(repoRoot, relPath), 'utf8')
    .split('\n')
    .some((line) => !isComment(line) && ROLE_TABPANEL.test(line))
}

describe('TabPanel primitive adoption (anti-sprawl)', () => {
  const offenders = tsxFiles(srcRoot)
    .filter((p) => resolve(repoRoot, p) !== resolve(repoRoot, PRIMITIVE_OWNER))
    .filter(fileHandRollsTabpanel)
    .map((p) => relative(repoRoot, resolve(repoRoot, p)))

  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(tsxFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('introduces no NEW hand-rolled role="tabpanel" outside the TabPanel primitive', () => {
    const unsanctioned = offenders.filter((p) => !ALLOWLIST.has(p))
    expect(unsanctioned).toEqual([])
  })

  it('keeps the migration-debt allowlist honest (no stale entries after a site migrates)', () => {
    const stale = [...ALLOWLIST].filter((p) => !fileHandRollsTabpanel(p))
    expect(stale).toEqual([])
  })

  it('detects the hand-rolled signature but not the <TabPanel> primitive', () => {
    expect(ROLE_TABPANEL.test('<div role="tabpanel" id="tabpanel-info" aria-labelledby="tab-info">')).toBe(true)
    expect(ROLE_TABPANEL.test('<TabPanel id="info" active={tab === \'info\'}>')).toBe(false)
  })
})
