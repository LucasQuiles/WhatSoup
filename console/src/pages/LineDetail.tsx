import React, { useState, useCallback } from 'react'
import TagInput from '../components/TagInput'
import { validatePhone } from '../lib/validation'
import { useParams, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { useLine, useChats, useMessages, useAccess, useLogs, useTyping } from '../hooks/use-fleet'
import { useStickyScroll } from '../hooks/use-sticky-scroll'
import { getProvider, DEFAULT_PROVIDER_ID } from '../lib/providers'
import { formatRelative, formatTime } from '../lib/format-time'
import { levelColor, levelBg, levelLineBg } from '../lib/log-theme'
import { useToast } from '../hooks/toast-context'
import { api } from '../lib/api'
import ModeBadge from '../components/ModeBadge'
import LineTags from '../components/LineTags'
import HeartbeatStrip from '../components/HeartbeatStrip'
import EmptyState from '../components/EmptyState'
import ChatListItem from '../components/ChatListItem'
import MessageBubble from '../components/MessageBubble'
import FilterPill from '../components/FilterPill'
import ConfirmDialog from '../components/ConfirmDialog'
import Skeleton, { TableSkeleton } from '../components/Skeleton'
import RelinkModal from '../components/RelinkModal'
import EditConfigModal from '../components/EditConfigModal'
import {
  ArrowLeft, Info, SlidersHorizontal, GitBranch, Shield, Send,
  MessageSquare, ScrollText, BarChart3, UserCheck, Ban,
  User, Users, UserPlus, UserX,
  RotateCw, MessageSquareOff, Bot, ChevronsUp, Power,
  X, AlertTriangle, Save, Loader2,
  Trash2, Link2, Settings,
} from 'lucide-react'
import type { Mode, ChatItem, AccessEntry, LogEntry, Message, LineInstance } from '../types'

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
          border: active ? `var(--bw) solid var(--m-${modeKey}-soft)` : 'var(--bw) solid transparent',
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
  const { data: typingData } = useTyping()
  const typingJids = React.useMemo(() =>
    new Set((typingData ?? []).filter(t => t.instance === name).map(t => t.jid)),
    [typingData, name],
  )
  const [selectedChat, setSelectedChat] = useState<string | null>(null)
  const { data: messages } = useMessages(name || '', selectedChat || '')
  const toast = useToast()
  const queryClient = useQueryClient()
  const [logFilter, setLogFilter] = useState<string>('all')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showRelink, setShowRelink] = useState(false)
  const [showEditConfig, setShowEditConfig] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    if (!line) return
    const lineName = line.name
    setDeleting(true)
    try {
      await api.deleteLine(lineName)
      toast.success(`${lineName} deleted`)
      navigate('/ops')
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeleting(false)
      setShowDeleteConfirm(false)
    }
  }, [line, toast, navigate])

  if (!line) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex items-center gap-4 px-10 py-4" style={{ borderBottom: 'var(--bw) solid var(--b1)' }}>
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

  const ease = [0.22, 1, 0.36, 1] as const

  return (
    <motion.div
      className="flex-1 flex flex-col min-h-0 overflow-hidden"
      style={{ padding: 'var(--sp-4)', gap: 'var(--sp-3)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease }}
    >
      {/* ═══ Line Header ═══ */}
      <div
        className="flex items-center gap-4 c-toolbar flex-shrink-0"
        style={{ background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', borderRadius: 'var(--radius-lg)' }}
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
            <LineTags line={line} />
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

        {/* Heartbeat + Actions */}
        <HeartbeatStrip beats={line.heartbeat} />
        <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
          {line.linkedStatus === 'unlinked' && (
            <button
              onClick={() => setShowRelink(true)}
              className="c-btn c-btn-ghost"
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <Link2 size={11} strokeWidth={1.75} /> Re-link
            </button>
          )}
          {line.linkedStatus !== 'unlinked' && (
            <button
              onClick={() => { toast.info(`Restarting ${line.name}...`); api.restart(line.name).then(() => toast.success(`${line.name} restart requested`)).catch(e => toast.error(`Restart failed: ${e.message}`)); }}
              className="c-btn c-btn-ghost"
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <RotateCw size={11} strokeWidth={1.75} /> Restart
            </button>
          )}
          {line.status === 'unreachable' && (
            <button
              onClick={() => setShowEditConfig(true)}
              className="c-btn c-btn-ghost"
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <Settings size={11} strokeWidth={1.75} /> Configure
            </button>
          )}
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="c-btn c-btn-ghost"
            style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-s-crit)' }}
          >
            <Trash2 size={11} strokeWidth={1.75} /> Delete
          </button>
        </div>
      </div>

      {/* ═══ Tab bar + content container ═══ */}
      <div
        className="flex-1 flex flex-col min-h-0"
        style={{ background: 'var(--color-d1)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}
      >
      <div
        className="flex gap-0 flex-shrink-0"
        style={{ padding: '0 var(--sp-4)', borderBottom: 'var(--bw) solid var(--b1)', background: 'var(--color-d2)' }}
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
              style={{ padding: 'var(--sp-2h) var(--sp-4)', fontSize: 'var(--font-size-data)' }}
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
            {activeTab === 'mode' && <ModeTab mode={line.mode} line={line} />}
            {activeTab === 'pipeline' && <PipelineTab mode={line.mode} line={line} modeColor={modeColor} />}
            {activeTab === 'access' && <AccessTab access={access || []} lineName={name || ''} />}
            {activeTab === 'history' && (
              <HistoryTab
                chats={chats || []}
                messages={messages || []}
                selectedChat={selectedChat}
                onSelectChat={setSelectedChat}
                mode={line.mode}
                lineName={name || ''}
                typingJids={typingJids}
              />
            )}
            {activeTab === 'logs' && <LogsTab logs={logs || []} filter={logFilter} onFilterChange={setLogFilter} />}
          </motion.div>
        </AnimatePresence>
      </div>
      </div>

      {/* ═══ Modals ═══ */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title={`Delete ${line?.name}?`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete permanently'}
        confirmVariant="danger"
        confirmIcon={deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      >
        This will stop the process, remove all configuration, data, and message history for <strong>{line?.name}</strong>. This cannot be undone.
      </ConfirmDialog>

      <RelinkModal
        lineName={line?.name ?? ''}
        open={showRelink}
        onClose={() => setShowRelink(false)}
        onLinked={() => { setShowRelink(false); queryClient.invalidateQueries({ queryKey: ['lines', name] }); toast.success(`${line?.name} re-linked!`); }}
      />

      <EditConfigModal
        lineName={line?.name ?? ''}
        open={showEditConfig}
        onClose={() => setShowEditConfig(false)}
        onSaved={() => { setShowEditConfig(false); queryClient.invalidateQueries({ queryKey: ['lines', name] }); toast.success('Config saved'); }}
      />
    </motion.div>
  )
}

/* ═══ Config helpers — build entries dynamically from real instance config ═══ */
const CONFIG_EXCLUDE_KEYS = new Set(['name', 'type', 'paths', 'healthPort'])

const CONFIG_PATH_KEYS = new Set(['cwd', 'instructionsPath', 'socketPath', 'configDir', 'dataDir', 'stateDir'])

function buildConfigEntries(rawConfig: Record<string, unknown>): { key: string; value: string; type: 'string' | 'number' | 'boolean' | 'path' }[] {
  return Object.entries(rawConfig)
    .filter(([k]) => !CONFIG_EXCLUDE_KEYS.has(k))
    .map(([key, value]) => {
      let displayValue: string;
      if (typeof value === 'object' && value !== null) {
        displayValue = JSON.stringify(value);
      } else {
        displayValue = String(value);
      }
      // Truncate long string values (e.g., systemPrompt)
      if (displayValue.length > 80) {
        displayValue = displayValue.slice(0, 77) + '...';
      }
      return {
        key,
        value: displayValue,
        type: typeof value === 'boolean' ? 'boolean' as const
          : typeof value === 'number' ? 'number' as const
          : CONFIG_PATH_KEYS.has(key) ? 'path' as const
          : 'string' as const,
      };
    })
}

const TYPE_COLOR: Record<string, string> = {
  string: 'var(--color-m-pas)', number: 'var(--color-s-warn)',
  boolean: 'var(--color-m-agt)', path: 'var(--color-m-cht)',
}

const AGENT_OPTION_FLAT: Record<string, 'string' | 'boolean' | 'enum' | 'array'> = {
  sessionScope: 'enum',
  cwd: 'string',
  instructionsPath: 'string',
  sandboxPerChat: 'boolean',
  pluginDirs: 'array',
}
const AGENT_OPTION_ENUMS: Record<string, string[]> = {
  sessionScope: ['single', 'shared', 'per_chat'],
}

/* ═══ Enum options for known select fields ═══ */
const ENUM_OPTIONS: Record<string, string[]> = {
  accessMode: ['self_only', 'allowlist', 'open_dm', 'groups_only'],
  toolUpdateMode: ['full', 'minimal'],
  model: ['', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
}

const FIELD_VALIDATORS: Record<string, (val: unknown) => string | null> = {
  maxTokens: v => typeof v === 'number' && v < 256 ? 'Min 256' : typeof v === 'number' && v > 200000 ? 'Max 200,000' : null,
  tokenBudget: v => typeof v === 'number' && v < 1000 ? 'Min 1,000' : typeof v === 'number' && v > 10000000 ? 'Max 10M' : null,
  rateLimitPerHour: v => typeof v === 'number' && v < 1 ? 'Min 1' : typeof v === 'number' && v > 10000 ? 'Max 10,000' : null,
}

/* ═══ ConfigEditDialog — type-aware form for editing line config ═══ */
function ConfigEditDialog({
  config,
  lineName,
  adminPhonesDisplay,
  onClose,
}: {
  config: Record<string, unknown>
  lineName: string
  adminPhonesDisplay?: Record<string, string>
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [patch, setPatch] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)

  const editableEntries: [string, unknown][] = React.useMemo(() => {
    const entries: [string, unknown][] = []
    for (const [k, v] of Object.entries(config)) {
      if (CONFIG_EXCLUDE_KEYS.has(k)) continue
      if (k === 'agentOptions' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>
        const otherKeys: Record<string, unknown> = {}
        for (const [sk, sv] of Object.entries(obj)) {
          if (sk in AGENT_OPTION_FLAT) {
            entries.push([`agentOptions.${sk}`, sv])
          } else {
            otherKeys[sk] = sv
          }
        }
        if (Object.keys(otherKeys).length > 0) {
          entries.push(['agentOptions (other)', otherKeys])
        }
      } else {
        entries.push([k, v])
      }
    }
    return entries
  }, [config])

  /** Resolve a config value, handling dotted keys like 'agentOptions.cwd'. */
  const configValue = useCallback((key: string): unknown => {
    if (key.includes('.')) {
      const [parent, child] = key.split('.')
      return (config[parent] as Record<string, unknown> | undefined)?.[child]
    }
    return config[key]
  }, [config])

  const currentValue = (key: string): unknown =>
    key in patch ? patch[key] : configValue(key)

  const setField = useCallback((key: string, value: unknown) => {
    setPatch(prev => {
      // If value matches original, remove from patch (only dirty fields tracked)
      const originalValue = configValue(key)
      if (value === originalValue) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: value }
    })
  }, [configValue])

  const handleSave = async () => {
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    try {
      const apiPatch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(patch)) {
        if (key.includes('.')) {
          const [parent, child] = key.split('.')
          if (!apiPatch[parent]) apiPatch[parent] = {}
          ;(apiPatch[parent] as Record<string, unknown>)[child] = value
        } else {
          apiPatch[key] = value
        }
      }
      await api.updateConfig(lineName, apiPatch)
      toast.success('Configuration updated')
      await queryClient.invalidateQueries({ queryKey: ['lines', lineName] })
      onClose()
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const renderField = (key: string, originalValue: unknown) => {
    const val = currentValue(key)

    // Boolean -> checkbox
    if (typeof originalValue === 'boolean') {
      return (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={val as boolean}
            onChange={e => setField(key, e.target.checked)}
            className="accent-current"
            style={{ width: 16, height: 16 }}
          />
          <span className="font-mono" style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-m-agt)' }}>
            {String(val)}
          </span>
        </label>
      )
    }

    // Number -> number input
    if (typeof originalValue === 'number') {
      return (
        <input
          type="number"
          value={val as number}
          onChange={e => setField(key, Number(e.target.value))}
          className="font-mono"
          style={{
            width: '100%',
            padding: '6px var(--sp-3)',
            fontSize: 'var(--font-size-data)',
            background: 'var(--color-d1)',
            color: 'var(--color-s-warn)',
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
          }}
        />
      )
    }

    // Array of strings -> TagInput
    if (Array.isArray(originalValue) && originalValue.every(v => typeof v === 'string')) {
      const values = (val as string[]) ?? []
      return (
        <TagInput
          values={values}
          onChange={(newValues) => setField(key, newValues)}
          placeholder={key === 'adminPhones' ? 'Add phone number' : 'Add item'}
          validate={key === 'adminPhones' ? validatePhone : undefined}
          accentColor={values.length > 0 ? 'var(--color-m-agt)' : undefined}
          displayLabels={key === 'adminPhones' ? adminPhonesDisplay : undefined}
        />
      )
    }

    // Object -> read-only JSON textarea
    if (typeof originalValue === 'object' && originalValue !== null) {
      return (
        <textarea
          readOnly
          value={JSON.stringify(val, null, 2)}
          className="font-mono"
          style={{
            width: '100%',
            padding: '6px var(--sp-3)',
            fontSize: 'var(--font-size-data)',
            background: 'var(--color-d1)',
            color: 'var(--color-t3)',
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
            borderRadius: 'var(--radius-sm)',
            resize: 'vertical',
            minHeight: 60,
            filter: 'brightness(0.7)',
          }}
        />
      )
    }

    // String with known enum -> select
    const dotKey = key.includes('.') ? key.split('.')[1] : null
    const enumOpts = key in ENUM_OPTIONS ? ENUM_OPTIONS[key]
      : (dotKey && dotKey in AGENT_OPTION_ENUMS) ? AGENT_OPTION_ENUMS[dotKey]
      : null
    if (typeof originalValue === 'string' && enumOpts) {
      return (
        <select
          value={val as string}
          onChange={e => setField(key, e.target.value)}
          className="font-mono cursor-pointer"
          style={{
            width: '100%',
            padding: '6px var(--sp-3)',
            fontSize: 'var(--font-size-data)',
            background: 'var(--color-d1)',
            color: 'var(--color-m-pas)',
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
          }}
        >
          {enumOpts.map(opt => (
            <option key={opt} value={opt}>{opt || '(default)'}</option>
          ))}
        </select>
      )
    }

    // String (long) -> textarea
    if (typeof originalValue === 'string' && (originalValue as string).length > 80) {
      return (
        <textarea
          value={val as string}
          onChange={e => setField(key, e.target.value)}
          className="font-mono"
          style={{
            width: '100%',
            padding: '6px var(--sp-3)',
            fontSize: 'var(--font-size-data)',
            background: 'var(--color-d1)',
            color: 'var(--color-m-pas)',
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
            borderRadius: 'var(--radius-sm)',
            resize: 'vertical',
            minHeight: 80,
            outline: 'none',
          }}
        />
      )
    }

    // String (short) -> text input
    return (
      <input
        type="text"
        value={val as string}
        onChange={e => setField(key, e.target.value)}
        className="font-mono"
        style={{
          width: '100%',
          padding: '6px var(--sp-3)',
          fontSize: 'var(--font-size-data)',
          background: 'var(--color-d1)',
          color: 'var(--color-m-pas)',
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-sm)',
          outline: 'none',
        }}
      />
    )
  }

  const hasChanges = Object.keys(patch).length > 0
  const hasErrors = Object.entries(patch).some(([key]) => {
    const validator = FIELD_VALIDATORS[key]
    return validator ? validator(currentValue(key)) !== null : false
  })

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ background: 'var(--overlay)' }}
      onClick={onClose}
    >
      <div
        className="flex flex-col overflow-hidden"
        style={{
          background: 'var(--color-d2)',
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
          borderRadius: 'var(--radius-lg)',
          width: 560,
          maxWidth: '90%',
          maxHeight: '80vh',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between flex-shrink-0"
          style={{ padding: 'var(--sp-4) var(--sp-5)', borderBottom: 'var(--bw) solid var(--b1)' }}
        >
          <span className="font-sans font-semibold" style={{ fontSize: 'var(--font-size-lg)' }}>
            Edit Configuration
          </span>
          <button
            onClick={onClose}
            className="text-t4 hover:text-t2 cursor-pointer c-hover"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </div>

        {/* Restart warning */}
        <div
          className="flex items-center gap-2 flex-shrink-0"
          style={{
            padding: 'var(--sp-3) var(--sp-5)',
            background: 'var(--s-warn-wash)',
            borderBottom: 'var(--bw) solid var(--b1)',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-s-warn)',
          }}
        >
          <AlertTriangle size={14} strokeWidth={1.75} />
          <span>Some changes may require a restart to take effect.</span>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto" style={{ padding: 'var(--sp-4) var(--sp-5)' }}>
          <div className="flex flex-col" style={{ gap: 'var(--sp-4)' }}>
            {editableEntries.map(([key, originalValue]) => (
              <div key={key}>
                <label className="c-label" style={{ display: 'block', marginBottom: 'var(--sp-1)' }}>
                  {key}
                  {key in patch && (
                    <span
                      className="font-mono"
                      style={{
                        marginLeft: 'var(--sp-2)',
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-s-warn)',
                      }}
                    >
                      modified
                    </span>
                  )}
                </label>
                {renderField(key, originalValue)}
                {key in patch && FIELD_VALIDATORS[key]?.(currentValue(key)) && (
                  <span className="font-mono" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-s-crit)', marginTop: 'var(--sp-1)', display: 'block' }}>
                    {FIELD_VALIDATORS[key]!(currentValue(key))}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end gap-2 flex-shrink-0"
          style={{
            padding: 'var(--sp-3) var(--sp-5)',
            borderTop: 'var(--bw) solid var(--b1)',
            background: 'var(--color-d1)',
          }}
        >
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md font-sans text-t3 hover:text-t2 hover:bg-d4 cursor-pointer c-hover"
            style={{ fontSize: 'var(--font-size-heading)', border: 'none', background: 'transparent' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !hasChanges || hasErrors}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md font-sans font-medium cursor-pointer c-hover"
            style={{
              fontSize: 'var(--font-size-heading)',
              borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--color-m-cht)',
              background: hasChanges ? 'var(--color-m-cht)' : 'transparent',
              color: hasChanges ? 'var(--color-d0)' : 'var(--color-t5)',
              opacity: saving ? 0.6 : 1,
            }}
          >
            <Save size={14} strokeWidth={1.75} />
            {saving ? 'Saving...' : `Save${hasChanges ? ` (${Object.keys(patch).length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══ ModeSwitchDialog — select mode and restart ═══ */
const MODE_OPTIONS: { value: Mode; label: string; description: string }[] = [
  { value: 'passive', label: 'Passive', description: 'Listen and store messages. No responses.' },
  { value: 'chat', label: 'Chat', description: 'API-powered responses with access control.' },
  { value: 'agent', label: 'Agent', description: 'Full autonomous agent with tool use.' },
]

function ModeSwitchDialog({
  currentMode,
  lineName,
  onClose,
}: {
  currentMode: Mode
  lineName: string
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Mode>(currentMode)
  const [switching, setSwitching] = useState(false)

  const handleConfirm = async () => {
    if (selected === currentMode) {
      onClose()
      return
    }
    setSwitching(true)
    try {
      await api.updateConfig(lineName, { type: selected })
      await api.restart(lineName)
      toast.success(`Switched to ${selected} mode — restarting...`)
      await queryClient.invalidateQueries({ queryKey: ['lines', lineName] })
      onClose()
    } catch (e) {
      toast.error(`Mode switch failed: ${(e as Error).message}`)
    } finally {
      setSwitching(false)
    }
  }

  const modeKey = (m: Mode) => m === 'passive' ? 'pas' : m === 'chat' ? 'cht' : 'agt'
  const changed = selected !== currentMode

  return (
    <ConfirmDialog
      open
      title={`Switch ${lineName} Mode`}
      confirmLabel={changed ? `Switch to ${selected}` : 'No change'}
      confirmVariant="primary"
      confirmIcon={<GitBranch size={14} strokeWidth={1.75} />}
      onConfirm={handleConfirm}
      onCancel={onClose}
    >
      <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
        <p className="text-t3" style={{ fontSize: 'var(--font-size-sm)', marginBottom: 'var(--sp-2)' }}>
          Select the operating mode for this instance. The instance will restart after switching.
        </p>
        {MODE_OPTIONS.map(opt => {
          const isSelected = selected === opt.value
          const isCurrent = currentMode === opt.value
          const mk = modeKey(opt.value)
          return (
            <button
              key={opt.value}
              onClick={() => !switching && setSelected(opt.value)}
              className="flex items-start gap-3 text-left cursor-pointer c-hover"
              style={{
                padding: 'var(--sp-3) var(--sp-4)',
                borderRadius: 'var(--radius-md)',
                borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: isSelected ? `var(--m-${mk}-soft)` : 'var(--b1)',
                background: isSelected ? `var(--m-${mk}-wash)` : 'var(--color-d1)',
                opacity: switching ? 0.6 : 1,
              }}
            >
              {/* Radio indicator */}
              <span
                className="flex-shrink-0 rounded-full"
                style={{
                  width: 16,
                  height: 16,
                  marginTop: 2,
                  borderWidth: 'var(--bw-accent)', borderStyle: 'solid', borderColor: isSelected ? `var(--color-m-${mk})` : 'var(--b3)',
                  background: isSelected ? `var(--color-m-${mk})` : 'transparent',
                  boxShadow: isSelected ? `inset 0 0 0 3px var(--color-d2)` : 'none',
                }}
              />
              <div>
                <div className="font-sans font-medium" style={{ fontSize: 'var(--font-size-body)', color: isSelected ? `var(--color-m-${mk})` : 'var(--color-t2)' }}>
                  {opt.label}
                  {isCurrent && (
                    <span
                      className="font-mono"
                      style={{
                        marginLeft: 'var(--sp-2)',
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-t4)',
                      }}
                    >
                      current
                    </span>
                  )}
                </div>
                <div className="text-t4" style={{ fontSize: 'var(--font-size-sm)' }}>
                  {opt.description}
                </div>
              </div>
            </button>
          )
        })}
        {changed && (
          <div
            className="flex items-center gap-2"
            style={{
              padding: 'var(--sp-2) var(--sp-3)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--s-warn-wash)',
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-s-warn)',
            }}
          >
            <AlertTriangle size={13} strokeWidth={1.75} />
            <span>This will restart the instance. Active sessions will be interrupted.</span>
          </div>
        )}
      </div>
    </ConfirmDialog>
  )
}

/* ═══ Summary Tab — KPI strip + pipeline strip + config/actions columns ═══ */
function SummaryTab({ line }: { line: LineInstance }) {
  const toast = useToast()
  const [confirmAction, setConfirmAction] = useState<'restart' | 'stop' | null>(null)
  const [showConfigEditor, setShowConfigEditor] = useState(false)
  const [showModeSwitch, setShowModeSwitch] = useState(false)
  const modeColor = line.mode === 'passive' ? 'pas' : line.mode === 'chat' ? 'cht' : 'agt'
  const provider = (line.config?.agentOptions as Record<string, unknown> | undefined)?.provider as string | undefined
  const providerDisplay = line.mode === 'agent' && provider
    ? (getProvider(provider)?.displayName ?? provider)
    : line.mode

  const cards = [
    { label: 'STATUS', value: line.status, color: line.status === 'online' ? 'text-s-ok' : line.status === 'degraded' ? 'text-s-warn' : 'text-s-crit' },
    { label: 'UPTIME', value: line.uptime ?? '—', color: 'text-t1' },
    { label: 'MESSAGES', value: (line.messagesToday ?? 0).toLocaleString(), color: 'text-t1' },
    { label: line.mode === 'agent' ? 'PROVIDER' : 'MODE', value: providerDisplay, color: line.mode === 'passive' ? 'text-m-pas' : line.mode === 'chat' ? 'text-m-cht' : 'text-m-agt' },
    { label: 'ACCESS', value: line.accessMode ?? '—', color: 'text-t2' },
    { label: 'ACTIVE', value: line.lastActive ? formatRelative(line.lastActive) : '—', color: 'text-t3' },
  ]

  // Pipeline node active states driven by real runtime data
  const isOnline = line.status === 'online'
  const pipelineNodes = line.mode === 'passive'
    ? [
        { label: 'Inbound', active: isOnline },
        { label: 'Store', active: isOnline },
        { label: 'Done', active: isOnline && (line.unread ?? 0) === 0 },
      ]
    : line.mode === 'chat'
    ? [
        { label: 'Inbound', active: isOnline },
        { label: 'Access', active: isOnline && line.accessMode !== 'self_only' },
        { label: 'Queue', active: (line.queueDepth ?? 0) > 0 },
        { label: 'Enrich', active: (line.enrichmentUnprocessed ?? 0) > 0 },
        { label: 'API', active: isOnline },
        { label: 'Outbound', active: (line.queueDepth ?? 0) > 0 },
      ]
    : [
        { label: 'Inbound', active: isOnline },
        { label: 'Router', active: isOnline },
        { label: 'SDK Loop', active: (line.activeSessions ?? 0) > 0 },
        { label: 'Tools', active: (line.activeSessions ?? 0) > 0 },
        { label: 'Outbound', active: (line.activeSessions ?? 0) > 0 },
      ]

  const rawConfig = line.config ?? {}
  const config = line.mode !== 'passive' ? buildConfigEntries(rawConfig) : null

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
      {/* Row 1: KPI cards — 6-wide single row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: 'var(--sp-2)',
          background: 'var(--color-d1)',
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
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
              borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
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
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
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
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          <div className="flex items-center justify-between c-toolbar bg-d3" style={{ borderBottom: 'var(--bw) solid var(--b1)' }}>
            <span className="c-col-header text-t4">{line.mode} Configuration</span>
            {config && (
              <button
                onClick={() => setShowConfigEditor(true)}
                className="c-btn c-btn-ghost"
                style={{ padding: '3px var(--sp-2)', fontSize: 'var(--font-size-xs)' }}
              >
                Edit
              </button>
            )}
          </div>
          {config ? (
            <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
              {line.mode === 'agent' && (
                <div className="flex items-center justify-between" style={{ padding: '6px 0', ...(config.length > 0 ? { borderBottom: 'var(--bw) solid var(--b1)' } : {}) }}>
                  <span className="c-label">provider</span>
                  <span className="font-mono" style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-m-agt)' }}>
                    {getProvider(
                      ((rawConfig.agentOptions as Record<string, unknown> | undefined)?.provider as string) ?? DEFAULT_PROVIDER_ID
                    )?.displayName ?? DEFAULT_PROVIDER_ID}
                  </span>
                </div>
              )}
              {config.map((entry, i) => (
                <div key={entry.key} className="flex items-center justify-between" style={{ padding: '6px 0', ...(i < config.length - 1 ? { borderBottom: 'var(--bw) solid var(--b1)' } : {}) }}>
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
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          <div className="c-toolbar bg-d3" style={{ borderBottom: 'var(--bw) solid var(--b1)' }}>
            <span className="c-col-header text-t4">Actions</span>
          </div>
          <div className="flex flex-col" style={{ padding: 'var(--sp-3) var(--sp-4)', gap: 'var(--sp-2)' }}>
            <button
              onClick={() => setConfirmAction('restart')}
              className="c-btn w-full justify-center"
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <RotateCw size={13} strokeWidth={1.75} /> Restart Instance
            </button>
            {line.mode !== 'passive' && (
              <button
                onClick={() => setShowConfigEditor(true)}
                className="c-btn w-full justify-center"
                style={{ fontSize: 'var(--font-size-label)' }}
              >
                <SlidersHorizontal size={13} strokeWidth={1.75} /> Edit Configuration
              </button>
            )}
            <button
              onClick={() => setShowModeSwitch(true)}
              className="c-btn w-full justify-center"
              style={{ fontSize: 'var(--font-size-label)' }}
            >
              <GitBranch size={13} strokeWidth={1.75} /> Change Mode
            </button>
            <div style={{ borderTop: 'var(--bw) solid var(--b1)', paddingTop: 'var(--sp-2)', marginTop: 'var(--sp-1)' }}>
              <button
                onClick={() => setConfirmAction('stop')}
                className="c-btn c-btn-danger w-full justify-center"
                style={{ fontSize: 'var(--font-size-label)' }}
              >
                <Power size={13} strokeWidth={1.75} /> Stop Instance
              </button>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Confirmation dialogs for destructive actions */}
      <ConfirmDialog
        open={confirmAction === 'restart'}
        title={`Restart ${line.name}?`}
        confirmLabel="Restart"
        confirmVariant="primary"
        confirmIcon={<RotateCw size={14} strokeWidth={1.75} />}
        onConfirm={() => {
          setConfirmAction(null)
          toast.info(`Restarting ${line.name}...`)
          api.restart(line.name)
            .then(() => toast.success(`${line.name} restart requested`))
            .catch(e => toast.error(`Restart failed: ${e.message}`))
        }}
        onCancel={() => setConfirmAction(null)}
      >
        <p>Restarting will briefly disconnect <strong>{line.name}</strong> from WhatsApp.</p>
        <ul style={{ marginTop: 'var(--sp-2)', paddingLeft: 'var(--sp-5)' }}>
          <li>Active chat sessions will be interrupted</li>
          <li>Agent sessions will be terminated and must restart</li>
          <li>Messages received during restart will be queued</li>
          <li>The instance will attempt to reconnect automatically</li>
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmAction === 'stop'}
        title={`Stop ${line.name}?`}
        confirmLabel="Stop"
        confirmVariant="danger"
        confirmIcon={<Power size={14} strokeWidth={1.75} />}
        onConfirm={() => {
          setConfirmAction(null)
          toast.info(`Stopping ${line.name}...`)
          api.stopInstance(line.name)
            .then(() => toast.success(`${line.name} stop requested`))
            .catch(e => toast.error(`Stop failed: ${e.message}`))
        }}
        onCancel={() => setConfirmAction(null)}
      >
        <p>Stopping will disconnect <strong>{line.name}</strong> from WhatsApp.</p>
        <ul style={{ marginTop: 'var(--sp-2)', paddingLeft: 'var(--sp-5)' }}>
          <li>All active chat and agent sessions will be terminated</li>
          <li>The instance will not reconnect until manually started</li>
          <li>Messages received while stopped will not be delivered</li>
        </ul>
      </ConfirmDialog>

      {/* Config editor dialog */}
      {showConfigEditor && rawConfig && (
        <ConfigEditDialog
          config={rawConfig}
          lineName={line.name}
          adminPhonesDisplay={(line as unknown as { adminPhonesDisplay?: Record<string, string> }).adminPhonesDisplay}
          onClose={() => setShowConfigEditor(false)}
        />
      )}

      {/* Mode switch dialog */}
      {showModeSwitch && (
        <ModeSwitchDialog
          currentMode={line.mode}
          lineName={line.name}
          onClose={() => setShowModeSwitch(false)}
        />
      )}
    </div>
  )
}

/* ═══ Config Block — c-config from components.html ═══ */
function ConfigValue({ value, type }: { value: string; type: 'string' | 'number' | 'boolean' | 'path' }) {
  return <span style={{ color: TYPE_COLOR[type] }}>{value}</span>
}

/* ═══ Mode Tab ═══ */
function ModeTab({ mode, line }: { mode: Mode; line: LineInstance }) {
  if (mode === 'passive') {
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
      >
        <EmptyState
          icon={<Bot size={40} strokeWidth={1.25} />}
          title="Read-only Mode"
          description="Passive instances listen and store — no configuration required."
        />
      </div>
    )
  }

  const rawConfig = line.config ?? {}
  const config = buildConfigEntries(rawConfig)

  return (
    <div
      style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
    >
      <div className="c-col-header mb-5">
        {mode} Configuration
      </div>
      {/* c-config block — syntax-highlighted JSON-like display */}
      <div
        className="font-mono overflow-x-auto whitespace-pre leading-relaxed"
        style={{
          background: 'var(--color-d1)',
          borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--msg-pad-h) var(--sp-4)',
          fontSize: 'var(--font-size-data)',
          color: 'var(--color-t2)',
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
  const isOnline = line.status === 'online'
  if (mode === 'passive') {
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
      >
        <div className="flex items-center justify-center gap-2 py-12">
          <PipelineNode label="Inbound" color={modeColor} active={isOnline} />
          <PipelineArrow />
          <PipelineNode label="Store" color={modeColor} active={isOnline} />
          <PipelineArrow />
          <PipelineNode label="Done" color={modeColor} active={isOnline && (line.unread ?? 0) === 0} />
        </div>
      </div>
    )
  }
  if (mode === 'chat') {
    const queueDepth = line.queueDepth ?? 0
    const enrichUnproc = line.enrichmentUnprocessed ?? 0
    return (
      <div
        style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
      >
        <div className="flex items-center justify-center gap-2 py-12 flex-wrap">
          <PipelineNode label="Inbound" color={modeColor} active={isOnline} />
          <PipelineArrow />
          <PipelineNode label="Access" color={modeColor} active={isOnline && line.accessMode !== 'self_only'} />
          <PipelineArrow />
          <PipelineNode label="Queue" value={`depth: ${queueDepth}`} color={modeColor} active={queueDepth > 0} />
          <PipelineArrow />
          <PipelineNode label="Enrich" value={enrichUnproc > 0 ? `${enrichUnproc} pending` : undefined} color={modeColor} active={enrichUnproc > 0} />
          <PipelineArrow />
          <PipelineNode label="API" color={modeColor} active={isOnline} />
          <PipelineArrow />
          <PipelineNode label="Outbound" color={modeColor} active={queueDepth > 0} />
        </div>
      </div>
    )
  }
  const sessions = line.activeSessions ?? 0
  return (
    <div
      style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', padding: 'var(--sp-7)' }}
    >
      <div className="flex items-center justify-center gap-2 py-12 flex-wrap">
        <PipelineNode label="Inbound" color={modeColor} active={isOnline} />
        <PipelineArrow />
        <PipelineNode label="Router" color={modeColor} active={isOnline} />
        <PipelineArrow />
        <PipelineNode label="SDK Loop" value={`sessions: ${sessions}`} color={modeColor} active={sessions > 0} />
        <PipelineArrow />
        <PipelineNode label="Tools" color={modeColor} active={sessions > 0} />
        <PipelineArrow />
        <PipelineNode label="Outbound" color={modeColor} active={sessions > 0} />
      </div>
    </div>
  )
}

/* ═══ Access Tab — compact layout from components.html ═══ */
function AccessTab({ access, lineName }: { access: AccessEntry[]; lineName: string }) {
  const toast = useToast()

  const handleAccess = (subjectType: string, subjectId: string, subjectName: string, action: 'allow' | 'block') => {
    const label = action === 'allow' ? 'Allow' : 'Block'
    api.accessDecision(lineName, subjectType, subjectId, action)
      .then(() => toast.success(`${label}ed ${subjectName}`))
      .catch(e => toast.error(`${label} failed: ${e.message}`))
  }
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
        padding: 'var(--sp-2h) var(--sp-4)',
        borderBottom: 'var(--bw) solid var(--b1)',
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
            onClick={() => handleAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'allow')}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-s-ok hover:bg-d5 cursor-pointer c-hover"
            style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
          >
            <UserCheck size={11} strokeWidth={1.75} /> Allow
          </button>
          <button
            onClick={() => handleAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'block')}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer c-hover"
            style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
          >
            <Ban size={11} strokeWidth={1.75} /> Block
          </button>
        </div>
      )}
      {showActions === 'allowed' && (
        <button
          onClick={() => handleAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'block')}
          className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer c-hover"
          style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
        >
          <Ban size={11} strokeWidth={1.75} />
        </button>
      )}
      {showActions === 'blocked' && (
        <button
          onClick={() => handleAccess(entry.subjectType, entry.subjectId, entry.subjectName, 'allow')}
          className="flex items-center gap-1 px-2 py-0.5 rounded font-mono text-s-ok hover:bg-d5 cursor-pointer c-hover"
          style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
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
        <div className="rounded-lg overflow-hidden" style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
          <div
            className="c-col-header text-t4"
            style={{ padding: 'var(--sp-2) var(--msg-pad-h)', borderBottom: 'var(--bw) solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Pending ({pending.length})
          </div>
          {pending.map(e => renderItem(e, 'pending'))}
        </div>
      )}

      {/* Allowed + Blocked in two columns */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg overflow-hidden" style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
          <div
            className="c-col-header text-t4"
            style={{ padding: 'var(--sp-2) var(--msg-pad-h)', borderBottom: 'var(--bw) solid var(--b1)', background: 'var(--color-d3)' }}
          >
            Allowed ({allowed.length})
          </div>
          {allowed.map(e => renderItem(e, 'allowed'))}
        </div>
        <div className="rounded-lg overflow-hidden" style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}>
          <div
            className="c-col-header text-t4"
            style={{ padding: 'var(--sp-2) var(--msg-pad-h)', borderBottom: 'var(--bw) solid var(--b1)', background: 'var(--color-d3)' }}
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
function HistoryMessages({ messages, outgoingBg, selectedChat, lineName }: {
  messages: Message[]; outgoingBg: string; selectedChat: string; lineName: string;
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const [msgText, setMsgText] = React.useState('')
  const [isSending, setIsSending] = React.useState(false)

  // Reset textarea height when text is cleared
  React.useEffect(() => {
    if (!msgText && textareaRef.current) {
      textareaRef.current.style.height = ''
      textareaRef.current.style.overflow = 'hidden'
    }
  }, [msgText])

  // Clear message input when switching conversations
  React.useEffect(() => { setMsgText('') }, [selectedChat])

  // ── Cursor pagination state ──
  const [olderMessages, setOlderMessages] = React.useState<Message[]>([])
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(true)

  // Reset pagination when conversation changes
  React.useEffect(() => { setOlderMessages([]); setHasMore(true) }, [selectedChat])

  const loadOlder = async () => {
    if (loadingOlder || !hasMore) return
    const allMsgs = [...(messages || []), ...olderMessages]
    const positivePks = allMsgs.map(m => m.pk).filter(pk => pk > 0)
    const oldestPk = positivePks.length > 0 ? Math.min(...positivePks) : undefined
    if (!oldestPk) return

    setLoadingOlder(true)
    try {
      const older = await api.getMessages(lineName, selectedChat, oldestPk)
      if (older.length === 0) {
        setHasMore(false)
      } else {
        setOlderMessages(prev => [...prev, ...older])
      }
    } catch (e) {
      toast.error(`Failed to load older messages: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoadingOlder(false)
    }
  }

  // Track which message PKs were just added optimistically so we can animate them
  const [animatedPks, setAnimatedPks] = React.useState<Set<number>>(new Set())

  const handleSend = async () => {
    if (!msgText.trim() || !selectedChat || isSending) return
    const text = msgText.trim()
    setIsSending(true)
    setMsgText('')

    // Optimistic: inject message into cache immediately with a negative pk
    const optimisticPk = -Date.now()
    const optimisticMsg: Message = {
      pk: optimisticPk,
      conversationKey: selectedChat,
      senderName: 'You',
      senderJid: '',
      content: text,
      timestamp: new Date().toISOString(),
      fromMe: true,
      type: 'text',
    }
    const queryKey = ['messages', lineName, selectedChat]
    queryClient.setQueryData<Message[]>(queryKey, (old) => [optimisticMsg, ...(old ?? [])])
    setAnimatedPks(prev => new Set(prev).add(optimisticPk))

    try {
      await api.sendMessage(lineName, selectedChat, text)
      // Refetch to get the real persisted message (replaces the optimistic one)
      queryClient.invalidateQueries({ queryKey })
    } catch (e) {
      // Remove optimistic message on failure
      queryClient.setQueryData<Message[]>(queryKey, (old) => (old ?? []).filter(m => m.pk !== optimisticPk))
      toast.error(`Send failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setIsSending(false)
    }
  }

  // Combine live + older messages, deduplicate by pk
  const allMessages = React.useMemo(() => {
    const combined = [...(messages || []), ...olderMessages]
    const seen = new Set<number>()
    return combined.filter(m => { if (seen.has(m.pk)) return false; seen.add(m.pk); return true })
  }, [messages, olderMessages])

  const reversed = React.useMemo(() => [...allMessages].reverse(), [allMessages])

  // Shared auto-scroll hook
  const { scrollRef: stickyScrollRef, showJump: showJumpToBottom, handleScroll, jumpToBottom } = useStickyScroll(reversed, selectedChat)

  return (
    <>
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={stickyScrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scrollbar-hide"
        style={{ padding: 'var(--sp-4) var(--sp-5)' }}
      >
        {/* Load older messages */}
        {reversed.length > 0 && (
          hasMore ? (
            <div
              className={`flex items-center justify-center c-hover text-t5 ${loadingOlder ? '' : 'cursor-pointer hover:text-t2'}`}
              style={{ padding: 'var(--sp-3) 0 var(--sp-4)', gap: 'var(--sp-2)' }}
              onClick={loadOlder}
            >
              {loadingOlder ? (
                <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
              ) : (
                <ChevronsUp size={14} strokeWidth={1.75} />
              )}
              <span style={{ fontSize: 'var(--font-size-sm)' }}>
                {loadingOlder ? 'Loading...' : 'Load older messages'}
              </span>
            </div>
          ) : (
            <div
              className="flex items-center justify-center text-t5"
              style={{ padding: 'var(--sp-3) 0 var(--sp-4)', gap: 'var(--sp-2)' }}
            >
              <span style={{ fontSize: 'var(--font-size-sm)' }}>No more messages</span>
            </div>
          )
        )}

        {/* Message list */}
        <div className="flex flex-col" style={{ gap: 'var(--sp-3)' }}>
          {reversed.map(msg => (
            <MessageBubble
              key={msg.pk}
              msg={msg}
              outgoingBg={outgoingBg}
              onCreateContact={(name) => toast.info(`Save contact: ${name}`)}
              animate={animatedPks.has(msg.pk)}
            />
          ))}
        </div>

        {/* Scroll anchor (empty div at bottom for content termination) */}
        <div />
      </div>

      {/* Jump to newest — floats above the input bar, inside the positioned wrapper */}
      {showJumpToBottom && (
        <div
          className="absolute flex items-center justify-center cursor-pointer hover:text-t2 c-hover text-t5"
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 'var(--sp-4)',
            padding: 'var(--sp-2) var(--sp-5)',
            gap: 'var(--sp-2)',
            background: 'color-mix(in srgb, var(--color-d4) 80%, transparent)',
            borderRadius: 'var(--radius-md)',
            backdropFilter: 'blur(4px)',
            zIndex: 10,
          }}
          onClick={jumpToBottom}
        >
          <ChevronsUp size={14} strokeWidth={1.75} className="rotate-180" />
          <span style={{ fontSize: 'var(--font-size-sm)' }}>Jump to newest</span>
        </div>
      )}
      </div>

      {/* Input bar */}
      <div
        className="flex flex-shrink-0 items-center"
        style={{ padding: 'var(--sp-3) var(--sp-4)', gap: 'var(--sp-3)', borderTop: 'var(--bw) solid var(--b1)', background: 'var(--color-d2)' }}
      >
        <textarea
          ref={textareaRef}
          className="flex-1 text-t2 font-sans placeholder-t5 outline-none leading-tight"
          rows={1}
          style={{
            fontSize: 'var(--font-size-body)',
            padding: 'var(--sp-2h) var(--sp-4)',
            background: 'var(--color-d1)',
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
            borderRadius: 'var(--radius-md)',
            maxHeight: '120px',
            resize: 'none',
            overflow: 'hidden',
          }}
          placeholder="Type a reply..."
          value={msgText}
          onChange={e => {
            setMsgText(e.target.value)
            const el = e.target
            el.style.height = '0'
            el.style.height = Math.min(el.scrollHeight, 120) + 'px'
            el.style.overflow = el.scrollHeight > 120 ? 'auto' : 'hidden'
          }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
        />
        <button
          className="c-btn c-btn-primary c-btn-send flex-shrink-0"
          onClick={handleSend}
          disabled={isSending || !msgText.trim()}
        >
          <Send size={16} strokeWidth={2} />
          <span className="c-btn-send-label">Send</span>
        </button>
      </div>
    </>
  )
}

/* ═══ History Tab — matches chat component patterns ═══ */

function HistoryTab({ chats, messages, selectedChat, onSelectChat, mode, lineName, typingJids }: {
  chats: ChatItem[]; messages: Message[]; selectedChat: string | null; onSelectChat: (key: string) => void; mode: Mode; lineName: string; typingJids: Set<string>;
}) {
  const outgoingBg = mode === 'agent' ? 'var(--m-agt-soft)' : 'var(--m-cht-soft)'
  return (
    <div
      className="flex overflow-hidden h-full"
      style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', borderRadius: 'var(--radius-lg)' }}
    >
      {/* Chat list */}
      <div
        className="flex-shrink-0 flex flex-col"
        style={{ width: 'var(--panel-history)', borderRight: 'var(--bw) solid var(--b1)', background: 'var(--color-d1)' }}
      >
        {/* Chat list header */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
          style={{ borderBottom: 'var(--bw) solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
        >
          <span className="c-heading">Conversations</span>
          <span className="c-label">{chats.length} chats</span>
        </div>

        <div className="flex-1 overflow-auto scrollbar-hide">
          {chats.map(chat => (
            <ChatListItem
              key={chat.conversationKey}
              chat={chat}
              isSelected={selectedChat === chat.conversationKey}
              onClick={() => onSelectChat(chat.conversationKey)}
              isTyping={typingJids.has(chat.conversationKey)}
            />
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--color-d0)' }}>
        {selectedChat ? (
          <HistoryMessages
            messages={messages}
            outgoingBg={outgoingBg}
            selectedChat={selectedChat}
            lineName={lineName}
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
      style={{ borderRadius: 'var(--radius-lg)', background: 'var(--color-d2)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)' }}
    >
      {/* Toolbar with level filter pills — matches established pattern */}
      <div
        className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
        style={{ borderBottom: 'var(--bw) solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
      >
        <span className="c-heading">Logs</span>
        <div className="flex" style={{ gap: 'var(--sp-1)' }}>
          {levels.map(l => (
            <FilterPill
              key={l}
              label={l}
              isActive={filter === l}
              activeColor={l === 'error' ? 'text-s-crit' : l === 'warn' ? 'text-s-warn' : 'text-t2'}
              activeBorder={filter === l ? 'var(--bw) solid var(--b3)' : undefined}
              onClick={() => onFilterChange(l)}
            />
          ))}
        </div>
      </div>

      {/* Log viewer — c-log-line pattern */}
      <div
        className="rounded-lg overflow-hidden font-mono"
        style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', background: 'var(--color-d1)', fontSize: 'var(--font-size-data)' }}
      >
        {filtered.map((log, i) => (
          <div
            key={`${log.timestamp}-${log.source}-${i}`}
            className="flex gap-0 hover:bg-d3 c-hover leading-relaxed"
            style={{
              borderBottom: 'var(--bw) solid var(--b1)',
              background: levelLineBg[log.level],
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
