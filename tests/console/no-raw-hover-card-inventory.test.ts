import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Anti-sprawl guard (DD-43). Anchored hover/focus overlays — a card or bubble that reveals
// next to a trigger and must flip above/below or anchor to an edge to avoid clipping — go
// through the sanctioned primitives (HoverCard for interactive cards, Tooltip for the
// lightweight accelerator bubble). Both own the hover-bridge, the debounce, the Escape
// handling, the OR-semantics, and the placement math.
//
// The structural fingerprint of a HAND-ROLLED anchored overlay is direct consumption of
// `resolveViewportPlacement` (the sanctioned viewport-placement engine) outside those
// primitives — exactly what MessageBubble's old DetailCard did before it migrated onto
// HoverCard (#1289), and what PipelineTab's click-driven NodeDetailCard correctly does NOT
// do (reclassified out, #1280). With both real hover-cards now resolved, this freezes the
// debt closed: any NEW file that reaches for the placement engine directly fails here, so a
// new raw hover-card cannot bypass the primitives.
//
// Migrating a consumer onto the primitive makes its allowlist entry stale and the honesty
// test prompts deletion. Report-only-passing; promote to an eslint/resilience error once the
// pattern is proven durable.

const repoRoot = resolve(import.meta.dirname, '..', '..')
const srcRoot = 'console/src'

const PLACEMENT_ENGINE = /\bresolveViewportPlacement\b/

// The sanctioned homes of the viewport-placement engine. useViewportPlacement.ts DEFINES it;
// HoverCard and Tooltip are the two sanctioned anchored-overlay primitives that consume it.
// Every OTHER consumer is a hand-rolled anchored overlay owed a migration onto a primitive.
const ALLOWLIST = new Set<string>([
  'console/src/hooks/useViewportPlacement.ts',
  'console/src/components/primitives/HoverCard.tsx',
  'console/src/components/primitives/Tooltip.tsx',
])

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(repoRoot, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`
    if (statSync(resolve(repoRoot, rel)).isDirectory()) return sourceFiles(rel)
    return /\.(?:ts|tsx)$/.test(entry) ? [rel] : []
  })
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function usesPlacementEngine(rel: string): boolean {
  return readFileSync(resolve(repoRoot, rel), 'utf8')
    .split('\n')
    .some((line) => !isComment(line) && PLACEMENT_ENGINE.test(line))
}

describe('Anchored-overlay primitive adoption — no new raw hover-card (DD-43)', () => {
  const consumers = sourceFiles(srcRoot).filter(usesPlacementEngine)

  it('scans a non-empty source tree (fail-closed against a broken glob)', () => {
    expect(sourceFiles(srcRoot).length).toBeGreaterThan(0)
  })

  it('introduces no NEW raw anchored hover-card outside the primitive allowlist', () => {
    const unsanctioned = consumers.filter((p) => !ALLOWLIST.has(p))
    expect(unsanctioned.sort()).toEqual([])
  })

  it('keeps the allowlist honest (no stale entry after a consumer migrates onto a primitive)', () => {
    const stale = [...ALLOWLIST].filter((p) => !usesPlacementEngine(p))
    expect(stale.sort()).toEqual([])
  })

  it('detection fires on a hand-rolled anchored overlay and ignores unrelated tokens', () => {
    // Firing negative fixture: a synthetic raw hover-card MUST be caught (non-vacuity guard).
    const rawHoverCard = "const p = resolveViewportPlacement({ anchorRect, estimatedCardHeight })"
    expect(PLACEMENT_ENGINE.test(rawHoverCard)).toBe(true)
    // Discrimination: an unrelated placement-ish identifier must NOT trip the guard.
    expect(PLACEMENT_ENGINE.test('const x = resolveViewport(rect)')).toBe(false)
    expect(PLACEMENT_ENGINE.test('className="placement-below"')).toBe(false)
  })

  it('positive control — the sanctioned primitives are the only flagged consumers', () => {
    // Proves the scan actually reaches the primitives (not a vacuous empty result) and that
    // they are the exact allowlist, so the no-new-consumer assertion above is meaningful.
    expect(consumers.sort()).toEqual([...ALLOWLIST].sort())
  })
})
