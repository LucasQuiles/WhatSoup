import { useState } from 'react'
import { useLines, useChats, useMessages } from '../hooks/use-fleet'
import StatusDot from '../components/StatusDot'
import ModeBadge from '../components/ModeBadge'
import EmptyState from '../components/EmptyState'
import { MessageSquare, Send, UserCheck, Ban, User, Users, ChevronDown, ChevronsUp } from 'lucide-react'

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

export default function Inbox() {
  const { data: lines } = useLines()
  const [selectedLine, setSelectedLine] = useState<string>('')
  const [selectedChat, setSelectedChat] = useState<string | null>(null)
  const [linePickerOpen, setLinePickerOpen] = useState(false)

  const activeLine = selectedLine || (lines?.[0]?.name ?? '')
  const { data: chats } = useChats(activeLine)
  const { data: messages } = useMessages(activeLine, selectedChat || '')

  const currentLine = lines?.find(l => l.name === activeLine)
  const currentChat = chats?.find(c => c.conversationKey === selectedChat)

  return (
    <div className="flex-1 flex" style={{ height: 'calc(100vh - 52px)', padding: '12px', gap: '8px' }}>
      {/* ═══ Left: Line picker + Chat list ═══ */}
      <div
        className="flex-shrink-0 flex flex-col"
        style={{
          width: '288px',
          background: 'var(--color-d1)',
          border: '1px solid var(--b1)',
          borderRadius: '10px',
          overflow: 'hidden',
        }}
      >
        {/* Line picker */}
        <div className="relative">
          <button
            onClick={() => setLinePickerOpen(!linePickerOpen)}
            className="w-full flex items-center justify-between px-4 py-3 font-sans text-sm text-t1 hover:bg-d3 transition-colors cursor-pointer"
            style={{ borderBottom: '1px solid var(--b1)' }}
          >
            <div className="flex items-center gap-2">
              {currentLine && <StatusDot status={currentLine.status} size="sm" />}
              <span className="font-medium">{activeLine || 'Select a line'}</span>
              {currentLine && <ModeBadge mode={currentLine.mode} />}
            </div>
            <ChevronDown size={14} className="text-t4" />
          </button>

          {linePickerOpen && (
            <div
              className="absolute top-full left-0 right-0 z-10 max-h-64 overflow-auto"
              style={{ background: 'var(--color-d6)', border: '1px solid var(--b2)', borderTop: 'none' }}
            >
              {lines?.map(line => (
                <button
                  key={line.name}
                  onClick={() => { setSelectedLine(line.name); setLinePickerOpen(false); setSelectedChat(null) }}
                  className={`w-full flex items-center gap-2 px-4 py-2 text-sm text-left hover:bg-d4 transition-colors cursor-pointer ${
                    line.name === activeLine ? 'bg-d4 text-t1' : 'text-t3'
                  }`}
                >
                  <StatusDot status={line.status} size="sm" />
                  <span>{line.name}</span>
                  <span className="text-t5 font-mono text-xs ml-auto">{line.phone}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Chat list — c-chat-list pattern */}
        <div className="flex-1 overflow-auto">
          {chats?.map(chat => {
            const isSelected = selectedChat === chat.conversationKey
            return (
              <div
                key={chat.conversationKey}
                onClick={() => setSelectedChat(chat.conversationKey)}
                className={`flex gap-3 cursor-pointer transition-colors ${
                  isSelected ? 'bg-d4' : 'hover:bg-d3'
                }`}
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--b1)',
                  ...(isSelected ? { borderLeft: '2px solid var(--color-m-cht)', paddingLeft: '14px' } : {}),
                }}
              >
                {/* Avatar — 36px */}
                <div
                  className="rounded-full flex items-center justify-center flex-shrink-0 font-mono text-t3 font-semibold"
                  style={{ width: '36px', height: '36px', background: 'var(--color-d5)', fontSize: '0.72rem' }}
                >
                  {getInitials(chat.name)}
                </div>

                {/* Body */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-t1 font-medium truncate" style={{ fontSize: '0.85rem', maxWidth: '140px' }}>
                      {chat.name}
                    </span>
                  </div>
                  <div className="text-t4 truncate" style={{ fontSize: '0.78rem' }}>
                    {chat.lastMessagePreview}
                  </div>
                </div>

                {/* Right — time + badge */}
                <div className="flex flex-col items-end gap-1 flex-shrink-0 self-center">
                  <span className="font-mono text-t4" style={{ fontSize: '0.65rem' }}>
                    {chat.lastMessageAt}
                  </span>
                  {chat.unreadCount > 0 && (
                    <span
                      className="bg-m-cht text-d0 font-mono font-semibold flex items-center justify-center rounded-full"
                      style={{ fontSize: '0.6rem', width: '20px', height: '20px' }}
                    >
                      {chat.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
          {(!chats || chats.length === 0) && (
            <div className="p-8 text-center text-t4 text-sm">
              No chats found
            </div>
          )}
        </div>
      </div>

      {/* ═══ Center: Messages — c-msg pattern ═══ */}
      <div
        className="flex-1 flex flex-col"
        style={{
          background: 'var(--color-d0)',
          border: '1px solid var(--b1)',
          borderRadius: '10px',
          overflow: 'hidden',
        }}
      >
        {selectedChat && currentChat ? (
          <>
            {/* Chat header */}
            <div
              className="flex items-center gap-3 px-4 py-3"
              style={{ borderBottom: '1px solid var(--b1)', background: 'var(--color-d1)' }}
            >
              {currentChat.isGroup
                ? <Users size={18} className="text-t3" />
                : <User size={18} className="text-t3" />
              }
              <div>
                <div className="text-t1 text-sm font-medium">{currentChat.name}</div>
                <div className="text-t5 font-mono" style={{ fontSize: '0.68rem' }}>
                  {activeLine} / {currentChat.isGroup ? 'group' : 'direct'}
                </div>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-auto p-4 flex flex-col gap-1">
              {messages && messages.length > 0 && (
                <div className="flex items-center justify-center gap-2 py-3 text-t4 cursor-pointer hover:text-t2 transition-colors">
                  <ChevronsUp size={16} strokeWidth={1.75} />
                  <span style={{ fontSize: '0.82rem' }}>Load older messages</span>
                </div>
              )}
              {messages?.map(msg => (
                <div
                  key={msg.pk}
                  className={`flex flex-col max-w-[60%] ${msg.fromMe ? 'self-end' : 'self-start'}`}
                >
                  {!msg.fromMe && (
                    <span className="font-mono text-t4 px-1 mb-0.5" style={{ fontSize: '0.65rem' }}>
                      {msg.senderName}
                    </span>
                  )}
                  <div
                    style={{
                      padding: '10px 14px',
                      borderRadius: '12px',
                      fontSize: '0.85rem',
                      lineHeight: 1.5,
                      ...(msg.fromMe
                        ? { background: 'rgba(56,189,248,0.15)', borderBottomRightRadius: '4px' }
                        : { background: 'var(--color-d4)', borderBottomLeftRadius: '4px' }),
                    }}
                  >
                    <div className="text-t1 leading-relaxed">{msg.content}</div>
                  </div>
                  <span
                    className={`font-mono text-t5 mt-0.5 px-1 ${msg.fromMe ? 'text-right' : ''}`}
                    style={{ fontSize: '0.62rem' }}
                  >
                    {msg.timestamp}
                  </span>
                </div>
              ))}
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

            {/* Input */}
            <div
              className="flex gap-2 p-3"
              style={{ borderTop: '1px solid var(--b1)', background: 'var(--color-d1)' }}
            >
              <input
                className="flex-1 rounded-md px-3 py-2 text-sm text-t2 font-sans placeholder-t5 outline-none"
                style={{ background: 'var(--color-d2)', border: '1px solid var(--b2)' }}
                placeholder="Type a message..."
              />
              <button
                className="flex items-center gap-2 px-4 py-2 rounded-md font-sans font-medium cursor-pointer transition-opacity hover:opacity-90"
                style={{ fontSize: '0.82rem', background: 'var(--color-m-cht)', color: 'var(--color-d0)' }}
              >
                <Send size={14} strokeWidth={2} />
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
        className="flex-shrink-0 p-4 space-y-4"
        style={{
          width: '256px',
          background: 'var(--color-d1)',
          border: '1px solid var(--b1)',
          borderRadius: '10px',
          overflow: 'hidden',
        }}
      >
        {currentChat ? (
          <>
            <div className="text-center py-4">
              <div
                className="rounded-full flex items-center justify-center mx-auto mb-3"
                style={{ width: '64px', height: '64px', background: 'var(--color-d4)' }}
              >
                {currentChat.isGroup
                  ? <Users size={24} className="text-t4" />
                  : <User size={24} className="text-t4" />
                }
              </div>
              <div className="text-t1 font-medium">{currentChat.name}</div>
              <div className="text-t4 font-mono mt-1" style={{ fontSize: '0.68rem' }}>
                {currentChat.conversationKey.slice(0, 15)}...
              </div>
            </div>

            <div className="space-y-2">
              <div className="font-mono text-t5" style={{ fontSize: '0.65rem', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                Details
              </div>
              <div className="rounded-md p-3 text-sm" style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)' }}>
                <div className="flex justify-between mb-2">
                  <span className="text-t4">Line</span>
                  <span className="text-t2 font-mono text-xs">{activeLine}</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-t4">Type</span>
                  <span className="text-t2 font-mono text-xs">{currentChat.isGroup ? 'Group' : 'Direct'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-t4">Unread</span>
                  <span className="text-t2 font-mono text-xs">{currentChat.unreadCount}</span>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="font-mono text-t5" style={{ fontSize: '0.65rem', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                Actions
              </div>
              <button
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-s-ok hover:bg-d3 cursor-pointer transition-colors"
                style={{ border: '1px solid var(--b1)' }}
              >
                <UserCheck size={14} strokeWidth={1.75} /> Allow Contact
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-s-crit hover:bg-d3 cursor-pointer transition-colors"
                style={{ border: '1px solid var(--b1)' }}
              >
                <Ban size={14} strokeWidth={1.75} /> Block Contact
              </button>
            </div>
          </>
        ) : (
          <div className="text-center py-12 text-t4 text-sm">
            Select a conversation to see details
          </div>
        )}
      </div>
    </div>
  )
}
