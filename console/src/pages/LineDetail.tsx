import React, { useState, useCallback, lazy, Suspense } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { useLine, useChats, useMessages, useAccess, useLogs, useTyping } from '../hooks/use-fleet'
import { useMetrics } from '../hooks/use-metrics'
import type { MetricsRange } from '../types'
import { getPreference, setPreference } from '../lib/preferences'
import { useToast } from '../hooks/toast-context'
import { api } from '../lib/api'
import ModeBadge from '../components/ModeBadge'
import LineTags from '../components/LineTags'
import HeartbeatStrip from '../components/HeartbeatStrip'
import ConfirmDialog from '../components/ConfirmDialog'
import Skeleton, { TableSkeleton } from '../components/Skeleton'
const RelinkModal = lazy(() => import('../components/RelinkModal'))
import {
  ArrowLeft, Info, SlidersHorizontal, GitBranch, Shield,
  MessageSquare, ScrollText, BarChart3, Clock, Users,
  RotateCw, Loader2, Trash2, Link2,
} from 'lucide-react'

import {
  SummaryTab,
  ModeTab,
  PipelineTab,
  AccessTab,
  HistoryTab,
  LogsTab,
  MetricsTab,
  ScheduledTab,
  GroupsTab,
  ConfigEditDialog,
  ModeSwitchDialog,
} from '../components/line-detail'

const TABS = [
  { id: 'summary', label: 'Summary', icon: Info },
  { id: 'mode', label: 'Mode', icon: SlidersHorizontal },
  { id: 'pipeline', label: 'Pipeline', icon: GitBranch },
  { id: 'access', label: 'Access', icon: Shield },
  { id: 'history', label: 'History', icon: MessageSquare },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'metrics', label: 'Metrics', icon: BarChart3 },
  { id: 'scheduled', label: 'Scheduled', icon: Clock },
  { id: 'groups', label: 'Groups', icon: Users },
] as const

type TabId = typeof TABS[number]['id']

/* ═══ Main Component ═══ */
export default function LineDetail() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<TabId>('summary')
  const [metricsRange, setMetricsRangeRaw] = useState<MetricsRange>(
    () => getPreference('metricsRange', '24h') as MetricsRange
  )
  const setMetricsRange = (r: MetricsRange) => { setMetricsRangeRaw(r); setPreference('metricsRange', r); }
  const { data: line } = useLine(name || '')
  const { data: chats } = useChats(name || '')
  const { data: access } = useAccess(name || '')
  const { data: logs } = useLogs(name || '')
  const { data: metrics, isLoading: metricsLoading, error: metricsError } = useMetrics(name || '', metricsRange)
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
  const [showConfigEditor, setShowConfigEditor] = useState(false)
  const [showModeSwitch, setShowModeSwitch] = useState(false)
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

        {/* Status dot */}
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

        {/* Meta */}
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
        role="tablist"
        aria-label="Line detail tabs"
        style={{ padding: '0 var(--sp-4)', borderBottom: 'var(--bw) solid var(--b1)', background: 'var(--color-d2)' }}
      >
        {TABS.map(tab => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              id={`tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 font-sans font-medium c-hover relative ${
                isActive
                  ? 'text-t1 cursor-pointer'
                  : 'text-t4 hover:text-t3 cursor-pointer'
              }`}
              style={{ padding: 'var(--sp-2h) var(--sp-4)', fontSize: 'var(--font-size-data)' }}
            >
              <Icon size={15} strokeWidth={1.75} />
              {tab.label}
              {isActive && (
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
      <div
        className="flex-1 overflow-hidden min-h-0 flex flex-col"
        role="tabpanel"
        id={`tabpanel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
        style={{ padding: 'var(--sp-5)' }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="flex-1 min-h-0 flex flex-col overflow-hidden"
          >
            {activeTab === 'summary' && (
              <SummaryTab
                line={line}
                onEditConfig={() => setShowConfigEditor(true)}
                onChangeMode={() => setShowModeSwitch(true)}
              />
            )}
            {activeTab === 'mode' && (
              <ModeTab
                mode={line.mode}
                line={line}
                onEditConfig={() => setShowConfigEditor(true)}
                onChangeMode={() => setShowModeSwitch(true)}
              />
            )}
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
            {activeTab === 'metrics' && (
              <MetricsTab
                metrics={metrics}
                metricsLoading={metricsLoading}
                metricsError={metricsError}
                metricsRange={metricsRange}
                setMetricsRange={setMetricsRange}
                lineName={name}
              />
            )}
            {activeTab === 'scheduled' && (
              <ScheduledTab lineName={name || ''} />
            )}
            {activeTab === 'groups' && <GroupsTab lineName={name || ''} />}
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

      <Suspense fallback={null}>
        <RelinkModal
          lineName={line?.name ?? ''}
          open={showRelink}
          onClose={() => setShowRelink(false)}
          onLinked={() => { setShowRelink(false); queryClient.invalidateQueries({ queryKey: ['lines', name] }); toast.success(`${line?.name} re-linked!`); }}
        />
      </Suspense>
      {showConfigEditor && line.config && (
        <ConfigEditDialog
          config={line.config}
          lineName={line.name}
          adminPhonesDisplay={(line as unknown as { adminPhonesDisplay?: Record<string, string> }).adminPhonesDisplay}
          onClose={() => setShowConfigEditor(false)}
        />
      )}

      {showModeSwitch && (
        <ModeSwitchDialog
          currentMode={line.mode}
          lineName={line.name}
          onClose={() => setShowModeSwitch(false)}
        />
      )}
    </motion.div>
  )
}
