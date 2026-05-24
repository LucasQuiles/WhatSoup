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
            className="c-btn text-[var(--font-size-label)]"
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
        className="flex items-center justify-between flex-wrap gap-[var(--sp-2)] mb-[var(--sp-5)]"
      >
        <div className="c-col-header">
          {mode} Configuration
        </div>
        <div className="flex flex-wrap gap-[var(--sp-2)]">
          <button
            type="button"
            onClick={onEditConfig}
            className="c-btn text-[var(--font-size-label)]"
          >
            <SlidersHorizontal size={13} strokeWidth={1.75} /> Edit Configuration
          </button>
          <button
            type="button"
            onClick={onChangeMode}
            className="c-btn text-[var(--font-size-label)]"
          >
            <GitBranch size={13} strokeWidth={1.75} /> Change Mode
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
          className="bg-d1 border border-[var(--b1)] rounded-md py-[var(--sp-3)] px-[var(--sp-4)]"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(var(--chat-name-max), auto) 1fr',
            rowGap: 'var(--sp-1)',
            columnGap: 'var(--sp-4)',
          }}
        >
          {config.map((entry) => (
            <React.Fragment key={entry.key}>
              <span
                className="font-mono text-[var(--font-size-data)] text-m-cht"
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
                      className="w-[var(--dot-table)] h-[var(--dot-table)] rounded-full flex-shrink-0"
                      style={{
                        background: entry.value === 'true' ? 'var(--color-s-ok)' : 'var(--color-t5)',
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
