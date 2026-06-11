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

function contentText(message: VirtualMessage | null | undefined): string {
  return typeof message?.content === 'string' ? message.content : ''
}

export function estimateMessageRowHeight(message: VirtualMessage | null | undefined): number {
  const contentLength = Math.max(contentText(message).trim().length, 1)
  const estimatedLines = Math.max(1, Math.ceil(contentLength / MESSAGE_CHARS_PER_LINE))

  return (
    MESSAGE_BASE_ROW_HEIGHT +
    (message?.fromMe === false ? INCOMING_MESSAGE_LABEL_HEIGHT : 0) +
    (message?.type && message.type !== 'text' ? MEDIA_MESSAGE_BONUS_HEIGHT : 0) +
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
    estimateSize: (index) => estimateMessageRowHeight(messages[index]),
    measureElement: (element) =>
      Math.ceil(element.getBoundingClientRect().height) || MESSAGE_BASE_ROW_HEIGHT,
  }
}

export function useVirtualMessages(options: VirtualMessagesOptions) {
  // eslint-disable-next-line react-hooks/incompatible-library -- waiver:WVR-009 @tanstack/react-virtual's useVirtualizer is flagged by the react-hooks compiler heuristic but is a stable supported library hook; expires 2026-12-31
  return useVirtualizer(createVirtualMessagesOptions(options))
}
