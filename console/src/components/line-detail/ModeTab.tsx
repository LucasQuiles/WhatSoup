import React from 'react'
import { SlidersHorizontal, GitBranch, Bot } from 'lucide-react'
import EmptyState from '../EmptyState'
import { buildConfigEntries, TYPE_COLOR } from './config-helpers'
import type { Mode, LineInstance } from './types'

export function ModeTab({
  mode,
  line,
  onEditConfig,
  onChangeMode,
}: {
  mode: Mode
  line: LineInstance
  onEditConfig: () => void
  onChangeMode: () => void
}) {
  if (mode === 'passive') {
    return (
      <div className="c-section">
        <EmptyState
          icon={<Bot size={40} strokeWidth={1.25} />}
          title="Read-only Mode"
          description="Passive instances listen and store — no configuration required."
        />
        <div className="flex justify-center" style={{ marginTop: 'var(--sp-5)' }}>
          <button
            onClick={onChangeMode}
            className="c-btn"
            style={{ fontSize: 'var(--font-size-label)' }}
          >
            <GitBranch size={13} strokeWidth={1.75} /> Change Mode
          </button>
        </div>
      </div>
    )
  }

  const rawConfig = line.config ?? {}
  const config = buildConfigEntries(rawConfig)

  return (
    <div className="c-section">
      <div
        className="flex items-center justify-between flex-wrap"
        style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-5)' }}
      >
        <div className="c-col-header">
          {mode} Configuration
        </div>
        <div className="flex flex-wrap" style={{ gap: 'var(--sp-2)' }}>
          <button
            onClick={onEditConfig}
            className="c-btn"
            style={{ fontSize: 'var(--font-size-label)' }}
          >
            <SlidersHorizontal size={13} strokeWidth={1.75} /> Edit Configuration
          </button>
          <button
            onClick={onChangeMode}
            className="c-btn"
            style={{ fontSize: 'var(--font-size-label)' }}
          >
            <GitBranch size={13} strokeWidth={1.75} /> Change Mode
          </button>
        </div>
      </div>
      {/* Config entries — structured key-value grid */}
      {config.length === 0 ? (
        <div className="text-t4" style={{ fontSize: 'var(--font-size-data)' }}>
          No configuration values.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(140px, auto) 1fr',
            gap: 'var(--sp-1) var(--sp-4)',
            background: 'var(--color-d1)',
            borderWidth: 'var(--bw)',
            borderStyle: 'solid',
            borderColor: 'var(--b1)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--sp-3) var(--sp-4)',
          }}
        >
          {config.map((entry) => (
            <React.Fragment key={entry.key}>
              <span
                className="font-mono"
                style={{
                  fontSize: 'var(--font-size-data)',
                  color: 'var(--color-m-cht)',
                  paddingTop: 'var(--radius-xs)',
                }}
              >
                {entry.key}
              </span>
              <span
                className="font-mono"
                style={{
                  fontSize: 'var(--font-size-data)',
                  color: TYPE_COLOR[entry.type],
                  wordBreak: 'break-word',
                }}
              >
                {entry.type === 'boolean' ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
                    <span
                      style={{
                        width: 'var(--dot-table)',
                        height: 'var(--dot-table)',
                        borderRadius: 'var(--radius-circle)',
                        background: entry.value === 'true' ? 'var(--color-s-ok)' : 'var(--color-t5)',
                        flexShrink: 0,
                      }}
                    />
                    {entry.value}
                  </span>
                ) : (
                  entry.value
                )}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
