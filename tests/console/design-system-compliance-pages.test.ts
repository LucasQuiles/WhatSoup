import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')
const sourceRoots = ['console/src/components', 'console/src/pages']

function tsxFiles(dir: string): string[] {
  return readdirSync(resolve(repoRoot, dir)).flatMap(entry => {
    const fullPath = resolve(repoRoot, dir, entry)
    const stat = statSync(fullPath)
    const relativePath = `${dir}/${entry}`
    if (stat.isDirectory()) return tsxFiles(relativePath)
    return /\.(?:ts|tsx)$/.test(entry) ? [relativePath] : []
  })
}

// Legacy consumer classes migrated to zero. Single source of truth for the
// re-entry guards below — both the className scan and the class-map scan read
// this map, so adding a class here extends every guard at once (no second
// design-law source).
const LEGACY_CONSUMER_CLASS = {
  'c-btn': /\bc-btn(?:\b|-)/,
  'c-pill': /\bc-pill(?:\b|-)/,
  'c-chip': /\bc-chip(?:\b|-)/,
} as const

// A source line that is wholly a comment (line, block, or JSDoc continuation).
// JSDoc prose like "* - Raw c-btn buttons → Button primitives" documents past
// migrations and must never trip a re-entry guard.
function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

// Extract the contents of every string literal (single/double/template) on a
// line. Detecting legacy classes *inside string literals* is what catches const
// class-maps, array/tuple elements, and clsx() operands that carry no
// `className=` on their line — the blind spot of classNameOffenders.
function stringLiteralsOf(line: string): string[] {
  const out: string[] = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push(m[2])
  return out
}

// Re-entry guards: legacy patterns migrated to zero. Pin each so it cannot
// silently creep back during parallel development.
function classNameOffenders(pattern: RegExp): string[] {
  return sourceRoots
    .flatMap(tsxFiles)
    .flatMap(path => read(path)
      .split('\n')
      .flatMap((line, index) => (
        line.includes('className=')
          && pattern.test(line)
          ? [`${relative(repoRoot, resolve(repoRoot, path))}:${index + 1}: ${line.trim()}`]
          : []
      )))
}

// Class-map scan: a legacy class hiding inside a string literal on any
// non-comment line (const maps, arrays, clsx operands, template literals) —
// regardless of whether `className=` appears on that line.
function classMapOffenders(pattern: RegExp): string[] {
  return sourceRoots
    .flatMap(tsxFiles)
    .flatMap(path => read(path)
      .split('\n')
      .flatMap((line, index) => (
        !isCommentLine(line)
          && stringLiteralsOf(line).some(literal => pattern.test(literal))
          ? [`${relative(repoRoot, resolve(repoRoot, path))}:${index + 1}: ${line.trim()}`]
          : []
      )))
}

function jsxElementOffenders(pattern: RegExp): string[] {
  return sourceRoots
    .flatMap(tsxFiles)
    .flatMap(path => read(path)
      .split('\n')
      .flatMap((line, index) => (
        pattern.test(line)
          ? [`${relative(repoRoot, resolve(repoRoot, path))}:${index + 1}: ${line.trim()}`]
          : []
      )))
}
// C0 token split: index.css is now a slim importer; design-token assertions read the full tier set.
const readTokenCss = () => [
  'console/src/index.css',
  'console/src/styles/tokens.primitive.css',
  'console/src/styles/tokens.semantic.css',
  'console/src/styles/tokens.component.css',
  'console/src/styles/composites.css',
].map(read).join('\n')

