import type { Message } from '../types'

export interface VirtualRowItem {
  index: number
  key: string | number | bigint
  start: number
  size: number
}

export interface VirtualMessageRow extends VirtualRowItem {
  message: Message
}

export function toChronologicalMessages(messages: Message[]): Message[] {
  return [...messages].reverse()
}

export function selectVirtualMessageRows(
  messages: Message[],
  virtualItems: readonly VirtualRowItem[],
): VirtualMessageRow[] {
  return virtualItems.flatMap((item) => {
    const message = messages[item.index]
    if (!message) return []
    return [{ ...item, message }]
  })
}
