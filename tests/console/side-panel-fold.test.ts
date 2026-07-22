/**
 * Side-panel fold + rail collapse — CSS-law pins (DD-18r closeout).
 *
 * The fold/stack behaviors are CSS-only (container/media queries), which
 * jsdom cannot evaluate — so, mirroring a11y-keyboard-focus.test.ts, these
 * pins wire the RULES and the TSX class contracts that activate them:
 *  - soup-summary-split / soup-history-split fold band (container-type +
 *    @container thresholds + fold declarations) in primitives.css
 *  - the TSX class wiring on SummaryTab Row 3 and the HistoryTab split
 *  - the soup-rail collapse recipe (760px, sr-only labels, collapsed width
 *    token) + the scroll-owner rule (leg 1: nav width pressure)
 * The computed-layout proofs run in CI (tests/browser/viewport-matrix).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const read = (p: string) => readFileSync(resolve(repoRoot, p), 'utf8')

const primitives = read('console/src/styles/primitives.css')
const summaryTab = read('console/src/components/line-detail/SummaryTab.tsx')
const historyTab = read('console/src/components/line-detail/HistoryTab.tsx')
const chrome = read('console/src/styles/chrome.css')
const navRail = read('console/src/components/chrome/NavRail.tsx')

describe('DD-18r side-panel fold law (non-Fleet surfaces)', () => {
  it('declares container-query roots for both split surfaces', () => {
    expect(primitives).toContain('.soup-summary-split {\n  container-type: inline-size;')
    expect(primitives).toContain('.soup-history-split {\n  container-type: inline-size;')
  })

  it('folds SummaryTab Row 3 below the 600px stress threshold — stack + full-width panel', () => {
    expect(primitives).toContain('@container (max-width: 599px)')
    expect(primitives).toContain('.soup-summary-split .soup-summary-split__row {\n    flex-direction: column;')
    expect(primitives).toContain('.soup-summary-split .soup-summary-split__panel {\n    width: 100%;')
  })

  it('folds the HistoryTab split below the 640px stress threshold — stack, full-width capped list, border flip', () => {
    expect(primitives).toContain('@container (max-width: 639px)')
    expect(primitives).toContain('.soup-history-split .soup-history-split__row {\n    flex-direction: column;')
    expect(primitives).toContain('.soup-history-split .soup-history-split__list {\n    width: 100%;')
    expect(primitives).toContain('max-height: 40dvh;')
    expect(primitives).toContain('border-bottom: var(--bw) solid var(--border-hairline);')
  })

  it('wires the SummaryTab fold: root container, row class, actions panel class', () => {
    expect(summaryTab).toContain('className="soup-summary-split flex flex-col')
    expect(summaryTab).toContain('className="soup-summary-split__row flex gap-')
    expect(summaryTab).toContain('className="soup-summary-split__panel w-[var(--panel-actions)] flex-shrink-0"')
  })

  it('wires the HistoryTab fold: container wrapper, row class, chat-list class', () => {
    expect(historyTab).toContain('className="soup-history-split h-full"')
    expect(historyTab).toContain('soup-history-split__row flex overflow-hidden h-full')
    expect(historyTab).toContain('soup-history-split__list flex-shrink-0 flex flex-col w-[var(--panel-history)]')
  })
})

describe('v3.5 rail collapse + scroll-owner recipes (T5 b-02, mockup ≤1100px)', () => {
  it('collapses the rail at the 1100px breakpoint to the collapsed-width token', () => {
    expect(chrome).toContain('@media (max-width: 1100px)')
    expect(chrome).toContain('width: var(--rail-w-collapsed);')
  })

  it('drops rail labels out of layout inside the collapse (mockup SSOT)', () => {
    const collapseStart = chrome.indexOf('@media (max-width: 1100px)')
    expect(collapseStart).toBeGreaterThan(-1)
    const collapseBlock = chrome.slice(collapseStart, collapseStart + 2000)
    // Labels leave visual layout via the sr-only clip recipe — NOT display:none —
    // so icon-only rows keep their content-computed accessible name (label +
    // Inbox unread count) for screen readers (b-02 cross-review finding).
    expect(collapseBlock).toContain('.chrome-nav-item__label {')
    expect(collapseBlock).toContain('clip: rect(0, 0, 0, 0);')
    const labelRule = collapseBlock.slice(collapseBlock.indexOf('.chrome-nav-item__label {'))
    expect(labelRule.slice(0, labelRule.indexOf('}'))).not.toContain('display: none;')
    // Non-label chrome (sections, wordmark, ctx, host labels) still drops out.
    expect(collapseBlock).toContain('display: none;')
  })

  it('owns the reduced-height scroll on the nav region (scroll-owner law)', () => {
    expect(chrome).toContain('.chrome-nav {')
    expect(chrome).toContain('min-height: 0;')
    expect(chrome).toContain('overflow-y: auto;')
  })

  it('NavRail wires the scroll region and the collapse-target labels', () => {
    expect(navRail).toContain('className="chrome-nav"')
    expect(navRail).toContain('chrome-nav-item__label')
  })
})
