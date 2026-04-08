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
        <div className="flex justify-center mt-[var(--sp-5)]">
          <button
            type="button"
            onClick={onChangeMode}
            className="c-btn"
          >
            <GitBranch size={15} strokeWidth={1.75} /> Change Mode
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
        className="flex items-center justify-between flex-wrap gap-[var(--sp-2)] mb-[var(--sp-5)]"
      >
        <div className="c-col-header">
          {mode} Configuration
        </div>
        <div className="flex flex-wrap gap-[var(--sp-2)]">
          <button
            type="button"
            onClick={onEditConfig}
            className="c-btn"
          >
            <SlidersHorizontal size={15} strokeWidth={1.75} /> Edit Configuration
          </button>
          <button
            type="button"
            onClick={onChangeMode}
            className="c-btn"
          >
            <GitBranch size={15} strokeWidth={1.75} /> Change Mode
          </button>
        </div>
      </div>
      {/* Config entries — structured key-value grid */}
      {config.length === 0 ? (
        <div className="text-t4 text-[var(--font-size-data)]">
          No configuration values.
        </div>
      ) : (
        <div
          className="bg-d1 rounded-md border-[var(--b1)] py-[var(--sp-3)] px-[var(--sp-4)] gap-x-[var(--sp-4)] gap-y-[var(--sp-1)]"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(var(--config-key-col), auto) 1fr',
            borderWidth: 'var(--bw)',
            borderStyle: 'solid',
          }}
        >
          {config.map((entry) => (
            <React.Fragment key={entry.key}>
              <span
                className="font-mono text-m-cht text-[var(--font-size-data)]"
                style={{
                  paddingTop: 'var(--radius-xs)',
                }}
              >
                {entry.key}
              </span>
              <span
                className="font-mono text-[var(--font-size-data)]"
                style={{
                  color: TYPE_COLOR[entry.type],
                  wordBreak: 'break-word',
                }}
              >
                {entry.type === 'boolean' ? (
                  <span className="inline-flex items-center gap-[var(--sp-2)]">
                    <span
                      className="inline-block rounded-full flex-shrink-0 w-[var(--dot-table)] h-[var(--dot-table)]"
                      style={{ background: entry.value === 'true' ? 'var(--color-s-ok)' : 'var(--color-t5)' }}
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
