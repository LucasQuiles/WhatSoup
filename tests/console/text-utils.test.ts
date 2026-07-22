import { describe, expect, it } from 'vitest'

import {
  capitalize,
  buildSelfJid,
  displayInstanceName,
  formatCompact,
  formatCount,
  formatPhone,
  getInitials,
  lineIdentity,
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

  it.each([
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@signal', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    ['+15550001111@signal', '+1 555-000-1111'],
    ['Z3JvdXAtY29udmVyc2F0aW9u@signal', 'Z3JvdXAtY29udmVyc2F0aW9u'],
    ['owner@example.com@imessage', 'owner@example.com'],
    ['iMessage;+;chat123@imessage', 'iMessage;+;chat123'],
    ['+15550002222@sms', '+1 555-000-2222'],
    ['+15550002222evil@sms', '+15550002222evil@sms'],
    ['owner@example.com', 'owner@example.com'],
  ])('preserves transport-aware conversation identity %s', (identity, expected) => {
    expect(resolveDisplayName(identity)).toBe(expected)
  })

  it.each([
    ['@signal', '—'],
    ['@imessage', '—'],
    ['unknown@signal', '—'],
    ['not connected@imessage', '—'],
    ['+15550001111evil@signal', '+15550001111evil@signal'],
    ['safe\u202Eevil@signal', 'safe\\u202Eevil@signal'],
    ['safe\u0007evil@imessage', 'safe\\u0007evil@imessage'],
  ])('fails closed for malformed or control-bearing transport identity %s', (identity, expected) => {
    expect(resolveDisplayName(identity)).toBe(expected)
  })

  it('keeps escaped controls distinct from literal escape text', () => {
    const controlled = resolveDisplayName('safe\u202Eevil@signal')
    const literal = resolveDisplayName('safe\\u202Eevil@signal')

    expect(controlled).toBe('safe\\u202Eevil@signal')
    expect(literal).toBe('safe\\\\u202Eevil@signal')
    expect(controlled).not.toBe(literal)
  })

  it('does not trim boundary controls before making them visible', () => {
    expect(resolveDisplayName('\nevil@signal')).toBe('\\u000Aevil@signal')
    expect(lineIdentity({
      transport: 'signal',
      selfId: '\nevil@signal',
      phone: '+15550009999',
    })).toBe('\\u000Aevil@signal')
  })

  it.each([
    ['safe\u200Bevil@signal', 'safe\\u200Bevil@signal'],
    ['safe\u2060evil@signal', 'safe\\u2060evil@signal'],
    ['safe\uFEFFevil@signal', 'safe\\uFEFFevil@signal'],
    ['safe\u070Fevil@signal', 'safe\\u070Fevil@signal'],
    ['safe\u{E0001}evil@signal', 'safe\\u{E0001}evil@signal'],
  ])('makes default-ignorable identity code points visible for %s', (identity, expected) => {
    expect(resolveDisplayName(identity)).toBe(expected)
  })

  it.each([
    ['\u00A0evil@signal', '\\u00A0evil@signal'],
    ['safe\u2028evil@signal', 'safe\\u2028evil@signal'],
    ['safe\u2029evil@signal', 'safe\\u2029evil@signal'],
    ['\u1680evil@signal', '\\u1680evil@signal'],
    ['\u2000evil@signal', '\\u2000evil@signal'],
    ['\u202Fevil@signal', '\\u202Fevil@signal'],
    ['\u205Fevil@signal', '\\u205Fevil@signal'],
    ['\u3000evil@signal', '\\u3000evil@signal'],
  ])('makes non-ASCII identity separators visible for %s', (identity, expected) => {
    expect(resolveDisplayName(identity)).toBe(expected)
    const withoutSeparator = identity.replace(/[\u00A0\u1680\u2000\u2028\u2029\u202F\u205F\u3000]/u, '')
    expect(resolveDisplayName(identity)).not.toBe(resolveDisplayName(withoutSeparator))
  })

  it('prefers the generic line self identity over the legacy phone field', () => {
    expect(lineIdentity({
      transport: 'signal',
      selfId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@signal',
      phone: '+15550009999',
    })).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(lineIdentity({ phone: '+15550009999' })).toBe('+15550009999')
    expect(lineIdentity({ selfId: 'UNKNOWN', phone: '+15550009999' })).toBe('+15550009999')
    expect(lineIdentity({
      transport: 'future',
      selfId: 'opaque@signal',
      phone: '+15550009999',
    })).toBe('opaque@signal')
    expect(lineIdentity({
      transport: 'imessage',
      selfId: 'opaque@signal',
      phone: '+15550009999',
    })).toBe('opaque@signal')
    expect(lineIdentity({
      transport: 'signal',
      selfId: 'unknown@signal',
      phone: '+15550009999',
    })).toBe('+15550009999')
    expect(lineIdentity({
      transport: 'signal',
      selfId: 'safe\u202Eevil@signal',
      phone: '+15550009999',
    })).toBe('safe\\u202Eevil@signal')
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
