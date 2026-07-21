import React, { useState, useCallback, lazy, Suspense } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { useLine, useChats, useMessages, useAccess, useLogs, useTyping, useCheckpoints, useLiveSessions, useApprovals } from '../hooks/use-fleet'
import { useMetrics } from '../hooks/use-metrics'
import type { MetricsRange } from '../types'
import { getPreference, setPreference } from '../lib/preferences'
import { formatCount } from '../lib/text-utils'
import { useToast } from '../hooks/toast-context'
import { api } from '../lib/api'
import ModeBadge from '../components/ModeBadge'
import { StatusCell, Tabs, Tab, Button, ActionButton } from '../components/primitives'
import LineTags from '../components/LineTags'
import HeartbeatStrip from '../components/HeartbeatStrip'
import ConfirmDialog from '../components/ConfirmDialog'
import Skeleton, { TableSkeleton } from '../components/Skeleton'
import EmptyState from '../components/EmptyState'
import ErrorBoundary from '../components/ErrorBoundary'
const RelinkModal = lazy(() => import('../components/RelinkModal'))
import {
  ArrowLeft, Info, SlidersHorizontal, GitBranch, Shield,
  MessageSquare, ScrollText, BarChart3, Clock, Users, BookMarked,
  RotateCw, Loader2, Trash2, Link2, ClipboardCheck,
} from 'lucide-react'

import {
  SummaryTab,
  ModeTab,
  PipelineTab,
  AccessTab,
  ApprovalsTab,
  HistoryTab,
  LogsTab,
  MetricsTab,
  CheckpointsTab,
  ScheduledTab,
  GroupsTab,
  ConfigEditDialog,
  ModeSwitchDialog,
} from '../components/line-detail'

const BASE_TABS = [
  { id: 'summary', label: 'Summary', icon: Info },
  { id: 'mode', label: 'Mode', icon: SlidersHorizontal },
  { id: 'pipeline', label: 'Pipeline', icon: GitBranch },
  { id: 'access', label: 'Access', icon: Shield },
  { id: 'history', label: 'History', icon: MessageSquare },
  { id: 'logs', label: 'Logs', icon: ScrollText },
  { id: 'metrics', label: 'Metrics', icon: BarChart3 },
  { id: 'checkpoints', label: 'Checkpoints', icon: BookMarked },
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck },
] as const

/** MCP-dependent tabs — only shown when instance has a global MCP socket (not sandbox-per-chat). */
const MCP_TABS = [
  { id: 'scheduled', label: 'Scheduled', icon: Clock },
  { id: 'groups', label: 'Groups', icon: Users },
] as const

type TabId = typeof BASE_TABS[number]['id'] | typeof MCP_TABS[number]['id']

