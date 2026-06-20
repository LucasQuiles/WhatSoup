import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Anti-sprawl guard: raw `<label className="c-field-label">` markup bypasses
// the <Field> wrapper primitive (console/src/components/primitives/FormControl.tsx)
// which is the sanctioned home of the c-field-label recipe. Hand-rolling the class
// directly decouples label styling from the <Field> a11y contract (htmlFor wiring,
// error/helper association, consistent spacing tokens).
//
// This pins the CURRENT raw consumers to an allowlist (tracked migration debt →
// <Field>) and FAILS on any NEW file that reaches for c-field-label directly, so
// the pattern cannot spread while the existing sites migrate. Migrating a file onto
// <Field> (good!) makes its allowlist entry stale and the honesty test below prompts
// deletion. Update the allowlist only when a file is genuinely migrated — never add
// new raw consumers; add them via <Field> instead.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

// The canonical owner of the c-field-label recipe — the primitive itself.
// It is NOT migration debt; stays allowlisted until the recipe is renamed/absorbed.
const PRIMITIVE_OWNER = 'console/src/components/primitives/FormControl.tsx'

// Current raw c-field-label consumers — tracked debt to migrate onto <Field>.
// Removing a file's raw label (good!) makes this allowlist stale and the
// honesty test will prompt deleting the entry.
const ALLOWLIST = new Set<string>([
  'console/src/components/line-detail/CreateGroupModal.tsx',
  'console/src/components/line-detail/GroupDetailModal.tsx',
  'console/src/components/line-detail/ScheduleComposerModal.tsx',
  'console/src/components/wizard/ConfigStep.tsx',
  'console/src/components/wizard/IdentityStep.tsx',
  // ModelAuthStep.tsx migrated onto <Field> (W2-S5): all 3 raw c-field-label
  // labels (2 previously-unassociated Anthropic/OpenAI role selects + the API
  // key input) now route through the <Field> primitive's htmlFor wiring.
])

const FIELD_LABEL_RECIPE = /\bc-field-label\b/

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

function usesRawFieldLabel(rel: string): boolean {
  return readFileSync(resolve(repoRoot, rel), 'utf8')
    .split('\n')
    .some((line) => !isComment(line) && FIELD_LABEL_RECIPE.test(line))
}

describe('Field primitive adoption — no new raw c-field-label recipe', () => {
  const consumers = tsxFiles(srcRoot)
    .filter((p) => resolve(repoRoot, p) !== resolve(repoRoot, PRIMITIVE_OWNER))
    .filter(usesRawFieldLabel)

  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(tsxFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('introduces no NEW raw c-field-label consumer outside the migration allowlist', () => {
    const unsanctioned = consumers.filter((p) => !ALLOWLIST.has(p))
    expect(unsanctioned.sort()).toEqual([])
  })

  it('keeps the migration allowlist honest (no stale entries after a consumer migrates onto <Field>)', () => {
    const stale = [...ALLOWLIST].filter((p) => !usesRawFieldLabel(p))
    expect(stale.sort()).toEqual([])
  })

  it('matches the field-label class but not an unrelated token', () => {
    expect(FIELD_LABEL_RECIPE.test('className="c-field-label"')).toBe(true)
    expect(FIELD_LABEL_RECIPE.test('className="c-label c-field-label"')).toBe(true)
    expect(FIELD_LABEL_RECIPE.test('className="c-field-label block"')).toBe(true)
    // "notc-field-label" has no word boundary before `c` (preceded by `t`), so no match
    expect(FIELD_LABEL_RECIPE.test('className="notc-field-label"')).toBe(false)
    expect(FIELD_LABEL_RECIPE.test('className="form-label"')).toBe(false)
  })
})
