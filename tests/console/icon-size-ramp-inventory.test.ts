import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Categorical-pattern guard (iconography.md §2 size ramp). Lucide icons must use
// the sanctioned ramp — 16 inline, 18 default, 20 emphasis, 24 hero, 12
// informational-only — and "sizes below 12px do not exist" (the v2 10px helper is
// rejected, tokens-v3 §8). Raw ad-hoc `size={N}` numerics are hardcoded values
// the design system forbids; the spec itself names the intended `icon-size-ramp`
// lint rule (iconography.md:60) but nothing enforces it yet.
//
// Entry tier = frozen-inventory ratchet (source is in heavy violation today): pin
// the CURRENT icon-scale (<=24px) off-ramp sizes to a debt allowlist and FAIL on
// any NEW off-ramp size, so ad-hoc sizes cannot spread while the existing set is
// migrated onto the ramp. Sizes >24px are out of icon-ramp scope (illustration /
// avatar / empty-state `--icon-empty` / logo) and are intentionally not flagged
// here. Report-only-passing; escalation to an eslint error is Systems-coordinated.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

// iconography.md §2 — the sanctioned ramp (interactive/structural + info-only 12).
const RAMP = new Set<number>([12, 16, 18, 20, 24])

// Anything <= this is icon-scale and bound by the ramp; larger is illustration.
const ICON_SCALE_MAX = 24

// Current icon-scale off-ramp sizes — tracked debt to migrate onto the ramp
// (sub-12 first: spec says those "do not exist"). Migrating a size away (good!)
// makes its entry stale and the honesty test below prompts its removal.
const OFF_RAMP_DEBT = new Set<number>([6, 9, 10, 11, 13, 14, 15])

// Lucide convention: `size={<int>}`. Excludes string/expression sizes.
const ICON_SIZE = /\bsize=\{(\d+)\}/g

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

/** Distinct icon-scale (<=24px) numeric sizes present in the source tree. */
function iconScaleSizes(): Set<number> {
  const sizes = new Set<number>()
  for (const rel of tsxFiles(srcRoot)) {
    const text = readFileSync(resolve(repoRoot, rel), 'utf8')
    for (const line of text.split('\n')) {
      if (isComment(line)) continue
      for (const m of line.matchAll(ICON_SIZE)) {
        const n = Number.parseInt(m[1], 10)
        if (n <= ICON_SCALE_MAX) sizes.add(n)
      }
    }
  }
  return sizes
}

describe('icon size ramp (categorical pattern enforcement)', () => {
  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(tsxFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('finds the ramp in use (sanity: the inventory is actually parsing sizes)', () => {
    const present = iconScaleSizes()
    expect([...RAMP].some((s) => present.has(s))).toBe(true)
  })

  it('introduces no NEW off-ramp icon size (<=24px outside the sanctioned ramp)', () => {
    const offRamp = [...iconScaleSizes()].filter((n) => !RAMP.has(n))
    const unsanctioned = offRamp.filter((n) => !OFF_RAMP_DEBT.has(n))
    expect(unsanctioned.sort((a, b) => a - b)).toEqual([])
  })

  it('keeps the off-ramp debt allowlist honest (no stale entries after a size is migrated)', () => {
    const present = iconScaleSizes()
    const stale = [...OFF_RAMP_DEBT].filter((n) => !present.has(n))
    expect(stale.sort((a, b) => a - b)).toEqual([])
  })
})
