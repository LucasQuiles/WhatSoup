import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')

describe('design token component classes', () => {
  it('defines reusable input, dialog, and card classes in index.css', () => {
    const css = read('console/src/index.css')

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

    expect(soupKitchen).toContain('c-input c-input-search')
    expect(inbox).toContain('c-input c-input-search')
  })

  it('uses detail card classes for message bubble hover metadata', () => {
    const messageBubble = read('console/src/components/MessageBubble.tsx')

    expect(messageBubble).toContain('c-card c-card--detail')
  })
})
