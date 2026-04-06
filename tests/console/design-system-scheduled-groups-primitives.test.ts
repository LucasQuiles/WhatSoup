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
    expect(scheduledRow).not.toContain("borderTop: 'var(--bw) solid var(--b1)'")
    expect(groupDetail).not.toContain("borderBottom: 'var(--bw) solid var(--b1)'")
    expect(contactPicker).not.toContain("padding: 0")
    // bg-d1 and rounded-sm are now used intentionally on tag chips, not raw container fallback
    expect(contactPicker).not.toContain("border: 'var(--bw) solid var(--b1)'")
    expect(contactPicker).not.toContain("maxHeight: '200px'")
    // bg-d1 and rounded-md are used intentionally on picker chrome
    expect(chatPicker).not.toContain("border: 'var(--bw) solid var(--b1)'")
    expect(chatPicker).not.toContain("maxHeight: '240px'")
    expect(scheduledUtils).not.toContain('#3b82f6')
    expect(scheduledUtils).not.toContain('#ef4444')
  })

  it('keeps the updated modal surfaces on shared dialog/input/tab primitives', () => {
    const scheduleComposer = read('console/src/components/line-detail/ScheduleComposerModal.tsx')
    const groupDetail = read('console/src/components/line-detail/GroupDetailModal.tsx')

    expect(scheduleComposer).toContain('c-dialog-backdrop')
    expect(scheduleComposer).toContain('c-dialog-header')
    expect(scheduleComposer).toContain('c-dialog-footer')
    expect(scheduleComposer).toContain('className="c-input font-mono text-t2"')
    expect(groupDetail).toContain('className="c-tab"')
    expect(groupDetail).toContain('role="tablist"')
    expect(groupDetail).toContain('role="tab"')
  })

  it('extends eslint custom rules for hardcoded dimension and color literals', () => {
    const eslint = read('console/eslint.config.js')

    // Rules were consolidated — verify the key categories still exist
    expect(eslint).toContain('Hardcoded size px')
    expect(eslint).toContain('Bare vh/vw unit')
    expect(eslint).toContain('Raw numeric value (becomes px)')
    expect(eslint).toContain('Hardcoded hex color')
    expect(eslint).toContain('Border edge shorthand in style')
  })
})
