import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('UpdateModal close controls', () => {
  it('icon-only close button carries aria-label="Close"', () => {
    const source = readFileSync(resolve(__dirname, '../../console/src/components/UpdateModal.tsx'), 'utf8')
    // The header X-button is icon-only — it must have aria-label="Close" so screen readers
    // announce it correctly.  Exactly one such button exists.
    const iconCloseButtons = source.match(/<button[^>]*aria-label="Close"[^>]*>\s*<X /g) ?? []
    expect(iconCloseButtons).toHaveLength(1)
  })

  it('text-labelled close buttons do not carry a redundant aria-label', () => {
    const source = readFileSync(resolve(__dirname, '../../console/src/components/UpdateModal.tsx'), 'utf8')
    // Buttons with visible text ("Cancel", "Close", "Skip") must derive their accessible name
    // from that text, not from a competing aria-label.  Any match here is a regression.
    const mismatchedLabels = source.match(/<button[^>]*aria-label="Close"[^>]*>[^<]*(?:Cancel|Skip)[^<]*<\/button>/g) ?? []
    expect(mismatchedLabels).toHaveLength(0)
  })
})
