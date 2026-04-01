import React, { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useLine, useChats, useMessages, useAccess, useLogs } from '../hooks/use-fleet'
import { formatRelative, formatTime, formatChatTime } from '../lib/format-time'
import { getInitials, stripMarkdown, resolveDisplayName } from '../lib/text-utils'
import { levelColor, levelBg, levelLineBg } from '../lib/log-theme'
import { useToast } from '../hooks/toast-context'
import ModeBadge from '../components/ModeBadge'
import HeartbeatStrip from '../components/HeartbeatStrip'
import EmptyState from '../components/EmptyState'
import Skeleton, { TableSkeleton } from '../components/Skeleton'
import {
  ArrowLeft, Info, SlidersHorizontal, GitBranch, Shield, Send,
  MessageSquare, ScrollText, BarChart3, UserCheck, Ban,
  User, Users, UserPlus, UserX,
  RotateCw, MessageSquareOff, Bot, ChevronsUp, Power,
} from 'lucide-react'
import type { Mode, ChatItem, AccessEntry, LogEntry, Message, LineInstance } from '../mock-data'

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

/* ═══ Pipeline Node — compact inline pill (c-pipe-node) ═══ */
function PipelineNode({ label, value, color, active }: { label: string; value?: string; color: string; active?: boolean }) {
  const modeKey = color === 'pas' ? 'pas' : color === 'cht' ? 'cht' : 'agt';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="font-mono font-medium"
        style={{
          padding: '5px var(--sp-3)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--font-size-label)',
          background: active ? `var(--m-${modeKey}-wash)` : 'var(--color-d4)',
          color: active ? `var(--color-m-${modeKey})` : 'var(--color-t3)',
          border: active ? `1px solid var(--m-${modeKey}-soft)` : '1px solid transparent',
        }}
      >
        {label}
      </span>
      {value && (
        <span className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)' }}>
          {value}
        </span>
      )}
    </span>
  )
}

