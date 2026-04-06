import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')

describe('scheduled/groups design-system primitives', () => {
  it('extracts a shared search input primitive for picker surfaces', () => {
    const contactPicker = read('console/src/components/shared/ContactSearchPicker.tsx')
    const chatPicker = read('console/src/components/shared/ChatPicker.tsx')
    const searchInput = read('console/src/components/shared/SearchInput.tsx')

    expect(searchInput).toContain('c-input c-input-search')
    expect(searchInput).toContain('Search')

    expect(contactPicker).toContain("from './SearchInput")
    expect(chatPicker).toContain("from './SearchInput")
    expect(contactPicker).toContain('<SearchInput')
    expect(chatPicker).toContain('<SearchInput')
  })

  it('removes raw fallback colors and hardcoded numeric style literals from the new surfaces', () => {
    const scheduleComposer = read('console/src/components/line-detail/ScheduleComposerModal.tsx')
    const groupDetail = read('console/src/components/line-detail/GroupDetailModal.tsx')
    const groupCard = read('console/src/components/line-detail/GroupCard.tsx')
    const scheduledRow = read('console/src/components/line-detail/ScheduledMessageRow.tsx')
    const contactPicker = read('console/src/components/shared/ContactSearchPicker.tsx')
    const chatPicker = read('console/src/components/shared/ChatPicker.tsx')
    const scheduledUtils = read('console/src/components/line-detail/scheduled-utils.ts')

    expect(scheduleComposer).not.toContain('#3b82f6')
    expect(groupDetail).not.toContain('minWidth: 80')
    expect(groupDetail).not.toContain("minHeight: '72px'")
    expect(groupCard).not.toContain('width: 36')
    expect(groupCard).not.toContain('height: 36')
    expect(groupCard).not.toContain("marginTop: '2px'")
    expect(scheduledRow).not.toContain("width: '6px'")
    expect(scheduledRow).not.toContain("height: '6px'")
    expect(scheduledRow).not.toContain('#ef4444')
    expect(contactPicker).not.toContain("padding: 0")
    expect(contactPicker).not.toContain("maxHeight: '200px'")
    expect(chatPicker).not.toContain("maxHeight: '240px'")
    expect(scheduledUtils).not.toContain('#3b82f6')
    expect(scheduledUtils).not.toContain('#ef4444')
  })

  it('extends eslint custom rules for hardcoded dimension and color literals', () => {
    const eslint = read('console/eslint.config.js')

    expect(eslint).toContain('Hardcoded minHeight px')
    expect(eslint).toContain('Hardcoded maxHeight px')
    expect(eslint).toContain('Hardcoded maxHeight viewport unit')
    expect(eslint).toContain('Hardcoded numeric size literal')
    expect(eslint).toContain('Hardcoded hex color')
  })
})
