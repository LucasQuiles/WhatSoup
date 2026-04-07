import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')

describe('design system compliance — Shannon slice', () => {
  it('uses design tokens for Nav hardcoded pixel values', () => {
    const source = read('console/src/components/Nav.tsx')

    expect(source).toContain('left: "var(--sp-3)"')
    expect(source).toContain('right: "var(--sp-3)"')
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
    expect(heatmap).toContain("fontSize: 'var(--font-size-xs)'")

    expect(tags).not.toContain("gap: '3px'")
    expect(tags).toContain("gap-[var(--sp-0h)]")

    expect(content).not.toContain("maxHeight: '48px'")
    expect(content).toContain("maxHeight: 'var(--sp-12)'")
  })

  it('uses accessible button and textarea semantics in HistoryTab', () => {
    const source = read('console/src/components/line-detail/HistoryTab.tsx')

    expect(source).toContain('c-btn c-btn-sm')
    expect(source).toContain("z-[var(--z-float)]")
    expect(source).toContain('aria-label="Type a reply"')
  })

  it('adds dialog ARIA to AddLineWizard', () => {
    const source = read('console/src/components/AddLineWizard.tsx')

    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain('aria-labelledby="wizard-title"')
    expect(source).toContain('id="wizard-title"')
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

    expect(pipeline).toContain('<button')
    expect(pipeline).toContain('type="button"')
    expect(pipeline).toContain('className="c-btn c-btn-sm font-mono inline-flex items-center gap-1.5"')
    expect(pipeline).not.toContain('<span\n      className="inline-flex items-center gap-1.5"\n      onClick={onClick}')
  })

  it('migrates Inbox panels and interaction affordances to design-system classes', () => {
    const inbox = read('console/src/pages/Inbox.tsx')

    expect((inbox.match(/c-card/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(inbox).toContain('c-btn c-btn-ghost')
    expect(inbox).toContain('c-btn c-btn-sm')
    expect(inbox).toContain('z-[var(--z-float)]')
    expect(inbox).toContain('aria-label="Type a message"')
    expect(inbox).toContain('aria-label="Clear search"')
  })

  it('migrates Ops and SoupKitchen page panels to c-card and labels search input', () => {
    const ops = read('console/src/pages/Ops.tsx')
    const soupKitchen = read('console/src/pages/SoupKitchen.tsx')

    expect((ops.match(/c-card/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((soupKitchen.match(/c-card/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(soupKitchen).toContain('aria-label="Search lines"')
  })
})
