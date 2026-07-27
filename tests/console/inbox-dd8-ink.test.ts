/**
 * Inbox — thread meta lane ink tier (T5 b-07 supersession of the DD-8 pin).
 *
 * The v3 pin (package §2.1 "Inbox chat meta lane", ESSENTIAL — sole rendering
 * of the chat's owning line and group/direct kind in the detail panel) moved
 * the v3 lane off ghost ink (text-text-3 → text-text-2). T5 b-07 replaced the
 * page: the meta lane is now the thread header sub line
 * (`{line} · {channel} · {kind}`) — still the sole rendering of owning line
 * and kind — consuming the v3.5 designed quiet register (--text-3-v35), whose
 * contrast is a palette-level decision re-verified at the G3 gate (b-13).
 *
 * What this file pins now, same structural-site methodology:
 *   - the meta lane exists and renders line · channel · kind (the ESSENTIAL
 *     information the DD-8 package classified);
 *   - it consumes the -v35 register (never a re-rolled v3 class or raw color);
 *   - the v3 ghost/AA utility classes are absent from the thread header.
 *
 * Positive-control pattern preserved: absence is never asserted without a
 * co-located presence check first (no vacuous not-contains pass).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')

describe('Inbox thread meta lane — v3.5 quiet register, v3 ink classes absent', () => {
  it('meta lane renders line · channel · kind at the thead sub site', () => {
    const source = read('console/src/components/inbox/ThreadPane.tsx')

    // The ESSENTIAL lane: sole rendering of owning line + conversation kind.
    expect(source).toContain('inbox-thead__sub')
    expect(source).toContain('CHANNEL_LABEL[conversation.channel]')
    expect(source).toContain("conversation.isGroup ? 'room' : 'direct'")
  })

  it('thead sub consumes the -v35 quiet register in the surface stylesheet', () => {
    const css = read('console/src/styles/inbox.css')

    // Co-located presence: the class exists and its color is the designed
    // quiet tier — a raw hex here would be a vocabulary defect.
    expect(css).toMatch(/\.inbox-thead__sub\s*{[^}]*var\(--text-3-v35\)/)
  })

  it('v3 ghost/AA ink utility classes are absent from the thread header', () => {
    const source = read('console/src/components/inbox/ThreadPane.tsx')

    // Positive control first: this IS the v3.5 surface source.
    expect(source).toContain('inbox-thead__sub')

    expect(source).not.toContain('text-text-3')
    expect(source).not.toContain('text-text-2 font-mono text-label')
  })
})