function PipelineArrow() {
  return <span className="text-t5 font-mono flex-shrink-0" style={{ fontSize: 'var(--font-size-sm)' }}>→</span>
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
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ padding: 'var(--sp-4)', gap: 'var(--sp-3)' }}>
      {/* ═══ Line Header ═══ */}
      <div
        className="flex items-center gap-4 c-toolbar flex-shrink-0"
        style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)', borderRadius: 'var(--radius-lg)' }}
      >
        <button
          onClick={() => navigate('/')}
          className="text-t4 hover:text-t1 c-hover cursor-pointer"
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
            width: 'var(--dot-header)',
            height: 'var(--dot-header)',
            boxShadow: line.status === 'online'
              ? '0 0 12px var(--s-ok-glow)'
              : line.status === 'degraded'
              ? '0 0 12px var(--s-warn-glow)'
              : '0 0 12px var(--s-crit-glow)',
          }}
        />

        {/* Identity */}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-t1 font-extrabold font-sans" style={{ fontSize: 'var(--font-size-xl)', letterSpacing: 'var(--tracking-tight)' }}>
              {line.name}
            </h1>
            <ModeBadge mode={line.mode} />
          </div>
          <div className="font-mono text-t3" style={{ fontSize: 'var(--font-size-data)' }}>
            {line.phone}
          </div>
        </div>

        {/* Meta — mono, muted */}
        <div className="flex gap-4 font-mono text-t4" style={{ fontSize: 'var(--font-size-sm)' }}>
          <span>uptime: {line.uptime ?? '—'}</span>
          <span>port: {line.healthPort}</span>
          <span>msgs: {(line.messagesTotal ?? 0).toLocaleString()}</span>
        </div>

        {/* Heartbeat + Restart */}
        <HeartbeatStrip beats={line.heartbeat} />
        <button
          onClick={() => toast.info(`Restarting ${line.name}...`)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-t3 hover:text-t1 hover:bg-d5 cursor-pointer c-hover"
          style={{ fontSize: 'var(--font-size-label)', border: '1px solid var(--b2)' }}
        >
          <RotateCw size={11} strokeWidth={1.75} /> Restart
        </button>
      </div>

      {/* ═══ Tab bar + content container ═══ */}
      <div
        className="flex-1 flex flex-col min-h-0"
        style={{ background: 'var(--color-d1)', border: '1px solid var(--b1)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}
      >
      <div
        className="flex gap-0 flex-shrink-0"
        style={{ padding: '0 var(--sp-4)', borderBottom: '1px solid var(--b1)', background: 'var(--color-d2)' }}
      >
        {TABS.map(tab => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          const isDeferred = tab.id === 'metrics'
          return (
            <button
              key={tab.id}
              onClick={() => !isDeferred && setActiveTab(tab.id)}
              className={`flex items-center gap-2 font-sans font-medium c-hover relative ${
                isDeferred
                  ? 'text-t5 cursor-default'
                  : isActive
                  ? 'text-t1 cursor-pointer'
                  : 'text-t4 hover:text-t3 cursor-pointer'
              }`}
              style={{ padding: '10px var(--sp-4)', fontSize: 'var(--font-size-data)' }}
              title={isDeferred ? 'Coming in Phase 2' : undefined}
            >
              <Icon size={15} strokeWidth={1.75} />
              {tab.label}
              {isDeferred && (
                <span className="font-mono text-t5" style={{ fontSize: 'var(--font-size-xs)', marginLeft: '-4px' }}>
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
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col" style={{ padding: 'var(--sp-5)' }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="flex-1 min-h-0 flex flex-col overflow-hidden"
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
                mode={line.mode}
              />
            )}
            {activeTab === 'logs' && <LogsTab logs={logs || []} filter={logFilter} onFilterChange={setLogFilter} />}
          </motion.div>
        </AnimatePresence>
      </div>
      </div>
    </div>
  )
}

/* ═══ Static config data — hoisted to module scope for stable references ═══ */
const CHAT_CONFIG = [
  { key: 'model', value: 'claude-sonnet-4-20250514', type: 'string' as const },
  { key: 'systemPrompt', value: 'You are a helpful support...', type: 'string' as const },
  { key: 'maxTokens', value: '4096', type: 'number' as const },
  { key: 'tokenBudget', value: '100000', type: 'number' as const },
  { key: 'rateLimitPerHour', value: '30', type: 'number' as const },
  { key: 'pineconeIndex', value: 'bes-knowledge-base', type: 'string' as const },
  { key: 'ragEnabled', value: 'true', type: 'boolean' as const },
]
const AGENT_CONFIG = [
  { key: 'sessionScope', value: 'per_chat', type: 'string' as const },
  { key: 'cwd', value: '~/LAB/agent-workspace', type: 'path' as const },
  { key: 'instructionsPath', value: 'CLAUDE.md', type: 'path' as const },
  { key: 'sandbox', value: 'true', type: 'boolean' as const },
  { key: 'sandboxPerChat', value: 'true', type: 'boolean' as const },
  { key: 'mcpServers', value: '3', type: 'number' as const },
  { key: 'perUserDirs', value: 'true', type: 'boolean' as const },
]
const TYPE_COLOR: Record<string, string> = {
  string: 'var(--color-m-pas)', number: 'var(--color-s-warn)',
  boolean: 'var(--color-m-agt)', path: 'var(--color-m-cht)',
}

/* ═══ Summary Tab — KPI strip + pipeline strip + config/actions columns ═══ */
function SummaryTab({ line }: { line: LineInstance }) {
  const toast = useToast()
  const modeColor = line.mode === 'passive' ? 'pas' : line.mode === 'chat' ? 'cht' : 'agt'
  const cards = [
    { label: 'STATUS', value: line.status, color: line.status === 'online' ? 'text-s-ok' : line.status === 'degraded' ? 'text-s-warn' : 'text-s-crit' },
    { label: 'UPTIME', value: line.uptime ?? '—', color: 'text-t1' },
    { label: 'MESSAGES', value: (line.messagesToday ?? 0).toLocaleString(), color: 'text-t1' },
    { label: 'MODE', value: line.mode, color: line.mode === 'passive' ? 'text-m-pas' : line.mode === 'chat' ? 'text-m-cht' : 'text-m-agt' },
    { label: 'ACCESS', value: line.accessMode ?? '—', color: 'text-t2' },
    { label: 'ACTIVE', value: line.lastActive ? formatRelative(line.lastActive) : '—', color: 'text-t3' },
  ]

  const pipelineNodes = line.mode === 'passive'
    ? [{ label: 'Inbound', active: true }, { label: 'Store', active: true }, { label: 'Done', active: false }]
    : line.mode === 'chat'
    ? [{ label: 'Inbound', active: true }, { label: 'Access', active: true }, { label: 'Queue', active: (line.queueDepth ?? 0) > 0 }, { label: 'Enrich', active: false }, { label: 'API', active: true }, { label: 'Outbound', active: false }]
    : [{ label: 'Inbound', active: true }, { label: 'Router', active: true }, { label: 'SDK Loop', active: (line.activeSessions ?? 0) > 0 }, { label: 'Tools', active: (line.activeSessions ?? 0) > 0 }, { label: 'Outbound', active: false }]

  const config = line.mode === 'chat' ? CHAT_CONFIG : line.mode === 'agent' ? AGENT_CONFIG : null

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
      {/* Row 1: KPI cards — 6-wide single row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: 'var(--sp-2)',
          background: 'var(--color-d1)',
          border: '1px solid var(--b1)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--sp-2)',
        }}
      >
        {cards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] }}
            style={{
              padding: 'var(--sp-3) var(--sp-4)',
              background: 'var(--color-d2)',
              border: '1px solid var(--b1)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div className="c-col-header text-t4" style={{ marginBottom: 'var(--sp-1)' }}>
              {card.label}
            </div>
            <div className={`font-mono font-semibold ${card.color}`} style={{ fontSize: 'var(--font-size-lg)', letterSpacing: 'var(--tracking-tight)' }}>
              {card.value}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Row 2: Pipeline — full-width strip */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
        className="flex items-center justify-between"
        style={{
          background: 'var(--color-d2)',
          border: '1px solid var(--b1)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--sp-4) var(--sp-5)',
        }}
      >
        <div className="c-col-header text-t4 flex-shrink-0" style={{ marginRight: 'var(--sp-5)' }}>
          Pipeline
        </div>
        <div className="flex items-center flex-1 justify-center flex-wrap" style={{ gap: 'var(--sp-2)' }}>
          {pipelineNodes.map((node, i) => (
            <span key={node.label} className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
              {i > 0 && <PipelineArrow />}
              <PipelineNode label={node.label} color={modeColor} active={node.active} />
            </span>
          ))}
        </div>
      </motion.div>

      {/* Row 3: Config + Actions side-by-side */}
      <div className="flex" style={{ gap: 'var(--sp-3)' }}>
        {/* Configuration panel */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="flex-1"
          style={{
            background: 'var(--color-d2)',
            border: '1px solid var(--b1)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          <div className="flex items-center justify-between c-toolbar bg-d3" style={{ borderBottom: '1px solid var(--b1)' }}>
            <span className="c-col-header text-t4">{line.mode} Configuration</span>
            {config && (
              <button
                onClick={() => toast.info('Edit mode coming in Phase 2')}
                className="c-btn c-btn-ghost"
                style={{ padding: '3px var(--sp-2)', fontSize: 'var(--font-size-xs)' }}
              >
                Edit
              </button>
            )}
          </div>
          {config ? (
            <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
              {config.map((entry, i) => (
                <div key={entry.key} className="flex items-center justify-between" style={{ padding: '6px 0', ...(i < config.length - 1 ? { borderBottom: '1px solid var(--b1)' } : {}) }}>
                  <span className="c-label">{entry.key}</span>
                  <span className="font-mono" style={{ fontSize: 'var(--font-size-data)', color: TYPE_COLOR[entry.type] }}>{entry.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-t4" style={{ padding: 'var(--sp-5)', fontSize: 'var(--font-size-sm)' }}>
              Passive mode — no configuration required.
            </div>
          )}
        </motion.div>

        {/* Actions / Controls panel */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
          style={{
            width: 'var(--panel-actions)',
            flexShrink: 0,
            background: 'var(--color-d2)',
            border: '1px solid var(--b1)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          <div className="c-toolbar bg-d3" style={{ borderBottom: '1px solid var(--b1)' }}>
            <span className="c-col-header text-t4">Actions</span>
          </div>
          <div className="flex flex-col" style={{ padding: 'var(--sp-3) var(--sp-4)', gap: 'var(--sp-2)' }}>
            <button
              onClick={() => toast.info(`Restarting ${line.name}...`)}
              className="c-btn w-full justify-center"
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <RotateCw size={13} strokeWidth={1.75} /> Restart Instance
            </button>
            {line.mode !== 'passive' && (
              <button
                onClick={() => toast.info('Config editor coming in Phase 2')}
                className="c-btn w-full justify-center"
                style={{ fontSize: 'var(--font-size-label)' }}
              >
                <SlidersHorizontal size={13} strokeWidth={1.75} /> Edit Configuration
              </button>
            )}
            <button
              onClick={() => toast.info('Mode switching coming in Phase 2')}
              className="c-btn w-full justify-center"
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <GitBranch size={13} strokeWidth={1.75} /> Change Mode
            </button>
            <div style={{ borderTop: '1px solid var(--b1)', paddingTop: 'var(--sp-2)', marginTop: 'var(--sp-1)' }}>
              <button
                onClick={() => toast.error(`Stopping ${line.name}...`)}
                className="c-btn c-btn-danger w-full justify-center"
                style={{ fontSize: 'var(--font-size-label)' }}
              >
                <Power size={13} strokeWidth={1.75} /> Stop Instance
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}

/* ═══ Config Block — c-config from components.html ═══ */
function ConfigValue({ value, type }: { value: string; type: 'string' | 'number' | 'boolean' | 'path' }) {
  return <span style={{ color: TYPE_COLOR[type] }}>{value}</span>
}

/* ═══ Mode Tab ═══ */
function ModeTab({ mode }: { mode: Mode }) {
  if (mode === 'passive') {
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)' }}
        style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)', padding: 'var(--sp-7)' }}
      >
        <EmptyState
          icon={<Bot size={40} strokeWidth={1.25} />}
          title="Read-only Mode"
          description="Passive instances listen and store — no configuration required."
        />
      </div>
    )
  }

  const chatConfig: { key: string; value: string; type: 'string' | 'number' | 'boolean' | 'path' }[] = [
    { key: 'model', value: '"claude-sonnet-4-20250514"', type: 'string' },
    { key: 'systemPrompt', value: '"You are a helpful support assistant for BES..."', type: 'string' },
    { key: 'maxTokens', value: '4096', type: 'number' },
    { key: 'tokenBudget', value: '100000', type: 'number' },
    { key: 'rateLimitPerHour', value: '30', type: 'number' },
    { key: 'pineconeIndex', value: '"bes-knowledge-base"', type: 'string' },
    { key: 'ragEnabled', value: 'true', type: 'boolean' },
  ]
  const agentConfig: typeof chatConfig = [
    { key: 'sessionScope', value: '"per_chat"', type: 'string' },
    { key: 'cwd', value: '"~/LAB/agent-workspace"', type: 'path' },
    { key: 'instructionsPath', value: '"CLAUDE.md"', type: 'path' },
    { key: 'sandbox', value: 'true', type: 'boolean' },
    { key: 'sandboxPerChat', value: 'true', type: 'boolean' },
    { key: 'mcpServers', value: '3', type: 'number' },
    { key: 'perUserDirs', value: 'true', type: 'boolean' },
  ]
  const config = mode === 'chat' ? chatConfig : agentConfig

  return (
    <div
      style={{ borderRadius: 'var(--radius-lg)' }}
      style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)', padding: 'var(--sp-7)' }}
    >
      <div className="c-col-header mb-5">
        {mode} Configuration
      </div>
      {/* c-config block — syntax-highlighted JSON-like display */}
      <div
        className="font-mono overflow-x-auto whitespace-pre"
        style={{
          background: 'var(--color-d1)',
          border: '1px solid var(--b1)',
          borderRadius: 'var(--radius-md)',
          padding: '14px var(--sp-4)',
          fontSize: 'var(--font-size-data)',
          color: 'var(--color-t2)',
          lineHeight: 1.7,
        }}
      >
        {'{\n'}
        {config.map((entry, i) => (
          <span key={entry.key}>
            {'  '}<span style={{ color: 'var(--color-m-cht)' }}>{entry.key}</span>
            <span style={{ color: 'var(--color-t5)' }}>: </span>
            <ConfigValue value={entry.value} type={entry.type} />
            {i < config.length - 1 ? ',' : ''}
            {'\n'}
          </span>
        ))}
        {'}'}
      </div>
    </div>
  )
}

/* ═══ Pipeline Tab ═══ */
function PipelineTab({ mode, line, modeColor }: { mode: Mode; line: LineInstance; modeColor: string }) {
  if (mode === 'passive') {
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)' }}
        style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)', padding: 'var(--sp-7)' }}
      >
        <div className="flex items-center justify-center gap-2 py-12">
          <PipelineNode label="Inbound" color={modeColor} active />
          <PipelineArrow />
          <PipelineNode label="Store" color={modeColor} active />
          <PipelineArrow />
          <PipelineNode label="Done" color={modeColor} />
        </div>
      </div>
    )
  }
  if (mode === 'chat') {
    const queueDepth = line.health?.runtime?.chat?.queueDepth ?? 0
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)' }}
        style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)', padding: 'var(--sp-7)' }}
      >
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
      </div>
    )
  }
  const sessions = line.health?.runtime?.agent?.activeSessions ?? 0
  return (
    <div
      style={{ borderRadius: 'var(--radius-lg)' }}
      style={{ background: 'var(--color-d2)', border: '1px solid var(--b1)', padding: 'var(--sp-7)' }}
    >
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
    if (status === 'blocked') return <UserX size={16} strokeWidth={1.75} className="text-s-crit" />
    if (status === 'pending' || status === 'seen') return <UserPlus size={16} strokeWidth={1.75} className="text-s-warn" />
    return type === 'group'
      ? <Users size={16} strokeWidth={1.75} className="text-t3" />
      : <User size={16} strokeWidth={1.75} className="text-t3" />
  }

  const statusBadge: Record<string, { bg: string; color: string; label: string }> = {
    allowed: { bg: 'var(--s-ok-wash)', color: 'var(--color-s-ok)', label: 'allowed' },
    blocked: { bg: 'var(--s-crit-wash)', color: 'var(--color-s-crit)', label: 'blocked' },
    pending: { bg: 'var(--s-warn-wash)', color: 'var(--color-s-warn)', label: 'pending' },
    seen:    { bg: 'var(--s-warn-wash)', color: 'var(--color-s-warn)', label: 'seen' },
  }

  const renderItem = (entry: AccessEntry, showActions: 'pending' | 'allowed' | 'blocked') => (
    <div
      key={entry.subjectId}
      className="flex items-center gap-3 hover:bg-d3 c-hover"
      style={{
        padding: '10px var(--sp-4)',
        borderBottom: '1px solid var(--b1)',
        ...(showActions === 'pending' ? { background: 'var(--s-warn-wash)' } : {}),
        ...(showActions === 'blocked' ? { opacity: 0.6 } : {}),
      }}
    >
      {/* Avatar — 32px circle with icon (c-access-avatar) */}
      <div
        className="rounded-full flex items-center justify-center flex-shrink-0"
        style={{ width: 'var(--avatar-sm)', height: 'var(--avatar-sm)', background: 'var(--color-d5)' }}
      >
        {statusIcon(entry.status, entry.subjectType)}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="font-sans font-medium text-t2" style={{ fontSize: 'var(--font-size-body)' }}>
          {entry.subjectName}
        </div>
        <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-sm)' }}>
          {entry.subjectId}
        </div>
      </div>

      {/* Status badge (c-access-status) */}
      <span
        className="font-mono font-medium flex-shrink-0"
        style={{
          fontSize: 'var(--font-size-sm)',
          padding: '2px var(--sp-2)',
          borderRadius: 'var(--radius-sm)',
          background: statusBadge[entry.status]?.bg,
          color: statusBadge[entry.status]?.color,
        }}
      >
        {statusBadge[entry.status]?.label ?? entry.status}
      </span>

      {/* Actions */}
      {showActions === 'pending' && (
        <div className="flex gap-1.5">
          <button
            onClick={() => toast.success(`Allowed ${entry.subjectName}`)}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-s-ok hover:bg-d5 cursor-pointer c-hover"
            style={{ fontSize: 'var(--font-size-label)', border: '1px solid var(--b2)' }}
          >
            <UserCheck size={11} strokeWidth={1.75} /> Allow
          </button>
          <button
            onClick={() => toast.error(`Blocked ${entry.subjectName}`)}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer c-hover"
            style={{ fontSize: 'var(--font-size-label)', border: '1px solid var(--b2)' }}
          >
            <Ban size={11} strokeWidth={1.75} /> Block
          </button>
        </div>
      )}
      {showActions === 'allowed' && (
        <button
          onClick={() => toast.error(`Blocked ${entry.subjectName}`)}
          className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer c-hover"
          style={{ fontSize: 'var(--font-size-label)', border: '1px solid var(--b2)' }}
        >
          <Ban size={11} strokeWidth={1.75} />
        </button>
      )}
      {showActions === 'blocked' && (
        <button
          onClick={() => toast.success(`Allowed ${entry.subjectName}`)}
          className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-s-ok hover:bg-d5 cursor-pointer c-hover"
          style={{ fontSize: 'var(--font-size-label)', border: '1px solid var(--b2)' }}
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
            className="c-col-header text-t4"
            style={{ padding: '8px 14px', borderBottom: '1px solid var(--b1)', background: 'var(--color-d3)' }}
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
            className="c-col-header text-t4"
            style={{ padding: '8px 14px', borderBottom: '1px solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Allowed ({allowed.length})
          </div>
          {allowed.map(e => renderItem(e, 'allowed'))}
        </div>
        <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--b1)' }}>
          <div
            className="c-col-header text-t4"
            style={{ padding: '8px 14px', borderBottom: '1px solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Blocked ({blocked.length})
          </div>
          {blocked.length === 0 ? (
            <div className="text-t5 text-center py-6 font-mono" style={{ fontSize: 'var(--font-size-data)' }}>
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

/* ═══ History Messages — scroll-to-bottom + load older + create contact ═══ */
function HistoryMessages({ messages, outgoingBg, selectedChat }: {
  messages: Message[]; outgoingBg: string; selectedChat: string;
}) {
  const toast = useToast()
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const bottomRef = React.useRef<HTMLDivElement>(null)
  const [showJumpToBottom, setShowJumpToBottom] = React.useState(false)

  const reversed = React.useMemo(() => [...messages].reverse(), [messages])

  // Auto-scroll to bottom on new messages
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [selectedChat, messages.length])

  // Show/hide jump-to-bottom FAB based on scroll position
  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowJumpToBottom(distFromBottom > 200)
  }, [])

  const jumpToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const isRawJid = (name: string) => /^\d{5,}$/.test(name)

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto scrollbar-hide flex flex-col min-h-0 relative"
        style={{ padding: 'var(--sp-4) var(--sp-5)' }}
      >
        {/* Load older messages */}
        {reversed.length > 0 && (
          <div
            className="flex items-center justify-center cursor-pointer hover:text-t2 c-hover text-t5"
            style={{ padding: 'var(--sp-3) 0 var(--sp-4)', gap: 'var(--sp-2)' }}
            onClick={() => toast.info('Cursor pagination coming in Phase 2')}
          >
            <ChevronsUp size={14} strokeWidth={1.75} />
            <span style={{ fontSize: 'var(--font-size-sm)' }}>Load older messages</span>
          </div>
        )}

        {/* Message list */}
        <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
          {reversed.map(msg => (
            <div
              key={msg.pk}
              className={`flex flex-col max-w-[65%] ${msg.fromMe ? 'self-end' : 'self-start'}`}
            >
              {!msg.fromMe && (
                <div className="flex items-center" style={{ marginBottom: '2px', paddingLeft: 'var(--sp-1)', gap: 'var(--sp-2)' }}>
                  <span className="c-label">{resolveDisplayName(msg.senderName)}</span>
                  {isRawJid(msg.senderName ?? '') && (
                    <button
                      onClick={() => toast.info(`Save contact: ${resolveDisplayName(msg.senderName)}`)}
                      className="c-hover cursor-pointer text-t5 hover:text-m-cht"
                      style={{ fontSize: 'var(--font-size-xs)' }}
                      title="Save as contact"
                    >
                      <UserPlus size={10} strokeWidth={2} />
                    </button>
                  )}
                </div>
              )}
              <div
                className="c-msg-bubble"
                style={{
                  padding: 'var(--sp-2h) var(--msg-pad-h)',
                  borderRadius: 'var(--radius-lg)',
                  fontSize: 'var(--font-size-body)',
                  ...(msg.fromMe
                    ? { background: outgoingBg, borderBottomRightRadius: 'var(--radius-sm)' }
                    : { background: 'var(--color-d3)', borderBottomLeftRadius: 'var(--radius-sm)' }),
                }}
              >
                <div className="text-t1 leading-relaxed">{msg.content}</div>
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

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Jump to bottom FAB */}
      {showJumpToBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute c-btn c-btn-ghost"
          style={{
            right: 'var(--sp-5)',
            bottom: '80px',
            padding: 'var(--sp-2)',
            borderRadius: '50%',
            background: 'var(--color-d4)',
            border: '1px solid var(--b2)',
            boxShadow: 'var(--shadow-md)',
          }}
          title="Jump to latest"
        >
          <ChevronsUp size={16} strokeWidth={2} className="rotate-180" />
        </button>
      )}

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
          }}
          placeholder="Type a reply..."
        />
        <button
          className="c-btn c-btn-primary flex-shrink-0"
          style={{ padding: 'var(--sp-2h) var(--sp-5)', fontSize: 'var(--font-size-body)' }}
        >
          <Send size={15} strokeWidth={2} />
          Send
        </button>
      </div>
    </>
  )
}

/* ═══ History Tab — matches chat component patterns ═══ */

function HistoryTab({ chats, messages, selectedChat, onSelectChat, mode }: {
  chats: ChatItem[]; messages: Message[]; selectedChat: string | null; onSelectChat: (key: string) => void; mode: Mode
}) {
  const outgoingBg = mode === 'agent' ? 'var(--m-agt-soft)' : 'var(--m-cht-soft)'
  return (
    <div
      className="flex overflow-hidden h-full"
      style={{ border: '1px solid var(--b1)', borderRadius: 'var(--radius-lg)' }}
    >
      {/* Chat list */}
      <div
        className="flex-shrink-0 flex flex-col"
        style={{ width: 'var(--panel-history)', borderRight: '1px solid var(--b1)', background: 'var(--color-d1)' }}
      >
        {/* Chat list header */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
          style={{ borderBottom: '1px solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
        >
          <span className="c-heading">Conversations</span>
          <span className="c-label">{chats.length} chats</span>
        </div>

        <div className="flex-1 overflow-auto scrollbar-hide">
          {chats.map(chat => {
            const isSelected = selectedChat === chat.conversationKey
            return (
              <div
                key={chat.conversationKey}
                onClick={() => onSelectChat(chat.conversationKey)}
                className={`flex cursor-pointer c-chat-item ${isSelected ? 'active' : ''}`}
                style={{
                  padding: 'var(--sp-3) var(--sp-4)',
                  gap: 'var(--sp-3)',
                  borderBottom: '1px solid var(--b1)',
                  ...(isSelected ? { borderLeft: '2px solid var(--color-m-cht)', paddingLeft: 'var(--msg-pad-h)' } : {}),
                }}
              >
                <div
                  className="rounded-full flex items-center justify-center flex-shrink-0 font-mono text-t3 font-semibold"
                  style={{ width: 'var(--avatar-md)', height: 'var(--avatar-md)', background: 'var(--color-d5)', fontSize: 'var(--font-size-sm)' }}
                >
                  {getInitials(resolveDisplayName(chat.name))}
                </div>
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
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--color-d0)' }}>
        {selectedChat ? (
          <HistoryMessages
            messages={messages}
            outgoingBg={outgoingBg}
            selectedChat={selectedChat}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={<MessageSquareOff size={40} strokeWidth={1.25} />}
              title="No messages yet"
              description="Select a conversation from the list to view messages."
            />
          </div>
        )}
      </div>
    </div>
  )
}

/* ═══ Logs Tab — matches c-log-line pattern ═══ */
function LogsTab({ logs, filter, onFilterChange }: { logs: LogEntry[]; filter: string; onFilterChange: (f: string) => void }) {
  const levels = ['all', 'info', 'warn', 'error', 'debug']
  // Imported from lib/log-theme — no local duplicates

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter)

  return (
    <div
      className="overflow-hidden"
      style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', border: '1px solid var(--b1)' }}
    >
      {/* Toolbar with level filter pills — matches established pattern */}
      <div
        className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
        style={{ borderBottom: '1px solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
      >
        <span className="c-heading">Logs</span>
        <div className="flex" style={{ gap: 'var(--sp-1)' }}>
          {levels.map(l => {
            const isActive = filter === l
            const pillColor = l === 'error' ? 'text-s-crit' : l === 'warn' ? 'text-s-warn' : 'text-t2'
            return (
              <button
                key={l}
                onClick={() => onFilterChange(l)}
                className={`font-mono cursor-pointer c-hover inline-flex items-center ${
                  isActive ? `${pillColor} bg-d4` : 'text-t4 hover:text-t2 hover:bg-d3'
                }`}
                style={{
                  fontSize: 'var(--font-size-label)',
                  letterSpacing: 'var(--tracking-pill)',
                  padding: '3px var(--sp-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: isActive ? '1px solid var(--b3)' : '1px solid var(--b1)',
                }}
              >
                {l}
              </button>
            )
          })}
        </div>
      </div>

      {/* Log viewer — c-log-line pattern */}
      <div
        className="rounded-lg overflow-hidden font-mono"
        style={{ border: '1px solid var(--b1)', background: 'var(--color-d1)', fontSize: 'var(--font-size-data)' }}
      >
        {filtered.map((log, i) => (
          <div
            key={`${log.timestamp}-${log.source}-${i}`}
            className="flex gap-0 hover:bg-d3 c-hover"
            style={{
              borderBottom: '1px solid var(--b1)',
              background: levelLineBg[log.level],
              lineHeight: 1.7,
            }}
          >
            {/* Timestamp */}
            <div className="px-3 py-1 text-t5 flex-shrink-0" style={{ width: 'var(--log-col-time)', minWidth: 'var(--log-col-time)' }}>
              {formatTime(log.timestamp)}
            </div>
            {/* Level badge */}
            <div className="px-2 py-1 flex-shrink-0 text-center" style={{ width: 'var(--log-col-level)', minWidth: 'var(--log-col-level)' }}>
              <span
                className={`inline-block px-1.5 py-0.5 rounded font-medium ${levelColor[log.level]}`}
                style={{ fontSize: 'var(--font-size-sm)', background: levelBg[log.level] }}
              >
                {log.level}
              </span>
            </div>
            {/* Source */}
            <div
              className="px-2 py-1 text-t5 truncate flex-shrink-0"
              style={{ width: 'var(--log-col-source)', minWidth: 'var(--log-col-source)' }}
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
