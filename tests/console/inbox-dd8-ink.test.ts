/**
 * Inbox — DD-8 Option B ink-tier evidence for the chat meta lane.
 *
 * Source-scan methodology: the chat meta lane ({activeLine} · group/direct) is
 * only rendered inside the `selectedChat && currentChat` conditional block.
 * Driving that branch in jsdom requires full hook-state wiring that belongs in
 * the D7 interaction layer; the class-contract is proven here by scanning the
 * source file directly, mirroring the pattern in design-system-compliance-pages.test.ts.
 *
 * Decision-package classification (package §2.1):
 *   "Inbox chat meta lane — pages/Inbox.tsx:255 ({activeLine} · group/direct) —
 *    ESSENTIAL — sole rendering of the chat's owning line and group/direct kind
 *    in the detail panel."
 *   Option B: text-t5 → text-t2 (7.60:1 dark / 6.03:1 light on every bed).
 *
 * Positive-control pattern: text-t5 absence is verified by asserting text-t2 is
 * present at the same structural site first (prevents vacuous not-contains pass).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')

// ---------------------------------------------------------------------------
// DD-8 — Inbox chat meta lane ink tier (package §2.1 "Inbox chat meta lane")
// Classification: ESSENTIAL — sole rendering of owning line + group/direct kind.
// Option B: text-t5 → text-t2 (7.60:1 dark / 6.03:1 light on every bed).
// ---------------------------------------------------------------------------

describe('Inbox DD-8 — chat meta lane carries text-t2 not text-t5 (Option B)', () => {
  it('chat meta lane container has text-t2 class (AA ink — package §2.1)', () => {
    const source = read('console/src/pages/Inbox.tsx')

    // The chat meta lane renders activeLine · group/direct.
    // Assert the enclosing div uses text-t2 (AA ink promotion).
    expect(source).toContain('text-t2 font-mono text-label')
  })

  it('chat meta lane does NOT use text-t5 on the line/kind container (ghost tier absent)', () => {
    const source = read('console/src/pages/Inbox.tsx')

    // Positive control: text-t2 is present at the meta-lane site.
    expect(source).toContain('text-t2 font-mono text-label')

    // Ghost-tier absence: the meta-lane div must not carry text-t5 + font-mono
    // (the combination that identified the pre-Option-B ghost tier at this site).
    expect(source).not.toContain('text-t5 font-mono text-label')
  })

  it('text-t2 presence is co-located with the activeLine render (structural guard)', () => {
    const source = read('console/src/pages/Inbox.tsx')

    // The meta-lane div must appear in proximity to the activeLine interpolation.
    // This guards against a stray text-t2 elsewhere satisfying the presence check
    // while the actual meta-lane site still uses text-t5.
    //
    // Methodology: find the index of the first text-t2 font-mono text-label
    // occurrence and verify that the activeLine · group/direct text is within 3
    // lines (300 characters) of it in the source.
    const metaLaneIdx = source.indexOf('text-t2 font-mono text-label')
    expect(metaLaneIdx).toBeGreaterThan(-1)

    const surrounding = source.slice(metaLaneIdx, metaLaneIdx + 300)
    expect(surrounding).toContain('activeLine')
  })
})
