import { describe, it, expect, vi } from 'vitest'
import {
  estimateMessageRowHeight,
  createVirtualMessagesOptions,
  DEFAULT_MESSAGE_OVERSCAN,
} from '../../console/src/hooks/use-virtual-messages'
import type { Message } from '../../console/src/types'

type TestMessage = Pick<Message, 'pk' | 'content' | 'type' | 'fromMe'>

describe('use-virtual-messages', () => {
  describe('estimateMessageRowHeight', () => {
    const BASE_HEIGHT = 76

    it('returns base height for simple text message', () => {
      const message: TestMessage = {
        pk: 1,
        content: 'Hi',
        type: 'text',
        fromMe: true,
      }
      const height = estimateMessageRowHeight(message)
      expect(height).toBe(BASE_HEIGHT)
    })

    it('adds label height for incoming messages', () => {
      const incomingMessage: TestMessage = {
        pk: 1,
        content: 'Hi',
        type: 'text',
        fromMe: false,
      }
      const outgoingMessage: TestMessage = {
        pk: 2,
        content: 'Hi',
        type: 'text',
        fromMe: true,
      }

      const incomingHeight = estimateMessageRowHeight(incomingMessage)
      const outgoingHeight = estimateMessageRowHeight(outgoingMessage)

      expect(incomingHeight).toBeGreaterThan(outgoingHeight)
      expect(incomingHeight).toBe(outgoingHeight + 18)
    })

    it('adds media bonus height for non-text messages', () => {
      const textMessage: TestMessage = {
        pk: 1,
        content: 'Message',
        type: 'text',
        fromMe: true,
      }
      const mediaMessage: TestMessage = {
        pk: 2,
        content: 'Image',
        type: 'image',
        fromMe: true,
      }

      const textHeight = estimateMessageRowHeight(textMessage)
      const mediaHeight = estimateMessageRowHeight(mediaMessage)

      expect(mediaHeight).toBe(textHeight + 24)
    })

    it('scales height with content length', () => {
      const shortMessage: TestMessage = {
        pk: 1,
        content: 'Hi',
        type: 'text',
        fromMe: true,
      }
      const longMessage: TestMessage = {
        pk: 2,
        content: 'This is a very long message that will wrap across multiple lines in the chat view',
        type: 'text',
        fromMe: true,
      }

      const shortHeight = estimateMessageRowHeight(shortMessage)
      const longHeight = estimateMessageRowHeight(longMessage)

      expect(longHeight).toBeGreaterThan(shortHeight)
    })

    it('calculates line count based on characters per line (40)', () => {
      const message40Chars: TestMessage = {
        pk: 1,
        content: 'x'.repeat(40),
        type: 'text',
        fromMe: true,
      }
      const message80Chars: TestMessage = {
        pk: 2,
        content: 'x'.repeat(80),
        type: 'text',
        fromMe: true,
      }

      const height40 = estimateMessageRowHeight(message40Chars)
      const height80 = estimateMessageRowHeight(message80Chars)

      expect(height80).toBeGreaterThan(height40)
    })

    it('handles null message', () => {
      const height = estimateMessageRowHeight(null)
      expect(height).toBe(BASE_HEIGHT)
    })

    it('handles undefined message', () => {
      const height = estimateMessageRowHeight(undefined)
      expect(height).toBe(BASE_HEIGHT)
    })

    it('treats whitespace-only content as single line', () => {
      const message: TestMessage = {
        pk: 1,
        content: '     ',
        type: 'text',
        fromMe: true,
      }
      const height = estimateMessageRowHeight(message)
      expect(height).toBe(BASE_HEIGHT)
    })

    it('combines incoming label and media bonus heights', () => {
      const message: TestMessage = {
        pk: 1,
        content: 'Media message',
        type: 'image',
        fromMe: false,
      }
      const height = estimateMessageRowHeight(message)
      expect(height).toBe(BASE_HEIGHT + 18 + 24)
    })

    it('handles message with no type field', () => {
      const message: TestMessage = {
        pk: 1,
        content: 'Message',
        type: undefined as any,
        fromMe: true,
      }
      const height = estimateMessageRowHeight(message)
      expect(height).toBe(BASE_HEIGHT)
    })
  })

  describe('createVirtualMessagesOptions', () => {
    it('returns options with correct count', () => {
      const messages: TestMessage[] = [
        { pk: 1, content: 'Message 1', type: 'text', fromMe: true },
        { pk: 2, content: 'Message 2', type: 'text', fromMe: false },
      ]
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      expect(options.count).toBe(2)
    })

    it('uses default overscan value', () => {
      const messages: TestMessage[] = []
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      expect(options.overscan).toBe(DEFAULT_MESSAGE_OVERSCAN)
    })

    it('uses custom overscan value when provided', () => {
      const messages: TestMessage[] = []
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({
        messages,
        getScrollElement,
        overscan: 5,
      })

      expect(options.overscan).toBe(5)
    })

    it('sets gap between messages', () => {
      const messages: TestMessage[] = []
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      expect(options.gap).toBe(12)
    })

    it('provides getScrollElement function', () => {
      const messages: TestMessage[] = []
      const mockScrollElement = {} as any // Mock element
      const getScrollElement = vi.fn(() => mockScrollElement)

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      expect(options.getScrollElement).toBe(getScrollElement)
      expect(options.getScrollElement()).toBe(mockScrollElement)
    })

    it('getItemKey returns pk for valid messages', () => {
      const messages: TestMessage[] = [
        { pk: 100, content: 'Message', type: 'text', fromMe: true },
        { pk: 200, content: 'Message', type: 'text', fromMe: false },
      ]
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      expect(options.getItemKey?.(0)).toBe(100)
      expect(options.getItemKey?.(1)).toBe(200)
    })

    it('getItemKey falls back to index when pk is missing', () => {
      const messages: TestMessage[] = [
        { pk: undefined as any, content: 'Message', type: 'text', fromMe: true },
      ]
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      expect(options.getItemKey?.(0)).toBe(0)
    })

    it('estimateSize calls estimateMessageRowHeight', () => {
      const messages: TestMessage[] = [
        { pk: 1, content: 'Test message', type: 'text', fromMe: true },
      ]
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      const estimatedHeight = options.estimateSize?.(0)
      expect(estimatedHeight).toBeGreaterThan(0)
    })

    it('measureElement returns ceiling of bounding rect height', () => {
      const messages: TestMessage[] = []
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      const mockElement = {
        getBoundingClientRect: () => ({ height: 75.3 }),
      } as any

      // Typecheck fix during the 2026-07-17 wave-8 land: @tanstack/react-virtual's
      // measureElement type takes (element, entry, instance); the local
      // implementation only reads `element`, so the extra args are unused stand-ins.
      const measured = options.measureElement?.(mockElement, undefined, {} as never)
      expect(measured).toBe(76)
    })

    it('measureElement falls back to base height when rect height is 0', () => {
      const messages: TestMessage[] = []
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages, getScrollElement })

      const mockElement = {
        getBoundingClientRect: () => ({ height: 0 }),
      } as any

      const measured = options.measureElement?.(mockElement, undefined, {} as never)
      expect(measured).toBe(76)
    })

    it('handles empty message list', () => {
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({ messages: [], getScrollElement })

      expect(options.count).toBe(0)
    })

    it('handles sparse message array with undefined entries', () => {
      const messages: (TestMessage | undefined)[] = [
        { pk: 1, content: 'Message 1', type: 'text', fromMe: true },
        undefined,
        { pk: 3, content: 'Message 3', type: 'text', fromMe: false },
      ]
      const getScrollElement = () => null

      const options = createVirtualMessagesOptions({
        messages: messages as TestMessage[],
        getScrollElement,
      })

      expect(options.count).toBe(3)
      expect(options.getItemKey?.(1)).toBe(1)
    })
  })
})
