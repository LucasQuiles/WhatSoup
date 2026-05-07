import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('SummaryTab provider card contract', () => {
  it('adds a provider card to agent summary metrics', () => {
    const source = readFileSync('console/src/components/line-detail/SummaryTab.tsx', 'utf8')

    expect(source).toContain("label: 'PROVIDER'")
    expect(source).toContain('providerDisplay')
    expect(source).toContain("line.mode === 'agent'")
  })
})
