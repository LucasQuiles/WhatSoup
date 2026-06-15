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

      expect(body).toContain('color: var(--color-t4);')
      expect(body).not.toContain('color: var(--color-t5);')
    }
  })

  it('keeps Ops empty/loading fleet state copy off text-t5', () => {
    const source = read('console/src/pages/Ops.tsx')

    expect(source).toContain('text-t2 text-center py-8 font-mono text-data')
    expect(source).not.toContain('text-t5 text-center py-8 font-mono text-data')
  })

  it('keeps Inbox load-more and empty-selection labels off text-t5', () => {
    const source = read('console/src/pages/Inbox.tsx')

    expect(source).toContain('w-full justify-center text-t2')
    expect(source).toContain('text-center text-t2 text-sm')
    expect(source).not.toContain('w-full justify-center text-t5')
    expect(source).not.toContain('text-center text-t5 text-sm')
  })

  it('keeps HistoryTab load/no-more/jump controls off text-t5', () => {
    const source = read('console/src/components/line-detail/HistoryTab.tsx')

    expect(source).toContain('c-hover text-t2 pt-[var(--sp-3)]')
    expect(source).toContain('justify-center text-t2 pt-[var(--sp-3)]')
    expect(source).toContain('c-hover text-t2 left-1/2')
    expect(source).not.toContain('c-hover text-t5 pt-[var(--sp-3)]')
    expect(source).not.toContain('justify-center text-t5 pt-[var(--sp-3)]')
    expect(source).not.toContain('c-hover text-t5 left-1/2')
  })

  it('keeps AccessTab and ChartPanel empty copy off text-t5', () => {
    const accessTab = read('console/src/components/line-detail/AccessTab.tsx')
    const chartPanel = read('console/src/components/ChartPanel.tsx')

    expect(accessTab).toContain('text-t2 text-center py-6 font-mono text-data')
    expect(chartPanel).toContain('items-center justify-center text-center text-t2')
    expect(accessTab).not.toContain('text-t5 text-center py-6 font-mono text-data')
    expect(chartPanel).not.toContain('items-center justify-center text-center text-t5')
  })
})
