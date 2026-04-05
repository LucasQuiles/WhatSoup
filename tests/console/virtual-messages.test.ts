import { describe, expect, it } from 'vitest'

import {
  createVirtualMessagesOptions,
  DEFAULT_MESSAGE_OVERSCAN,
  estimateMessageRowHeight,
  useVirtualMessages,
} from '../../console/src/hooks/use-virtual-messages.ts'
import type { Message } from '../../console/src/types.ts'

const shortOutgoing: Message = {
  pk: 101,
  conversationKey: 'chat-1',
  senderName: 'You',
  senderJid: 'me',
  content: 'ok',
  timestamp: '2026-04-05T12:00:00.000Z',
  fromMe: true,
  type: 'text',
}

const longIncoming: Message = {
  pk: 102,
  conversationKey: 'chat-1',
  senderName: 'Alex',
  senderJid: 'alex',
  content: 'This is a longer inbound message that should wrap across multiple estimated lines in the virtual list.',
  timestamp: '2026-04-05T12:01:00.000Z',
  fromMe: false,
  type: 'text',
}

const mediaIncoming: Message = {
  pk: 103,
  conversationKey: 'chat-1',
  senderName: 'Alex',
  senderJid: 'alex',
  content: 'photo.jpg',
  timestamp: '2026-04-05T12:02:00.000Z',
  fromMe: false,
  type: 'image',
}

describe('useVirtualMessages', () => {
  it('exports the hook and default overscan config', () => {
    expect(typeof useVirtualMessages).toBe('function')
    expect(DEFAULT_MESSAGE_OVERSCAN).toBe(8)
  })

  it('estimates taller rows for inbound and media messages', () => {
    expect(estimateMessageRowHeight(shortOutgoing)).toBe(76)
    expect(estimateMessageRowHeight(longIncoming)).toBe(130)
    expect(estimateMessageRowHeight(mediaIncoming)).toBe(118)
  })

  it('builds virtualizer options keyed by message pk', () => {
    const messages = [shortOutgoing, longIncoming, mediaIncoming]
    const getScrollElement = () => null

    const options = createVirtualMessagesOptions({ messages, getScrollElement })

    expect(options.count).toBe(3)
    expect(options.getScrollElement).toBe(getScrollElement)
    expect(options.overscan).toBe(DEFAULT_MESSAGE_OVERSCAN)
    expect(options.getItemKey?.(1)).toBe(102)
    expect(options.estimateSize(0)).toBe(76)
    expect(options.estimateSize(1)).toBe(130)
    expect(typeof options.measureElement).toBe('function')
  })
})
