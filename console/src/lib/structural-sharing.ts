import { replaceEqualDeep } from '@tanstack/react-query'

import type { ChatItem, LineInstance, Message } from '../types.js'

type ItemKey = string | number | bigint

function mergeByKey<T>(
  oldItems: T[] | undefined,
  newItems: T[],
  getKey: (item: T) => ItemKey,
): T[] {
  if (!oldItems || oldItems.length === 0) {
    return newItems
  }

  const previousByKey = new Map(oldItems.map((item) => [getKey(item), item]))
  const mergedItems = newItems.map((item) => {
    const previousItem = previousByKey.get(getKey(item))
    return previousItem ? replaceEqualDeep(previousItem, item) : item
  })

  const sameLength = oldItems.length === mergedItems.length
  const sameOrder = sameLength && mergedItems.every((item, index) => item === oldItems[index])

  return sameOrder ? oldItems : mergedItems
}

export function mergeLinesByName(
  oldData: LineInstance[] | undefined,
  newData: LineInstance[],
): LineInstance[] {
  return mergeByKey(oldData, newData, (line) => line.name)
}

export function mergeLineByName(
  oldData: LineInstance | undefined,
  newData: LineInstance,
): LineInstance {
  if (!oldData || oldData.name !== newData.name) {
    return newData
  }

  return replaceEqualDeep(oldData, newData)
}

export function mergeChatsByConversationKey(
  oldData: ChatItem[] | undefined,
  newData: ChatItem[],
): ChatItem[] {
  return mergeByKey(oldData, newData, (chat) => chat.conversationKey)
}

export function mergeMessagesByPk(
  oldData: Message[] | undefined,
  newData: Message[],
): Message[] {
  const mergedNewestPage = mergeByKey(oldData, newData, (message) => message.pk)
  if (!oldData || oldData.length === 0 || newData.length === 0) {
    return mergedNewestPage
  }

  const newKeys = new Set(newData.map((message) => message.pk))
  const oldestNewPk = Math.min(...newData.map((message) => message.pk))
  const preservedOlder = oldData.filter((message) => (
    message.pk > 0
    && message.pk < oldestNewPk
    && !newKeys.has(message.pk)
  ))

  if (preservedOlder.length === 0) {
    return mergedNewestPage
  }

  return [...mergedNewestPage, ...preservedOlder]
}

export function shareLinesByName(oldData: unknown, newData: unknown): unknown {
  return mergeLinesByName(oldData as LineInstance[] | undefined, newData as LineInstance[])
}

export function shareLineByName(oldData: unknown, newData: unknown): unknown {
  return mergeLineByName(oldData as LineInstance | undefined, newData as LineInstance)
}

export function shareChatsByConversationKey(oldData: unknown, newData: unknown): unknown {
  return mergeChatsByConversationKey(oldData as ChatItem[] | undefined, newData as ChatItem[])
}

export function shareMessagesByPk(oldData: unknown, newData: unknown): unknown {
  return mergeMessagesByPk(oldData as Message[] | undefined, newData as Message[])
}
