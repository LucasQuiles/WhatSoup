import { describe, expect, it } from 'vitest'

import {
  capitalize,
  displayInstanceName,
  formatPhone,
  getInitials,
  resolveDisplayName,
  stripMarkdown,
} from '../../console/src/lib/text-utils'

describe('console text utilities', () => {
  it('keeps shared display helpers safe for missing runtime values', () => {
    expect(capitalize(null as unknown as string)).toBe('')
    expect(capitalize(undefined as unknown as string)).toBe('')

    expect(displayInstanceName(null as unknown as string)).toBe('—')
    expect(displayInstanceName(undefined as unknown as string)).toBe('—')

    expect(getInitials(null as unknown as string)).toBe('')
    expect(getInitials(undefined as unknown as string)).toBe('')

    expect(stripMarkdown(null as unknown as string)).toBe('')
    expect(stripMarkdown(undefined as unknown as string)).toBe('')

    expect(formatPhone(null as unknown as string)).toBe('—')
    expect(formatPhone(undefined as unknown as string)).toBe('—')
    expect(formatPhone('not-a-number')).toBe('—')

    expect(resolveDisplayName(null)).toBe('—')
    expect(resolveDisplayName(undefined)).toBe('—')
  })

  it('formats numeric display names without crashing render paths', () => {
    expect(resolveDisplayName(15551234567)).toBe('+1 555-123-4567')
    expect(formatPhone(15551234567)).toBe('+1 555-123-4567')
  })

  it('preserves existing string formatting behavior', () => {
    expect(capitalize('agent')).toBe('Agent')
    expect(displayInstanceName('q')).toBe('Q')
    expect(getInitials('Ada Lovelace')).toBe('AL')
    expect(stripMarkdown('**hello** `world`')).toBe('hello world')
    expect(resolveDisplayName('15551234567@s.whatsapp.net')).toBe('+1 555-123-4567')
  })
})
