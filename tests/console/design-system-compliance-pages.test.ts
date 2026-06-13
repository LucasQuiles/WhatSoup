import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')
// C0 token split: index.css is now a slim importer; design-token assertions read the full tier set.
const readTokenCss = () => [
  'console/src/index.css',
  'console/src/styles/tokens.primitive.css',
  'console/src/styles/tokens.semantic.css',
  'console/src/styles/tokens.component.css',
  'console/src/styles/composites.css',
].map(read).join('\n')

describe('design system compliance — Shannon slice', () => {
  it('uses design tokens for Nav hardcoded pixel values', () => {
    const source = read('console/src/components/Nav.tsx')

    expect(source).toMatch(/left:\s*["']var\(--sp-3\)["']/)
    expect(source).toMatch(/right:\s*["']var\(--sp-3\)["']/)
    expect(source).toContain('h-[var(--bw-accent)]')
    expect(source).toContain('min-w-[var(--sp-4)]')
    expect(source).toContain('py-[var(--sp-0h)] px-[var(--sp-1)]')
    expect(source).toContain('py-[var(--sp-1h)] px-[var(--sp-3)]')
    expect(source).not.toContain('left: "12px"')
    expect(source).not.toContain('right: "12px"')
    expect(source).not.toContain('height: "2px"')
    expect(source).not.toContain('minWidth: "16px"')
    expect(source).not.toContain('padding: "1px 5px"')
    expect(source).not.toContain("padding: '2px 6px'")
  })

  it('replaces remaining hardcoded values with tokens in heatmap, tags, and quoted replies', () => {
    const heatmap = read('console/src/components/ActiveHoursHeatmap.tsx')
    const tags = read('console/src/components/LineTags.tsx')
    const content = read('console/src/components/MessageContent.tsx')

    expect(heatmap).not.toContain("fontSize: '9px'")
    expect(heatmap).toContain("text-xs")

    expect(tags).not.toContain("gap: '3px'")
    expect(tags).toContain("gap-[var(--sp-0h)]")

    expect(content).not.toContain("maxHeight: '48px'")
    expect(content).toContain("maxHeight: 'var(--sp-12)'")
  })

  it('uses accessible button and textarea semantics in HistoryTab', () => {
    const source = read('console/src/components/line-detail/HistoryTab.tsx')

    // Buttons are on the Button/ActionButton primitives (raw <button>/c-btn retired).
    expect(source).toContain('<Button')
    expect(source).toContain('<ActionButton')
    expect(source).toContain("z-[var(--z-float)]")
    expect(source).toContain('aria-label="Type a reply"')
  })

  it('AddLineWizard uses Modal primitive (role-on-backdrop defect dead)', () => {
    const source = read('console/src/components/AddLineWizard.tsx')

    // Modal primitive — dialog role is on the shell, not the backdrop
    expect(source).toContain('<Modal')
    expect(source).not.toContain('c-dialog-backdrop')
    // No raw role="dialog" in source — Modal owns it
    expect(source).not.toContain('role="dialog"')
  })

  it('associates Field labels with their controls in wizard form primitives', () => {
    const primitives = read('console/src/components/wizard/form-primitives.tsx')
    const configStep = read('console/src/components/wizard/ConfigStep.tsx')

    expect(primitives).toContain('useId')
    expect(primitives).toContain('htmlFor={id}')
    expect(primitives).toContain('children: (id: string) => ReactNode')
    expect(primitives).toContain('{children(id)}')
    expect(configStep).toContain('{(id) => (')
    expect(configStep).toContain('id={id}')
  })

  it('adds explicit accessibility semantics to HeartbeatStrip and PipelineTab', () => {
    const heartbeat = read('console/src/components/HeartbeatStrip.tsx')
    const pipeline = read('console/src/components/line-detail/PipelineTab.tsx')

    expect(heartbeat).toContain('role="img"')
    expect(heartbeat).toContain('aria-label={`Health: ${beats.filter(b => b === \'up\').length} of ${beats.length} heartbeats healthy`}')

    // PipelineNode is a real, accessible button — now the Button primitive, not a
    // clickable <span>. Preserved layout utilities ride on the primitive's className.
    expect(pipeline).toContain('<Button')
    expect(pipeline).toMatch(/className="font-mono inline-flex items-center gap-1\.5[^"]*"/)
    expect(pipeline).not.toContain('<span\n      className="inline-flex items-center gap-1.5"\n      onClick={onClick}')
  })

  it('migrates Inbox panels and interaction affordances to design-system classes', () => {
    const inbox = read('console/src/pages/Inbox.tsx')

    expect((inbox.match(/c-card/g) ?? []).length).toBeGreaterThanOrEqual(3)
    // Interaction affordances are on the Button/ActionButton primitives.
    expect(inbox).toContain('<Button')
    expect(inbox).toContain('<ActionButton')
    expect(inbox).toContain('z-[var(--z-float)]')
    expect(inbox).toContain('aria-label="Type a message"')
    expect(inbox).toContain('aria-label="Clear search"')
  })

  it('migrates Ops and SoupKitchen page panels to c-card and labels search input', () => {
    const ops = read('console/src/pages/Ops.tsx')
    const soupKitchen = read('console/src/pages/SoupKitchen.tsx')

    expect((ops.match(/c-card/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((soupKitchen.match(/c-card/g) ?? []).length).toBeGreaterThanOrEqual(3)
    // C2.3: ToolbarSearch primitive generates aria-label from the label prop.
    expect(soupKitchen).toContain('label="Search lines"')
  })

  it('KpiCard uses aria-pressed and useId for gradient IDs', () => {
    const source = read('console/src/components/KpiCard.tsx')
    expect(source).toContain('aria-pressed')
    expect(source).toContain('useId')
    expect(source).not.toContain('spark-fill-${label')
  })

  it('ActivityFeed and FilterPill use aria-pressed for toggle state', () => {
    const feed = read('console/src/components/ActivityFeed.tsx')
    const pill = read('console/src/components/FilterPill.tsx')
    expect(feed).toContain('aria-pressed')
    expect(pill).toContain('aria-pressed')
  })

  it('uses --text-* tokens in @theme (not --font-size-*) and text-* utility classes', () => {
    const css = readTokenCss()
    // @theme uses --text-* naming for Tailwind v4 native utility generation
    expect(css).toContain('--text-xs:')
    expect(css).toContain('--text-sm:')
    expect(css).toContain('--text-data:')
    expect(css).toContain('--text-xl:')
    expect(css).not.toContain('--font-size-xs:')
    expect(css).not.toContain('--font-size-sm:')

    // Line-height companions exist for sizes that override TW4 defaults
    expect(css).toContain('--text-xs--line-height:')
    expect(css).toContain('--text-sm--line-height:')
    expect(css).toContain('--text-xl--line-height:')
  })

  it('wraps form reset and body styles in @layer base (not unlayered)', () => {
    const css = readTokenCss()
    // Unlayered button/input { font: inherit } would override @layer utilities text-* classes
    // The form reset MUST be inside @layer base
    const formResetMatch = css.match(/input,\s*select,\s*textarea,\s*button\s*\{[^}]*font:\s*inherit/)
    expect(formResetMatch).not.toBeNull()

    // Verify it's inside @layer base by checking the preceding context
    const idx = css.indexOf('input, select, textarea, button')
    const preceding = css.slice(Math.max(0, idx - 200), idx)
    expect(preceding).toContain('@layer base')
  })

  it('TSX files use text-* classes, not text-[var(--font-size-*)] or text-[var(--text-*)]', () => {
    const nav = read('console/src/components/Nav.tsx')
    const pill = read('console/src/components/FilterPill.tsx')
    // text-[var(--font-size-*)] generates no CSS in TW4 (ambiguous)
    // text-[var(--text-*)] is redundant when text-* utility exists
    expect(nav).not.toMatch(/text-\[var\(--font-size-/)
    expect(nav).not.toMatch(/text-\[var\(--text-/)
    expect(pill).not.toMatch(/text-\[var\(--font-size-/)
    // C2 migration: FilterPill no longer styles its own text — the Pill primitive owns
    // typography via soup-pill classes (pill.md). Pin the delegation instead.
    expect(pill).toContain("from './primitives'")
    expect(pill).not.toMatch(/text-\[var\(--text-/)
  })

  it('fully dissolves form-styles.ts — no remaining imports in wizard components', () => {
    const exists = (() => { try { read('console/src/components/wizard/form-styles.ts'); return true } catch { return false } })()
    expect(exists).toBe(false)

    const primitives = read('console/src/components/wizard/form-primitives.tsx')
    const identity = read('console/src/components/wizard/IdentityStep.tsx')
    const modelAuth = read('console/src/components/wizard/ModelAuthStep.tsx')

    expect(primitives).not.toContain('form-styles')
    expect(identity).not.toContain('form-styles')
    expect(modelAuth).not.toContain('form-styles')
  })
})
