/**
 * inbox-unified — pure helpers for the v3.5 Inbox surface (T5 b-07).
 *
 * The v3.5 inbox is a UNIFIED conversation plane across every line
 * (mockup inbox.html: channel chips + one list, no per-line picker).
 * These helpers merge per-line chat payloads into that plane and keep
 * the filter/sort/format logic testable without JSX.
 *
 * Data honesty notes (verified against src/fleet route table):
 * - Channel is a LINE-level fact (health.transport.kind), never a chat field.
 * - No per-chat agent/paused field exists; nothing here invents one.
 */
import type { ChatItem, LineInstance } from '../types.js'

/** Channel vocabulary the inbox knows how to glyph (11-channel-glyphography §1). */
export type InboxChannel =
  | 'whatsapp'
  | 'signal'
  | 'imessage'
  | 'sms'
  | 'email'
  | 'discord'
  | 'x'
  | 'unknown'

export interface Conversation {
  /** Owning line instance name — conversationKey is only unique per line. */
  line: string
  conversationKey: string
  name: string
  lastMessagePreview: string
  lastMessageAt: string
  unreadCount: number
  isGroup: boolean
  channel: InboxChannel
}

export type InboxSeg = 'direct' | 'rooms'

/** Stable takeover-map key: line + conversation pair (newline can never appear in either). */
export function conversationId(line: string, conversationKey: string): string {
  return `${line}\n${conversationKey}`
}

/**
 * Map a line's transport kind to the inbox channel vocabulary.
 * `baileys` is the WhatsApp transport id (src/transport/registry.ts);
 * `twilio` carries SMS. Unknown/absent health stays honest as 'unknown'.
 */
export function channelForLine(line: LineInstance | undefined): InboxChannel {
  const kind = line?.health?.transport?.kind
  switch (kind) {
    case 'baileys':
      return 'whatsapp'
    case 'signal':
      return 'signal'
    case 'imessage':
      return 'imessage'
    case 'twilio':
      return 'sms'
    case 'email':
      return 'email'
    case 'discord':
      return 'discord'
    case 'x':
      return 'x'
    default:
      return 'unknown'
  }
}

/** Human label per channel (chip + context pane identity row). */
export const CHANNEL_LABEL: Record<InboxChannel, string> = {
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  imessage: 'iMessage',
  sms: 'SMS',
  email: 'Email',
  discord: 'Discord',
  x: 'X',
  unknown: 'Channel',
}

/** Merge every line's chat page into one recency-sorted conversation plane. */
export function mergeConversations(
  lines: readonly LineInstance[],
  chatsByLine: ReadonlyMap<string, ChatItem[]>,
): Conversation[] {
  const merged: Conversation[] = []
  for (const line of lines) {
    const chats = chatsByLine.get(line.name)
    if (!chats) continue
    const channel = channelForLine(line)
    for (const chat of chats) {
      merged.push({
        line: line.name,
        conversationKey: chat.conversationKey,
        name: chat.name,
        lastMessagePreview: chat.lastMessagePreview,
        lastMessageAt: chat.lastMessageAt,
        unreadCount: chat.unreadCount,
        isGroup: chat.isGroup,
        channel,
      })
    }
  }
  // Recency: newest first; conversations with no timestamp sink, stable by name.
  return merged.sort((a, b) => {
    const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0
    const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0
    if (at !== bt) return bt - at
    return a.name.localeCompare(b.name)
  })
}

/** Channels actually present in the plane — chips render for real channels only. */
export function presentChannels(conversations: readonly Conversation[]): InboxChannel[] {
  const seen = new Set<InboxChannel>()
  for (const c of conversations) seen.add(c.channel)
  const order: InboxChannel[] = ['whatsapp', 'signal', 'imessage', 'sms', 'discord', 'email', 'x', 'unknown']
  return order.filter((k) => seen.has(k))
}

export function filterConversations(
  conversations: readonly Conversation[],
  channel: InboxChannel | 'all',
  seg: InboxSeg,
): Conversation[] {
  return conversations.filter((c) => {
    if (channel !== 'all' && c.channel !== channel) return false
    return seg === 'rooms' ? c.isGroup : !c.isGroup
  })
}

export function countByChannel(conversations: readonly Conversation[]): Map<InboxChannel, number> {
  const counts = new Map<InboxChannel, number>()
  for (const c of conversations) counts.set(c.channel, (counts.get(c.channel) ?? 0) + 1)
  return counts
}

/**
 * Normalize a typing-indicator JID to a conversation key, mirroring
 * src/core/conversation-key.ts `toConversationKey` (strip :device, personal →
 * bare local, group → local_at_g.us, other domains → local_at_domain).
 * Returns null for unparseable input — a malformed typing row must never
 * light up an unrelated conversation.
 */
export function normalizeTypingJid(jid: string): string | null {
  if (!jid || !jid.includes('@')) return null
  const at = jid.indexOf('@')
  const rawLocal = jid.slice(0, at)
  const domain = jid.slice(at + 1)
  if (!rawLocal || !domain) return null
  const colon = rawLocal.indexOf(':')
  const local = colon >= 0 ? rawLocal.slice(0, colon) : rawLocal
  if (domain === 'g.us') return `${local}_at_g.us`
  if (domain === 's.whatsapp.net' || domain === 'lid') return local
  return `${local}_at_${domain}`
}

/** List-lane timestamp (mockup .tm): same-day HH:MM, older MM/DD. */
export function formatListTime(iso: string, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
}

/** Bubble timestamp (mockup .bub .tm): always HH:MM. */
export function formatBubbleTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Avatar initials: first letters of the first two words, uppercased (mockup anatomy). */
export function conversationInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '·'
  const first = words[0]!.charAt(0)
  const second = words.length > 1 ? words[1]!.charAt(0) : ''
  return (first + second).toUpperCase()
}

/** Single initial for message-row avatars (mockup .ma). */
export function senderInitial(senderName: string): string {
  const trimmed = senderName.trim()
  return trimmed ? trimmed.charAt(0).toUpperCase() : '·'
}
