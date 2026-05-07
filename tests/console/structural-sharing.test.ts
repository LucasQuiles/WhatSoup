import { describe, expect, it } from 'vitest'

import type { ChatItem, LineInstance, Message } from '../../console/src/types.ts'
import {
  mergeChatsByConversationKey,
  mergeLineByName,
  mergeLinesByName,
  mergeMessagesByPk,
  shareChatsByConversationKey,
  shareLinesByName,
  shareMessagesByPk,
} from '../../console/src/lib/structural-sharing.ts'
import {
  getChatsQueryOptions,
  getLinesQueryOptions,
  getMessagesQueryOptions,
} from '../../console/src/hooks/use-fleet.ts'

function makeLine(name: string, overrides: Partial<LineInstance> = {}): LineInstance {
  return {
    name,
    phone: `+1-555-${name}`,
    mode: 'passive',
    status: 'online',
    accessMode: 'allowAll',
    healthPort: 3100,
    uptime: '1h',
    messagesTotal: 10,
    health: null,
    heartbeat: ['up'],
    lastActive: '2026-04-05T12:00:00.000Z',
    error: null,
    ...overrides,
  }
}

function makeChat(conversationKey: string, overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey,
    name: conversationKey,
    lastMessagePreview: 'hello',
    lastMessageAt: '2026-04-05T12:00:00.000Z',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

function makeMessage(pk: number, overrides: Partial<Message> = {}): Message {
  return {
    pk,
    conversationKey: 'chat-1',
    senderName: 'Alex',
    senderJid: `jid-${pk}`,
    content: `message-${pk}`,
    timestamp: '2026-04-05T12:00:00.000Z',
    fromMe: false,
    type: 'text',
    ...overrides,
  }
}

describe('structural sharing helpers', () => {
  it('reuses unchanged lines by name even when order changes', () => {
    const alpha = makeLine('alpha')
    const beta = makeLine('beta', { unread: 2 })
    const previous = [alpha, beta]

    const merged = mergeLinesByName(previous, [
      makeLine('beta', { unread: 2 }),
      makeLine('alpha', { unread: 3 }),
    ])

    expect(merged[0]).toBe(beta)
    expect(merged[1]).not.toBe(alpha)
    expect(merged[1].name).toBe('alpha')
    expect(merged[1].unread).toBe(3)
  })

  it('returns the previous chat array when all chat rows are unchanged', () => {
    const previous = [makeChat('chat-a'), makeChat('chat-b', { unreadCount: 1 })]

    const merged = mergeChatsByConversationKey(previous, [
      makeChat('chat-a'),
      makeChat('chat-b', { unreadCount: 1 }),
    ])

    expect(merged).toBe(previous)
    expect(merged[0]).toBe(previous[0])
    expect(merged[1]).toBe(previous[1])
  })

  it('reuses existing messages by pk when older pages are appended', () => {
    const first = makeMessage(3)
    const second = makeMessage(2)
    const previous = [first, second]

    const merged = mergeMessagesByPk(previous, [
      makeMessage(3),
      makeMessage(2),
      makeMessage(1),
    ])

    expect(merged[0]).toBe(first)
    expect(merged[1]).toBe(second)
    expect(merged[2].pk).toBe(1)
  })

  it('preserves loaded older message pages when realtime refetch returns the newest page', () => {
    const previousNewest = makeMessage(5)
    const previousSecond = makeMessage(4)
    const loadedOlder = makeMessage(3)
    const loadedOldest = makeMessage(2)
    const previous = [previousNewest, previousSecond, loadedOlder, loadedOldest]

    const merged = mergeMessagesByPk(previous, [
      makeMessage(6),
      makeMessage(5),
      makeMessage(4),
    ])

    expect(merged.map((message) => message.pk)).toEqual([6, 5, 4, 3, 2])
    expect(merged[1]).toBe(previousNewest)
    expect(merged[2]).toBe(previousSecond)
    expect(merged[3]).toBe(loadedOlder)
    expect(merged[4]).toBe(loadedOldest)
  })

  it('does not preserve optimistic placeholders when replacing with server messages', () => {
    const loadedOlder = makeMessage(4)
    const previous = [
      makeMessage(-100, { content: 'optimistic' }),
      makeMessage(5),
      loadedOlder,
    ]

    const merged = mergeMessagesByPk(previous, [
      makeMessage(6),
      makeMessage(5),
    ])

    expect(merged.map((message) => message.pk)).toEqual([6, 5, 4])
    expect(merged[2]).toBe(loadedOlder)
  })

  it('does not preserve missing messages from inside the refreshed page range', () => {
    const previous = [
      makeMessage(5),
      makeMessage(4),
      makeMessage(3),
      makeMessage(2),
    ]

    const merged = mergeMessagesByPk(previous, [
      makeMessage(5),
      makeMessage(3),
    ])

    expect(merged.map((message) => message.pk)).toEqual([5, 3, 2])
  })

  it('reuses an unchanged single line by name', () => {
    const previous = makeLine('alpha', { unread: 7 })

    const merged = mergeLineByName(previous, makeLine('alpha', { unread: 7 }))

    expect(merged).toBe(previous)
  })
})

describe('fleet query option wiring', () => {
  it('wires structural sharing into lines, chats, and messages queries', () => {
    expect(getLinesQueryOptions().structuralSharing).toBe(shareLinesByName)
    expect(getChatsQueryOptions('line-a').structuralSharing).toBe(shareChatsByConversationKey)
    expect(getMessagesQueryOptions('line-a', 'chat-a').structuralSharing).toBe(shareMessagesByPk)
  })
})
