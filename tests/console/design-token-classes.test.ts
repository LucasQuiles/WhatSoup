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

    for (const selector of [
      '.c-input',
      '.c-input-search',
      '.c-card',
      '.c-card--detail',
    ]) {
      expect(css).toContain(selector)
    }
    // B3W4: .c-dialog-backdrop deleted — last consumer (AddLineWizard) migrated to Modal
    expect(css).not.toContain('.c-dialog-backdrop')
  })

  it('uses shared search input classes in SoupKitchen and Inbox', () => {
    const soupKitchen = read('console/src/pages/SoupKitchen.tsx')
    const inbox = read('console/src/pages/Inbox.tsx')

    // C2.3: SoupKitchen migrated to ToolbarSearch primitive; no longer uses c-input c-input-search.
    expect(soupKitchen).toContain('ToolbarSearch')
    // B4: Inbox migrated to shared SearchInput component — the last raw c-input-search
    // re-roll is gone; Inbox now imports and uses the shared SearchInput producer.
    expect(inbox).toContain('SearchInput')
    expect(inbox).not.toContain('c-input c-input-search')
  })

  it('uses detail card classes for message bubble hover metadata', () => {
    const messageBubble = read('console/src/components/MessageBubble.tsx')

    expect(messageBubble).toContain('c-card c-card--detail')
    expect(messageBubble).toContain('z-[var(--z-float)]')
    expect(messageBubble).not.toContain('z-50')
  })

  it('keeps c-dialog visual-only and documents the canonical panel border token', () => {
    const css = readTokenCss()

    expect(css).not.toContain('width: min(100%, var(--panel-confirm));')
    expect(css).not.toContain('max-height: var(--modal-max-h);')
    expect(css).toContain('/* Canonical panel container border: use --b1 for c-card and c-section so all primary panels share the same boundary token. */')
    expect(css).toContain('.c-card {\n  background: var(--color-d2);\n  border: var(--bw) solid var(--b1);')
    expect(css).toContain('.c-section {\n  background: var(--color-d2);\n  border: var(--bw) solid var(--b1);')
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

    expect(block).toContain('outline: none;')
    expect(block).toContain('background: var(--surface-overlay);')
    expect(block).toContain('box-shadow:')
    expect(block).toContain('var(--focus-ring)')
    expect(block).toContain('transition: none;')
  })
})
