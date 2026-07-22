import type { ChatItem, Message } from '../types.js'
import { isE164WireInput } from './validation'

function isGroupConversation(conversationKey: string): boolean {
  if (conversationKey.endsWith('@g.us') || conversationKey.endsWith('_at_g.us')) return true
  if (conversationKey.endsWith('@imessage') || conversationKey.endsWith('_at_imessage')) {
    return conversationKey.startsWith('iMessage;+;')
  }
  if (conversationKey.endsWith('@signal') || conversationKey.endsWith('_at_signal')) {
    const separator = conversationKey.endsWith('@signal') ? '@signal' : '_at_signal'
    const address = conversationKey.slice(0, -separator.length)
    const isE164 = isE164WireInput(address)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(address)
    return !isE164 && !isUuid && /^[A-Za-z0-9+/]{16,}={0,2}$/.test(address)
  }
  return false
}

function messagePreview(message: Message | undefined): string {
  return typeof message?.content === 'string' ? message.content : ''
}

function fallbackName(conversationKey: string, messages: Message[] | undefined): string {
  const sender = messages?.find((message) => (
    !message.fromMe
    && typeof message.senderName === 'string'
    && message.senderName.trim()
  ))
  return sender && typeof sender.senderName === 'string' ? sender.senderName : conversationKey
}

export function resolveCurrentChat(
  chats: ChatItem[] | undefined,
  selectedChat: string | null,
  messages: Message[] | undefined,
): ChatItem | null {
  if (!selectedChat) {
    return null
  }

  const loadedChat = chats?.find((chat) => chat.conversationKey === selectedChat)
  if (loadedChat) {
    return loadedChat
  }

  const latestMessage = messages?.[0]
  return {
    conversationKey: selectedChat,
    name: fallbackName(selectedChat, messages),
    lastMessagePreview: messagePreview(latestMessage),
    lastMessageAt: latestMessage?.timestamp ?? '',
    unreadCount: 0,
    isGroup: isGroupConversation(selectedChat),
  }
}
