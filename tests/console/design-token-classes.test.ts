import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')
const readCompositeCss = () => read('console/src/styles/composites.css')
// C0 token split: index.css is now a slim importer; design-token assertions read the full tier set.
const readTokenCss = () => [
  'console/src/index.css',
  'console/src/styles/tokens.primitive.css',
  'console/src/styles/tokens.semantic.css',
  'console/src/styles/tokens.component.css',
  'console/src/styles/composites.css',
].map(read).join('\n')
// DD-38 closeout: the card recipe was absorbed into the Card primitive as
// `.soup-card` in primitives.css — card-class pins read it separately (the
// token set above keeps its original scope; primitives legitimately owns
// modal sizing declarations the c-dialog test forbids in composites).
const readPrimitivesCss = () => read('console/src/styles/primitives.css')

const blockFor = (css: string, selectorFragment: string) => {
  const selectorStart = css.indexOf(selectorFragment)
  expect(selectorStart).toBeGreaterThanOrEqual(0)

  const blockStart = css.indexOf('{', selectorStart)
  const blockEnd = css.indexOf('}', blockStart)
  expect(blockStart).toBeGreaterThan(selectorStart)
  expect(blockEnd).toBeGreaterThan(blockStart)

  return css.slice(blockStart + 1, blockEnd)
}

describe('design token component classes', () => {
  it('defines reusable input and card classes in index.css', () => {
    const css = readTokenCss()
    const primitivesCss = readPrimitivesCss()

    for (const selector of [
      '.c-input',
      '.c-input-search',
    ]) {
      expect(css).toContain(selector)
    }
    // DD-38 closeout: the card class is `.soup-card` (Card primitive,
    // primitives.css); the legacy `.c-card` recipe is deleted everywhere.
    expect(primitivesCss).toContain('.soup-card')
    expect(css).not.toMatch(/\.c-card\s*\{/)
    expect(primitivesCss).not.toMatch(/\.c-card\s*\{/)
    // DD-43: MessageBubble's detail card migrated onto the HoverCard primitive; the
    // `.c-card--detail` modifier had no other consumer and was deleted (composites.css).
    expect(css).not.toContain('.c-card--detail')
    // B3W4: .c-dialog-backdrop deleted — last consumer (AddLineWizard) migrated to Modal
    expect(css).not.toContain('.c-dialog-backdrop')
  })

  it('uses shared search input classes in SoupKitchen; v3.5 Inbox re-rolls no search input', () => {
    const soupKitchen = read('console/src/pages/SoupKitchen.tsx')
    const inbox = read('console/src/pages/Inbox.tsx')

    // C2.3: SoupKitchen migrated to ToolbarSearch primitive; no longer uses c-input c-input-search.
    expect(soupKitchen).toContain('ToolbarSearch')
    // T5 b-07: the in-conversation search lane left the inbox surface per the
    // v3.5 mockup SSOT (no search affordance in inbox.html). The pin that
    // remains meaningful: the page re-rolls NO raw search input of its own —
    // the B4 anti-re-roll law still holds, now by absence of the lane itself.
    expect(inbox).not.toContain('c-input c-input-search')
    expect(inbox).not.toContain('Search this conversation')
  })

  it('renders message-bubble hover metadata via the HoverCard primitive (DD-43)', () => {
    const messageBubble = read('console/src/components/MessageBubble.tsx')

    // DD-43: the hand-rolled detail Card migrated onto the canonical HoverCard primitive
    // (edge-anchored, the panel owns its surface/z-index). No raw Card recipe, no float
    // z-index, and never a raw `z-50` on the surface.
    expect(messageBubble).toContain('<HoverCard')
    expect(messageBubble).toContain('anchorX="edge"')
    expect(messageBubble).toContain('cardLabel="Message detail"')
    expect(messageBubble).not.toContain('c-card--detail')
    expect(messageBubble).not.toContain('z-50')
  })

  it('keeps c-dialog visual-only and documents the canonical panel border token', () => {
    const css = readTokenCss()

    expect(css).not.toContain('width: min(100%, var(--panel-confirm));')
    expect(css).not.toContain('max-height: var(--modal-max-h);')
    // DD-38 closeout: the card recipe moved to `.soup-card` in primitives.css
    // (declarations verbatim); c-section keeps the canonical border in composites.
    expect(readPrimitivesCss()).toContain('.soup-card {\n  background: var(--surface-raised);\n  border: var(--bw) solid var(--border-hairline);')
    expect(css).toContain('.c-section {\n  background: var(--surface-raised);\n  border: var(--bw) solid var(--border-hairline);')
  })

  it('keeps modal viewport-height tokens on dynamic viewport units', () => {
    const componentTokens = read('console/src/styles/tokens.component.css')
    const staticViewportHeightTokens = componentTokens
      .split('\n')
      .filter(line => /^\s*--.*(?:h|height).*:\s*[^;]*\b\d+(?:\.\d+)?vh\b/.test(line))

    expect(componentTokens).toContain('--modal-max-h: 85dvh;')
    expect(componentTokens).not.toContain('--modal-max-h: 85vh;')
    expect(staticViewportHeightTokens).toEqual([])
  })

  it('keeps shared control focus rings on the dedicated focus token', () => {
    const css = readCompositeCss()
    const modeOrStatusFocusColor = /--(?:color-[ms]-|[ms]-[a-z]+-(?:wash|soft|border|ring)|mode-|status-)/

    for (const selector of ['.c-input:focus-visible', '.c-select:focus-visible']) {
      const block = blockFor(css, selector)

      expect(block).toContain('border-color: var(--focus-ring);')
      expect(block).toContain('outline: 2px solid var(--focus-ring);')
      expect(block).toContain('outline-offset: var(--bw-focus);')
      expect(block).toContain('transition: none;')
      expect(block).not.toMatch(modeOrStatusFocusColor)
    }

    const globalActionFocus = blockFor(css, '\nbutton:focus-visible')
    expect(globalActionFocus).toContain('outline: 2px solid var(--focus-ring);')
    expect(globalActionFocus).toContain('outline-offset: var(--bw-accent);')
    expect(globalActionFocus).toContain('transition: none;')
    expect(globalActionFocus).not.toMatch(modeOrStatusFocusColor)

    const globalFormFocus = blockFor(css, '\ninput:focus-visible')
    expect(globalFormFocus).toContain('border-color: var(--focus-ring);')
    expect(globalFormFocus).toContain('outline: 2px solid var(--focus-ring);')
    expect(globalFormFocus).toContain('outline-offset: var(--bw-focus);')
    expect(globalFormFocus).toContain('transition: none;')
    expect(globalFormFocus).not.toMatch(modeOrStatusFocusColor)

    expect(css).not.toContain('Focus ring: --m-cht')
  })

  it('keeps ChatListItem rows on the tokenized focus-visible ring recipe', () => {
    const css = readCompositeCss()
    const block = blockFor(css, '.c-chat-item:focus-visible')

    expect(block).toContain('outline: var(--bw-accent) solid var(--focus-ring);')
    expect(block).toContain('outline-offset: calc(var(--bw-accent) * -1);')
    expect(block).toContain('background: var(--surface-overlay);')
    expect(block).toContain('box-shadow:')
    expect(block).toContain('var(--focus-ring)')
    expect(block).toContain('transition: none;')
  })
})
