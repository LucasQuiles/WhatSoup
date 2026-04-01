import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useLine, useChats, useMessages, useAccess, useLogs } from '../hooks/use-fleet'
import { useToast } from '../hooks/use-toast'
import ModeBadge from '../components/ModeBadge'
import HeartbeatStrip from '../components/HeartbeatStrip'
import EmptyState from '../components/EmptyState'
import Skeleton, { TableSkeleton } from '../components/Skeleton'
import {
  ArrowLeft, Info, SlidersHorizontal, GitBranch, Shield,
  MessageSquare, ScrollText, BarChart3, UserCheck, Ban,
  ChevronRight, User, Users, UserPlus, UserX,
  RotateCw, MessageSquareOff, Bot, ChevronsUp,
} from 'lucide-react'
import type { Mode, ChatItem, AccessEntry, LogEntry } from '../mock-data'

const TABS = [
  { id: 'summary', label: 'Summary', icon: Info },
  { id: 'mode', label: 'Mode', icon: SlidersHorizontal },
  { id: 'pipeline', label: 'Pipeline', icon: GitBranch },
  { id: 'access', label: 'Access', icon: Shield },
  { id: 'history', label: 'History', icon: MessageSquare },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'metrics', label: 'Metrics', icon: BarChart3 },
] as const

type TabId = typeof TABS[number]['id']

/* ═══ Pipeline Node ═══ */
function PipelineNode({ label, value, color, active }: { label: string; value?: string; color: string; active?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="w-16 h-16 rounded-md flex items-center justify-center text-xs font-mono font-medium"
        style={{
          background: active ? `var(--m-${color}-soft)` : 'var(--color-d5)',
          color: active ? `var(--color-m-${color === 'pas' ? 'pas' : color === 'cht' ? 'cht' : 'agt'})` : 'var(--color-t3)',
          boxShadow: active ? `inset 0 0 0 1px var(--color-m-${color === 'pas' ? 'pas' : color === 'cht' ? 'cht' : 'agt'})` : undefined,
        }}
      >
        {label}
      </div>
      {value && <span className="text-xs font-mono text-t3">{value}</span>}
    </div>
  )
}

function PipelineArrow() {
  return <ChevronRight size={16} className="text-t5 mt-3 flex-shrink-0" />
}

