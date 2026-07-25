/**
 * Empty / paused state copy — DD-8 Option B ink-tier evidence.
 *
 * The DD-8 package keeps decorative/placeholder ghost ink lawful, but the
 * named empty-state copy and resting pause/load controls are sole visible state
 * or action text. Those sites must carry secondary ink, not ghost ink.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')

function cssRuleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const css = read('console/src/styles/composites.css')
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`))
  expect(match?.groups?.body).toBeDefined()
  return match?.groups?.body ?? ''
}

describe('DD-8 empty and paused state copy carries secondary ink', () => {
  it('maps feed-empty and pause-control CSS defaults to text-2 via color-t4', () => {
    for (const selector of ['.feed-empty', '.feed-toolbar__pause']) {
      const body = cssRuleBody(selector)

      expect(body).toContain('color: var(--text-2);')
      expect(body).not.toContain('color: var(--text-3);')
    }
  })

  it('keeps Ops empty/loading fleet state copy off ghost ink (text-text-3)', () => {
    const source = read('console/src/pages/Operator.tsx')

    // v3 semantic class names: secondary ink is text-text-2 (--text-2),
    // ghost ink is text-text-3 (--text-3). Empty/loading fleet copy is sole
    // visible state text and must carry secondary ink, not ghost ink.
    expect(source).toContain('text-text-2 text-center py-8 font-mono text-data')
    expect(source).not.toContain('text-text-3 text-center py-8 font-mono text-data')
  })

  it('keeps the v3.5 Inbox off the v3 ghost-ink class entirely (T5 b-07)', () => {
    const source = read('console/src/pages/Inbox.tsx')
    const css = read('console/src/styles/inbox.css')

    // T5 b-07 supersession: the v3 page pinned quiet copy at text-text-2; the
    // v3.5 surface consumes the -v35 register where quiet tiers are a palette
    // decision (contrast re-verified at the G3 gate, b-13). The law that still
    // holds here: the v3 ghost-ink utility class is gone from the page source,
    // and the surface's quiet copy (list empty note, ctx empty note, preview
    // lane) consumes the designed -v35 quiet register — never a re-rolled hex.
    expect(source).not.toContain('text-text-3')
    expect(source).toContain('inbox-page') // positive control: the file is the v3.5 surface
    expect(css).toMatch(/\.inbox-list__empty\s*{[^}]*var\(--text-3-v35\)/)
    expect(css).toMatch(/\.inbox-citem__pv\s*{[^}]*var\(--text-3-v35\)/)
  })

  it('keeps HistoryTab load/no-more/jump controls off text-t5', () => {
    const source = read('console/src/components/line-detail/HistoryTab.tsx')

    expect(source).toContain('c-hover text-text-2 pt-[var(--sp-3)]')
    expect(source).toContain('justify-center text-text-2 pt-[var(--sp-3)]')
    expect(source).toContain('c-hover text-text-2 left-1/2')
    expect(source).not.toContain('c-hover text-text-3 pt-[var(--sp-3)]')
    expect(source).not.toContain('justify-center text-text-3 pt-[var(--sp-3)]')
    expect(source).not.toContain('c-hover text-text-3 left-1/2')
  })

  it('keeps AccessTab and ChartPanel empty copy off text-t5', () => {
    const accessTab = read('console/src/components/line-detail/AccessTab.tsx')
    const chartPanel = read('console/src/components/ChartPanel.tsx')

    expect(accessTab).toContain('text-text-2 text-center py-6 font-mono text-data')
    expect(chartPanel).toContain('items-center justify-center text-center text-text-2')
    expect(accessTab).not.toContain('text-text-3 text-center py-6 font-mono text-data')
    expect(chartPanel).not.toContain('items-center justify-center text-center text-text-3')
  })
})
