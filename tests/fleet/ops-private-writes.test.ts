import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('fleet ops private file writes', () => {
  it('does not use bare string encoding for direct file writes', () => {
    const source = readFileSync('src/fleet/routes/ops.ts', 'utf-8')
    const unsafeWrites = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(({ text }) => text.includes('fs.writeFileSync('))
      .filter(({ text }) => /,\s*['"]utf-8['"]\s*\)/.test(text))

    expect(unsafeWrites).toEqual([])
  })
})