/* ═══ Main Component ═══ */
export default function LineDetail() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<TabId>('summary')
  const { data: line } = useLine(name || '')
  const { data: chats } = useChats(name || '')
  const { data: access } = useAccess(name || '')
  const { data: logs } = useLogs(name || '')
  const [selectedChat, setSelectedChat] = useState<string | null>(null)
  const { data: messages } = useMessages(name || '', selectedChat || '')
  const toast = useToast()
  const [logFilter, setLogFilter] = useState<string>('all')

  if (!line) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex items-center gap-4 px-10 py-4" style={{ borderBottom: '1px solid var(--b1)' }}>
          <Skeleton className="w-5 h-5 rounded" />
          <Skeleton className="w-2.5 h-2.5 rounded-full" />
          <div>
            <Skeleton className="w-40 h-5 mb-2" />
            <Skeleton className="w-24 h-3" />
          </div>
        </div>
        <TableSkeleton />
      </div>
    )
  }

  const modeColor = line.mode === 'passive' ? 'pas' : line.mode === 'chat' ? 'cht' : 'agt'

  return (
    <div className="flex-1 flex flex-col">
      {/* ═══ Line Header — matches c-line-header from design system ═══ */}
      <div
        className="flex items-center gap-4 px-10 py-4"
        style={{ borderBottom: '1px solid var(--b1)', background: 'var(--color-d2)' }}
      >
        <button
          onClick={() => navigate('/')}
          className="text-t4 hover:text-t1 transition-colors cursor-pointer"
        >
          <ArrowLeft size={18} strokeWidth={1.75} />
        </button>

        {/* Status dot — 10px for line header per design */}
        <span
          className={`inline-block rounded-full flex-shrink-0 ${
            line.status === 'online' ? 'bg-s-ok animate-breathe' :
            line.status === 'degraded' ? 'bg-s-warn' : 'bg-s-crit'
          }`}
          style={{
            width: '10px',
            height: '10px',
            boxShadow: line.status === 'online'
              ? '0 0 8px rgba(45,212,168,0.3)'
              : line.status === 'degraded'
              ? '0 0 8px rgba(246,173,85,0.3)'
              : '0 0 8px rgba(252,129,129,0.3)',
          }}
        />

        {/* Identity */}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-t1 font-extrabold font-sans" style={{ fontSize: '1.4rem', letterSpacing: '-0.04em' }}>
              {line.name}
            </h1>
            <ModeBadge mode={line.mode} />
          </div>
          <div className="font-mono text-t3" style={{ fontSize: '0.78rem' }}>
            {line.phone}
          </div>
        </div>

        {/* Meta — mono, muted */}
        <div className="flex gap-4 font-mono text-t4" style={{ fontSize: '0.72rem' }}>
          <span>uptime: {line.uptime ?? '—'}</span>
          <span>port: {line.healthPort}</span>
          <span>msgs: {(line.messagesTotal ?? 0).toLocaleString()}</span>
        </div>

        {/* Heartbeat + Restart */}
        <HeartbeatStrip beats={line.heartbeat} />
        <button
          onClick={() => toast.info(`Restarting ${line.name}...`)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-t3 hover:text-t1 hover:bg-d5 cursor-pointer transition-colors"
          style={{ fontSize: '0.65rem', border: '1px solid var(--b2)' }}
        >
          <RotateCw size={11} strokeWidth={1.75} /> Restart
        </button>
      </div>

      {/* ═══ Tab bar ═══ */}
      <div
        className="flex gap-0 px-10"
        style={{ borderBottom: '1px solid var(--b1)', background: 'var(--color-d1)' }}
      >
        {TABS.map(tab => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          const isDeferred = tab.id === 'metrics'
          return (
            <button
              key={tab.id}
              onClick={() => !isDeferred && setActiveTab(tab.id)}
              className={`flex items-center gap-2 font-sans transition-colors relative ${
                isDeferred
                  ? 'text-t5 cursor-default'
                  : isActive
                  ? 'text-t1 cursor-pointer'
                  : 'text-t4 hover:text-t3 cursor-pointer'
              }`}
              style={{ padding: '10px 16px', fontSize: '0.85rem' }}
              title={isDeferred ? 'Coming in Phase 2' : undefined}
            >
              <Icon size={15} strokeWidth={1.75} />
              {tab.label}
              {isDeferred && (
                <span className="font-mono text-t5" style={{ fontSize: '0.55rem', marginLeft: '-4px' }}>
                  P2
                </span>
              )}
              {isActive && !isDeferred && (
                <div
                  className="absolute bottom-0 left-2 right-2 h-[2px] rounded-t"
                  style={{ background: `var(--color-m-${modeColor})` }}
                />
              )}
            </button>
          )
        })}
      </div>

      {/* ═══ Tab content ═══ */}
      <div className="flex-1 overflow-auto p-6 px-10">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            {activeTab === 'summary' && <SummaryTab line={line} />}
            {activeTab === 'mode' && <ModeTab mode={line.mode} />}
            {activeTab === 'pipeline' && <PipelineTab mode={line.mode} line={line} modeColor={modeColor} />}
            {activeTab === 'access' && <AccessTab access={access || []} />}
            {activeTab === 'history' && (
              <HistoryTab
                chats={chats || []}
                messages={messages || []}
                selectedChat={selectedChat}
                onSelectChat={setSelectedChat}
              />
            )}
            {activeTab === 'logs' && <LogsTab logs={logs || []} filter={logFilter} onFilterChange={setLogFilter} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

/* ═══ Summary Tab ═══ */
function SummaryTab({ line }: { line: any }) {
  const cards = [
    { label: 'STATUS', value: line.status, color: line.status === 'online' ? 'text-s-ok' : line.status === 'degraded' ? 'text-s-warn' : 'text-s-crit' },
    { label: 'UPTIME', value: line.uptime ?? '—', color: 'text-t1' },
    { label: 'MESSAGES', value: (line.messagesToday ?? 0).toLocaleString(), color: 'text-t1' },
    { label: 'MODE', value: line.mode, color: line.mode === 'passive' ? 'text-m-pas' : line.mode === 'chat' ? 'text-m-cht' : 'text-m-agt' },
    { label: 'ACCESS MODE', value: line.accessMode ?? '—', color: 'text-t2' },
    { label: 'LAST ACTIVE', value: line.lastActive ?? '—', color: 'text-t3' },
  ]

  return (
    <div className="grid grid-cols-3 gap-3">
      {cards.map((card, i) => (
        <motion.div
          key={card.label}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-lg p-5"
          style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)' }}
        >
          <div className="font-mono text-t5 mb-2" style={{ fontSize: '0.65rem', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            {card.label}
          </div>
          <div className={`font-mono text-lg font-semibold ${card.color}`}>{card.value}</div>
        </motion.div>
      ))}
    </div>
  )
}

/* ═══ Mode Tab ═══ */
function ModeTab({ mode }: { mode: Mode }) {
  if (mode === 'passive') {
    return (
      <EmptyState
        icon={<Bot size={40} strokeWidth={1.25} />}
        title="Read-only Mode"
        description="Passive instances listen and store — no configuration required."
      />
    )
  }

  const fields = mode === 'chat'
    ? [
        { label: 'MODEL', value: 'claude-sonnet-4-20250514' },
        { label: 'SYSTEM PROMPT', value: 'You are a helpful support assistant for BES...' },
        { label: 'MAX TOKENS', value: '4096' },
        { label: 'TOKEN BUDGET', value: '100,000 / day' },
        { label: 'RATE LIMIT', value: '30 / hour' },
        { label: 'PINECONE INDEX', value: 'bes-knowledge-base' },
      ]
    : [
        { label: 'SESSION SCOPE', value: 'per_chat' },
        { label: 'WORKING DIR', value: '~/LAB/agent-workspace' },
        { label: 'INSTRUCTIONS', value: 'CLAUDE.md' },
        { label: 'SANDBOX', value: 'enabled (sandboxPerChat)' },
        { label: 'MCP SERVERS', value: '3 configured' },
      ]

  return (
    <div className="space-y-3">
      {fields.map(field => (
        <div
          key={field.label}
          className="rounded-md p-4"
          style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)' }}
        >
          <div className="font-mono text-t5 mb-1" style={{ fontSize: '0.65rem', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            {field.label}
          </div>
          <div className="font-mono text-sm text-t2">{field.value}</div>
        </div>
      ))}
    </div>
  )
}

/* ═══ Pipeline Tab ═══ */
function PipelineTab({ mode, line, modeColor }: { mode: Mode; line: any; modeColor: string }) {
  if (mode === 'passive') {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <PipelineNode label="Inbound" color={modeColor} active />
        <PipelineArrow />
        <PipelineNode label="Store" color={modeColor} active />
        <PipelineArrow />
        <PipelineNode label="Done" color={modeColor} />
      </div>
    )
  }
  if (mode === 'chat') {
    const queueDepth = line.health?.runtime?.chat?.queueDepth ?? 0
    return (
      <div className="flex items-center justify-center gap-2 py-12 flex-wrap">
        <PipelineNode label="Inbound" color={modeColor} active />
        <PipelineArrow />
        <PipelineNode label="Access" color={modeColor} />
        <PipelineArrow />
        <PipelineNode label="Queue" value={`depth: ${queueDepth}`} color={modeColor} active={queueDepth > 0} />
        <PipelineArrow />
        <PipelineNode label="Enrich" color={modeColor} />
        <PipelineArrow />
        <PipelineNode label="API" color={modeColor} active />
        <PipelineArrow />
        <PipelineNode label="Outbound" color={modeColor} />
      </div>
    )
  }
  const sessions = line.health?.runtime?.agent?.activeSessions ?? 0
  return (
    <div className="flex items-center justify-center gap-2 py-12 flex-wrap">
      <PipelineNode label="Inbound" color={modeColor} active />
      <PipelineArrow />
      <PipelineNode label="Router" color={modeColor} />
      <PipelineArrow />
      <PipelineNode label="SDK Loop" value={`sessions: ${sessions}`} color={modeColor} active={sessions > 0} />
      <PipelineArrow />
      <PipelineNode label="Tools" color={modeColor} active={sessions > 0} />
      <PipelineArrow />
      <PipelineNode label="Outbound" color={modeColor} />
    </div>
  )
}

/* ═══ Access Tab — compact layout from components.html ═══ */
function AccessTab({ access }: { access: AccessEntry[] }) {
  const toast = useToast()
  const allowed = access.filter(e => e.status === 'allowed')
  const blocked = access.filter(e => e.status === 'blocked')
  const pending = access.filter(e => e.status === 'pending' || e.status === 'seen')

  const statusIcon = (status: string, type: string) => {
    if (status === 'blocked') return <UserX size={14} strokeWidth={1.75} className="text-s-crit" />
    if (status === 'pending' || status === 'seen') return <UserPlus size={14} strokeWidth={1.75} className="text-s-warn" />
    return type === 'group'
      ? <Users size={14} strokeWidth={1.75} className="text-t3" />
      : <User size={14} strokeWidth={1.75} className="text-t3" />
  }

  const renderItem = (entry: AccessEntry, showActions: 'pending' | 'allowed' | 'blocked') => (
    <div
      key={entry.subjectId}
      className="flex items-center gap-3 hover:bg-d3 transition-colors"
      style={{
        padding: '8px 14px',
        borderBottom: '1px solid var(--b1)',
        ...(showActions === 'pending' ? { background: 'var(--s-warn-wash)' } : {}),
        ...(showActions === 'blocked' ? { opacity: 0.6 } : {}),
      }}
    >
      {/* Avatar — 28px circle with icon */}
      <div
        className="rounded-full flex items-center justify-center flex-shrink-0"
        style={{ width: '28px', height: '28px', background: 'var(--color-d5)' }}
      >
        {statusIcon(entry.status, entry.subjectType)}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="font-sans font-medium text-t2" style={{ fontSize: '0.82rem' }}>
          {entry.subjectName}
        </div>
        <div className="font-mono text-t4" style={{ fontSize: '0.68rem' }}>
          {entry.subjectId}
        </div>
      </div>

      {/* Actions */}
      {showActions === 'pending' && (
        <div className="flex gap-1.5">
          <button
            onClick={() => toast.success(`Allowed ${entry.subjectName}`)}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-s-ok hover:bg-d5 cursor-pointer transition-colors"
            style={{ fontSize: '0.65rem', border: '1px solid var(--b2)' }}
          >
            <UserCheck size={11} strokeWidth={1.75} /> Allow
          </button>
          <button
            onClick={() => toast.error(`Blocked ${entry.subjectName}`)}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer transition-colors"
            style={{ fontSize: '0.65rem', border: '1px solid var(--b2)' }}
          >
            <Ban size={11} strokeWidth={1.75} /> Block
          </button>
        </div>
      )}
      {showActions === 'allowed' && (
        <button
          onClick={() => toast.error(`Blocked ${entry.subjectName}`)}
          className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer transition-colors"
          style={{ fontSize: '0.65rem', border: '1px solid var(--b2)' }}
        >
          <Ban size={11} strokeWidth={1.75} />
        </button>
      )}
      {showActions === 'blocked' && (
        <button
          onClick={() => toast.success(`Allowed ${entry.subjectName}`)}
          className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-s-ok hover:bg-d5 cursor-pointer transition-colors"
          style={{ fontSize: '0.65rem', border: '1px solid var(--b2)' }}
        >
          <UserCheck size={11} strokeWidth={1.75} />
        </button>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* Pending queue */}
      {pending.length > 0 && (
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--b1)' }}>
          <div
            className="font-mono text-t4 font-medium"
            style={{ fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '8px 14px', borderBottom: '1px solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Pending ({pending.length})
          </div>
          {pending.map(e => renderItem(e, 'pending'))}
        </div>
      )}

      {/* Allowed + Blocked in two columns */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--b1)' }}>
          <div
            className="font-mono text-t4 font-medium"
            style={{ fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '8px 14px', borderBottom: '1px solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Allowed ({allowed.length})
          </div>
          {allowed.map(e => renderItem(e, 'allowed'))}
        </div>
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--b1)' }}>
          <div
            className="font-mono text-t4 font-medium"
            style={{ fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '8px 14px', borderBottom: '1px solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Blocked ({blocked.length})
          </div>
          {blocked.length === 0 ? (
            <div className="text-t5 text-center py-6 font-mono" style={{ fontSize: '0.75rem' }}>
              No blocked contacts
            </div>
          ) : (
            blocked.map(e => renderItem(e, 'blocked'))
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══ History Tab — matches chat component patterns ═══ */
function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

function HistoryTab({ chats, messages, selectedChat, onSelectChat }: {
  chats: ChatItem[]; messages: any[]; selectedChat: string | null; onSelectChat: (key: string) => void
}) {
  return (
    <div
      className="flex gap-0 rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--b1)', height: 'calc(100vh - 240px)' }}
    >
      {/* Chat list — c-chat-list pattern */}
      <div
        className="flex-shrink-0 overflow-auto"
        style={{ width: '288px', borderRight: '1px solid var(--b1)', background: 'var(--color-d1)' }}
      >
        {chats.map(chat => {
          const isSelected = selectedChat === chat.conversationKey
          return (
            <div
              key={chat.conversationKey}
              onClick={() => onSelectChat(chat.conversationKey)}
              className={`flex gap-3 cursor-pointer transition-colors ${isSelected ? 'bg-d4' : 'hover:bg-d3'}`}
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--b1)',
                ...(isSelected ? { borderLeft: '2px solid var(--color-m-cht)', paddingLeft: '14px' } : {}),
              }}
            >
              {/* Avatar — 36px circle */}
              <div
                className="rounded-full flex items-center justify-center flex-shrink-0 font-mono text-t3 font-semibold"
                style={{ width: '36px', height: '36px', background: 'var(--color-d5)', fontSize: '0.72rem' }}
              >
                {getInitials(chat.name)}
              </div>

              {/* Body */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-t1 font-medium truncate" style={{ fontSize: '0.85rem' }}>
                    {chat.name}
                  </span>
                </div>
                <div className="text-t3 truncate" style={{ fontSize: '0.78rem' }}>
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
      </div>

      {/* Messages — c-msg pattern */}
      <div className="flex-1 flex flex-col" style={{ background: 'var(--color-d0)' }}>
        {selectedChat ? (
          <>
            <div className="flex-1 overflow-auto p-4 flex flex-col gap-1">
              {messages.length > 0 && (
                <div className="flex items-center justify-center gap-2 py-3 text-t4 cursor-pointer hover:text-t2 transition-colors">
                  <ChevronsUp size={16} strokeWidth={1.75} />
                  <span style={{ fontSize: '0.82rem' }}>Load older messages</span>
                </div>
              )}
              {messages.map(msg => (
                <div
                  key={msg.pk}
                  className={`flex flex-col max-w-[75%] ${msg.fromMe ? 'self-end' : 'self-start'}`}
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
                    <div className="text-t1">{msg.content}</div>
                  </div>
                  <span
                    className={`font-mono text-t5 mt-0.5 px-1 ${msg.fromMe ? 'text-right' : ''}`}
                    style={{ fontSize: '0.62rem' }}
                  >
                    {msg.timestamp}
                  </span>
                </div>
              ))}
            </div>

            {/* Input area */}
            <div
              className="flex gap-2 p-3"
              style={{ borderTop: '1px solid var(--b1)', background: 'var(--color-d1)' }}
            >
              <input
                className="flex-1 rounded-md px-3 py-2 text-sm text-t2 font-sans placeholder-t5 outline-none"
                style={{ background: 'var(--color-d2)', border: '1px solid var(--b2)' }}
                placeholder="Type a reply..."
              />
              <button
                className="flex items-center gap-1.5 px-4 py-2 rounded-md font-sans font-medium cursor-pointer transition-opacity hover:opacity-90"
                style={{ fontSize: '0.82rem', background: 'var(--color-m-cht)', color: 'var(--color-d0)' }}
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <EmptyState
            icon={<MessageSquareOff size={40} strokeWidth={1.25} />}
            title="No messages yet"
            description="Select a conversation from the list to view messages."
          />
        )}
      </div>
    </div>
  )
}

/* ═══ Logs Tab — matches c-log-line pattern ═══ */
function LogsTab({ logs, filter, onFilterChange }: { logs: LogEntry[]; filter: string; onFilterChange: (f: string) => void }) {
  const levels = ['all', 'info', 'warn', 'error', 'debug']
  const levelColor: Record<string, string> = {
    info: 'text-t3',
    warn: 'text-s-warn',
    error: 'text-s-crit',
    debug: 'text-t5',
  }
  const levelBg: Record<string, string> = {
    info: 'var(--color-d5)',
    warn: 'var(--s-warn-wash)',
    error: 'var(--s-crit-soft)',
    debug: 'var(--color-d4)',
  }
  const lineBg: Record<string, string | undefined> = {
    info: undefined,
    warn: 'var(--s-warn-wash)',
    error: 'var(--s-crit-wash)',
    debug: undefined,
  }

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter)

  return (
    <div>
      {/* Level filter pills */}
      <div className="flex gap-1 mb-3">
        {levels.map(l => (
          <button
            key={l}
            onClick={() => onFilterChange(l)}
            className={`px-2.5 py-1 rounded font-mono cursor-pointer transition-colors ${
              filter === l ? 'text-t1 bg-d5' : 'text-t4 hover:text-t3'
            }`}
            style={{
              fontSize: '0.65rem',
              border: `1px solid ${filter === l ? 'var(--b3)' : 'var(--b1)'}`,
            }}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Log viewer — c-log-line pattern */}
      <div
        className="rounded-lg overflow-hidden font-mono"
        style={{ border: '1px solid var(--b1)', background: 'var(--color-d1)', fontSize: '0.78rem' }}
      >
        {filtered.map((log, i) => (
          <div
            key={i}
            className="flex gap-0 hover:bg-d3 transition-colors"
            style={{
              borderBottom: '1px solid var(--b1)',
              background: lineBg[log.level],
              lineHeight: 1.7,
            }}
          >
            {/* Timestamp */}
            <div className="px-3 py-1 text-t5 flex-shrink-0" style={{ width: '80px', minWidth: '80px' }}>
              {log.timestamp.split('T')[1]?.replace('Z', '').slice(0, 8) || log.timestamp}
            </div>
            {/* Level badge */}
            <div className="px-2 py-1 flex-shrink-0 text-center" style={{ width: '50px', minWidth: '50px' }}>
              <span
                className={`inline-block px-1.5 py-0.5 rounded font-medium ${levelColor[log.level]}`}
                style={{ fontSize: '0.7rem', background: levelBg[log.level] }}
              >
                {log.level}
              </span>
            </div>
            {/* Source */}
            <div
              className="px-2 py-1 text-t5 truncate flex-shrink-0"
              style={{ width: '100px', minWidth: '100px' }}
            >
              {log.source}
            </div>
            {/* Message */}
            <div className={`px-3 py-1 flex-1 ${levelColor[log.level]}`}>
              {log.msg}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
