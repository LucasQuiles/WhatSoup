import { useState } from 'react'
import { motion } from 'framer-motion'
import { RotateCw, SlidersHorizontal, GitBranch, Power } from 'lucide-react'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import { formatRelative } from '../../lib/format-time'
import { getProvider, DEFAULT_PROVIDER_ID } from '../../lib/providers'
import { statusTextClass } from '../../lib/status-severity'
import ConfirmDialog from '../ConfirmDialog'
import { PipelineNode, PipelineArrow } from './PipelineTab'
import { ProvidersKeysCard } from './ProvidersKeysCard'
import { buildConfigEntries, TYPE_COLOR } from './config-helpers'
import { getModeColor } from './types'
import type { LineInstance } from './types'

export function SummaryTab({
  line,
  onEditConfig,
  onChangeMode,
}: {
  line: LineInstance
  onEditConfig: () => void
  onChangeMode: () => void
}) {
  const toast = useToast()
  const [confirmAction, setConfirmAction] = useState<'restart' | 'stop' | null>(null)
  const modeColor = getModeColor(line.mode)
  const connectionState = line.health?.connection?.state ?? 'unknown'
  const rawConfig = line.config ?? {}
  const agentOptions = rawConfig.agentOptions as Record<string, unknown> | undefined
  const configProvider =
    typeof agentOptions?.provider === 'string' ? agentOptions.provider : DEFAULT_PROVIDER_ID
  const providerId = line.provider ?? line.health?.instance?.provider ?? configProvider
  const providerDisplay = getProvider(providerId)?.displayName ?? providerId

  // All instance KPIs in one row — health, runtime, identity, tokens
  const cards = [
    { label: 'STATUS', value: line.status, color: statusTextClass(line.status) },
    { label: 'CONNECTION', value: connectionState, color: connectionState === 'connected' ? 'text-s-ok' : connectionState === 'connecting' ? 'text-s-warn' : 'text-t4' },
    ...(line.linkedStatus
      ? [{
          label: 'LINK',
          value: line.linkedStatus,
          color: line.linkedStatus === 'linked' ? 'text-s-ok' : line.linkedStatus === 'unlinked' ? 'text-s-warn' : 'text-t4',
        }]
      : []),
    // Mode-specific runtime metrics
    ...(line.mode === 'passive' ? [
      { label: 'UNREAD', value: String(line.unread ?? 0), color: (line.unread ?? 0) > 0 ? 'text-s-warn' : 'text-t3' },
      ...(line.health?.runtime?.passive?.lastActivityAt
        ? [{ label: 'LAST ACTIVITY', value: formatRelative(line.health.runtime.passive.lastActivityAt), color: 'text-t3' }]
        : []),
    ] : []),
    ...(line.mode === 'chat' ? [
      { label: 'QUEUE', value: String(line.queueDepth ?? 0), color: (line.queueDepth ?? 0) > 0 ? 'text-s-warn' : 'text-t3' },
      { label: 'ENRICHMENT', value: String(line.enrichmentUnprocessed ?? 0), color: (line.enrichmentUnprocessed ?? 0) > 0 ? 'text-s-warn' : 'text-t3' },
    ] : []),
    ...(line.mode === 'agent' ? [
      { label: 'PROVIDER', value: providerDisplay, color: 'text-m-agt' },
      { label: 'SESSIONS', value: String(line.activeSessions ?? 0), color: (line.activeSessions ?? 0) > 0 ? 'text-m-agt' : 'text-t3' },
      ...(line.health?.runtime?.agent?.lastSessionStatus
        ? [{ label: 'LAST SESSION', value: line.health.runtime.agent.lastSessionStatus, color: line.health.runtime.agent.lastSessionStatus === 'success' ? 'text-s-ok' : 'text-s-warn' }]
        : []),
    ] : []),
    // Instance metadata
    ...(line.models?.conversation
      ? [{ label: 'MODEL', value: line.models.conversation, color: 'text-t2' }]
      : []),
    ...(line.sandboxPerChat
      ? [{ label: 'ISOLATION', value: 'per-chat', color: 'text-m-agt' }]
      : []),
    ...(line.tokenUsage && (line.tokenUsage.input > 0 || line.tokenUsage.output > 0)
      ? [{ label: 'TOKENS', value: `${(line.tokenUsage.input + line.tokenUsage.output).toLocaleString()}`, color: 'text-t2' }]
      : []),
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

  const config = line.mode !== 'passive' ? buildConfigEntries(rawConfig) : null

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      {/* Row 1: KPI cards — 6-wide single row */}
      <div
        className="grid gap-[var(--sp-2)] bg-d1 c-border rounded-lg p-[var(--sp-2)]"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(var(--input-number-w), 1fr))',
        }}
      >
        {cards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.04, ease: [0.22, 1, 0.36, 1] }}
            className="c-card py-[var(--sp-3)] px-[var(--sp-4)]"
          >
            <div className="c-col-header text-t4 mb-[var(--sp-1)]">
              {card.label}
            </div>
            <div className={`font-mono font-semibold ${card.color} tracking-[var(--tracking-tight)] text-lg`}>
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
        className="c-card flex items-center justify-between py-[var(--sp-4)] px-[var(--sp-5)]"
      >
        <div className="c-col-header text-t4 flex-shrink-0 mr-[var(--sp-5)]">
          Pipeline
        </div>
        <div className="flex items-center flex-1 justify-center flex-wrap gap-[var(--sp-2)]">
          {pipelineNodes.map((node, i) => (
            <span key={node.label} className="flex items-center gap-[var(--sp-2)]">
              {i > 0 && <PipelineArrow />}
              <PipelineNode label={node.label} color={modeColor} active={node.active} />
            </span>
          ))}
        </div>
      </motion.div>

      {/* Row 3: Config + Actions side-by-side */}
      <div className="flex gap-[var(--sp-3)]">
        {/* Configuration panel */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="c-card flex-1 overflow-hidden"
        >
          <div className="flex items-center justify-between c-toolbar bg-d3 c-border-b">
            <span className="c-col-header text-t4">{line.mode} Configuration</span>
            {config && (
              <button
                type="button"
                onClick={onEditConfig}
                className="c-btn c-btn-ghost py-[var(--sp-0h)] px-[var(--sp-2)] text-label"
              >
                Edit
              </button>
            )}
          </div>
          {config ? (
            <div className="py-[var(--sp-3)] px-[var(--sp-4)]">
              {line.mode === 'agent' && (
                <div className={`flex items-center justify-between py-[var(--sp-1h)] px-0${config.length > 0 ? ' c-border-b' : ''}`}>
                  <span className="c-label">provider</span>
                  <span className="font-mono text-m-agt text-data">
                    {getProvider(
                      ((rawConfig.agentOptions as Record<string, unknown> | undefined)?.provider as string) ?? DEFAULT_PROVIDER_ID
                    )?.displayName ?? DEFAULT_PROVIDER_ID}
                  </span>
                </div>
              )}
              {config.map((entry, i) => (
                <div key={entry.key} className={`flex items-center justify-between py-[var(--sp-1h)] px-0${i < config.length - 1 ? ' c-border-b' : ''}`}>
                  <span className="c-label">{entry.key}</span>
                  <span className="font-mono text-data" style={{ color: TYPE_COLOR[entry.type] }}>{entry.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-t4 p-[var(--sp-5)] text-sm">
              Passive mode — no configuration required.
            </div>
          )}
        </motion.div>

        {/* Actions / Controls panel */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="c-card overflow-hidden w-[var(--panel-actions)] flex-shrink-0"
        >
          <div className="c-toolbar bg-d3 c-border-b">
            <span className="c-col-header text-t4">Actions</span>
          </div>
          <div className="flex flex-col py-[var(--sp-3)] px-[var(--sp-4)] gap-[var(--sp-2)]">
            <button
              type="button"
              onClick={() => setConfirmAction('restart')}
              className="c-btn w-full justify-center"
            >
              <RotateCw size={15} strokeWidth={1.75} /> Restart Instance
            </button>
            {line.mode !== 'passive' && (
              <button
                type="button"
                onClick={onEditConfig}
                className="c-btn w-full justify-center"
              >
                <SlidersHorizontal size={15} strokeWidth={1.75} /> Edit Configuration
              </button>
            )}
            <button
              type="button"
              onClick={onChangeMode}
              className="c-btn w-full justify-center"
            >
              <GitBranch size={15} strokeWidth={1.75} /> Change Mode
            </button>
            <div className="c-border-t pt-[var(--sp-2)] mt-[var(--sp-1)]">
              <button
                type="button"
                onClick={() => setConfirmAction('stop')}
                className="c-btn c-btn-danger w-full justify-center"
              >
                <Power size={15} strokeWidth={1.75} /> Stop Instance
              </button>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Row 4: Providers & Keys — agent mode only (read-only) */}
      {line.mode === 'agent' && <ProvidersKeysCard lineName={line.name} />}

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
        <ul className="mt-[var(--sp-2)] pl-[var(--sp-5)]">
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
        <ul className="mt-[var(--sp-2)] pl-[var(--sp-5)]">
          <li>All active chat and agent sessions will be terminated</li>
          <li>The instance will not reconnect until manually started</li>
          <li>Messages received while stopped will not be delivered</li>
        </ul>
      </ConfirmDialog>
    </div>
  )
}
