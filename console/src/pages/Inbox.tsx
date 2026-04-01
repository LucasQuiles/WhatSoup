import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLines, useChats, useMessages } from '../hooks/use-fleet'
import { api } from '../lib/api'
import { formatChatTime, formatTime } from '../lib/format-time'
import StatusDot from '../components/StatusDot'
import ModeBadge from '../components/ModeBadge'
import EmptyState from '../components/EmptyState'
import { MessageSquare, Send, UserCheck, Ban, User, Users, ChevronDown, ChevronsUp, Shield } from 'lucide-react'
import { getInitials, stripMarkdown, resolveDisplayName } from '../lib/text-utils'

export default function Inbox() {
  const { data: lines } = useLines()
  const [selectedLine, setSelectedLine] = useState<string>('')
  const [selectedChat, setSelectedChat] = useState<string | null>(null)
  const [linePickerOpen, setLinePickerOpen] = useState(false)
  const [msgText, setMsgText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const queryClient = useQueryClient()

  const activeLine = selectedLine || (lines?.[0]?.name ?? '')
  const { data: chats } = useChats(activeLine)
  const { data: messages } = useMessages(activeLine, selectedChat || '')

  const currentLine = lines?.find(l => l.name === activeLine)
  const currentChat = chats?.find(c => c.conversationKey === selectedChat)

  const handleSend = async () => {
    if (!msgText.trim() || !selectedChat || isSending) return
    setIsSending(true)
    try {
      await api.sendMessage(activeLine, selectedChat, msgText.trim())
      setMsgText('')
      queryClient.invalidateQueries({ queryKey: ['messages', activeLine, selectedChat] })
    } catch (e) {
      console.error('Send failed:', e instanceof Error ? e.message : e)
    } finally {
      setIsSending(false)
    }
  }

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden" style={{ padding: 'var(--sp-4)', gap: 'var(--sp-3)' }}>

      {/* ═══ Left: Line picker + Chat list ═══ */}
      <div
        className="flex-shrink-0 flex flex-col"
        style={{
          width: 'var(--panel-chat-list)',
          background: 'var(--color-d1)',
          border: '1px solid var(--b1)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Line picker — toolbar pattern */}
        <div className="relative">
          <button
            onClick={() => setLinePickerOpen(!linePickerOpen)}
            className="w-full flex items-center justify-between font-sans text-t1 hover:bg-d4 cursor-pointer bg-d3 c-toolbar c-hover"
            style={{ fontSize: 'var(--font-size-body)', borderBottom: '1px solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
          >
            <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
              {currentLine && <StatusDot status={currentLine.status} size="sm" />}
              <span className="font-medium">{activeLine || 'Select a line'}</span>
              {currentLine && <ModeBadge mode={currentLine.mode} />}
            </div>
            <ChevronDown size={14} className={`text-t4 transition-transform duration-200 ${linePickerOpen ? 'rotate-180' : ''}`} />
          </button>

          {linePickerOpen && (
            <div
              className="absolute top-full left-0 right-0 z-10 max-h-64 overflow-auto scrollbar-hide"
              style={{ background: 'var(--color-d6)', border: '1px solid var(--b2)', borderTop: 'none', borderRadius: '0 0 var(--radius-md) var(--radius-md)', boxShadow: 'var(--shadow-md)' }}
            >
              {lines?.map(line => (
                <button
                  key={line.name}
                  onClick={() => { setSelectedLine(line.name); setLinePickerOpen(false); setSelectedChat(null) }}
                  className={`w-full flex items-center text-left cursor-pointer c-dropdown-item ${
                    line.name === activeLine ? 'bg-d4 text-t1' : 'text-t3'
                  }`}
                  style={{ padding: 'var(--sp-2) var(--sp-4)', gap: 'var(--sp-2)', fontSize: 'var(--font-size-body)' }}
                >
                  <StatusDot status={line.status} size="sm" />
                  <span className="flex-1">{line.name}</span>
                  <ModeBadge mode={line.mode} />
                  <span className="c-label ml-auto">{line.phone}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-auto scrollbar-hide">
          {chats?.map(chat => {
            const isSelected = selectedChat === chat.conversationKey
            return (
              <div
                key={chat.conversationKey}
                onClick={() => setSelectedChat(chat.conversationKey)}
                className={`flex cursor-pointer c-chat-item ${
                  isSelected ? 'active' : ''
                }`}
                style={{
                  padding: 'var(--sp-3) var(--sp-4)',
                  gap: 'var(--sp-3)',
                  borderBottom: '1px solid var(--b1)',
                  ...(isSelected ? { borderLeft: '2px solid var(--color-m-cht)', paddingLeft: 'var(--msg-pad-h)' } : {}),
                }}
              >
                {/* Avatar */}
                <div
                  className="rounded-full flex items-center justify-center flex-shrink-0 font-mono text-t3 font-semibold"
                  style={{ width: 'var(--avatar-md)', height: 'var(--avatar-md)', background: 'var(--color-d5)', fontSize: 'var(--font-size-sm)' }}
                >
                  {getInitials(resolveDisplayName(chat.name))}
                </div>

                {/* Body */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between" style={{ marginBottom: '2px' }}>
                    <span className="text-t1 font-medium truncate" style={{ fontSize: 'var(--font-size-body)', maxWidth: 'var(--chat-name-max)' }}>
                      {resolveDisplayName(chat.name)}
                    </span>
                    <span className="c-label flex-shrink-0" style={{ marginLeft: 'var(--sp-2)' }}>
                      {formatChatTime(chat.lastMessageAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-t4 truncate" style={{ fontSize: 'var(--font-size-data)' }}>
                      {stripMarkdown(chat.lastMessagePreview ?? '')}
                    </div>
                    {chat.unreadCount > 0 && (
                      <span
                        className="bg-m-cht text-d0 font-mono font-semibold flex items-center justify-center rounded-full flex-shrink-0"
                        style={{ fontSize: 'var(--font-size-xs)', width: 'var(--badge-unread)', height: 'var(--badge-unread)', marginLeft: 'var(--sp-2)' }}
                      >
                        {chat.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          {(!chats || chats.length === 0) && (
            <div style={{ padding: 'var(--sp-8) var(--sp-4)' }} className="text-center text-t4">
              <span style={{ fontSize: 'var(--font-size-body)' }}>No chats found</span>
            </div>
          )}
        </div>
      </div>

      {/* ═══ Center: Messages ═══ */}
      <div
        className="flex-1 flex flex-col min-h-0"
        style={{
          background: 'var(--color-d0)',
          border: '1px solid var(--b1)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {selectedChat && currentChat ? (
          <>
            {/* Chat header */}
            <div
              className="flex items-center bg-d3 c-toolbar"
              style={{ borderBottom: '1px solid var(--b1)', minHeight: 'var(--toolbar-h)', gap: 'var(--sp-3)' }}
            >
              <div
                className="rounded-full flex items-center justify-center flex-shrink-0"
                style={{ width: 'var(--avatar-sm)', height: 'var(--avatar-sm)', background: 'var(--color-d5)' }}
              >
                {currentChat.isGroup
                  ? <Users size={15} className="text-t3" />
                  : <User size={15} className="text-t3" />
                }
              </div>
              <div className="flex-1">
                <div className="text-t1 font-medium" style={{ fontSize: 'var(--font-size-body)' }}>{resolveDisplayName(currentChat.name)}</div>
                <div className="text-t5 font-mono" style={{ fontSize: 'var(--font-size-label)' }}>
                  {activeLine} · {currentChat.isGroup ? 'group' : 'direct'}
                </div>
              </div>
              <span className="c-label">{currentChat.unreadCount > 0 ? `${currentChat.unreadCount} unread` : 'read'}</span>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-auto scrollbar-hide flex flex-col min-h-0" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
              {messages && messages.length > 0 && (
                <div className="flex items-center justify-center cursor-pointer hover:text-t2 c-hover text-t5" style={{ padding: 'var(--sp-2) 0 var(--sp-4)', gap: 'var(--sp-2)' }}>
                  <ChevronsUp size={14} strokeWidth={1.75} />
                  <span style={{ fontSize: 'var(--font-size-sm)' }}>Load older messages</span>
                </div>
              )}
              <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
                {[...(messages ?? [])].reverse().map(msg => (
                  <div
                    key={msg.pk}
                    className={`flex flex-col max-w-[65%] ${msg.fromMe ? 'self-end' : 'self-start'}`}
                  >
                    {!msg.fromMe && (
                      <span className="c-label" style={{ marginBottom: '2px', paddingLeft: 'var(--sp-1)' }}>
                        {msg.senderName}
                      </span>
                    )}
                    <div
                      style={{
                        padding: 'var(--sp-2h) var(--msg-pad-h)',
                        borderRadius: 'var(--radius-lg)',
                        fontSize: 'var(--font-size-body)',
                        lineHeight: 1.6,
                        ...(msg.fromMe
                          ? { background: 'var(--m-cht-soft)', borderBottomRightRadius: 'var(--radius-sm)' }
                          : { background: 'var(--color-d3)', borderBottomLeftRadius: 'var(--radius-sm)' }),
                      }}
                    >
                      <div className="text-t1">{msg.content}</div>
                    </div>
                    <span
                      className={`font-mono text-t5 ${msg.fromMe ? 'text-right' : ''}`}
                      style={{ fontSize: 'var(--font-size-xs)', marginTop: '2px', padding: '0 var(--sp-1)' }}
                    >
                      {formatTime(msg.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
              {(!messages || messages.length === 0) && (
                <div className="flex-1 flex items-center justify-center">
                  <EmptyState
                    icon={<MessageSquare size={40} strokeWidth={1.25} />}
                    title="No messages loaded"
                    description="Messages will appear here."
                  />
                </div>
              )}
            </div>

            {/* Input bar */}
            <div
              className="flex flex-shrink-0"
              style={{ padding: 'var(--sp-3) var(--sp-4)', gap: 'var(--sp-3)', borderTop: '1px solid var(--b1)', background: 'var(--color-d2)' }}
            >
              <input
                className="flex-1 text-t2 font-sans placeholder-t5 outline-none"
                style={{
                  fontSize: 'var(--font-size-body)',
                  padding: 'var(--sp-2h) var(--sp-4)',
                  background: 'var(--color-d1)',
                  border: '1px solid var(--b2)',
                  borderRadius: 'var(--radius-md)',
                  transition: 'border-color 0.2s var(--ease)',
                }}
                placeholder="Type a message..."
                value={msgText}
                onChange={e => setMsgText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
              />
              <button
                className="c-btn c-btn-primary flex-shrink-0"
                style={{ padding: 'var(--sp-2h) var(--sp-5)', fontSize: 'var(--font-size-body)' }}
                onClick={handleSend}
              >
                <Send size={15} strokeWidth={2} />
                Send
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={<MessageSquare size={40} strokeWidth={1.25} />}
              title="Select a conversation"
              description="Choose a line and chat from the left panel."
            />
          </div>
        )}
      </div>

      {/* ═══ Right: Contact details ═══ */}
      <div
        className="flex-shrink-0 flex flex-col"
        style={{
          width: 'var(--panel-contact)',
          background: 'var(--color-d1)',
          border: '1px solid var(--b1)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}
      >
        {currentChat ? (
          <>
            {/* Contact header */}
            <div
              className="flex items-center bg-d3 c-toolbar"
              style={{ borderBottom: '1px solid var(--b1)', minHeight: 'var(--toolbar-h)', gap: 'var(--sp-3)' }}
            >
              <div
                className="rounded-full flex items-center justify-center flex-shrink-0"
                style={{ width: 'var(--avatar-sm)', height: 'var(--avatar-sm)', background: 'var(--color-d5)' }}
              >
                {currentChat.isGroup
                  ? <Users size={14} className="text-t4" />
                  : <User size={14} className="text-t4" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-t1 font-medium truncate" style={{ fontSize: 'var(--font-size-body)' }}>{resolveDisplayName(currentChat.name)}</div>
                <div className="c-label truncate">{currentChat.conversationKey.slice(0, 18)}...</div>
              </div>
            </div>

            {/* Details body */}
            <div className="flex-1 overflow-auto scrollbar-hide" style={{ padding: 'var(--sp-4)' }}>
              {/* Info card */}
              <div style={{ marginBottom: 'var(--sp-4)' }}>
                <div className="c-col-header" style={{ marginBottom: 'var(--sp-2)' }}>Details</div>
                <div
                  style={{
                    background: 'var(--color-d2)',
                    border: '1px solid var(--b1)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--sp-3) var(--sp-4)',
                  }}
                >
                  {[
                    { label: 'Line', value: activeLine },
                    { label: 'Type', value: currentChat.isGroup ? 'Group' : 'Direct' },
                    { label: 'Unread', value: String(currentChat.unreadCount) },
                    { label: 'Mode', value: currentLine?.mode ?? '—' },
                  ].map((item, i, arr) => (
                    <div
                      key={item.label}
                      className="flex justify-between"
                      style={{
                        padding: 'var(--sp-2) 0',
                        ...(i < arr.length - 1 ? { borderBottom: '1px solid var(--b1)' } : {}),
                      }}
                    >
                      <span className="c-label">{item.label}</span>
                      <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick actions */}
              <div>
                <div className="c-col-header" style={{ marginBottom: 'var(--sp-2)' }}>Actions</div>
                <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
                  <button className="c-btn c-btn-success w-full justify-center">
                    <UserCheck size={14} strokeWidth={1.75} /> Allow Contact
                  </button>
                  <button className="c-btn c-btn-danger w-full justify-center">
                    <Ban size={14} strokeWidth={1.75} /> Block Contact
                  </button>
                  <div style={{ borderTop: '1px solid var(--b1)', paddingTop: 'var(--sp-2)', marginTop: 'var(--sp-1)' }}>
                    <button className="c-btn c-btn-ghost w-full justify-center">
                      <Shield size={14} strokeWidth={1.75} /> View Access List
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center" style={{ padding: 'var(--sp-4)' }}>
            <div className="text-center text-t5" style={{ fontSize: 'var(--font-size-sm)' }}>
              Select a conversation to see details
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