/* ═══ Main Component ═══ */
export default function LineDetail() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<TabId>('summary')
  const [metricsRange, setMetricsRangeRaw] = useState<MetricsRange>(
    () => getPreference('metricsRange', '7d') as MetricsRange
  )
  const setMetricsRange = (r: MetricsRange) => { setMetricsRangeRaw(r); setPreference('metricsRange', r); }
  const {
    data: line,
    isLoading: lineLoading,
    error: lineError,
    refetch: refetchLine,
  } = useLine(name || '')
  const { data: chats } = useChats(name || '')
  const {
    data: access,
    isLoading: accessLoading,
    error: accessError,
    refetch: refetchAccess,
  } = useAccess(name || '')
  const {
    data: approvalsPayload,
    isLoading: approvalsLoading,
    freshness: approvalsFreshness,
  } = useApprovals(name || '')
  const {
    data: logs,
    isLoading: logsLoading,
    error: logsError,
    refetch: refetchLogs,
  } = useLogs(name || '')
  const { data: metrics, isLoading: metricsLoading, error: metricsError, refetch: refetchMetrics, freshness: metricsFreshness } = useMetrics(name || '', metricsRange)
  const { data: checkpointsPayload, isLoading: checkpointsLoading, freshness: checkpointsFreshness } = useCheckpoints(name || '')
  const { data: liveSessionsPayload } = useLiveSessions(name || '')
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
      navigate('/operator')
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeleting(false)
      setShowDeleteConfirm(false)
    }
  }, [line, toast, navigate])

  if (!line && !lineLoading) {
    const lineLabel = name ?? 'This line'
    const isNotFound = !lineError || /(?:not found|404)/i.test(lineError.message)
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-[var(--sp-6)]">
        <EmptyState
          variant="error"
          title={isNotFound ? 'Line not found' : 'Failed to load line'}
          description={isNotFound ? `${lineLabel} may have been deleted or renamed.` : lineError.message}
          onRetry={lineError ? () => { void refetchLine() } : undefined}
          retryLabel="Retry line"
        />
        <Button variant="ghost" onClick={() => navigate('/')}>Back to fleet</Button>
      </div>
    )
  }

  if (!line) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex items-center gap-4 px-10 py-4 c-border-b">
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

  // MCP-dependent tabs only for modes with a global MCP socket:
  // - passive: always has socket in state dir
  // - agent (non-sandbox): has socket at cwd/.claude/
  // - chat: no MCP socket server
  // - agent (sandbox-per-chat): per-chat sockets only, no global socket
  const hasMcpSocket = line.mode === 'passive' || (line.mode === 'agent' && !line.sandboxPerChat)
  const pendingApprovals = approvalsPayload?.approvals?.length ?? 0
  const tabs = (hasMcpSocket ? [...BASE_TABS, ...MCP_TABS] : [...BASE_TABS]).map((t) =>
    t.id === 'approvals' && pendingApprovals > 0 ? { ...t, label: `Approvals (${pendingApprovals})` } : t,
  )

  const ease = [0.22, 1, 0.36, 1] as const

  return (
    <motion.div
      className="flex-1 flex flex-col min-h-0 overflow-hidden p-[var(--sp-4)] gap-[var(--sp-3)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease }}
    >
      {/* ═══ Line Header ═══ */}
      <div
        className="flex flex-wrap md:flex-nowrap items-center gap-4 c-toolbar flex-shrink-0 bg-surface-raised c-border rounded-lg"
      >
        <ActionButton
          label="Back"
          icon={<ArrowLeft size={18} strokeWidth={1.75} />}
          onClick={() => navigate('/')}

        />

        {/* Status — shape law: disc/diamond/square/outline + label */}
        <StatusCell status={line.status} live={line.status === 'online'} />

        {/* Identity */}
        <div className="flex-1 min-w-[var(--header-identity-min)]">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <h1 title={line.name} className="text-text-1 font-extrabold font-[family-name:var(--font-display)] tracking-[var(--tracking-tight)] text-xl truncate min-w-0 flex-1">
              {line.name}
            </h1>
            <ModeBadge mode={line.mode} />
            <LineTags line={line} />
          </div>
          <div className="font-mono text-text-2 text-data">
            {line.phone}
          </div>
        </div>

        {/* Meta */}
        <div className="hidden lg:flex gap-4 font-mono text-text-2 text-sm">
          <span>uptime: {line.uptime ?? '—'}</span>
          <span>port: {line.healthPort}</span>
          <span>msgs: {formatCount(line.messagesTotal)}</span>
        </div>

        {/* Heartbeat + Actions */}
        <div className="hidden md:block">
          <HeartbeatStrip beats={line.heartbeat} />
        </div>
        <div className="flex items-center gap-[var(--sp-2)]">
          {line.linkedStatus === 'unlinked' && (
            <Button variant="ghost" size="sm" icon={<Link2 size={15} strokeWidth={1.75} />} onClick={() => setShowRelink(true)}>
              Re-link
            </Button>
          )}
          {line.linkedStatus !== 'unlinked' && (
            <Button variant="ghost" size="sm" icon={<RotateCw size={15} strokeWidth={1.75} />} onClick={() => { toast.info(`Restarting ${line.name}...`); api.restart(line.name).then(() => toast.success(`${line.name} restart requested`)).catch(e => toast.error(`Restart failed: ${e.message}`)); }}>
              Restart
            </Button>
          )}
          <Button variant="danger" size="sm" icon={<Trash2 size={15} strokeWidth={1.75} />} onClick={() => setShowDeleteConfirm(true)}>
            Delete
          </Button>
        </div>
      </div>

      {/* ═══ Tab bar + content container ═══ */}
      <div
        className="flex-1 flex flex-col min-h-0 bg-surface-inset c-border rounded-lg overflow-hidden"
      >
      <Tabs
        label="Line detail tabs"
        value={activeTab}
        onChange={(id) => setActiveTab(id as TabId)}
        inset
        lazyPanels
        className="flex-shrink-0 bg-surface-raised"
      >
        {tabs.map(tab => {
          const Icon = tab.icon
          return (
            <Tab key={tab.id} id={tab.id}>
              <Icon size={15} strokeWidth={1.75} />
              {tab.label}
            </Tab>
          )
        })}
      </Tabs>

      {/* ═══ Tab content ═══ */}
      <div
        className="flex-1 overflow-hidden min-h-0 flex flex-col relative"
        role="tabpanel"
        id={`tabpanel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="flex-1 min-h-0 min-w-0 flex flex-col overflow-auto px-[var(--sp-5)] pt-[var(--sp-4)] pb-[var(--sp-8)]"
          >
            <ErrorBoundary key={activeTab}>
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
              {activeTab === 'access' && (
                accessLoading ? (
                  <EmptyState title="Loading access list..." description="Fetching access decisions for this line." />
                ) : accessError ? (
                  <EmptyState
                    variant="error"
                    title="Failed to load access list"
                    description={accessError.message}
                    onRetry={() => { void refetchAccess() }}
                  />
                ) : (
                  <AccessTab access={access ?? []} lineName={name || ''} />
                )
              )}
              {activeTab === 'approvals' && (
                <ApprovalsTab
                  payload={approvalsPayload}
                  isLoading={approvalsLoading}
                  freshness={approvalsFreshness}
                  lineName={name || ''}
                />
              )}
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
              {activeTab === 'logs' && (
                logsLoading ? (
                  <EmptyState title="Loading logs..." description="Fetching recent log entries for this line." />
                ) : logsError ? (
                  <EmptyState
                    variant="error"
                    title="Failed to load logs"
                    description={logsError.message}
                    onRetry={() => { void refetchLogs() }}
                  />
                ) : (
                  <LogsTab logs={logs ?? []} filter={logFilter} onFilterChange={setLogFilter} />
                )
              )}
              {activeTab === 'metrics' && (
                <MetricsTab
                  metrics={metrics}
                  metricsLoading={metricsLoading}
                  metricsError={metricsError}
                  metricsRange={metricsRange}
                  setMetricsRange={setMetricsRange}
                  lineName={name}
                  line={line}
                  onRetry={refetchMetrics}
                  metricsFreshness={metricsFreshness}
                />
              )}
              {activeTab === 'scheduled' && (
                <ScheduledTab lineName={name || ''} />
              )}
              {activeTab === 'checkpoints' && (
                <CheckpointsTab
                  payload={checkpointsPayload}
                  isLoading={checkpointsLoading}
                  freshness={checkpointsFreshness}
                  lineName={name || ''}
                  liveSessions={liveSessionsPayload}
                />
              )}
              {activeTab === 'groups' && <GroupsTab lineName={name || ''} myJid={line.phone ? `${line.phone}@s.whatsapp.net` : undefined} />}
            </ErrorBoundary>
          </motion.div>
        </AnimatePresence>
        {/* Bottom fade to indicate scrollable content */}
        <div className="absolute bottom-0 left-0 right-0 h-[var(--sp-8)] pointer-events-none" style={{ background: 'linear-gradient(to top, var(--surface-base), transparent)' }} />
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
      {line.config && (
        <ConfigEditDialog
          open={showConfigEditor}
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
