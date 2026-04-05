import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('UpdateModal close controls', () => {
  it('labels every handleClose button for screen readers', () => {
    const source = readFileSync(resolve(__dirname, '../../console/src/components/UpdateModal.tsx'), 'utf8')
    const labeledCloseButtons = source.match(/<button[^>]*onClick=\{handleClose\}[^>]*aria-label="Close"/g) ?? []
    expect(labeledCloseButtons).toHaveLength(4)
  })
})
