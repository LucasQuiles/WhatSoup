import { describe, expect, it } from 'vitest'

import {
  capitalize,
  buildSelfJid,
  displayInstanceName,
  formatCompact,
  formatCount,
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

  it('formats linked IDs and non-US phone-like identifiers for display', () => {
    expect(resolveDisplayName('123456789012345')).toBe('Contact 2345')
    expect(resolveDisplayName('abc123456789012345@lid')).toBe('Contact 2345')
    expect(formatPhone('441234567890')).toBe('+44 123-456-7890')
    expect(formatPhone('12345678901234567890')).toBe('#567890')
    expect(formatPhone('12345')).toBe('+12345')
  })

  it('formats compact counts by magnitude', () => {
    expect(formatCompact(999)).toBe('999')
    expect(formatCompact(1_234)).toBe('1.2K')
    expect(formatCompact(12_345)).toBe('12K')
    expect(formatCompact(2_450_000)).toBe('2.5M')
  })

  it('formats exact counts through the shared helper', () => {
    expect(formatCount(1234567)).toBe('1,234,567')
    expect(formatCount(null)).toBe('0')
    expect(formatCount(Number.NaN)).toBe('0')
  })

  it('builds transport-native self JIDs idempotently', () => {
    expect(buildSelfJid('baileys', '15551234567')).toBe('15551234567@s.whatsapp.net')
    expect(buildSelfJid('twilio', '+15551234567')).toBe('+15551234567@sms')
    expect(buildSelfJid('signal', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@signal')
    expect(buildSelfJid('imessage', 'owner@example.com')).toBe('owner@example.com@imessage')
    expect(buildSelfJid('signal', '+15551234567@signal')).toBe('+15551234567@signal')
    expect(buildSelfJid('imessage', 'owner@example.com@imessage')).toBe('owner@example.com@imessage')
    expect(buildSelfJid('signal', 'not connected')).toBeUndefined()
  })
})
