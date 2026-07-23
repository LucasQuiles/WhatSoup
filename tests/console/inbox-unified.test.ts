/**
 * inbox-unified — pure-helper contracts for the v3.5 unified inbox plane.
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import type { ChatItem, LineInstance } from '../../console/src/types'
import {
  conversationId,
  conversationInitials,
  countByChannel,
  filterConversations,
  formatBubbleTime,
  formatListTime,
  mergeConversations,
  normalizeTypingJid,
  presentChannels,
  senderInitial,
} from '../../console/src/lib/inbox-unified'
import { channelOf } from '../../console/src/lib/transport-identity'

function line(name: string, kind?: string): LineInstance {
  return {
    name,
    health: kind
      ? { transport: { kind } }
      : null,
  } as unknown as LineInstance
}

function chat(key: string, overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey: key,
    name: `n-${key}`,
    lastMessagePreview: 'p',
    lastMessageAt: '',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

describe('channelOf (transport-identity home)', () => {
  it('maps transport kinds to the channel vocabulary', () => {
    expect(channelOf(line('a', 'baileys'))).toBe('wa')
    expect(channelOf(line('a', 'signal'))).toBe('signal')
    expect(channelOf(line('a', 'imessage'))).toBe('imessage')
    expect(channelOf(line('a', 'twilio'))).toBe('sms')
  })
  it('stays honest on absent or unknown health', () => {
    expect(channelOf(line('a'))).toBe('unknown')
    expect(channelOf(line('a', 'carrier-pigeon'))).toBe('unknown')
    expect(channelOf(undefined)).toBe('unknown')
  })
})

describe('mergeConversations', () => {
  it('merges across lines, stamps channel + line, sorts newest first', () => {
    const lines = [line('wa', 'baileys'), line('sig', 'signal')]
    const byLine = new Map<string, ChatItem[]>([
      ['wa', [chat('a', { lastMessageAt: '2026-07-23T10:00:00Z' }), chat('b', { lastMessageAt: '2026-07-23T12:00:00Z' })]],
      ['sig', [chat('c', { lastMessageAt: '2026-07-23T11:00:00Z' })]],
    ])
    const merged = mergeConversations(lines, byLine)
    expect(merged.map((c) => c.conversationKey)).toEqual(['b', 'c', 'a'])
    expect(merged[0]!.channel).toBe('wa')
    expect(merged[1]!.channel).toBe('signal')
    expect(merged[1]!.line).toBe('sig')
  })
  it('conversations with no timestamp sink rather than fabricating recency', () => {
    const lines = [line('wa', 'baileys')]
    const byLine = new Map<string, ChatItem[]>([
      ['wa', [chat('no-time'), chat('timed', { lastMessageAt: '2026-07-23T12:00:00Z' })]],
    ])
    const merged = mergeConversations(lines, byLine)
    expect(merged[0]!.conversationKey).toBe('timed')
    expect(merged[1]!.conversationKey).toBe('no-time')
  })
  it('lines without a loaded chat page contribute nothing', () => {
    const merged = mergeConversations([line('wa', 'baileys')], new Map())
    expect(merged).toEqual([])
  })
})

describe('presentChannels / countByChannel', () => {
  it('reports only channels with real conversations, in vocabulary order', () => {
    const merged = mergeConversations(
      [line('sig', 'signal'), line('wa', 'baileys')],
      new Map([
        ['sig', [chat('s1')]],
        ['wa', [chat('w1'), chat('w2')]],
      ]),
    )
    expect(presentChannels(merged)).toEqual(['wa', 'signal'])
    const counts = countByChannel(merged)
    expect(counts.get('wa')).toBe(2)
    expect(counts.get('signal')).toBe(1)
  })
})

describe('filterConversations', () => {
  const merged = mergeConversations(
    [line('wa', 'baileys')],
    new Map([
      ['wa', [chat('dm'), chat('g_at_g.us', { isGroup: true })]],
    ]),
  )
  it('seg splits direct from rooms', () => {
    expect(filterConversations(merged, 'all', 'direct').map((c) => c.conversationKey)).toEqual(['dm'])
    expect(filterConversations(merged, 'all', 'rooms').map((c) => c.conversationKey)).toEqual(['g_at_g.us'])
  })
  it('channel narrows within the seg', () => {
    expect(filterConversations(merged, 'wa', 'direct').length).toBe(1)
    expect(filterConversations(merged, 'signal', 'direct').length).toBe(0)
  })
})

// Repo convention (access-tab.test.tsx): 555-prefixed phone JIDs, short
// 120363NNN@g.us synthetic group JIDs — never real-shaped identifiers.
describe('normalizeTypingJid (mirrors src/core/conversation-key.ts)', () => {
  it('personal JIDs reduce to the bare local part', () => {
    expect(normalizeTypingJid('15550100001@s.whatsapp.net')).toBe('15550100001')
    expect(normalizeTypingJid('15550100001@lid')).toBe('15550100001')
  })
  it('strips device qualifiers from both personal and LID JIDs', () => {
    expect(normalizeTypingJid('15550100001:5@s.whatsapp.net')).toBe('15550100001')
    expect(normalizeTypingJid('15550100001:5@lid')).toBe('15550100001')
  })
  it('group JIDs map to the _at_g.us key form', () => {
    expect(normalizeTypingJid('120363001@g.us')).toBe('120363001_at_g.us')
  })
  it('foreign domains carry their domain suffix', () => {
    expect(normalizeTypingJid('+15551234567@signal')).toBe('+15551234567_at_signal')
  })
  it('garbage never produces a key (no false typing positives)', () => {
    expect(normalizeTypingJid('')).toBeNull()
    expect(normalizeTypingJid('no-at-sign')).toBeNull()
    expect(normalizeTypingJid('@s.whatsapp.net')).toBeNull()
  })
})

describe('time formatting', () => {
  it('list time is HH:MM same-day, MM/DD otherwise', () => {
    const now = new Date('2026-07-23T15:00:00Z')
    expect(formatListTime('2026-07-23T09:32:00Z', now)).toMatch(/^\d{2}:\d{2}$/)
    expect(formatListTime('2026-07-21T09:32:00Z', now)).toMatch(/^\d{2}\/\d{2}$/)
    expect(formatListTime('', now)).toBe('')
    expect(formatListTime('not-a-date', now)).toBe('')
  })
  it('bubble time is always HH:MM', () => {
    expect(formatBubbleTime('2026-07-21T09:32:00Z')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatBubbleTime('')).toBe('')
  })
})

describe('identity helpers', () => {
  it('conversation initials: two words, uppercased; honest fallback', () => {
    expect(conversationInitials('Lucas Quiles')).toBe('LQ')
    expect(conversationInitials('Mom')).toBe('M')
    expect(conversationInitials('  ')).toBe('·')
  })
  it('sender initial: first letter, uppercased', () => {
    expect(senderInitial('quinn')).toBe('Q')
    expect(senderInitial('')).toBe('·')
  })
  it('conversationId joins line and key unambiguously', () => {
    expect(conversationId('personal', 'conv-a')).toBe('personal\nconv-a')
  })
})
