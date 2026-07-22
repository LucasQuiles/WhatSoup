import { describe, expect, it } from 'vitest'

import { resolveCurrentChat } from '../../console/src/lib/inbox-chat-selection.ts'
import type { ChatItem, Message } from '../../console/src/types.ts'

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
    conversationKey: 'direct-1',
    senderName: 'Alex',
    senderJid: '15551234567@s.whatsapp.net',
    content: 'hello from history',
    timestamp: '2026-04-05T12:00:00.000Z',
    fromMe: false,
    type: 'text',
    ...overrides,
  }
}

describe('resolveCurrentChat', () => {
  it('returns the chat list row when the selected chat is loaded', () => {
    const loaded = makeChat('chat-1', { name: 'Loaded Chat', unreadCount: 3 })

    const resolved = resolveCurrentChat([loaded], 'chat-1', [])

    expect(resolved).toBe(loaded)
  })

  it('builds a fallback chat for a deep-linked direct conversation missing from the first chat page', () => {
    const resolved = resolveCurrentChat([], 'direct-1', [
      makeMessage(2, { content: 'newest visible message', timestamp: '2026-04-05T12:03:00.000Z' }),
      makeMessage(1, { content: 'older visible message', timestamp: '2026-04-05T12:02:00.000Z' }),
    ])

    expect(resolved).toEqual({
      conversationKey: 'direct-1',
      name: 'Alex',
      lastMessagePreview: 'newest visible message',
      lastMessageAt: '2026-04-05T12:03:00.000Z',
      unreadCount: 0,
      isGroup: false,
    })
  })

  it('builds a fallback chat for a deep-linked group before messages load', () => {
    const resolved = resolveCurrentChat([], 'team-alpha_at_g.us', undefined)

    expect(resolved).toMatchObject({
      conversationKey: 'team-alpha_at_g.us',
      name: 'team-alpha_at_g.us',
      lastMessagePreview: '',
      lastMessageAt: '',
      unreadCount: 0,
      isGroup: true,
    })
  })

  it.each([
    ['Signal', 'Z3JvdXAtY29udmVyc2F0aW9u_at_signal'],
    ['iMessage', 'iMessage;+;chatABC_at_imessage'],
  ])('builds a group fallback for a deep-linked %s conversation', (_transport, conversationKey) => {
    expect(resolveCurrentChat([], conversationKey, undefined)).toMatchObject({
      conversationKey,
      isGroup: true,
    })
  })

  it('does not crash when fallback message sender names are nullish', () => {
    const resolved = resolveCurrentChat([], 'direct-1', [
      makeMessage(1, { senderName: null as unknown as string }),
    ])

    expect(resolved?.name).toBe('direct-1')
  })

  it('returns null when no chat is selected', () => {
    expect(resolveCurrentChat([], null, [])).toBeNull()
  })
})
