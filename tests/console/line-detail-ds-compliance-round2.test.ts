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

const lineDetailFiles = [
  'console/src/components/line-detail/ScheduledTab.tsx',
  'console/src/components/line-detail/ScheduledMessageRow.tsx',
  'console/src/components/line-detail/ScheduleComposerModal.tsx',
  'console/src/components/line-detail/GroupsTab.tsx',
  'console/src/components/line-detail/GroupCard.tsx',
  'console/src/components/line-detail/GroupDetailModal.tsx',
  'console/src/components/line-detail/CreateGroupModal.tsx',
] as const

describe('design system compliance — round 2 shared search inputs', () => {
  it('extracts the shared search shell into SearchInput', () => {
    const searchInput = read('console/src/components/shared/SearchInput.tsx')
    const contactPicker = read('console/src/components/shared/ContactSearchPicker.tsx')
    const chatPicker = read('console/src/components/shared/ChatPicker.tsx')

    expect(searchInput).toContain('export function SearchInput')
    expect(searchInput).toContain('c-input c-input-search')

    expect(contactPicker).toContain("import { SearchInput } from './SearchInput.js'")
    expect(chatPicker).toContain("import { SearchInput } from './SearchInput.js'")
    expect(contactPicker).toContain('<SearchInput')
    expect(chatPicker).toContain('<SearchInput')
    expect(contactPicker).not.toContain('Search size={14}')
    expect(chatPicker).not.toContain('Search size={14}')
  })

  it('uses shared dialog, card, tab, and input primitives across the scheduled/group surfaces', () => {
    const createGroup = read('console/src/components/line-detail/CreateGroupModal.tsx')
    const scheduleComposer = read('console/src/components/line-detail/ScheduleComposerModal.tsx')
    const groupDetail = read('console/src/components/line-detail/GroupDetailModal.tsx')
    const groupCard = read('console/src/components/line-detail/GroupCard.tsx')
    const scheduledRow = read('console/src/components/line-detail/ScheduledMessageRow.tsx')

    // B3 wave 1: CreateGroupModal migrated. B3 wave 2: ScheduleComposerModal migrated.
    // GroupDetailModal keeps legacy pins until wave 3.
    expect(createGroup).toContain('Modal')
    expect(createGroup).toContain('ModalHeader')
    expect(createGroup).toContain('ModalFooter')
    expect(createGroup).not.toContain('c-dialog-backdrop')

    // groupDetail still on legacy shell (wave 3)
    for (const modal of [groupDetail]) {
      expect(modal).toContain('c-dialog-backdrop')
      expect(modal).toContain('c-dialog')
      expect(modal).toContain('c-dialog-header')
    }

    // scheduleComposer now on Modal primitive (B3 wave 2)
    expect(scheduleComposer).toContain('Modal')
    expect(scheduleComposer).toContain('ModalHeader')
    expect(scheduleComposer).toContain('ModalFooter')
    expect(scheduleComposer).not.toContain('c-dialog-backdrop')
    expect(createGroup).toContain('className="c-input font-mono text-t2"')
    expect(scheduleComposer).toContain('className="c-input font-mono text-t2')
    expect(groupDetail).toContain('className="c-tab"')
    expect(groupDetail).toContain('<SearchInput')
    expect(groupCard).toContain('className="c-card')
    expect(scheduledRow).toContain('className="c-card')
  })
})

describe('design system compliance — round 2 token cleanup', () => {
  it('defines the added opacity token and keeps orphan tokens deleted', () => {
    const css = readTokenCss()

    expect(css).toContain('--opacity-faint:')
    // --radius-circle was removed at the C0 token split as a zero-consumer orphan
    // (docs/design-system cutover plan); it must stay deleted.
    expect(css).not.toContain('--radius-circle:')
  })

  it('removes raw hex fallbacks from the new line-detail files', () => {
    for (const path of lineDetailFiles) {
      expect(read(path)).not.toMatch(/#[0-9a-fA-F]{3,8}/)
    }
  })

  it('removes remaining hardcoded numeric style literals from the touched detail components', () => {
    const scheduledRow = read('console/src/components/line-detail/ScheduledMessageRow.tsx')
    const scheduleComposer = read('console/src/components/line-detail/ScheduleComposerModal.tsx')
    const groupCard = read('console/src/components/line-detail/GroupCard.tsx')
    const groupDetail = read('console/src/components/line-detail/GroupDetailModal.tsx')
    const createGroup = read('console/src/components/line-detail/CreateGroupModal.tsx')

    for (const literal of [
      "marginTop: '2px'",
      "gap: '4px'",
      "width: '6px'",
      "height: '6px'",
      "marginTop: '3px'",
      'opacity: 0.4',
      "var(--color-info, #3b82f6)",
      "var(--color-error, #ef4444)",
    ]) {
      expect(scheduledRow).not.toContain(literal)
    }

    for (const literal of [
      "maxWidth: '95vw'",
      "maxHeight: '90vh'",
      "minHeight: '96px'",
      "var(--color-info, #3b82f6)",
    ]) {
      expect(scheduleComposer).not.toContain(literal)
    }

    for (const literal of [
      'width: 36',
      'height: 36',
      "padding: '1px var(--sp-1)'",
      "marginTop: '2px'",
      "marginRight: '4px'",
      "verticalAlign: '-1px'",
      "borderRadius: '50%'",
    ]) {
      expect(groupCard).not.toContain(literal)
    }

    for (const literal of [
      "minHeight: '72px'",
      'minWidth: 80',
      "padding: '1px var(--sp-1)'",
      'width: 32',
      'height: 32',
      "maxWidth: '90%'",
      "maxHeight: '80vh'",
      "borderRadius: '50%'",
      'z-50',
    ]) {
      expect(groupDetail).not.toContain(literal)
    }
    expect(groupDetail).toContain('max-h-[var(--modal-max-h)]')

    for (const literal of [
      "maxWidth: '90%'",
      "maxHeight: '80vh'",
      'z-50',
    ]) {
      expect(createGroup).not.toContain(literal)
    }

    expect(scheduleComposer).not.toContain('z-50')
  })
})
