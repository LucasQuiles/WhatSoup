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

describe('design token component classes', () => {
  it('defines reusable input, dialog, and card classes in index.css', () => {
    const css = readTokenCss()

    for (const selector of [
      '.c-input',
      '.c-input-search',
      '.c-dialog-backdrop',
      '.c-dialog',
      '.c-dialog-body',
      '.c-card',
      '.c-card--detail',
    ]) {
      expect(css).toContain(selector)
    }
  })

  it('uses shared search input classes in SoupKitchen and Inbox', () => {
    const soupKitchen = read('console/src/pages/SoupKitchen.tsx')
    const inbox = read('console/src/pages/Inbox.tsx')

    // C2.3: SoupKitchen migrated to ToolbarSearch primitive; no longer uses c-input c-input-search.
    expect(soupKitchen).toContain('ToolbarSearch')
    expect(inbox).toContain('c-input c-input-search')
  })

  it('uses detail card classes for message bubble hover metadata', () => {
    const messageBubble = read('console/src/components/MessageBubble.tsx')

    expect(messageBubble).toContain('c-card c-card--detail')
  })

  it('keeps c-dialog visual-only and documents the canonical panel border token', () => {
    const css = readTokenCss()

    expect(css).not.toContain('width: min(100%, var(--panel-confirm));')
    expect(css).not.toContain('max-height: var(--modal-max-h);')
    expect(css).toContain('/* Canonical panel container border: use --b1 for c-card and c-section so all primary panels share the same boundary token. */')
    expect(css).toContain('.c-card {\n  background: var(--color-d2);\n  border: var(--bw) solid var(--b1);')
    expect(css).toContain('.c-section {\n  background: var(--color-d2);\n  border: var(--bw) solid var(--b1);')
  })
})