describe('design system compliance — Shannon slice', () => {
  it('keeps legacy c-btn classes out of source consumers', () => {
    expect(classNameOffenders(LEGACY_CONSUMER_CLASS['c-btn'])).toEqual([])
  })

  it('keeps other migrated-away legacy utility classes out of source consumers', () => {
    // c-pill / c-chip migrated to the Pill / Badge primitives — re-entry guards.
    expect(classNameOffenders(LEGACY_CONSUMER_CLASS['c-pill'])).toEqual([])
    expect(classNameOffenders(LEGACY_CONSUMER_CLASS['c-chip'])).toEqual([])
  })

  it('keeps legacy classes out of const class-maps, arrays, and clsx operands (className-scan blind spot)', () => {
    // RED PROOF — a const class-map / clsx operand carries no `className=` on its
    // line, so the className-gated scan is blind to it; the class-map scan is not.
    const classNameGated = (src: string, pattern: RegExp) =>
      src.split('\n').some(line => line.includes('className=') && pattern.test(line))
    const classMapGated = (src: string, pattern: RegExp) =>
      src.split('\n').some(line => !isCommentLine(line) && stringLiteralsOf(line).some(s => pattern.test(s)))

    const planted = [
      "const VARIANT = { ok: 'c-pill', warn: 'c-chip' }",
      "export const cls = clsx('c-btn', base)",
      "const arr = ['c-chip']",
      'const tpl = `c-btn ${active ? \'on\' : \'\'}`',
    ].join('\n')

    for (const pattern of Object.values(LEGACY_CONSUMER_CLASS)) {
      expect(classNameGated(planted, pattern)).toBe(false) // old scan misses it
      expect(classMapGated(planted, pattern)).toBe(true) // new scan catches it
    }
    // JSDoc/comment prose that mentions a legacy class must NOT be flagged.
    expect(classMapGated(' *   - Raw c-btn buttons → Button primitives', LEGACY_CONSUMER_CLASS['c-btn'])).toBe(false)

    // GREEN — the real source tree carries zero class-map offenders.
    for (const pattern of Object.values(LEGACY_CONSUMER_CLASS)) {
      expect(classMapOffenders(pattern)).toEqual([])
    }
  })

  it('keeps raw motion.button out of source consumers', () => {
    // Migrated to <Button> (+ motion.div where animation is needed) — re-entry guard.
    expect(jsxElementOffenders(/<motion\.button\b/)).toEqual([])
  })

  it('v3.5 chrome consumes tokens only (T5 b-02)', () => {
    const rail = read('console/src/components/chrome/NavRail.tsx')
    const header = read('console/src/components/chrome/ChromeHeader.tsx')
    const chrome = read('console/src/styles/chrome.css')

    // The TSX carries class hooks only — geometry/typography live in chrome.css.
    for (const source of [rail, header]) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code).not.toMatch(/\d+px/)
      expect(source).not.toMatch(/text-\[var\(--font-size-/)
      expect(source).not.toMatch(/text-\[var\(--text-/)
    }

    // The stylesheet consumes the --chrome-* geometry tier, the -v35 semantic
    // addendum, and the border-width tokens — pin the load-bearing recipes.
    expect(chrome).toContain('width: var(--chrome-rail-w);')
    expect(chrome).toContain('background: var(--accent-wash-v35);')
    expect(chrome).toContain('box-shadow: inset var(--bw-accent) 0 0 var(--accent-v35);')
    expect(chrome).toContain('@media (max-width: 1100px)')

    // Raw-dimension law: the only raw px in chrome.css declarations is the
    // sanctioned media-query literal (custom properties do not evaluate in
    // @media). Comments are stripped before the scan.
    const declarations = chrome.replace(/\/\*[\s\S]*?\*\//g, '')
    const rawPx = declarations.match(/\d+px/g) ?? []
    expect(rawPx).toEqual(['1100px'])
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

  it('associates Field labels with their controls in the FormControl primitive', () => {
    const primitives = read('console/src/components/primitives/FormControl.tsx')
    const shim = read('console/src/components/wizard/form-primitives.tsx')
    const configStep = read('console/src/components/wizard/ConfigStep.tsx')

    expect(primitives).toContain('useId')
    expect(primitives).toContain('htmlFor={id}')
    expect(primitives).toContain('children: (id: string) => ReactNode')
    expect(primitives).toContain('injectFieldControlProps(children(id), fieldProps)')
    expect(primitives).toContain("'aria-describedby'")
    expect(primitives).toContain("'aria-invalid'")
    expect(shim).toContain("from '../primitives/FormControl'")
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

    // Inbox migrated off the raw `.c-card` recipe onto the <Card> primitive (DD-38):
    // the three panes (chats, messages, contact) are each a <Card>. Assert the
    // primitive is used and no raw recipe class remains.
    expect((inbox.match(/<Card\b/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(inbox).not.toMatch(/className="[^"]*\bc-card\b/)
    // Interaction affordances are on the Button/ActionButton primitives.
    expect(inbox).toContain('<Button')
    expect(inbox).toContain('<ActionButton')
    expect(inbox).toContain('z-[var(--z-float)]')
    expect(inbox).toContain('aria-label="Type a message"')
    expect(inbox).toContain('aria-label="Clear search"')
  })

  it('Operator and SoupKitchen panels adopt the <Card> primitive and label the search input', () => {
    const ops = read('console/src/pages/Operator.tsx')
    const soupKitchen = read('console/src/pages/SoupKitchen.tsx')

    // Operator migrated off the raw `.c-card` recipe onto the <Card> primitive
    // (DD-38): the two outer panels are <Card variant="base"> and each line card
    // is an interactive <Card variant="interactive">. Assert the primitive is used
    // and the raw recipe is gone (no bypass).
    expect(ops).toContain('<Card')
    expect((ops.match(/<Card\b/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(ops).toContain('variant="base"')
    expect(ops).toContain('variant="interactive"')
    expect(ops).not.toMatch(/className="[^"]*\bc-card\b/)
    // SoupKitchen MIGRATED off the raw `.c-card` recipe onto the <Card> primitive
    // (DD-38, W2-S4 — the LAST raw-recipe page): its 4 surfaces are <Card variant="base">
    // (one motion-nested, three plain-div 1:1 swaps). Assert the primitive is used and the
    // raw recipe is gone (no bypass).
    expect(soupKitchen).toContain('<Card')
    expect((soupKitchen.match(/<Card\b/g) ?? []).length).toBeGreaterThanOrEqual(4)
    expect(soupKitchen).toContain('variant="base"')
    expect(soupKitchen).not.toMatch(/className="[^"]*\bc-card\b/)
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
    const navRail = read('console/src/components/chrome/NavRail.tsx')
    const pill = read('console/src/components/FilterPill.tsx')
    // text-[var(--font-size-*)] generates no CSS in TW4 (ambiguous)
    // text-[var(--text-*)] is redundant when text-* utility exists
    expect(navRail).not.toMatch(/text-\[var\(--font-size-/)
    expect(navRail).not.toMatch(/text-\[var\(--text-/)
    expect(pill).not.toMatch(/text-\[var\(--font-size-/)
    // C2 migration: FilterPill no longer styles its own text — the Pill primitive owns
    // typography via soup-pill classes (pill.md). Pin the delegation instead.
    expect(pill).toContain("from './primitives'")
    expect(pill).not.toMatch(/text-\[var\(--text-/)
  })

  it('fully dissolves form-styles.ts — no remaining imports in wizard components', () => {
    const exists = (() => { try { read('console/src/components/wizard/form-styles.ts'); return true } catch { return false } })()
    expect(exists).toBe(false)

    const primitives = read('console/src/components/primitives/FormControl.tsx')
    const shim = read('console/src/components/wizard/form-primitives.tsx')
    const identity = read('console/src/components/wizard/IdentityStep.tsx')
    const modelAuth = read('console/src/components/wizard/ModelAuthStep.tsx')

    expect(primitives).not.toContain('form-styles')
    expect(shim).not.toContain('form-styles')
    expect(identity).not.toContain('form-styles')
    expect(modelAuth).not.toContain('form-styles')
  })
})
