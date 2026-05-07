import type { ChatItem, Message } from '../types.js'

function isGroupConversation(conversationKey: string): boolean {
  return conversationKey.endsWith('@g.us') || conversationKey.endsWith('_at_g.us')
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
