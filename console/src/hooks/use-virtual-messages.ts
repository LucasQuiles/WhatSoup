import {
  useVirtualizer,
  type PartialKeys,
  type ReactVirtualizerOptions,
} from '@tanstack/react-virtual'

import type { Message } from '../types'

type VirtualMessage = Pick<Message, 'pk' | 'content' | 'type' | 'fromMe'>

export const DEFAULT_MESSAGE_OVERSCAN = 8

const MESSAGE_BASE_ROW_HEIGHT = 76
const INCOMING_MESSAGE_LABEL_HEIGHT = 18
const MEDIA_MESSAGE_BONUS_HEIGHT = 24
const MESSAGE_LINE_HEIGHT = 18
const MESSAGE_CHARS_PER_LINE = 40
const MESSAGE_GAP = 12

export interface VirtualMessagesOptions {
  messages: VirtualMessage[]
  getScrollElement: () => HTMLDivElement | null
  overscan?: number
}

export function estimateMessageRowHeight(message: VirtualMessage): number {
  const contentLength = Math.max((message.content ?? '').trim().length, 1)
  const estimatedLines = Math.max(1, Math.ceil(contentLength / MESSAGE_CHARS_PER_LINE))

  return (
    MESSAGE_BASE_ROW_HEIGHT +
    (message.fromMe ? 0 : INCOMING_MESSAGE_LABEL_HEIGHT) +
    (message.type === 'text' ? 0 : MEDIA_MESSAGE_BONUS_HEIGHT) +
    (estimatedLines - 1) * MESSAGE_LINE_HEIGHT
  )
}

export function createVirtualMessagesOptions({
  messages,
  getScrollElement,
  overscan = DEFAULT_MESSAGE_OVERSCAN,
}: VirtualMessagesOptions): PartialKeys<
  ReactVirtualizerOptions<HTMLDivElement, HTMLDivElement>,
  'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
> {
  return {
    count: messages.length,
    getScrollElement,
    overscan,
    gap: MESSAGE_GAP,
    getItemKey: (index) => messages[index]?.pk ?? index,
    estimateSize: (index) => estimateMessageRowHeight(messages[index]!),
    measureElement: (element) =>
      Math.ceil(element.getBoundingClientRect().height) || MESSAGE_BASE_ROW_HEIGHT,
  }
}

export function useVirtualMessages(options: VirtualMessagesOptions) {
  // eslint-disable-next-line react-hooks/incompatible-library
  return useVirtualizer(createVirtualMessagesOptions(options))
}
